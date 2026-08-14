/**
 * @file session-memory.test.ts
 * @description Unit tests for the Neo4j session memory service.
 *
 * Tests cover:
 * - Session creation
 * - Active session retrieval and creation
 * - Entity view tracking
 * - Explored entity queries
 * - Session history queries
 */

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

// Stub ensure-edges so it doesn't invoke extra runWriteTransaction calls
jest.mock('@/lib/graph/ensure-edges', () => ({
  __esModule: true,
  ensureEdgesForNode: jest.fn(() => Promise.resolve({ edgesCreated: 0 })),
  getEdgeRulesForType: jest.fn(() => []),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock crypto.randomUUID for deterministic IDs
const MOCK_UUID = 'mock-session-uuid-1234';
const originalCrypto = global.crypto;
beforeAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: {
      ...originalCrypto,
      randomUUID: jest.fn(() => MOCK_UUID),
    },
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(global, 'crypto', {
    value: originalCrypto,
    writable: true,
    configurable: true,
  });
});

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import * as neo4jClient from '../neo4j-client';
import {
  createSession,
  getOrCreateActiveSession,
  trackEntityView,
  getExploredEntities,
  getExploredEntityTags,
  recordExploration,
  getActiveUserIds,
} from '../session-memory';

const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// ============================================================================
// HELPERS
// ============================================================================

function createMockQueryResult<T>(
  records: T[],
  counterOverrides: Partial<{ relationshipsCreated: number; propertiesSet: number }> = {}
) {
  return {
    records,
    summary: {
      counters: {
        nodesCreated: 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
        ...counterOverrides,
      },
      queryType: 'rw',
      resultAvailableAfter: 1,
      resultConsumedAfter: 0,
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('session-memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  describe('createSession', () => {
    it('creates a Session node with correct properties', async () => {
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: MOCK_UUID,
            userId: 'user-abc',
            startedAt: '2026-02-23T10:00:00.000Z',
          },
        ])
      );

      const session = await createSession('user-abc');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('CREATE (s:Session');
      expect(cypher).toContain('RETURN s.id AS id');
      expect(params.id).toBe(MOCK_UUID);
      expect(params.userId).toBe('user-abc');
      expect(params.startedAt).toBeDefined();

      expect(session).toEqual({
        id: MOCK_UUID,
        userId: 'user-abc',
        startedAt: '2026-02-23T10:00:00.000Z',
      });
    });

    it('throws and logs error when write transaction fails', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Neo4j down'));

      await expect(createSession('user-abc')).rejects.toThrow('Neo4j down');
    });
  });

  // --------------------------------------------------------------------------
  // getOrCreateActiveSession
  // --------------------------------------------------------------------------

  describe('getOrCreateActiveSession', () => {
    it('returns existing session when a recent session exists', async () => {
      const recentSession = {
        id: 'existing-session-id',
        userId: 'user-abc',
        startedAt: new Date().toISOString(),
      };

      mockedReadTransaction.mockResolvedValue(createMockQueryResult([recentSession]));

      const session = await getOrCreateActiveSession('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('MATCH (s:Session { userId: $userId })');
      expect(cypher).toContain('s.startedAt > $cutoff');
      expect(params.userId).toBe('user-abc');
      expect(params.cutoff).toBeDefined();

      expect(session).toEqual({
        id: 'existing-session-id',
        userId: 'user-abc',
        startedAt: recentSession.startedAt,
      });

      // Should NOT have called write transaction (no new session)
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('creates new session when no recent session exists', async () => {
      // First call: no matching sessions
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      // Second call: createSession write
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: MOCK_UUID,
            userId: 'user-abc',
            startedAt: '2026-02-23T10:00:00.000Z',
          },
        ])
      );

      const session = await getOrCreateActiveSession('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);

      expect(session.id).toBe(MOCK_UUID);
      expect(session.userId).toBe('user-abc');
    });

    it('uses custom maxAgeMs for session cutoff', async () => {
      const customMaxAge = 60 * 1000; // 1 minute
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));
      mockedWriteTransaction.mockResolvedValue(
        createMockQueryResult([
          {
            id: MOCK_UUID,
            userId: 'user-abc',
            startedAt: new Date().toISOString(),
          },
        ])
      );

      await getOrCreateActiveSession('user-abc', customMaxAge);

      const [, params] = mockedReadTransaction.mock.calls[0];
      const cutoffDate = new Date(params.cutoff as string);
      const expectedCutoff = new Date(Date.now() - customMaxAge);
      // Allow 2 second tolerance for test execution time
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(2000);
    });

    it('throws and logs error when read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Connection lost'));

      await expect(getOrCreateActiveSession('user-abc')).rejects.toThrow('Connection lost');
    });
  });

  // --------------------------------------------------------------------------
  // trackEntityView
  // --------------------------------------------------------------------------

  describe('trackEntityView', () => {
    it('creates EXPLORED edge with correct Cypher (labeled :Entity MATCH — no AllNodesScan)', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([], { relationshipsCreated: 1 }));

      await trackEntityView('session-1', 'tech-42', 'technology');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (s:Session { id: $sessionId })');
      // M16(a): the entity MATCH must carry the :Entity label — an unlabeled
      // `(e { id: $entityId })` is an AllNodesScan on the hottest write path.
      expect(cypher).toContain('MATCH (e:Entity { id: $entityId })');
      expect(cypher).toContain('MERGE (s)-[r:EXPLORED]->(e)');
      expect(cypher).toContain('ON CREATE SET');
      expect(cypher).toContain('r.viewCount = 1');
      expect(cypher).toContain('ON MATCH SET');
      expect(cypher).toContain('r.viewCount = r.viewCount + 1');

      expect(params.sessionId).toBe('session-1');
      expect(params.entityId).toBe('tech-42');
      expect(params.entityType).toBe('technology');
      expect(params.now).toBeDefined();
    });

    it('returns tracked=true when the edge is created (first view)', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([], { relationshipsCreated: 1 }));
      await expect(trackEntityView('session-1', 'tech-42', 'technology')).resolves.toEqual({ tracked: true });
    });

    it('returns tracked=true when an existing edge is updated (repeat view)', async () => {
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([], { propertiesSet: 2 }));
      await expect(trackEntityView('session-1', 'tech-42', 'technology')).resolves.toEqual({ tracked: true });
    });

    it('M16(b): returns an honest miss (tracked=false) when the MATCH found nothing', async () => {
      // Session or entity missing in the graph → MATCH binds nothing → zero
      // counters. Previously this silently no-oped while the route logged success.
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));
      await expect(trackEntityView('session-1', 'ghost-entity', 'technology')).resolves.toEqual({ tracked: false });
    });

    it('throws and logs error when write transaction fails', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('Write failed'));

      await expect(trackEntityView('session-1', 'tech-42', 'technology')).rejects.toThrow('Write failed');
    });
  });

  // --------------------------------------------------------------------------
  // getExploredEntities
  // --------------------------------------------------------------------------

  describe('getExploredEntities', () => {
    it('returns entities with aggregated view counts', async () => {
      const mockEntities = [
        {
          entityId: 'tech-1',
          entityType: 'technology',
          name: 'TensorFlow',
          viewCount: 5,
          lastViewedAt: '2026-02-23T10:00:00.000Z',
        },
        {
          entityId: 'comp-2',
          entityType: 'company',
          name: 'Acme Corp',
          viewCount: 2,
          lastViewedAt: '2026-02-22T15:00:00.000Z',
        },
      ];

      mockedReadTransaction.mockResolvedValue(createMockQueryResult(mockEntities));

      const entities = await getExploredEntities('user-abc');

      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (s:Session { userId: $userId })-[r:EXPLORED]->(e)');
      expect(cypher).toContain('s.startedAt > $cutoff');
      expect(cypher).toContain('sum(r.viewCount) AS viewCount');
      expect(cypher).toContain('ORDER BY lastViewedAt DESC');
      expect(params.userId).toBe('user-abc');

      expect(entities).toHaveLength(2);
      expect(entities[0]).toEqual({
        entityId: 'tech-1',
        entityType: 'technology',
        name: 'TensorFlow',
        viewCount: 5,
        lastViewedAt: '2026-02-23T10:00:00.000Z',
      });
      expect(entities[1]).toEqual({
        entityId: 'comp-2',
        entityType: 'company',
        name: 'Acme Corp',
        viewCount: 2,
        lastViewedAt: '2026-02-22T15:00:00.000Z',
      });
    });

    it('uses default 7-day window when sinceMs not provided', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      await getExploredEntities('user-abc');

      const [, params] = mockedReadTransaction.mock.calls[0];
      const cutoffDate = new Date(params.cutoff as string);
      const expectedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      // Allow 2 second tolerance
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(2000);
    });

    it('uses custom sinceMs when provided', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const oneDayMs = 24 * 60 * 60 * 1000;
      await getExploredEntities('user-abc', oneDayMs);

      const [, params] = mockedReadTransaction.mock.calls[0];
      const cutoffDate = new Date(params.cutoff as string);
      const expectedCutoff = new Date(Date.now() - oneDayMs);
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(2000);
    });

    it('returns empty array when no entities found', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([]));

      const entities = await getExploredEntities('user-abc');
      expect(entities).toEqual([]);
    });

    it('throws and logs error when read transaction fails', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));

      await expect(getExploredEntities('user-abc')).rejects.toThrow('Read failed');
    });
  });

  // --------------------------------------------------------------------------
  // getExploredEntityTags (A2 — interest-from-behavior signal source)
  // --------------------------------------------------------------------------

  describe('getExploredEntityTags', () => {
    it('returns explored entities with their (string-only) tags', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          { entityId: 'e1', tags: ['AI', 'Vector DB'] },
          { entityId: 'e2', tags: ['llm', 42, null] }, // non-strings filtered out
          { entityId: 'e3', tags: null }, // missing tags → []
        ],
      });
      const out = await getExploredEntityTags('user-abc');
      expect(out).toEqual([
        { entityId: 'e1', tags: ['AI', 'Vector DB'] },
        { entityId: 'e2', tags: ['llm'] },
        { entityId: 'e3', tags: [] },
      ]);
    });

    it('throws on read failure (a silent [] would dark interest derivation)', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Read failed'));
      await expect(getExploredEntityTags('user-abc')).rejects.toThrow('Read failed');
    });
  });

  // --------------------------------------------------------------------------
  // getActiveUserIds
  // --------------------------------------------------------------------------

  describe('getActiveUserIds', () => {
    it('returns the distinct active user ids', async () => {
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([{ userId: 'u1' }, { userId: 'u2' }]));
      expect(await getActiveUserIds()).toEqual(['u1', 'u2']);
    });

    it('THROWS on a read failure — never masks an outage as "no active users"', async () => {
      // Regression guard: returning [] here made an infra failure indistinguishable
      // from a healthy empty result (the failure class that hid the empty briefing).
      mockedReadTransaction.mockRejectedValue(new Error('Neo4j unavailable'));
      await expect(getActiveUserIds()).rejects.toThrow('Neo4j unavailable');
    });
  });

  // --------------------------------------------------------------------------
  // recordExploration (Phase 0 step 0.7 — unified session writers)
  //
  // Pins the fix: recordExploration must NOT write a parallel
  // `MERGE (s:Session { userId })` with `startedAt = datetime().epochMillis`.
  // That format mismatch (number vs ISO string) made the resulting session
  // invisible to `getOrCreateActiveSession`'s `WHERE s.startedAt > $cutoff`
  // query. The fix routes through the canonical pair:
  //   getOrCreateActiveSession (ISO-string startedAt)
  //   + EXPLORED MERGE on the resolved session id.
  // --------------------------------------------------------------------------

  describe('recordExploration', () => {
    it('delegates to getOrCreateActiveSession instead of doing its own session MERGE', async () => {
      // First write call: createSession (via getOrCreateActiveSession after
      // the initial read finds no active session). Second write call: the
      // EXPLORED merge.
      mockedReadTransaction.mockResolvedValue(createMockQueryResult([])); // no active session
      mockedWriteTransaction.mockResolvedValueOnce(
        createMockQueryResult([{ id: MOCK_UUID, userId: 'user-abc', startedAt: '2026-05-13T10:00:00.000Z' }])
      );
      mockedWriteTransaction.mockResolvedValueOnce(createMockQueryResult([]));

      await recordExploration('user-abc', 'ent-1');

      // The first write is createSession's ISO-string startedAt — NOT epochMillis.
      const [createCypher, createParams] = mockedWriteTransaction.mock.calls[0];
      expect(createCypher).toContain('CREATE (s:Session');
      expect(createCypher).toContain('startedAt: $startedAt');
      expect(typeof createParams.startedAt).toBe('string');
      expect(new Date(createParams.startedAt as string).toISOString()).toBe(createParams.startedAt);

      // Regression guard: never use `datetime().epochMillis` for startedAt —
      // that's the format the old parallel path used.
      for (const [cypher] of mockedWriteTransaction.mock.calls) {
        expect(cypher).not.toContain('datetime().epochMillis');
      }
    });

    it('writes EXPLORED with viewCount + entityType derived from the entity node', async () => {
      mockedReadTransaction.mockResolvedValue(
        createMockQueryResult([{ id: 'sess-existing', userId: 'user-abc', startedAt: '2026-05-13T09:00:00.000Z' }])
      );
      mockedWriteTransaction.mockResolvedValue(createMockQueryResult([]));

      await recordExploration('user-abc', 'ent-1');

      // One write only — the EXPLORED merge, since the session already existed.
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];

      expect(cypher).toContain('MATCH (s:Session { id: $sessionId })');
      expect(cypher).toContain('MATCH (e { id: $entityId })');
      expect(cypher).toContain("coalesce(e.entityType, '') AS entityType");
      expect(cypher).toContain('MERGE (s)-[r:EXPLORED]->(e)');
      expect(cypher).toContain('r.viewCount = 1');

      expect(params.sessionId).toBe('sess-existing');
      expect(params.entityId).toBe('ent-1');
    });

    it('is best-effort — swallows errors and never throws (mission-runtime stays alive)', async () => {
      mockedReadTransaction.mockRejectedValue(new Error('Neo4j unavailable'));

      await expect(recordExploration('user-abc', 'ent-1')).resolves.toBeUndefined();
    });
  });
});
