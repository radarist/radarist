/**
 * @file lib/__tests__/missions.test.ts
 * @description Unit tests for Mission service
 *
 * Tests cover:
 * - createMission: validates input, generates ID, calls Firestore set
 * - getMissionById: returns null for missing doc, returns mission for existing
 * - listMissions: filters by userId, orders by createdAt desc, limits to 50
 * - updateMission: calls Firestore update with correct fields
 * - Error handling: all functions propagate Firestore errors
 *
 * @jest-environment node
 * @author Radarist Team
 * @created 2026-02-23
 */

// ============================================================================
// Mocks — jest.mock factories are hoisted above const, so define inline
// ============================================================================

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    set: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: jest.fn(() => '__DELETE_FIELD__'),
    arrayUnion: jest.fn((value: unknown) => ({ __arrayUnion: value })),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// Import AFTER mocks are set up
import { db } from '@/lib/firebase-admin';
import {
  appendSkillInvocation,
  createMission,
  getMissionById,
  getStuckMissions,
  listMissions,
  markMissionStuck,
  updateMission,
} from '../missions';
import type { CreateMissionInput, Mission } from '@/lib/schemas/mission';
import { missionSchema, slotSchema, createMissionSchema } from '@/lib/schemas/mission';

// ============================================================================
// Test Data
// ============================================================================

const TEST_USER_ID = 'user-test-456';

const validInput: CreateMissionInput = {
  prompt: 'Research emerging AI frameworks in the enterprise space',
  agent: 'scout',
};

const storedMission: Mission = {
  id: 'mission-1234567890-abc123',
  userId: TEST_USER_ID,
  prompt: validInput.prompt,
  agent: 'scout',
  kind: 'research',
  status: 'pending',
  progress: 0,
  entities: [],
  sources: [],
  slots: [],
  createdAt: '2026-02-23T10:00:00.000Z',
};

// ============================================================================
// Helpers — build mock chains per test
// ============================================================================

/**
 * Configure the db mock for doc-level operations (set, get, update).
 * Returns the leaf mock functions so tests can assert on them.
 */
function mockDocOps(overrides?: { set?: jest.Mock; get?: jest.Mock; update?: jest.Mock }) {
  const mockSet = overrides?.set ?? jest.fn().mockResolvedValue(undefined);
  const mockGet = overrides?.get ?? jest.fn().mockResolvedValue({ exists: false });
  const mockUpdate = overrides?.update ?? jest.fn().mockResolvedValue(undefined);

  const docRef = { set: mockSet, get: mockGet, update: mockUpdate };
  const mockDoc = jest.fn().mockReturnValue(docRef);

  (db.collection as jest.Mock).mockReturnValue({
    doc: mockDoc,
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn(),
  });

  return { mockDoc, mockSet, mockGet, mockUpdate };
}

/**
 * Configure the db mock for query-level operations (where, orderBy, limit, get).
 * Returns the leaf mock functions so tests can assert on them.
 */
function mockQueryOps(overrides?: { get?: jest.Mock }) {
  const mockGetDocs = overrides?.get ?? jest.fn().mockResolvedValue({ docs: [] });
  const mockWhere = jest.fn().mockReturnThis();
  const mockOrderBy = jest.fn().mockReturnThis();
  const mockLimit = jest.fn().mockReturnThis();

  const collectionRef = {
    doc: jest.fn(),
    where: mockWhere,
    orderBy: mockOrderBy,
    limit: mockLimit,
    get: mockGetDocs,
  };

  (db.collection as jest.Mock).mockReturnValue(collectionRef);

  return { mockWhere, mockOrderBy, mockLimit, mockGetDocs };
}

// ============================================================================
// Tests
// ============================================================================

describe('Mission Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('appendSkillInvocation', () => {
    it('omits undefined optional fields before the atomic Firestore write', async () => {
      const { mockUpdate } = mockDocOps();

      await appendSkillInvocation('mission-skill-receipt', {
        skill: 'design-pass',
        args: undefined,
        firedAt: '2026-08-05T12:00:00.000Z',
        turn: 3,
      });

      expect(mockUpdate).toHaveBeenCalledWith({
        skillInvocations: {
          __arrayUnion: {
            skill: 'design-pass',
            firedAt: '2026-08-05T12:00:00.000Z',
            turn: 3,
          },
        },
      });
    });
  });

  // --------------------------------------------------------------------------
  // createMission
  // --------------------------------------------------------------------------

  describe('createMission', () => {
    it('should generate an ID with the correct format', async () => {
      mockDocOps();

      const result = await createMission(TEST_USER_ID, validInput);

      expect(result.id).toMatch(/^mission-\d+-[a-z0-9]+$/);
    });

    it('should call Firestore set with the mission document', async () => {
      const { mockDoc, mockSet } = mockDocOps();

      const result = await createMission(TEST_USER_ID, validInput);

      expect(db.collection).toHaveBeenCalledWith('missions');
      expect(mockDoc).toHaveBeenCalledWith(result.id);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          userId: TEST_USER_ID,
          prompt: validInput.prompt,
          agent: 'scout',
          status: 'pending',
          progress: 0,
          entities: [],
          sources: [],
        })
      );
    });

    it('normalizes undefined nested fields in validated optional objects before the write (ARUN-017)', async () => {
      const { mockSet } = mockDocOps();

      await createMission(TEST_USER_ID, {
        ...validInput,
        modelOverrides: { build: 'claude-sonnet-5', qa: undefined },
      });

      const payload = mockSet.mock.calls[0][0] as { modelOverrides: Record<string, unknown> };
      expect(payload.modelOverrides).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(payload.modelOverrides, 'qa')).toBe(false);
      expect(payload.modelOverrides).toStrictEqual({ build: 'claude-sonnet-5' });
    });

    it('should set createdAt to an ISO timestamp', async () => {
      mockDocOps();

      const before = new Date().toISOString();
      const result = await createMission(TEST_USER_ID, validInput);
      const after = new Date().toISOString();

      expect(result.createdAt).toBeDefined();
      expect(result.createdAt >= before).toBe(true);
      expect(result.createdAt <= after).toBe(true);
    });

    it('should return the full mission object', async () => {
      mockDocOps();

      const result = await createMission(TEST_USER_ID, validInput);

      expect(result).toEqual(
        expect.objectContaining({
          userId: TEST_USER_ID,
          prompt: validInput.prompt,
          agent: 'scout',
          status: 'pending',
          progress: 0,
          entities: [],
          sources: [],
        })
      );
    });

    it('should use the default agent when not specified', async () => {
      mockDocOps();

      // Use a plain object (not typed as CreateMissionInput) to test Zod default
      const inputWithoutAgent = { prompt: 'Scan for signals' };

      const result = await createMission(TEST_USER_ID, inputWithoutAgent as CreateMissionInput);

      expect(result.agent).toBe('scout');
    });

    it('should accept a custom agent name', async () => {
      mockDocOps();

      const customInput: CreateMissionInput = {
        prompt: 'Evaluate technology maturity',
        agent: 'evaluator',
      };

      const result = await createMission(TEST_USER_ID, customInput);

      expect(result.agent).toBe('evaluator');
    });

    it('should reject an empty prompt', async () => {
      const badInput = { prompt: '', agent: 'scout' };

      await expect(createMission(TEST_USER_ID, badInput)).rejects.toThrow();
    });

    it('should reject a prompt exceeding the 50000-char default cap', async () => {
      const longPrompt = 'x'.repeat(50001);
      const badInput = { prompt: longPrompt, agent: 'scout' };

      await expect(createMission(TEST_USER_ID, badInput)).rejects.toThrow();
    });

    it('should propagate Firestore errors', async () => {
      const failingSet = jest.fn().mockRejectedValue(new Error('Firestore write failed'));
      mockDocOps({ set: failingSet });

      await expect(createMission(TEST_USER_ID, validInput)).rejects.toThrow('Firestore write failed');
    });

    it('persists slots and classifierMetadata when provided', async () => {
      mockDocOps();

      const result = await createMission(
        'user-1',
        { prompt: 'create a vendor report', agent: 'creator' },
        {
          slots: [{ name: 'main', intent: 'vendor report' }],
          classifierMetadata: { latencyMs: 800, costUsd: 0, fallback: false, model: 'gemini-3-flash-preview' },
        }
      );
      expect(result.slots).toEqual([{ name: 'main', intent: 'vendor report' }]);
      expect(result.classifierMetadata?.fallback).toBe(false);
    });

    it('persists the exact user-authorized research cost cap', async () => {
      const { mockSet } = mockDocOps();

      const result = await createMission(
        'user-1',
        { prompt: 'create a vendor report', agent: 'creator' },
        { authorizedMaxCostUsd: 31 }
      );

      expect(result.authorizedMaxCostUsd).toBe(31);
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ authorizedMaxCostUsd: 31 }));
    });

    it.each([0, -1, Number.NaN])('rejects invalid user-authorized research cost cap %p', async (cap) => {
      await expect(
        createMission('user-1', { prompt: 'create a vendor report', agent: 'creator' }, { authorizedMaxCostUsd: cap })
      ).rejects.toThrow('authorizedMaxCostUsd must be a positive finite number');
    });

    it('persists the confirmed execution envelope alongside the authorized total', async () => {
      const { mockSet } = mockDocOps();

      const executionEnvelope = {
        orchestratorMaxCostUsd: 13,
        revisionMaxCostUsd: 0.01,
        preludeMaxCostUsd: 2,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 17.01,
        maxToolCalls: 120,
        timeoutMinutes: 90,
        requestedModel: 'claude-opus-5',
      };
      const result = await createMission(
        'user-1',
        { prompt: 'create a vendor report', agent: 'creator' },
        { authorizedMaxCostUsd: 17.01, executionEnvelope }
      );

      expect(result.executionEnvelope).toEqual(executionEnvelope);
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ executionEnvelope }));
    });

    it('rejects an execution envelope whose total disagrees with the authorized cap', async () => {
      const executionEnvelope = {
        orchestratorMaxCostUsd: 13,
        revisionMaxCostUsd: 0.01,
        preludeMaxCostUsd: 2,
        auxiliaryMaxCostUsd: 2,
        totalMaxCostUsd: 17.01,
        maxToolCalls: 120,
        timeoutMinutes: 90,
      };
      await expect(
        createMission(
          'user-1',
          { prompt: 'create a vendor report', agent: 'creator' },
          { authorizedMaxCostUsd: 15.3, executionEnvelope }
        )
      ).rejects.toThrow('executionEnvelope.totalMaxCostUsd');
    });

    it('rejects an internally inconsistent execution envelope', async () => {
      await expect(
        createMission(
          'user-1',
          { prompt: 'create a vendor report', agent: 'creator' },
          {
            executionEnvelope: {
              orchestratorMaxCostUsd: 13,
              revisionMaxCostUsd: 0.01,
              preludeMaxCostUsd: 2,
              auxiliaryMaxCostUsd: 2,
              totalMaxCostUsd: 15.3,
              maxToolCalls: 120,
              timeoutMinutes: 90,
            },
          }
        )
      ).rejects.toThrow('components sum to');
    });

    it('persists enablePrelude=false when caller opts out (benchmark A/B)', async () => {
      mockDocOps();

      const result = await createMission('user-1', { prompt: 'creator p', agent: 'creator' }, { enablePrelude: false });
      expect((result as unknown as { enablePrelude?: boolean }).enablePrelude).toBe(false);
    });

    it('omits enablePrelude when extras do not specify (preserves legacy mission shape)', async () => {
      mockDocOps();

      const result = await createMission('user-1', { prompt: 'creator p', agent: 'creator' });
      expect((result as unknown as { enablePrelude?: boolean }).enablePrelude).toBeUndefined();
    });

    it('defaults slots to [{ name: "main" }] when extras not provided (legacy callers)', async () => {
      mockDocOps();

      const result = await createMission('user-1', { prompt: 'do something', agent: 'creator' });
      expect(result.slots).toEqual([{ name: 'main', intent: 'legacy default (no classifier)' }]);
    });
  });

  // --------------------------------------------------------------------------
  // getMissionById
  // --------------------------------------------------------------------------

  describe('getMissionById', () => {
    it('should return null when the document does not exist', async () => {
      mockDocOps({ get: jest.fn().mockResolvedValue({ exists: false }) });

      const result = await getMissionById('mission-nonexistent');

      expect(result).toBeNull();
    });

    it('should return the mission when it exists', async () => {
      mockDocOps({
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => storedMission,
        }),
      });

      const result = await getMissionById(storedMission.id);

      expect(result).toEqual(storedMission);
    });

    it('should query the missions collection with the correct ID', async () => {
      const { mockDoc } = mockDocOps({
        get: jest.fn().mockResolvedValue({ exists: false }),
      });

      await getMissionById('mission-target-id');

      expect(db.collection).toHaveBeenCalledWith('missions');
      expect(mockDoc).toHaveBeenCalledWith('mission-target-id');
    });

    it('should propagate Firestore errors', async () => {
      mockDocOps({
        get: jest.fn().mockRejectedValue(new Error('Firestore read failed')),
      });

      await expect(getMissionById('mission-bad')).rejects.toThrow('Firestore read failed');
    });
  });

  // --------------------------------------------------------------------------
  // listMissions
  // --------------------------------------------------------------------------

  describe('listMissions', () => {
    it('filters on the server-authorized principal union (uid + system principals, nothing else)', async () => {
      const { mockWhere } = mockQueryOps();

      await listMissions(TEST_USER_ID);

      expect(mockWhere).toHaveBeenCalledWith('userId', 'in', [
        TEST_USER_ID,
        'system',
        'system-sweep',
        'system-discovery',
      ]);
    });

    it('should order by createdAt descending', async () => {
      const { mockOrderBy } = mockQueryOps();

      await listMissions(TEST_USER_ID);

      expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should limit results to 50', async () => {
      const { mockLimit } = mockQueryOps();

      await listMissions(TEST_USER_ID);

      expect(mockLimit).toHaveBeenCalledWith(50);
    });

    it('should return an empty array when no missions exist', async () => {
      mockQueryOps();

      const result = await listMissions(TEST_USER_ID);

      expect(result).toEqual([]);
    });

    it('should return missions mapped from doc.data()', async () => {
      const mission1: Mission = {
        ...storedMission,
        id: 'mission-1',
        createdAt: '2026-02-23T12:00:00.000Z',
      };
      const mission2: Mission = {
        ...storedMission,
        id: 'mission-2',
        createdAt: '2026-02-23T10:00:00.000Z',
      };

      mockQueryOps({
        get: jest.fn().mockResolvedValue({
          docs: [{ data: () => mission1 }, { data: () => mission2 }],
        }),
      });

      const result = await listMissions(TEST_USER_ID);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mission1);
      expect(result[1]).toEqual(mission2);
    });

    it('should propagate Firestore errors', async () => {
      mockQueryOps({
        get: jest.fn().mockRejectedValue(new Error('Firestore query failed')),
      });

      await expect(listMissions(TEST_USER_ID)).rejects.toThrow('Firestore query failed');
    });
  });

  // --------------------------------------------------------------------------
  // updateMission
  // --------------------------------------------------------------------------

  describe('updateMission', () => {
    it('should call Firestore update with the correct document ID', async () => {
      const { mockDoc, mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = { status: 'running', progress: 25 };

      await updateMission('mission-target-id', updates);

      expect(db.collection).toHaveBeenCalledWith('missions');
      expect(mockDoc).toHaveBeenCalledWith('mission-target-id');
      expect(mockUpdate).toHaveBeenCalledWith(updates);
    });

    it('should update status and progress', async () => {
      const { mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = {
        status: 'running',
        progress: 50,
        progressMessage: 'Scanning sources...',
      };

      await updateMission('mission-123', updates);

      expect(mockUpdate).toHaveBeenCalledWith(updates);
    });

    it('should update entities and sources', async () => {
      const { mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = {
        entities: [
          {
            id: 'tech-1',
            name: 'React Server Components',
            type: 'technology',
            confidence: 0.9,
            agentName: 'scout',
          },
        ],
        sources: [
          {
            url: 'https://example.com/article',
            title: 'RSC Deep Dive',
            snippet: 'An overview of React Server Components...',
          },
        ],
      };

      await updateMission('mission-123', updates);

      expect(mockUpdate).toHaveBeenCalledWith(updates);
    });

    it('should update completedAt and result on completion', async () => {
      const { mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = {
        status: 'completed',
        progress: 100,
        completedAt: '2026-02-23T12:00:00.000Z',
        result: '## Mission Complete\n\nFound 5 emerging technologies.',
      };

      await updateMission('mission-123', updates);

      expect(mockUpdate).toHaveBeenCalledWith(updates);
    });

    it('should update token usage and cost', async () => {
      const { mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = {
        tokenUsage: { input: 1500, output: 800 },
        costUsd: 0.023,
      };

      await updateMission('mission-123', updates);

      expect(mockUpdate).toHaveBeenCalledWith({
        ...updates,
        costUnavailableReason: '__DELETE_FIELD__',
        costUnavailableComponents: '__DELETE_FIELD__',
      });
    });

    it('atomically deletes explicitly named stale fields', async () => {
      const { mockUpdate } = mockDocOps();

      await updateMission(
        'mission-123',
        { costUnavailableReason: 'unknown-pricing' },
        { deleteFields: ['costUsd', 'costBreakdownUsd'] }
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        costUnavailableReason: 'unknown-pricing',
        costUsd: '__DELETE_FIELD__',
        costBreakdownUsd: '__DELETE_FIELD__',
      });
    });

    it('should propagate Firestore errors', async () => {
      mockDocOps({
        update: jest.fn().mockRejectedValue(new Error('Firestore update failed')),
      });

      await expect(updateMission('mission-bad', { status: 'failed' })).rejects.toThrow('Firestore update failed');
    });

    it('normalizes undefined optional fields inside mixed skillPrelude entries (ARUN-017)', async () => {
      const { mockUpdate } = mockDocOps();
      const updates: Partial<Mission> = {
        skillPrelude: [
          {
            skill: 'jtbd-framing',
            target: 'Workday Skills Cloud',
            block: '<jtbd>ok</jtbd>',
            costUsd: 0.04,
            durationMs: 12_000,
            firedAt: '2026-07-18T00:00:00.000Z',
            success: true,
          },
          {
            skill: 'cynefin-classification',
            target: undefined,
            block: '',
            costUsd: 0,
            durationMs: 0,
            firedAt: '2026-07-18T00:00:01.000Z',
            success: false,
            error: 'sub-mission timed out',
          },
        ],
      };

      await updateMission('mission-123', updates);

      const payload = mockUpdate.mock.calls[0][0] as { skillPrelude: Array<Record<string, unknown>> };
      expect(Object.prototype.hasOwnProperty.call(payload.skillPrelude[1], 'target')).toBe(false);
      expect(payload.skillPrelude).toStrictEqual([
        {
          skill: 'jtbd-framing',
          target: 'Workday Skills Cloud',
          block: '<jtbd>ok</jtbd>',
          costUsd: 0.04,
          durationMs: 12_000,
          firedAt: '2026-07-18T00:00:00.000Z',
          success: true,
        },
        {
          skill: 'cynefin-classification',
          block: '',
          costUsd: 0,
          durationMs: 0,
          firedAt: '2026-07-18T00:00:01.000Z',
          success: false,
          error: 'sub-mission timed out',
        },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // getStuckMissions + markMissionStuck (H4 + H8)
  // --------------------------------------------------------------------------

  describe('getStuckMissions', () => {
    /**
     * Configure parallel where/where/get chains so a single chain object
     * answers both `running` and `pending` query lookups. The two queries
     * run via Promise.all so we can hand back distinct snapshots.
     */
    function mockTwoStatusQueries(runningDocs: unknown[], pendingDocs: unknown[]) {
      const runningSnapshot = { docs: runningDocs.map((d) => ({ data: () => d })) };
      const pendingSnapshot = { docs: pendingDocs.map((d) => ({ data: () => d })) };
      const get = jest
        .fn()
        // First Promise.all() entry — running, second — pending. Order is
        // preserved by the implementation so we resolve in that order.
        .mockResolvedValueOnce(runningSnapshot)
        .mockResolvedValueOnce(pendingSnapshot);
      const where = jest.fn().mockReturnThis();
      (db.collection as jest.Mock).mockReturnValue({ where, get });
      return { where, get };
    }

    it('queries both running and pending statuses with the cutoff threshold', async () => {
      const { where } = mockTwoStatusQueries([], []);

      await getStuckMissions(24);

      expect(db.collection).toHaveBeenCalledWith('missions');
      // Each query has 2 where calls: status=...  + createdAt < cutoff
      const calls = where.mock.calls;
      expect(calls.length).toBe(4);
      const statuses = calls.map((c) => c[2]).filter((v, i) => calls[i][0] === 'status');
      expect(statuses).toEqual(expect.arrayContaining(['running', 'pending']));
      // createdAt comparator is "<"
      const ageCalls = calls.filter((c) => c[0] === 'createdAt');
      expect(ageCalls.length).toBe(2);
      expect(ageCalls[0][1]).toBe('<');
    });

    it('excludes build missions — they park at human gates for days and have their own GC', async () => {
      mockTwoStatusQueries(
        [
          { id: 'm-research', status: 'running' },
          { id: 'm-build', status: 'running', kind: 'build' },
        ],
        [{ id: 'm-build-2', status: 'pending', kind: 'build' }]
      );

      const result = await getStuckMissions(24);

      expect(result.map((m) => m.id)).toEqual(['m-research']);
    });

    it('returns merged missions from running + pending snapshots', async () => {
      mockTwoStatusQueries(
        [{ id: 'm-r1', status: 'running' }],
        [
          { id: 'm-p1', status: 'pending' },
          { id: 'm-p2', status: 'pending' },
        ]
      );

      const result = await getStuckMissions(24);

      expect(result.map((m) => m.id)).toEqual(['m-r1', 'm-p1', 'm-p2']);
    });

    it('returns empty array when no missions are stuck', async () => {
      mockTwoStatusQueries([], []);

      const result = await getStuckMissions(24);
      expect(result).toEqual([]);
    });

    it('propagates Firestore errors', async () => {
      const get = jest.fn().mockRejectedValue(new Error('firestore down'));
      const where = jest.fn().mockReturnThis();
      (db.collection as jest.Mock).mockReturnValue({ where, get });

      await expect(getStuckMissions(24)).rejects.toThrow('firestore down');
    });
  });

  describe('markMissionStuck', () => {
    it('forces the mission to failed with the supplied reason and a completedAt stamp', async () => {
      const { mockUpdate } = mockDocOps();

      await markMissionStuck('mission-stuck-id', 'stuck >24h');

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const update = mockUpdate.mock.calls[0][0];
      expect(update.status).toBe('failed');
      expect(update.errors).toEqual(['stuck >24h']);
      expect(typeof update.completedAt).toBe('string');
      // ISO 8601 sanity check.
      expect(update.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

describe('Mission slots field', () => {
  it('accepts a slot object with kebab-case name and intent', () => {
    const result = slotSchema.safeParse({ name: 'vendor-comparison', intent: 'compare top 3 vendors' });
    expect(result.success).toBe(true);
  });

  it('rejects slot names that are not kebab-case', () => {
    const result = slotSchema.safeParse({ name: 'VendorComparison', intent: 'foo' });
    expect(result.success).toBe(false);
  });

  it('accepts mission with empty slots array (exploratory)', () => {
    const m = {
      id: 'mission-1',
      userId: 'u1',
      prompt: 'p',
      agent: 'creator',
      status: 'pending',
      progress: 0,
      entities: [],
      sources: [],
      createdAt: '2026-05-01T00:00:00Z',
      slots: [],
    };
    expect(missionSchema.safeParse(m).success).toBe(true);
  });

  it('accepts mission with classifierMetadata', () => {
    const m = {
      id: 'mission-1',
      userId: 'u1',
      prompt: 'p',
      agent: 'creator',
      status: 'pending',
      progress: 0,
      entities: [],
      sources: [],
      createdAt: '2026-05-01T00:00:00Z',
      slots: [{ name: 'main', intent: 'x' }],
      classifierMetadata: { latencyMs: 800, costUsd: 0.0003, fallback: false, model: 'gemini-3-flash-preview' },
    };
    expect(missionSchema.safeParse(m).success).toBe(true);
  });

  it('accepts mission with qualityGateSkipped', () => {
    const m = {
      id: 'mission-1',
      userId: 'u1',
      prompt: 'p',
      agent: 'creator',
      status: 'pending',
      progress: 0,
      entities: [],
      sources: [],
      createdAt: '2026-05-01T00:00:00Z',
      slots: [],
      qualityGateSkipped: 'exploratory',
    };
    expect(missionSchema.safeParse(m).success).toBe(true);
  });
});

describe('createMission — DesignBrief conception wiring (P2)', () => {
  it('report agents (creator) get a brand-dark default brief, source=auto', async () => {
    mockDocOps();
    const m = await createMission(TEST_USER_ID, { prompt: 'make a landscape report', agent: 'creator' });
    expect(m.designBrief?.theme).toBe('brand-dark');
    expect(m.designBrief?.source).toBe('auto');
    expect(m.designBrief?.palette.sequence[0]).toBe('#d4a84b');
  });

  it('honors explicit design directives, source=user', async () => {
    mockDocOps();
    const m = await createMission(TEST_USER_ID, {
      prompt: 'report',
      agent: 'creator',
      designBrief: { theme: 'brand-light' },
    });
    expect(m.designBrief?.theme).toBe('brand-light');
    expect(m.designBrief?.source).toBe('user');
  });

  it('empower-all: every agent (incl. scout) gets the brand-dark default brief, source=auto', async () => {
    mockDocOps();
    const m = await createMission(TEST_USER_ID, { prompt: 'scout for vendors', agent: 'scout' });
    // The styling artifact is shared across all agents now — whichever agent
    // renders charts/infographics produces on-brand output.
    expect(m.designBrief?.theme).toBe('brand-dark');
    expect(m.designBrief?.source).toBe('auto');
  });

  it('createMissionSchema captures a designBrief partial input (not stripped)', () => {
    const r = createMissionSchema.safeParse({
      prompt: 'p',
      agent: 'creator',
      designBrief: { theme: 'brand-light', palette: { accent: '#4a9eff' } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.designBrief?.theme).toBe('brand-light');
      expect(r.data.designBrief?.palette?.accent).toBe('#4a9eff');
    }
  });
});
