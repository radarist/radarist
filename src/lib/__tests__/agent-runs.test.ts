/**
 * @file lib/__tests__/agent-runs.test.ts
 * @description Unit tests for AgentRun service
 *
 * Tests cover:
 * - createAgentRun: validates input, generates ID, calls Firestore set
 * - listAgentRuns: filters by userId, orders by createdAt desc, limits to 100
 * - getTokenUsageSummary: groups by date, returns 7-day window, computes totals
 * - Error handling: all functions propagate Firestore errors
 * - Zod validation: rejects invalid inputs
 *
 * @jest-environment node
 * @author Radarist Team
 * @created 2026-02-23
 */

// ============================================================================
// Mocks -- jest.mock factories are hoisted above const, so define inline
// ============================================================================

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    set: jest.fn(),
    get: jest.fn(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    runTransaction: jest.fn(),
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

jest.mock('@/lib/graph/agent-run-sync', () => ({
  syncAgentRunToNeo4j: jest.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks are set up
import { db } from '@/lib/firebase-admin';
import { syncAgentRunToNeo4j } from '@/lib/graph/agent-run-sync';
import {
  createAgentRun,
  listAgentRuns,
  listAgentRunsWithDiagnostics,
  getTokenUsageSummary,
  getTokenUsageByAgent,
  normalizeAgentRunForRead,
  patchAgentRunAccounting,
} from '../agent-runs';
import { primaryModelFromUsage } from '../agent-run-model';
import type { CreateAgentRunInput, AgentRun } from '@/lib/schemas/agent-run';

// ============================================================================
// Test Data
// ============================================================================

const TEST_USER_ID = 'user-test-789';

const validInput: CreateAgentRunInput = {
  userId: TEST_USER_ID,
  agentName: 'Scout',
  action: 'Researched 3 companies in healthcare AI',
  status: 'success',
  sweepId: 'sweep-2026-02-23-a',
  tokenUsage: { input: 4200, output: 1800 },
  costUsd: 0.012,
  duration: 12340,
};

const storedRun: AgentRun = {
  id: 'run-1234567890-abc123',
  userId: TEST_USER_ID,
  agentName: 'Scout',
  action: 'Researched 3 companies in healthcare AI',
  status: 'success',
  sweepId: 'sweep-2026-02-23-a',
  tokenUsage: { input: 4200, output: 1800 },
  costUsd: 0.012,
  duration: 12340,
  createdAt: '2026-02-23T10:00:00.000Z',
};

// ============================================================================
// Helpers -- build mock chains per test
// ============================================================================

/**
 * Configure the db mock for doc-level operations (set, get).
 * Returns the leaf mock functions so tests can assert on them.
 */
function mockDocOps(overrides?: { set?: jest.Mock; get?: jest.Mock }) {
  const mockSet = overrides?.set ?? jest.fn().mockResolvedValue(undefined);
  const mockGet = overrides?.get ?? jest.fn().mockResolvedValue({ exists: false });

  const docRef = { set: mockSet, get: mockGet };
  const mockDoc = jest.fn().mockReturnValue(docRef);

  (db.collection as jest.Mock).mockReturnValue({
    doc: mockDoc,
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn(),
  });

  return { mockDoc, mockSet, mockGet };
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

/**
 * Configure the db mock for chained query operations (multiple where clauses).
 * The getTokenUsageSummary function chains two .where() calls before .orderBy() and .get().
 */
function mockChainedQueryOps(overrides?: { get?: jest.Mock }) {
  const mockGetDocs = overrides?.get ?? jest.fn().mockResolvedValue({ docs: [] });

  // Build a self-referencing chain object that handles:
  // .where(...).where(...).orderBy(...).get()
  const chainRef: Record<string, jest.Mock> = {};
  chainRef.where = jest.fn().mockReturnValue(chainRef);
  chainRef.orderBy = jest.fn().mockReturnValue(chainRef);
  chainRef.limit = jest.fn().mockReturnValue(chainRef);
  chainRef.get = mockGetDocs;
  chainRef.doc = jest.fn();

  (db.collection as jest.Mock).mockReturnValue(chainRef);

  return { mockWhere: chainRef.where, mockOrderBy: chainRef.orderBy, mockGetDocs };
}

/**
 * ARUN-004: the token summaries now read TWO collections — `agentRuns` and
 * `missions` (build spend). Route each `db.collection(name)` to its own doc set
 * so a build-folding test can return builds from `missions` while `agentRuns`
 * stays independent.
 */
function mockCollectionRouter(byCollection: Record<string, unknown[]>) {
  (db.collection as jest.Mock).mockImplementation((name: string) => {
    const chainRef: Record<string, jest.Mock> = {};
    chainRef.where = jest.fn().mockReturnValue(chainRef);
    chainRef.orderBy = jest.fn().mockReturnValue(chainRef);
    chainRef.limit = jest.fn().mockReturnValue(chainRef);
    chainRef.doc = jest.fn();
    chainRef.get = jest.fn().mockResolvedValue({ docs: (byCollection[name] ?? []).map((d) => ({ data: () => d })) });
    return chainRef;
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentRun Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // createAgentRun
  // --------------------------------------------------------------------------

  describe('createAgentRun', () => {
    it('should generate an ID with the correct format', async () => {
      mockDocOps();

      const result = await createAgentRun(validInput);

      expect(result.id).toMatch(/^run-\d+-[a-z0-9]+$/);
    });

    it('should call Firestore set with the agent run document', async () => {
      const { mockDoc, mockSet } = mockDocOps();

      const result = await createAgentRun(validInput);

      expect(db.collection).toHaveBeenCalledWith('agentRuns');
      expect(mockDoc).toHaveBeenCalledWith(result.id);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          userId: TEST_USER_ID,
          agentName: 'Scout',
          action: validInput.action,
          status: 'success',
          sweepId: 'sweep-2026-02-23-a',
          kind: 'sweep',
          tokenUsage: { input: 4200, output: 1800 },
          costUsd: 0.012,
          duration: 12340,
        })
      );
    });

    it('normalizes undefined optional fields inside the mirrored skillPrelude entries (ARUN-017)', async () => {
      const { mockSet } = mockDocOps();

      await createAgentRun({
        ...validInput,
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
      });

      const payload = mockSet.mock.calls[0][0] as { skillPrelude: Array<Record<string, unknown>> };
      expect(Object.prototype.hasOwnProperty.call(payload.skillPrelude[1], 'target')).toBe(false);
      expect(payload.skillPrelude[1]).toStrictEqual({
        skill: 'cynefin-classification',
        block: '',
        costUsd: 0,
        durationMs: 0,
        firedAt: '2026-07-18T00:00:01.000Z',
        success: false,
        error: 'sub-mission timed out',
      });
    });

    it('persists inferred kind and provider for a legacy-shaped Claude chat writer', async () => {
      const { mockSet } = mockDocOps();

      const result = await createAgentRun({
        ...validInput,
        agentName: 'chat',
        sweepId: undefined,
        model: 'claude-opus-4-8',
      });

      expect(result).toMatchObject({ kind: 'chat', provider: 'claude', model: 'claude-opus-4-8' });
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'chat', provider: 'claude', model: 'claude-opus-4-8' })
      );
    });

    it('persists explicit Gemini chat fields and a strict redacted tool summary', async () => {
      const { mockSet } = mockDocOps();

      await createAgentRun({
        ...validInput,
        agentName: 'chat',
        sweepId: undefined,
        kind: 'chat',
        provider: 'gemini',
        model: 'gemini-3.5-pro',
        toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 25 }],
        toolSummaryTruncated: false,
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'chat',
          provider: 'gemini',
          model: 'gemini-3.5-pro',
          toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 25 }],
          toolSummaryTruncated: false,
        })
      );
    });

    it('does not infer a chat provider for a mission that uses a Claude model', async () => {
      const { mockSet } = mockDocOps();

      const result = await createAgentRun({
        ...validInput,
        sweepId: undefined,
        missionId: 'mission-1',
        model: 'claude-sonnet-4-6',
      });

      expect(result.kind).toBe('mission');
      expect(result.provider).toBeUndefined();
      expect(mockSet.mock.calls[0][0]).not.toHaveProperty('provider');
    });

    it('should set createdAt to an ISO timestamp', async () => {
      mockDocOps();

      const before = new Date().toISOString();
      const result = await createAgentRun(validInput);
      const after = new Date().toISOString();

      expect(result.createdAt).toBeDefined();
      expect(result.createdAt >= before).toBe(true);
      expect(result.createdAt <= after).toBe(true);
    });

    it('should return the full agent run object', async () => {
      mockDocOps();

      const result = await createAgentRun(validInput);

      expect(result).toEqual(
        expect.objectContaining({
          userId: TEST_USER_ID,
          agentName: 'Scout',
          action: validInput.action,
          status: 'success',
          tokenUsage: { input: 4200, output: 1800 },
          costUsd: 0.012,
          duration: 12340,
        })
      );
    });

    it('should accept input without optional fields', async () => {
      mockDocOps();

      const minimalInput: CreateAgentRunInput = {
        userId: TEST_USER_ID,
        agentName: 'Evaluator',
        action: 'Scored 5 signals',
        status: 'success',
        tokenUsage: { input: 1000, output: 500 },
        costUsd: 0.005,
        duration: 3000,
      };

      const result = await createAgentRun(minimalInput);

      expect(result.sweepId).toBeUndefined();
      expect(result.errors).toBeUndefined();
      expect(result.missionId).toBeUndefined();
    });

    it('should accept input with errors array', async () => {
      mockDocOps();

      const failedInput: CreateAgentRunInput = {
        userId: TEST_USER_ID,
        agentName: 'Scout',
        action: 'Failed to research quantum computing',
        status: 'failure',
        tokenUsage: { input: 1500, output: 200 },
        costUsd: 0.003,
        duration: 4100,
        errors: ['Rate limit exceeded', 'Retries exhausted'],
      };

      const result = await createAgentRun(failedInput);

      expect(result.errors).toEqual(['Rate limit exceeded', 'Retries exhausted']);
      expect(result.status).toBe('failure');
    });

    it('should accept input with missionId', async () => {
      mockDocOps();

      const inputWithMission: CreateAgentRunInput = {
        ...validInput,
        sweepId: undefined,
        missionId: 'mission-123-abc',
      };

      const result = await createAgentRun(inputWithMission);

      expect(result.missionId).toBe('mission-123-abc');
    });

    it('forwards missionId (not an episode id) to the Neo4j sync (M12)', async () => {
      mockDocOps();

      await createAgentRun({ ...validInput, sweepId: undefined, missionId: 'mission-77' });

      // The sync is fire-and-forget behind a dynamic import — flush microtasks.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(syncAgentRunToNeo4j).toHaveBeenCalledTimes(1);
      const syncArg = (syncAgentRunToNeo4j as jest.Mock).mock.calls[0][0];
      expect(syncArg).toMatchObject({ missionId: 'mission-77' });
      // The old bug: missionId was passed under `episodeId`, so the Episode
      // MATCH (which expects an 'ep-' id) never formed EXECUTED_DURING.
      expect(syncArg).not.toHaveProperty('episodeId');
      expect(syncArg.sweepId).toBeUndefined();
    });

    it('forwards sweepId as the proactive lifecycle owner', async () => {
      mockDocOps();

      await createAgentRun(validInput);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(syncAgentRunToNeo4j).toHaveBeenCalledTimes(1);
      expect((syncAgentRunToNeo4j as jest.Mock).mock.calls[0][0]).toMatchObject({
        missionId: undefined,
        sweepId: 'sweep-2026-02-23-a',
      });
    });

    it('forwards neither correlation for standalone runs', async () => {
      mockDocOps();
      const standalone: CreateAgentRunInput = {
        ...validInput,
        sweepId: undefined,
      };

      await createAgentRun(standalone);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(syncAgentRunToNeo4j).toHaveBeenCalledTimes(1);
      expect((syncAgentRunToNeo4j as jest.Mock).mock.calls[0][0]).toMatchObject({
        missionId: undefined,
        sweepId: undefined,
      });
    });

    it('rejects dual mission/sweep ownership before Firestore writes', async () => {
      const { mockSet } = mockDocOps();

      await expect(createAgentRun({ ...validInput, missionId: 'mission-conflict' })).rejects.toThrow(
        'cannot belong to both a mission and a sweep'
      );

      expect(mockSet).not.toHaveBeenCalled();
      expect(syncAgentRunToNeo4j).not.toHaveBeenCalled();
    });

    it('should reject input with empty agentName', async () => {
      const badInput = { ...validInput, agentName: '' };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with empty action', async () => {
      const badInput = { ...validInput, action: '' };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with empty userId', async () => {
      const badInput = { ...validInput, userId: '' };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with negative tokenUsage.input', async () => {
      const badInput = {
        ...validInput,
        tokenUsage: { input: -1, output: 100 },
      };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with negative costUsd', async () => {
      const badInput = { ...validInput, costUsd: -0.01 };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with negative duration', async () => {
      const badInput = { ...validInput, duration: -100 };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should reject input with invalid status', async () => {
      const badInput = { ...validInput, status: 'invalid' as CreateAgentRunInput['status'] };

      await expect(createAgentRun(badInput)).rejects.toThrow();
    });

    it('should propagate Firestore errors', async () => {
      const failingSet = jest.fn().mockRejectedValue(new Error('Firestore write failed'));
      mockDocOps({ set: failingSet });

      await expect(createAgentRun(validInput)).rejects.toThrow('Firestore write failed');
    });
  });

  describe('patchAgentRunAccounting', () => {
    it('replaces usage from durable receipts with literal model keys and projects the final estimate', async () => {
      const model = 'anthropic/claude.sonnet-4.5';
      const raw = {
        userId: TEST_USER_ID,
        kind: 'chat',
        provider: 'claude',
        agentName: 'chat',
        action: 'Assistant chat turn',
        status: 'success',
        model: 'requested-model-must-not-survive',
        modelUsage: {
          'requested-model-must-not-survive': { inputTokens: 999, outputTokens: 999 },
        },
        tokenUsage: { input: 10, output: 5 },
        costUnavailableReason: 'accounting-incomplete',
        duration: 100,
        createdAt: '2026-07-23T10:00:00.000Z',
      };
      const ref = { path: 'agentRuns/run-literal-model' };
      const update = jest.fn();
      (db.collection as jest.Mock).mockReturnValue({ doc: jest.fn().mockReturnValue(ref) });
      (db.runTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          get: jest.fn().mockResolvedValue({ exists: true, data: () => raw }),
          update,
        })
      );

      await patchAgentRunAccounting(
        'run-literal-model',
        { costUsd: 0.75 },
        {
          model,
          modelUsage: {
            [model]: {
              inputTokens: 10,
              outputTokens: 5,
              costUSD: 0.75,
            },
          },
          tokenUsage: { input: 10, output: 5 },
          tokenUsageProvenance: 'provider-reported',
        }
      );

      const persisted = update.mock.calls[0][1] as Record<string, unknown>;
      expect(persisted).not.toHaveProperty(`modelUsage.${model}.costUSD`);
      expect(persisted.modelUsage).toEqual({
        [model]: {
          inputTokens: 10,
          outputTokens: 5,
          costUSD: 0.75,
        },
      });
      expect(persisted).toMatchObject({
        model,
        tokenUsage: { input: 10, output: 5 },
        costUsd: 0.75,
        costState: 'estimated',
      });
      expect(syncAgentRunToNeo4j).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'run-literal-model',
          userId: TEST_USER_ID,
          costUsd: 0.75,
          costState: 'estimated',
        })
      );
    });

    it('awaits the terminal graph projection before reporting the accounting patch complete', async () => {
      const raw = {
        userId: TEST_USER_ID,
        kind: 'chat',
        provider: 'gemini',
        agentName: 'chat',
        action: 'Assistant chat turn',
        status: 'success',
        tokenUsage: { input: 0, output: 0 },
        costUnavailableReason: 'accounting-incomplete',
        duration: 100,
        createdAt: '2026-07-23T10:00:00.000Z',
      };
      const ref = { path: 'agentRuns/run-await-graph' };
      (db.collection as jest.Mock).mockReturnValue({ doc: jest.fn().mockReturnValue(ref) });
      (db.runTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          get: jest.fn().mockResolvedValue({ exists: true, data: () => raw }),
          update: jest.fn(),
        })
      );
      let releaseGraph!: () => void;
      (syncAgentRunToNeo4j as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseGraph = resolve;
          })
      );

      let completed = false;
      const pending = patchAgentRunAccounting(
        'run-await-graph',
        { costUsd: 0 },
        {
          model: 'gemini-3-flash-preview',
          modelUsage: {
            'gemini-3-flash-preview': { inputTokens: 0, outputTokens: 0, costUSD: 0 },
          },
          tokenUsage: { input: 0, output: 0 },
          tokenUsageProvenance: 'provider-reported',
        }
      ).then(() => {
        completed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(syncAgentRunToNeo4j).toHaveBeenCalledTimes(1);
      expect(completed).toBe(false);
      releaseGraph();
      await pending;
      expect(completed).toBe(true);
    });

    it('clears an unproven served-model breakdown instead of preserving requested-model facts', async () => {
      const raw = {
        userId: TEST_USER_ID,
        kind: 'chat',
        provider: 'claude',
        agentName: 'chat',
        action: 'Assistant chat turn',
        status: 'failure',
        model: 'requested-model',
        modelUsage: { 'requested-model': { inputTokens: 7, outputTokens: 3 } },
        tokenUsage: { input: 7, output: 3 },
        costUnavailableReason: 'accounting-incomplete',
        duration: 100,
        createdAt: '2026-07-23T10:00:00.000Z',
      };
      const ref = { path: 'agentRuns/run-unreported-model' };
      const update = jest.fn();
      (db.collection as jest.Mock).mockReturnValue({ doc: jest.fn().mockReturnValue(ref) });
      (db.runTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn({
          get: jest.fn().mockResolvedValue({ exists: true, data: () => raw }),
          update,
        })
      );

      await patchAgentRunAccounting(
        'run-unreported-model',
        { costUsd: null, costUnavailableReason: 'unknown-pricing' },
        { modelUsage: {}, tokenUsage: { input: 0, output: 0 }, tokenUsageProvenance: 'unreported' }
      );

      const persisted = update.mock.calls[0][1] as Record<string, unknown>;
      expect(persisted.modelUsage).toEqual({});
      expect(persisted.tokenUsage).toEqual({ input: 0, output: 0 });
      expect(persisted.costUnavailableReason).toBe('unknown-pricing');
    });
  });

  describe('normalizeAgentRunForRead cost authority', () => {
    it('fails an explicit malformed future costState closed instead of relabelling it settled', () => {
      const normalized = normalizeAgentRunForRead({
        ...storedRun,
        costUsd: 4.25,
        costState: 'provider-final-v3',
      });

      expect(normalized.costUsd).toBeUndefined();
      expect(normalized.costState).toBeUndefined();
      expect(normalized.costUnavailableReason).toBe('accounting-incomplete');
    });

    it('preserves the historical interpretation of a numeric cost with no costState', () => {
      const normalized = normalizeAgentRunForRead({
        ...storedRun,
        costUsd: 4.25,
      });

      expect(normalized.costUsd).toBe(4.25);
      expect(normalized.costState).toBeUndefined();
      expect(normalized.costUnavailableReason).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // listAgentRuns
  // --------------------------------------------------------------------------

  describe('listAgentRuns', () => {
    it('filters on the server-authorized principal union (uid + system principals, nothing else)', async () => {
      const { mockWhere } = mockQueryOps();

      await listAgentRuns(TEST_USER_ID);

      expect(mockWhere).toHaveBeenCalledWith('userId', 'in', [
        TEST_USER_ID,
        'system',
        'system-sweep',
        'system-discovery',
      ]);
    });

    it('should order by createdAt descending', async () => {
      const { mockOrderBy } = mockQueryOps();

      await listAgentRuns(TEST_USER_ID);

      expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should limit results to 100', async () => {
      const { mockLimit } = mockQueryOps();

      await listAgentRuns(TEST_USER_ID);

      expect(mockLimit).toHaveBeenCalledWith(100);
    });

    it('should return an empty array when no runs exist', async () => {
      mockQueryOps();

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result).toEqual([]);
    });

    it('should return runs mapped from doc.data()', async () => {
      const run1: AgentRun = {
        ...storedRun,
        id: 'run-1',
        createdAt: '2026-02-23T12:00:00.000Z',
      };
      const run2: AgentRun = {
        ...storedRun,
        id: 'run-2',
        createdAt: '2026-02-23T10:00:00.000Z',
      };

      mockQueryOps({
        get: jest.fn().mockResolvedValue({
          docs: [{ data: () => run1 }, { data: () => run2 }],
        }),
      });

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ ...run1, kind: 'sweep' });
      expect(result[1]).toEqual({ ...run2, kind: 'sweep' });
    });

    it('safely infers a legacy Claude chat and strips private tool payloads on read', async () => {
      const legacy = {
        ...storedRun,
        id: 'run-chat-legacy',
        agentName: 'chat',
        sweepId: undefined,
        model: `claude-opus-4-8${'x'.repeat(250)}`,
        toolSummary: [
          {
            name: 'searchEntities',
            status: 'success',
            durationMs: 12,
            args: { confirmationPhrase: 'CONFIRM SPEND $50 secret' },
            result: { documentContent: 'private document' },
          },
        ],
      };
      mockQueryOps({
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => legacy }] }),
      });

      const [result] = await listAgentRuns(TEST_USER_ID);

      expect(result.kind).toBe('chat');
      expect(result.provider).toBe('claude');
      expect(result.model).toHaveLength(200);
      expect(result.toolSummary).toEqual([{ name: 'searchEntities', status: 'success', durationMs: 12 }]);
      expect(JSON.stringify(result)).not.toContain('CONFIRM SPEND');
      expect(JSON.stringify(result)).not.toContain('private document');
    });

    it('preserves existing mission and sweep inference without assigning chat providers', async () => {
      const mission = {
        ...storedRun,
        id: 'run-mission',
        sweepId: undefined,
        missionId: 'mission-1',
        model: 'claude-opus-4-8',
      };
      const sweep = { ...storedRun, id: 'run-sweep', sweepId: 'sweep-1', model: 'gemini-3.5-pro' };
      mockQueryOps({
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => mission }, { data: () => sweep }] }),
      });

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result.map((run) => ({ id: run.id, kind: run.kind, provider: run.provider }))).toEqual([
        { id: 'run-mission', kind: 'mission', provider: undefined },
        { id: 'run-sweep', kind: 'sweep', provider: undefined },
      ]);
    });

    it('should propagate Firestore errors', async () => {
      mockQueryOps({
        get: jest.fn().mockRejectedValue(new Error('Firestore query failed')),
      });

      await expect(listAgentRuns(TEST_USER_ID)).rejects.toThrow('Firestore query failed');
    });
  });

  // --------------------------------------------------------------------------
  // ARUN-021 — bounded, kind-aware listing. Chat is persisted symmetrically,
  // so a wall of chat turns could occupy the entire global newest-N window and
  // crowd every older mission/sweep out of the Runs page. The list therefore
  // unions the global window with a bounded per-kind floor query per known
  // kind. Every query carries a limit — never an unbounded collection read.
  // --------------------------------------------------------------------------

  describe('listAgentRuns — ARUN-021 kind-aware bounded querying', () => {
    /** Filter-aware chain mock: each query accumulates its own where/limit
     * state, and get() serves docs from `global` or `byKind` based on the
     * query's own `kind ==` filter — so the union/dedup logic is exercised
     * against genuinely different windows per query. */
    function mockKindAwareRouter(config: {
      global: unknown[];
      byKind?: Record<string, unknown[]>;
      failKinds?: string[];
    }) {
      const executed: Array<{ filters: Array<[string, string, unknown]>; limit?: number }> = [];
      const makeChain = (filters: Array<[string, string, unknown]>, limit?: number) => {
        const chain: Record<string, jest.Mock> = {};
        chain.where = jest.fn((f: string, op: string, v: unknown) => makeChain([...filters, [f, op, v]], limit));
        chain.orderBy = jest.fn(() => chain);
        chain.limit = jest.fn((n: number) => makeChain(filters, n));
        chain.doc = jest.fn();
        chain.get = jest.fn(async () => {
          executed.push({ filters, limit });
          const kindFilter = filters.find(([f, op]) => f === 'kind' && op === '==');
          if (kindFilter && config.failKinds?.includes(kindFilter[2] as string)) {
            throw new Error(`floor unavailable: ${String(kindFilter[2])}`);
          }
          const docs = kindFilter ? (config.byKind?.[kindFilter[2] as string] ?? []) : config.global;
          const limited = limit !== undefined ? docs.slice(0, limit) : docs;
          return { docs: limited.map((d) => ({ data: () => d })) };
        });
        return chain;
      };
      (db.collection as jest.Mock).mockImplementation(() => makeChain([]));
      return { executed };
    }

    const chatRun = (i: number) => ({
      ...storedRun,
      id: `run-chat-${i}`,
      agentName: 'chat',
      kind: 'chat',
      sweepId: undefined,
      createdAt: `2026-07-15T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
    });

    it('issues a bounded per-kind floor query for every known kind alongside the global window', async () => {
      const { executed } = mockKindAwareRouter({ global: [] });

      await listAgentRuns(TEST_USER_ID);

      const kindQueries = executed
        .map((q) => q.filters.find(([f, op]) => f === 'kind' && op === '==')?.[2])
        .filter(Boolean)
        .sort();
      expect(kindQueries).toEqual(['chat', 'mission', 'sweep']);
      // Every executed query is bounded — never an unbounded collection read.
      for (const q of executed) {
        expect(q.limit).toBeGreaterThan(0);
      }
      // And every query stays inside the server-authorized principal union.
      for (const q of executed) {
        expect(q.filters).toEqual(
          expect.arrayContaining([['userId', 'in', [TEST_USER_ID, 'system', 'system-sweep', 'system-discovery']]])
        );
      }
    });

    it('chat volume cannot crowd missions/sweeps out: kind floors surface runs older than the global window', async () => {
      const wallOfChat = Array.from({ length: 100 }, (_, i) => chatRun(i));
      const olderMission = {
        ...storedRun,
        id: 'run-old-mission',
        sweepId: undefined,
        missionId: 'mission-old',
        kind: 'mission',
        createdAt: '2026-07-01T08:00:00.000Z',
      };
      const olderSweep = {
        ...storedRun,
        id: 'run-old-sweep',
        sweepId: 'sweep-old',
        kind: 'sweep',
        createdAt: '2026-07-02T08:00:00.000Z',
      };
      const { executed } = mockKindAwareRouter({
        global: wallOfChat,
        byKind: { mission: [olderMission], sweep: [olderSweep], chat: wallOfChat.slice(0, 50) },
      });

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result.map((r) => r.id)).toContain('run-old-mission');
      expect(result.map((r) => r.id)).toContain('run-old-sweep');
      // Stable ordering: newest first across the merged union.
      const times = result.map((r) => new Date(r.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(executed.length).toBeGreaterThanOrEqual(4);
    });

    it('degrades gracefully when a kind-floor query fails (e.g. index not yet deployed): the global window still serves', async () => {
      const missionRun = {
        ...storedRun,
        id: 'run-global-survivor',
        sweepId: undefined,
        missionId: 'mission-x',
        kind: 'mission',
        createdAt: '2026-07-15T10:00:00.000Z',
      };
      // Filter-aware chain where every kind-filtered query rejects (the shape
      // of a FAILED_PRECONDITION on an undeployed composite index).
      const makeChain = (filters: Array<[string, string, unknown]>) => {
        const chain: Record<string, jest.Mock> = {};
        chain.where = jest.fn((f: string, op: string, v: unknown) => makeChain([...filters, [f, op, v]]));
        chain.orderBy = jest.fn(() => chain);
        chain.limit = jest.fn(() => chain);
        chain.doc = jest.fn();
        chain.get = jest.fn(async () => {
          if (filters.some(([f, op]) => f === 'kind' && op === '==')) {
            throw new Error('FAILED_PRECONDITION: The query requires an index.');
          }
          return { docs: [{ data: () => missionRun }] };
        });
        return chain;
      };
      (db.collection as jest.Mock).mockImplementation(() => makeChain([]));

      const result = await listAgentRunsWithDiagnostics(TEST_USER_ID);

      expect(result.runs.map((r) => r.id)).toEqual(['run-global-survivor']);
      expect(result.degradedKinds).toEqual(['chat', 'mission', 'sweep']);
    });

    it('reports only the failed kind while retaining successful floors', async () => {
      const mission = { ...storedRun, id: 'run-mission-floor', kind: 'mission', missionId: 'm-floor' };
      const sweep = { ...storedRun, id: 'run-sweep-floor', kind: 'sweep', sweepId: 's-floor' };
      mockKindAwareRouter({
        global: [],
        byKind: { mission: [mission], sweep: [sweep] },
        failKinds: ['chat'],
      });

      const result = await listAgentRunsWithDiagnostics(TEST_USER_ID);

      expect(result.degradedKinds).toEqual(['chat']);
      expect(result.runs.map((run) => run.id)).toEqual(
        expect.arrayContaining(['run-mission-floor', 'run-sweep-floor'])
      );
    });

    it('kindFloors: false issues ONLY the single global window query (cheap recency-only callers)', async () => {
      const { executed } = mockKindAwareRouter({ global: [] });

      await listAgentRuns(TEST_USER_ID, { kindFloors: false });

      expect(executed).toHaveLength(1);
      expect(executed[0].filters.some(([f]) => f === 'kind')).toBe(false);
    });

    it('keys the dedup on the document id when a legacy doc carries no id field (rows must not collapse)', async () => {
      const noId = (createdAt: string) => ({
        ...storedRun,
        id: undefined,
        sweepId: undefined,
        missionId: 'mission-legacy',
        createdAt,
      });
      const docs = [noId('2026-07-15T10:00:00.000Z'), noId('2026-07-14T10:00:00.000Z')];
      let n = 0;
      const makeChain = (): Record<string, jest.Mock> => {
        const chain: Record<string, jest.Mock> = {};
        chain.where = jest.fn(() => chain);
        chain.orderBy = jest.fn(() => chain);
        chain.limit = jest.fn(() => chain);
        chain.doc = jest.fn();
        chain.get = jest.fn(async () => ({
          docs: n++ === 0 ? docs.map((d, i) => ({ id: `doc-${i}`, data: () => d })) : [],
        }));
        return chain;
      };
      (db.collection as jest.Mock).mockImplementation(() => makeChain());

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result).toHaveLength(2);
    });

    it('dedups a run present in both the global window and its kind floor', async () => {
      const missionRun = {
        ...storedRun,
        id: 'run-both-windows',
        sweepId: undefined,
        missionId: 'mission-x',
        kind: 'mission',
        createdAt: '2026-07-15T10:00:00.000Z',
      };
      mockKindAwareRouter({ global: [missionRun], byKind: { mission: [missionRun] } });

      const result = await listAgentRuns(TEST_USER_ID);

      expect(result.filter((r) => r.id === 'run-both-windows')).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // getTokenUsageSummary
  // --------------------------------------------------------------------------

  describe('getTokenUsageSummary', () => {
    it('should query runs from the past 7 days', async () => {
      const { mockWhere } = mockChainedQueryOps();

      await getTokenUsageSummary(TEST_USER_ID);

      // First where: the ARUN-005 principal union — the token cards must
      // reconcile with the runs table that lists system runs below them.
      expect(mockWhere).toHaveBeenCalledWith('userId', 'in', [
        TEST_USER_ID,
        'system',
        'system-sweep',
        'system-discovery',
      ]);
      // Second where: filter by createdAt >= weekAgo
      expect(mockWhere).toHaveBeenCalledWith('createdAt', '>=', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    });

    it('should order by createdAt descending', async () => {
      const { mockOrderBy } = mockChainedQueryOps();

      await getTokenUsageSummary(TEST_USER_ID);

      expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should return zero totals when no runs exist', async () => {
      mockChainedQueryOps();

      const result = await getTokenUsageSummary(TEST_USER_ID);

      expect(result.today).toEqual({
        input: 0,
        output: 0,
        total: 0,
        costUsd: 0,
        // ARUN-027 accounting split — all zero, and zero runs lacking cost
        // data (a genuine "nothing tracked yet", not a masked gap).
        settledCostUsd: 0,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
        unsettledMaximumUsd: 0,
        maximumExposureUsd: 0,
        unavailableCostRuns: 0,
        // ARUN-020: and zero runs whose TOKEN count is unknowable.
        unavailableTokenRuns: 0,
      });
      expect(result.thisWeek).toHaveLength(7);
    });

    it('should return 7 days in thisWeek array', async () => {
      mockChainedQueryOps();

      const result = await getTokenUsageSummary(TEST_USER_ID);

      expect(result.thisWeek).toHaveLength(7);
      // Each entry should have the expected shape
      for (const day of result.thisWeek) {
        expect(day).toHaveProperty('date');
        expect(day).toHaveProperty('input');
        expect(day).toHaveProperty('output');
        expect(day).toHaveProperty('total');
        expect(day).toHaveProperty('costUsd');
        expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('should aggregate token usage by date', async () => {
      const todayStr = new Date().toISOString().split('T')[0];

      const runs: AgentRun[] = [
        {
          ...storedRun,
          id: 'run-a',
          tokenUsage: { input: 1000, output: 500 },
          costUsd: 0.005,
          createdAt: `${todayStr}T10:00:00.000Z`,
        },
        {
          ...storedRun,
          id: 'run-b',
          tokenUsage: { input: 2000, output: 800 },
          costUsd: 0.008,
          createdAt: `${todayStr}T14:00:00.000Z`,
        },
      ];

      mockChainedQueryOps({
        get: jest.fn().mockResolvedValue({
          docs: runs.map((r) => ({ data: () => r })),
        }),
      });

      const result = await getTokenUsageSummary(TEST_USER_ID);

      expect(result.today.input).toBe(3000);
      expect(result.today.output).toBe(1300);
      expect(result.today.total).toBe(4300);
      expect(result.today.costUsd).toBeCloseTo(0.013, 5);
    });

    it('should place runs on the correct day in the weekly array', async () => {
      const now = new Date();
      const yesterdayDate = new Date(now);
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

      const runs: AgentRun[] = [
        {
          ...storedRun,
          id: 'run-yesterday',
          tokenUsage: { input: 5000, output: 2000 },
          costUsd: 0.02,
          createdAt: `${yesterdayStr}T12:00:00.000Z`,
        },
      ];

      mockChainedQueryOps({
        get: jest.fn().mockResolvedValue({
          docs: runs.map((r) => ({ data: () => r })),
        }),
      });

      const result = await getTokenUsageSummary(TEST_USER_ID);

      // Yesterday should be at index 5 (second to last), today at index 6
      const yesterdayEntry = result.thisWeek.find((d) => d.date === yesterdayStr);
      expect(yesterdayEntry).toBeDefined();
      expect(yesterdayEntry!.input).toBe(5000);
      expect(yesterdayEntry!.output).toBe(2000);
      expect(yesterdayEntry!.total).toBe(7000);
      expect(yesterdayEntry!.costUsd).toBeCloseTo(0.02, 5);
    });

    it('does not expose an unenforced tokens-per-day budget', async () => {
      mockChainedQueryOps();

      const result = await getTokenUsageSummary(TEST_USER_ID);

      expect(result).not.toHaveProperty('dailyBudget');
      expect(result.today).toHaveProperty('total');
      expect(result.today).toHaveProperty('costUsd');
    });

    it('should propagate Firestore errors', async () => {
      mockChainedQueryOps({
        get: jest.fn().mockRejectedValue(new Error('Firestore aggregation failed')),
      });

      await expect(getTokenUsageSummary(TEST_USER_ID)).rejects.toThrow('Firestore aggregation failed');
    });
  });

  // ==========================================================================
  // ARUN-003 — per-model attribution
  // ==========================================================================

  describe('primaryModelFromUsage', () => {
    it('picks the model with the most OUTPUT tokens (the work model)', () => {
      expect(
        primaryModelFromUsage({
          'claude-haiku-4-5': { outputTokens: 900 },
          'claude-opus-4-8': { outputTokens: 42_000 },
        })
      ).toBe('claude-opus-4-8');
    });

    it('returns undefined for a missing or empty breakdown — callers must not invent a model', () => {
      expect(primaryModelFromUsage(undefined)).toBeUndefined();
      expect(primaryModelFromUsage({})).toBeUndefined();
    });

    // OPS-005 — the worker's precedence rule, pinned here as a pure expression so
    // a future edit cannot quietly put the REQUESTED model back in front of the
    // provider-reported one. `run-agent-mission.ts` computes exactly this.
    describe('effective served model beats the requested pin', () => {
      const effectiveModel = (
        modelUsage: Record<string, { outputTokens: number }> | undefined,
        requestedModel: string | undefined
      ) => primaryModelFromUsage(modelUsage) ?? requestedModel;

      it('records what the provider SERVED even when a different model was requested', () => {
        // The live RC.2 evidence: the Creator profile named an Opus model and the
        // run was actually served Sonnet. The receipt must say Sonnet.
        expect(effectiveModel({ 'claude-sonnet-4-6': { outputTokens: 12_000 } }, 'claude-opus-4-8')).toBe(
          'claude-sonnet-4-6'
        );
      });

      it('falls back to the requested pin ONLY when the provider reported no breakdown', () => {
        expect(effectiveModel(undefined, 'claude-opus-5')).toBe('claude-opus-5');
        expect(effectiveModel({}, 'claude-opus-5')).toBe('claude-opus-5');
      });

      it('still records no model at all when neither is known — never a fabricated default', () => {
        expect(effectiveModel(undefined, undefined)).toBeUndefined();
      });
    });
  });

  describe('getTokenUsageByAgent — newest model wins (ARUN-003)', () => {
    it("keeps the NEWEST run's model when older runs used a different one", async () => {
      const runs = [
        // Rows arrive newest→oldest (createdAt desc).
        {
          agentName: 'scout',
          model: 'claude-opus-4-8',
          tokenUsage: { input: 10, output: 10 },
          costUsd: 0.2,
          createdAt: '2026-07-12T10:00:00.000Z',
        },
        {
          agentName: 'scout',
          model: 'claude-sonnet-4-6',
          tokenUsage: { input: 10, output: 10 },
          costUsd: 0.1,
          createdAt: '2026-07-01T10:00:00.000Z',
        },
      ];
      mockChainedQueryOps({
        get: jest.fn().mockResolvedValue({ docs: runs.map((r) => ({ data: () => r })) }),
      });

      const [scout] = await getTokenUsageByAgent(TEST_USER_ID);

      // Pre-fix the unconditional overwrite made the OLDEST run win.
      expect(scout.model).toBe('claude-opus-4-8');
      expect(scout.runCount).toBe(2);
    });

    it('backfills the model from an older run only when the newest carried none', async () => {
      const runs = [
        { agentName: 'scout', tokenUsage: { input: 5, output: 5 }, costUsd: 0, createdAt: '2026-07-12T10:00:00.000Z' },
        {
          agentName: 'scout',
          model: 'claude-sonnet-4-6',
          tokenUsage: { input: 5, output: 5 },
          costUsd: 0,
          createdAt: '2026-07-01T10:00:00.000Z',
        },
      ];
      mockChainedQueryOps({
        get: jest.fn().mockResolvedValue({ docs: runs.map((r) => ({ data: () => r })) }),
      });

      const [scout] = await getTokenUsageByAgent(TEST_USER_ID);
      expect(scout.model).toBe('claude-sonnet-4-6');
    });

    it('separates settled, estimated, and unavailable run costs per agent', async () => {
      const runs = [
        {
          agentName: 'chat',
          model: 'gemini-3.1-pro-preview',
          tokenUsage: { input: 100, output: 10 },
          costUsd: 0.75,
          costState: 'estimated',
          createdAt: '2026-07-12T12:00:00.000Z',
        },
        {
          agentName: 'chat',
          tokenUsage: { input: 50, output: 5 },
          costUsd: 0.25,
          createdAt: '2026-07-12T11:00:00.000Z',
        },
        {
          agentName: 'chat',
          tokenUsage: { input: 25, output: 2 },
          costUsd: 9,
          costState: 'future-provider-actual',
          createdAt: '2026-07-12T10:00:00.000Z',
        },
      ];
      mockChainedQueryOps({
        get: jest.fn().mockResolvedValue({ docs: runs.map((r) => ({ data: () => r })) }),
      });

      const [chat] = await getTokenUsageByAgent(TEST_USER_ID);

      expect(chat).toMatchObject({
        totalCost: 1,
        settledCost: 0.25,
        estimatedCost: 0.75,
        unavailableCostRuns: 1,
        runCount: 3,
      });
    });
  });

  describe('ARUN-004: build-mission spend folds into the usage summaries', () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const settledAccounting = (costUsd: number) => ({
      settledActualUsd: costUsd,
      estimatedUsd: 0,
      activeReservedUsd: 0,
      unsettledMaximumUsd: 0,
      trackedSpendUsd: costUsd,
      maximumExposureUsd: costUsd,
      unavailableSessionCount: 0,
      invalidSessionIndexes: [],
      observedAt: `${todayStr}T11:00:01.000Z`,
    });

    it('getTokenUsageSummary adds build cost + tokens to the daily totals (and ignores non-build missions)', async () => {
      mockCollectionRouter({
        agentRuns: [
          {
            ...storedRun,
            id: 'run-a',
            tokenUsage: { input: 1000, output: 500 },
            costUsd: 0.005,
            createdAt: `${todayStr}T10:00:00.000Z`,
          },
        ],
        missions: [
          {
            id: 'm-build',
            kind: 'build',
            agent: 'builder',
            tokenUsage: { input: 4000, output: 1500 },
            costUsd: 0.9,
            buildCostAccounting: settledAccounting(0.9),
            createdAt: `${todayStr}T11:00:00.000Z`,
          },
          // a NON-build mission is counted via its own agentRuns doc, so it must
          // NOT also be summed here (that would double-count).
          {
            id: 'm-research',
            kind: 'research',
            tokenUsage: { input: 9999, output: 9999 },
            costUsd: 9,
            createdAt: `${todayStr}T11:30:00.000Z`,
          },
        ],
      });

      const result = await getTokenUsageSummary(TEST_USER_ID);

      expect(result.today.input).toBe(5000); // 1000 agentRun + 4000 build
      expect(result.today.output).toBe(2000); // 500 + 1500
      expect(result.today.total).toBe(7000);
      expect(result.today.costUsd).toBeCloseTo(0.905, 5); // 0.005 + 0.9, research excluded
    });

    it('getTokenUsageByAgent attributes build spend to the builder row', async () => {
      mockCollectionRouter({
        agentRuns: [],
        missions: [
          {
            id: 'm-build',
            kind: 'build',
            agent: 'builder',
            tokenUsage: { input: 3000, output: 1000 },
            costUsd: 0.6,
            buildCostAccounting: settledAccounting(0.6),
            createdAt: `${todayStr}T09:00:00.000Z`,
          },
        ],
      });

      const result = await getTokenUsageByAgent(TEST_USER_ID);
      const builder = result.find((r) => r.agentName === 'builder');
      expect(builder).toBeDefined();
      expect(builder!.totalInput).toBe(3000);
      expect(builder!.totalOutput).toBe(1000);
      expect(builder!.totalTokens).toBe(4000);
      expect(builder!.totalCost).toBeCloseTo(0.6, 5);
      expect(builder!.runCount).toBe(1);
    });

    it('a build mission with no recorded tokenUsage contributes cost but zero tokens', async () => {
      mockCollectionRouter({
        agentRuns: [],
        missions: [
          {
            id: 'm-build',
            kind: 'build',
            agent: 'builder',
            costUsd: 0.4,
            buildCostAccounting: settledAccounting(0.4),
            createdAt: `${todayStr}T09:00:00.000Z`,
          },
        ],
      });

      const summary = await getTokenUsageSummary(TEST_USER_ID);
      expect(summary.today.total).toBe(0);
      expect(summary.today.costUsd).toBeCloseTo(0.4, 5);
    });
  });

  // ==========================================================================
  // ARUN-020 — the daily totals read the same authoritative mission usage
  // snapshot as the runs list/detail, and a build's running→completed
  // transition never double counts: the totals are a pure function of the
  // CURRENT doc state, and builds are only ever summed from `missions`.
  // ==========================================================================

  describe('ARUN-020: in-flight build usage in the daily totals', () => {
    const todayStr = new Date().toISOString().split('T')[0];

    const runningBuild = {
      id: 'm-build-live',
      kind: 'build',
      status: 'running',
      agent: 'builder',
      // In-flight: cost is durably charged at session reservation, tokens not
      // yet finalized — exactly the doc shape mid-first-session.
      costUsd: 6.5,
      buildCostAccounting: {
        settledActualUsd: 0,
        estimatedUsd: 0,
        activeReservedUsd: 6.5,
        unsettledMaximumUsd: 0,
        trackedSpendUsd: 0,
        maximumExposureUsd: 6.5,
        unavailableSessionCount: 0,
        invalidSessionIndexes: [],
        observedAt: `${todayStr}T09:00:01.000Z`,
      },
      createdAt: `${todayStr}T09:00:00.000Z`,
    };

    it('counts a RUNNING build reservation once without labeling authority as spend', async () => {
      mockCollectionRouter({ agentRuns: [], missions: [runningBuild] });

      const summary = await getTokenUsageSummary(TEST_USER_ID);
      expect(summary.today.costUsd).toBe(0);
      expect(summary.today.reservedCostUsd).toBeCloseTo(6.5, 5);
      expect(summary.today.maximumExposureUsd).toBeCloseTo(6.5, 5);
      expect(summary.today.total).toBe(0);
      expect(Number.isFinite(summary.today.costUsd)).toBe(true);
    });

    it('completion handoff replaces (never adds to) the running contribution — one doc, one count', async () => {
      const completedBuild = {
        ...runningBuild,
        status: 'completed',
        completedAt: `${todayStr}T10:00:00.000Z`,
        costUsd: 9.25,
        buildCostAccounting: {
          settledActualUsd: 9.25,
          estimatedUsd: 0,
          activeReservedUsd: 0,
          unsettledMaximumUsd: 0,
          trackedSpendUsd: 9.25,
          maximumExposureUsd: 9.25,
          unavailableSessionCount: 0,
          invalidSessionIndexes: [],
          observedAt: `${todayStr}T10:00:00.000Z`,
        },
        tokenUsage: { input: 90_000, output: 30_000 },
      };
      // Same mission id, now terminal — the ledger updated the SAME doc, so
      // the day bucket must show only the final numbers, not running+final.
      mockCollectionRouter({ agentRuns: [], missions: [completedBuild] });

      const summary = await getTokenUsageSummary(TEST_USER_ID);
      expect(summary.today.costUsd).toBeCloseTo(9.25, 5);
      expect(summary.today.input).toBe(90_000);
      expect(summary.today.output).toBe(30_000);

      const byAgent = await getTokenUsageByAgent(TEST_USER_ID);
      const builder = byAgent.find((r) => r.agentName === 'builder');
      expect(builder!.runCount).toBe(1);
      expect(builder!.totalTokens).toBe(120_000);
    });

    it('does not let a legacy row with absent or malformed usage crash or poison aggregates', async () => {
      const legacyRun = {
        ...storedRun,
        id: 'legacy-without-usage',
        agentName: 'legacy-agent',
        createdAt: `${todayStr}T08:00:00.000Z`,
        tokenUsage: undefined,
        costUsd: Number.NaN,
      };
      mockCollectionRouter({ agentRuns: [legacyRun], missions: [] });

      const summary = await getTokenUsageSummary(TEST_USER_ID);
      const byAgent = await getTokenUsageByAgent(TEST_USER_ID);

      expect(summary.today).toMatchObject({ input: 0, output: 0, total: 0, costUsd: 0 });
      expect(byAgent).toEqual([
        expect.objectContaining({ agentName: 'legacy-agent', totalTokens: 0, totalCost: 0, runCount: 1 }),
      ]);
    });
  });
});

// ============================================================================
// ARUN-027 — accounting-scope split on the usage summary
// ============================================================================

describe('getTokenUsageSummary accounting scope (ARUN-027)', () => {
  const today = new Date().toISOString().split('T')[0];
  const at = (time: string) => `${today}T${time}`;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('separates settled agent-run cost from unavailable rows — a missing cost is never summed as 0', async () => {
    mockCollectionRouter({
      agentRuns: [
        { userId: TEST_USER_ID, createdAt: at('09:00:00.000Z'), tokenUsage: { input: 100, output: 50 }, costUsd: 0.25 },
        // Legacy row: no costUsd at all. Counting it as $0 would understate
        // spend while looking like a precise measurement.
        { userId: TEST_USER_ID, createdAt: at('10:00:00.000Z'), tokenUsage: { input: 200, output: 60 } },
      ],
      missions: [],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.settledCostUsd).toBeCloseTo(0.25);
    expect(summary.today.unavailableCostRuns).toBe(1);
    expect(summary.today.reservedCostUsd).toBe(0);
  });

  it('a genuinely recorded zero cost is settled, not unavailable', async () => {
    mockCollectionRouter({
      agentRuns: [
        { userId: TEST_USER_ID, createdAt: at('09:00:00.000Z'), tokenUsage: { input: 10, output: 5 }, costUsd: 0 },
      ],
      missions: [],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.settledCostUsd).toBe(0);
    expect(summary.today.unavailableCostRuns).toBe(0);
  });

  it('classifies canonical chat receipt totals as estimated rather than settled', async () => {
    mockCollectionRouter({
      agentRuns: [
        {
          userId: TEST_USER_ID,
          createdAt: at('09:00:00.000Z'),
          tokenUsage: { input: 10, output: 5 },
          costUsd: 0.75,
          costState: 'estimated',
        },
      ],
      missions: [],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.costUsd).toBeCloseTo(0.75);
    expect(summary.today.estimatedCostUsd).toBeCloseTo(0.75);
    expect(summary.today.settledCostUsd).toBe(0);
    expect(summary.today.maximumExposureUsd).toBeCloseTo(0.75);
  });

  it('fails an explicit malformed costState closed while preserving absent legacy state as settled', async () => {
    mockCollectionRouter({
      agentRuns: [
        {
          userId: TEST_USER_ID,
          createdAt: at('09:00:00.000Z'),
          tokenUsage: { input: 10, output: 5 },
          costUsd: 4,
          costState: 'provider-final-v3',
        },
        {
          userId: TEST_USER_ID,
          createdAt: at('10:00:00.000Z'),
          tokenUsage: { input: 20, output: 6 },
          costUsd: 0.5,
        },
      ],
      missions: [],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.costUsd).toBeCloseTo(0.5);
    expect(summary.today.settledCostUsd).toBeCloseTo(0.5);
    expect(summary.today.estimatedCostUsd).toBe(0);
    expect(summary.today.unavailableCostRuns).toBe(1);
  });

  it('classifies in-flight build spend as reserved, not settled', async () => {
    mockCollectionRouter({
      agentRuns: [],
      missions: [
        {
          userId: TEST_USER_ID,
          kind: 'build',
          status: 'running',
          createdAt: at('11:00:00.000Z'),
          tokenUsage: { input: 900, output: 300 },
          costUsd: 4.5,
          buildCostAccounting: {
            settledActualUsd: 0,
            estimatedUsd: 0,
            activeReservedUsd: 4.5,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 0,
            maximumExposureUsd: 4.5,
            unavailableSessionCount: 0,
            invalidSessionIndexes: [],
            observedAt: at('11:00:01.000Z'),
          },
        },
      ],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.reservedCostUsd).toBeCloseTo(4.5);
    expect(summary.today.settledCostUsd).toBe(0);
    // The legacy total stays the full tracked estimate so existing readers
    // keep reconciling with the runs table.
    expect(summary.today.costUsd).toBe(0);
    expect(summary.today.maximumExposureUsd).toBeCloseTo(4.5);
  });

  it('classifies a completed build as settled', async () => {
    mockCollectionRouter({
      agentRuns: [],
      missions: [
        {
          userId: TEST_USER_ID,
          kind: 'build',
          status: 'completed',
          createdAt: at('11:00:00.000Z'),
          tokenUsage: { input: 900, output: 300 },
          costUsd: 4.5,
          buildCostAccounting: {
            settledActualUsd: 4.5,
            estimatedUsd: 0,
            activeReservedUsd: 0,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 4.5,
            maximumExposureUsd: 4.5,
            unavailableSessionCount: 0,
            invalidSessionIndexes: [],
            observedAt: at('11:30:00.000Z'),
          },
        },
      ],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.settledCostUsd).toBeCloseTo(4.5);
    expect(summary.today.reservedCostUsd).toBe(0);
  });

  it('counts a build with no recorded cost as unavailable regardless of status', async () => {
    mockCollectionRouter({
      agentRuns: [],
      missions: [
        {
          userId: TEST_USER_ID,
          kind: 'build',
          status: 'failed',
          createdAt: at('11:00:00.000Z'),
          tokenUsage: { input: 100, output: 10 },
        },
      ],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.unavailableCostRuns).toBe(1);
    expect(summary.today.settledCostUsd).toBe(0);
    expect(summary.today.reservedCostUsd).toBe(0);
  });

  it('mixes settled, reserved and unavailable in one day and keeps the tracked total equal to settled + reserved', async () => {
    mockCollectionRouter({
      agentRuns: [
        { userId: TEST_USER_ID, createdAt: at('09:00:00.000Z'), tokenUsage: { input: 100, output: 50 }, costUsd: 1.25 },
        { userId: TEST_USER_ID, createdAt: at('09:30:00.000Z'), tokenUsage: { input: 100, output: 50 } },
      ],
      missions: [
        {
          userId: TEST_USER_ID,
          kind: 'build',
          status: 'running',
          createdAt: at('11:00:00.000Z'),
          tokenUsage: { input: 900, output: 300 },
          costUsd: 3.0,
          buildCostAccounting: {
            settledActualUsd: 0,
            estimatedUsd: 0,
            activeReservedUsd: 3,
            unsettledMaximumUsd: 0,
            trackedSpendUsd: 0,
            maximumExposureUsd: 3,
            unavailableSessionCount: 0,
            invalidSessionIndexes: [],
            observedAt: at('11:00:01.000Z'),
          },
        },
      ],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.today.settledCostUsd).toBeCloseTo(1.25);
    expect(summary.today.reservedCostUsd).toBeCloseTo(3.0);
    expect(summary.today.unavailableCostRuns).toBe(1);
    expect(summary.today.costUsd).toBeCloseTo(1.25);
    expect(summary.today.maximumExposureUsd).toBeCloseTo(4.25);
  });

  it('carries the same split through every day of the weekly series', async () => {
    mockCollectionRouter({ agentRuns: [], missions: [] });

    const summary = await getTokenUsageSummary(TEST_USER_ID);

    expect(summary.thisWeek).toHaveLength(7);
    for (const day of summary.thisWeek) {
      expect(day.settledCostUsd).toBe(0);
      expect(day.estimatedCostUsd).toBe(0);
      expect(day.reservedCostUsd).toBe(0);
      expect(day.unsettledMaximumUsd).toBe(0);
      expect(day.maximumExposureUsd).toBe(0);
      expect(day.unavailableCostRuns).toBe(0);
    }
  });

  it('aggregates actual, estimated, active, and unsettled build buckets without conflation', async () => {
    mockCollectionRouter({
      agentRuns: [],
      missions: [
        {
          userId: TEST_USER_ID,
          kind: 'build',
          status: 'failed',
          createdAt: at('12:00:00.000Z'),
          buildCostAccounting: {
            settledActualUsd: 2,
            estimatedUsd: 1,
            activeReservedUsd: 3,
            unsettledMaximumUsd: 4,
            trackedSpendUsd: 3,
            maximumExposureUsd: 10,
            unavailableSessionCount: 1,
            invalidSessionIndexes: [],
            observedAt: at('12:10:00.000Z'),
          },
        },
      ],
    });

    const summary = await getTokenUsageSummary(TEST_USER_ID);
    expect(summary.today).toMatchObject({
      costUsd: 3,
      settledCostUsd: 2,
      estimatedCostUsd: 1,
      reservedCostUsd: 3,
      unsettledMaximumUsd: 4,
      maximumExposureUsd: 10,
      unavailableCostRuns: 1,
    });
  });
});
