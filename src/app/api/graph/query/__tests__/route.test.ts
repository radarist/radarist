/**
 * @file route.test.ts
 * @description Unit tests for POST /api/graph/query
 *
 * This route executes read-only Cypher queries against Neo4j with:
 * - Read-only mode validation (blocks mutations)
 * - Rate limiting (10 queries/minute)
 * - 30 second timeout
 * - Sanitized error messages
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';
import { GraphUnavailableError } from '@/lib/graph/errors';

jest.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { createLogger: () => mockLogger, __mockLogger: mockLogger };
});

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/graph', () => ({
  runRawReadQuery: jest.fn(),
  runReadTransaction: jest.fn(),
  checkHealth: jest.fn(),
}));

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    isInt: jest.fn(() => false),
    isDate: jest.fn(() => false),
    isDateTime: jest.fn(() => false),
    isLocalDateTime: jest.fn(() => false),
    isNode: jest.fn(() => false),
    isRelationship: jest.fn(() => false),
    isPath: jest.fn(() => false),
  },
}));

const { runRawReadQuery, runReadTransaction, checkHealth } = jest.requireMock('@/lib/graph');
const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const mockLogger = jest.requireMock('@/lib/logger').__mockLogger as { error: jest.Mock };

const EXPECTED_QUERY_OPTIONS = {
  transactionTimeoutMs: 30_000,
  wallTimeoutMs: 30_000,
  maxRecords: 500,
  metadata: { application: 'radarist', surface: 'graph-workbench' },
};

function createRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/graph/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// Use a unique client IP per test to avoid the in-memory rate limiter (10 req/min)
let testCounter = 0;
function uniqueHeaders(): Record<string, string> {
  return { 'x-forwarded-for': `test-client-${++testCounter}` };
}

describe('POST /api/graph/query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
    checkHealth.mockResolvedValue({ healthy: true });
    runRawReadQuery.mockResolvedValue({ records: [], truncated: false, truncationReasons: [] });
    // GRAPH-065 enrichment: default to no enrichment rows so own-prop fallback
    // captions are exercised unless a test opts into enrichment.
    runReadTransaction.mockResolvedValue({ records: [] });
  });

  // ---- Successful queries ----

  it('executes a valid read query and returns results', async () => {
    runRawReadQuery.mockResolvedValue({ records: [] });

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n LIMIT 10' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.nodes).toEqual([]);
    expect(json.relationships).toEqual([]);
    expect(json.stats).toBeDefined();
    expect(json.stats.nodeCount).toBe(0);
    expect(json.executionTimeMs).toBeDefined();
    expect(runRawReadQuery).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 10', {}, EXPECTED_QUERY_OPTIONS);
  });

  it('passes query parameters to runRawReadQuery', async () => {
    const res = await POST(
      createRequest({ query: 'MATCH (n {name: $name}) RETURN n', params: { name: 'Test' } }, uniqueHeaders())
    );

    expect(res.status).toBe(200);
    expect(runRawReadQuery).toHaveBeenCalledWith(
      'MATCH (n {name: $name}) RETURN n',
      { name: 'Test' },
      EXPECTED_QUERY_OPTIONS
    );
  });

  it('reports when the driver record limit returned a partial result', async () => {
    runRawReadQuery.mockResolvedValue({ records: [], truncated: true, truncationReasons: ['record limit'] });

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.truncated).toBe(true);
    expect(json.truncationReasons).toContain('record limit');
    expect(json.limits).toEqual(
      expect.objectContaining({ records: 500, nodes: 300, relationships: 600, responseBytes: 2 * 1024 * 1024 })
    );
  });

  // ---- Validation errors ----

  it('authenticates before parsing or executing the query', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Unauthorized' });

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));

    expect(res.status).toBe(401);
    expect(checkHealth).not.toHaveBeenCalled();
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when query is missing', async () => {
    const res = await POST(createRequest({}, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Invalid request');
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when query is not a string', async () => {
    const res = await POST(createRequest({ query: 123 }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('returns 400 when query contains only comments', async () => {
    const res = await POST(createRequest({ query: '/* only a comment */' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid query');
  });

  // ---- Write operation blocking ----

  it('returns 403 for CREATE queries', async () => {
    const res = await POST(createRequest({ query: 'CREATE (n:Test)' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Write operation blocked');
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('returns 403 for MERGE queries', async () => {
    const res = await POST(createRequest({ query: 'MERGE (n:Test {name: "x"})' }, uniqueHeaders()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for DELETE queries', async () => {
    const res = await POST(createRequest({ query: 'MATCH (n) DELETE n' }, uniqueHeaders()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for SET queries', async () => {
    const res = await POST(createRequest({ query: 'MATCH (n) SET n.name = "x"' }, uniqueHeaders()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for DETACH DELETE queries', async () => {
    const res = await POST(createRequest({ query: 'MATCH (n) DETACH DELETE n' }, uniqueHeaders()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for DROP queries', async () => {
    const res = await POST(createRequest({ query: 'DROP INDEX my_index' }, uniqueHeaders()));
    expect(res.status).toBe(403);
  });

  it.each([
    ['INSERT', 'INSERT (:Test)'],
    ['comment-obfuscated loading', 'LOAD /* hidden */ CSV FROM "https://example.invalid/a.csv" AS row RETURN row'],
    ['procedure', 'CALL db.labels() YIELD label RETURN label'],
    ['dynamic APOC Cypher', 'RETURN apoc.cypher.runFirstColumnSingle("CRE" + "ATE (:Test)", {}) AS result'],
    ['transaction termination', 'TERMINATE TRANSACTIONS "neo4j-transaction-1"'],
    ['administration', 'SHOW TRANSACTIONS YIELD transactionId RETURN transactionId'],
    ['PROFILE', 'PROFILE MATCH (n) RETURN n'],
    ['USE', 'USE system SHOW USERS'],
  ])('returns 403 for %s', async (_name, query) => {
    const res = await POST(createRequest({ query }, uniqueHeaders()));

    expect(res.status).toBe(403);
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('allows queries that contain mutation words as substrings', async () => {
    // "CREATED" contains "CREATE" but should be allowed as a property name
    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n.CREATED' }, uniqueHeaders()));

    // The regex uses word boundaries, so "CREATED" won't match \\bCREATE\\b
    // But actually "CREATED" does NOT match \\bCREATE\\b, so this should pass
    expect(res.status).toBe(200);
  });

  it('allows mutation words in literals and comments without rewriting the query', async () => {
    const query = "MATCH (n) /* DELETE n */ RETURN 'CREATE CALL LOAD CSV' AS text LIMIT 1";

    const res = await POST(createRequest({ query }, uniqueHeaders()));

    expect(res.status).toBe(200);
    expect(runRawReadQuery).toHaveBeenCalledWith(query, {}, EXPECTED_QUERY_OPTIONS);
  });

  it('returns 413 for query text above the raw-Cypher input limit', async () => {
    const query = `RETURN 1 /* ${'x'.repeat(16 * 1024)} */`;

    const res = await POST(createRequest({ query }, uniqueHeaders()));

    expect(res.status).toBe(413);
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('returns 413 for params above the raw-Cypher input limit', async () => {
    const res = await POST(
      createRequest({ query: 'RETURN $value AS value', params: { value: 'x'.repeat(64 * 1024) } }, uniqueHeaders())
    );

    expect(res.status).toBe(413);
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  it('returns 400 for non-object params', async () => {
    const res = await POST(createRequest({ query: 'RETURN 1', params: [] }, uniqueHeaders()));

    expect(res.status).toBe(400);
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  // ---- Neo4j health check ----

  it('returns 503 when Neo4j is unhealthy', async () => {
    checkHealth.mockResolvedValue({ healthy: false });

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe('Neo4j not available');
    expect(runRawReadQuery).not.toHaveBeenCalled();
  });

  // AUDIT-020. The pre-flight checkHealth above only catches an outage that
  // was ALREADY underway when the request arrived. A backend that dies between
  // the health probe and the query lands here — and used to answer 400 "Query
  // failed", telling the caller to go fix a query that was never wrong.
  it('returns 503, not 400, when the backend dies mid-query', async () => {
    checkHealth.mockResolvedValue({ healthy: true });
    runRawReadQuery.mockRejectedValue(
      new GraphUnavailableError('query', 'neo4j', 'Failed to connect: connect ECONNREFUSED [neo4j]')
    );

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.degraded).toBe(true);
    expect(json.error).toBe('Graph backend unavailable');
  });

  // ---- Timeout ----

  it('returns 408 when query times out', async () => {
    runRawReadQuery.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 50))
    );

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(408);
    expect(json.error).toBe('Query timeout');
  });

  it('returns 408 when Neo4j enforces the server-side transaction timeout', async () => {
    runRawReadQuery.mockRejectedValue(
      Object.assign(new Error('The transaction timed out'), {
        code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration',
      })
    );

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(408);
    expect(json.error).toBe('Query timeout');
  });

  // ---- Error sanitization ----

  it('sanitizes Neo4j connection details from error messages', async () => {
    runRawReadQuery.mockRejectedValue(
      new Error('Failed bolt://neo4j:p4ss@localhost:7687 password="two words" access_token=>abc')
    );

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.message).not.toContain('bolt://');
    expect(json.message).not.toContain('password');
    expect(json.message).not.toMatch(/token|p4ss|two words|abc/i);
    expect(json.message).toContain('[neo4j]');
    expect(json.message).toContain('[redacted]');
    const loggedError = mockLogger.error.mock.calls.at(-1)?.[1] as Error;
    expect(loggedError.message).not.toMatch(/bolt:\/\/|password|token|p4ss|two words|abc/i);
  });

  it('returns 500 for non-Error exceptions', async () => {
    runRawReadQuery.mockRejectedValue('unexpected string error');

    const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal error');
  });

  // ---- Node caption derivation ----

  describe('node captions', () => {
    const neo4jMock = jest.requireMock('neo4j-driver').default;

    /** Build a fake Neo4j node recognized by the mocked isNode guard. */
    function fakeNode(elementId: string, labels: string[], properties: Record<string, unknown>) {
      return { __isNode: true, elementId, identity: 0, labels, properties };
    }

    function fakeRecord(values: Record<string, unknown>) {
      return {
        keys: Object.keys(values),
        get: (key: string) => values[key],
      };
    }

    beforeEach(() => {
      neo4jMock.isNode.mockImplementation((v: unknown) => Boolean(v && (v as { __isNode?: boolean }).__isNode));
    });

    afterEach(() => {
      neo4jMock.isNode.mockImplementation(() => false);
    });

    it('resolves the authoritative quadrant name from enrichment (overriding a stale denormalized value)', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            p: fakeNode('4:abc:1', ['RadarPlacement'], {
              id: 'placement-1771689515182-kj1w383',
              quadrantName: 'STALE Autonomous Systems', // denormalized, may be stale
              ring: 'Assess',
              quadrantId: 'q-ai',
            }),
          }),
        ],
      });
      runReadTransaction.mockResolvedValueOnce({
        records: [
          {
            placementId: 'placement-1771689515182-kj1w383',
            technologyName: 'Autonomous Drones',
            ring: 'Assess',
            quadrantId: 'q-ai',
            radarId: 'radar-1',
            radarName: 'Ops Radar',
            quadrantIds: ['q-ai'],
            quadrantNames: ['AI & Autonomous Systems'],
          },
        ],
      });

      const res = await POST(createRequest({ query: 'MATCH (p:RadarPlacement) RETURN p' }, uniqueHeaders()));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.nodes[0].caption).toBe('Autonomous Drones · Assess');
      // Authoritative quadrant name from radar config replaces the stale one.
      expect(json.nodes[0].properties.quadrantName).toBe('AI & Autonomous Systems');
    });

    it('never emits raw machine ids as captions', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            p: fakeNode('4:abc:2', ['RadarPlacement'], { id: 'placement-1771443228833-w8hhpx9' }),
          }),
        ],
      });

      const res = await POST(createRequest({ query: 'MATCH (p:RadarPlacement) RETURN p' }, uniqueHeaders()));
      const json = await res.json();

      expect(json.nodes[0].caption).toBe('RadarPlacement #hpx9');
      expect(json.nodes[0].caption).not.toContain('placement-1771');
    });

    it('GRAPH-065: overrides the caption + resolved context from the bounded enrichment query', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            // A bare placement node (quadrantName null, as the sync often writes).
            p: fakeNode('4:abc:3', ['RadarPlacement'], {
              id: 'placement-quantum-1',
              ring: 'Trial',
              quadrantId: 'techniques',
            }),
          }),
        ],
      });
      // ONE enrichment round-trip resolves the placed technology + authoritative
      // quadrant name for every returned placement id.
      runReadTransaction.mockResolvedValueOnce({
        records: [
          {
            placementId: 'placement-quantum-1',
            technologyName: 'Quantum Annealing',
            ring: 'Trial',
            quadrantId: 'techniques',
            radarId: 'radar-1',
            radarName: 'Emerging Compute',
            quadrantIds: ['techniques'],
            quadrantNames: ['Techniques'],
          },
        ],
      });

      const res = await POST(createRequest({ query: 'MATCH (p:RadarPlacement) RETURN p' }, uniqueHeaders()));
      const json = await res.json();

      expect(json.nodes[0].caption).toBe('Quantum Annealing · Trial');
      expect(json.nodes[0].properties.technologyName).toBe('Quantum Annealing');
      expect(json.nodes[0].properties.radarName).toBe('Emerging Compute');
      expect(json.nodes[0].properties.quadrantName).toBe('Techniques');
      // The enrichment is a single bounded query over the placement ids.
      expect(runReadTransaction).toHaveBeenCalledTimes(1);
      expect(runReadTransaction.mock.calls[0][1]).toEqual({ ids: ['placement-quantum-1'] });
    });

    it('#12 clears stale display names + captions RadarPlacement #suffix on an enrichment OUTAGE', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            p: fakeNode('4:abc:9', ['RadarPlacement'], {
              id: 'placement-1771443228833-w8hhpx9',
              ring: 'Trial',
              quadrantName: 'Stale Quadrant Name', // denormalized, possibly stale
            }),
          }),
        ],
      });
      runReadTransaction.mockRejectedValueOnce(new Error('neo4j read timeout'));

      const res = await POST(createRequest({ query: 'MATCH (p:RadarPlacement) RETURN p' }, uniqueHeaders()));
      const json = await res.json();

      expect(res.status).toBe(200);
      // Stale quadrant name is dropped; caption falls back to the #suffix form.
      expect(json.nodes[0].properties.quadrantName).toBeUndefined();
      expect(json.nodes[0].caption).toBe('RadarPlacement #hpx9');
      expect(json.nodes[0].properties.unresolvedContext).toEqual(
        expect.arrayContaining(['enrichment', 'technology', 'radar', 'quadrant'])
      );
    });

    it('#12 a placement with NO enrichment row degrades honestly (no stale names retained)', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            p: fakeNode('4:abc:10', ['RadarPlacement'], {
              id: 'placement-orphan-1',
              ring: 'Assess',
              quadrantName: 'Stale',
            }),
          }),
        ],
      });
      // Enrichment succeeds but returns no row for this placement.
      runReadTransaction.mockResolvedValueOnce({ records: [] });

      const res = await POST(createRequest({ query: 'MATCH (p:RadarPlacement) RETURN p' }, uniqueHeaders()));
      const json = await res.json();

      expect(json.nodes[0].properties.quadrantName).toBeUndefined();
      expect(json.nodes[0].caption).toMatch(/^RadarPlacement #/);
      expect(json.nodes[0].properties.unresolvedContext).toContain('technology');
    });

    it('keeps name-based captions for entity nodes', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [
          fakeRecord({
            t: fakeNode('4:abc:3', ['Entity', 'Technology'], {
              id: 'tech-123',
              name: 'Neuromorphic Computing',
            }),
          }),
        ],
      });

      const res = await POST(createRequest({ query: 'MATCH (t:Technology) RETURN t' }, uniqueHeaders()));
      const json = await res.json();

      expect(json.nodes[0].caption).toBe('Neuromorphic Computing');
    });

    it('caps topology before sending it to the graph renderer', async () => {
      runRawReadQuery.mockResolvedValue({
        records: Array.from({ length: 301 }, (_, index) =>
          fakeRecord({ n: fakeNode(`node-${index}`, ['Technology'], { name: `Technology ${index}` }) })
        ),
      });

      const res = await POST(createRequest({ query: 'MATCH (n) RETURN n' }, uniqueHeaders()));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.nodes).toHaveLength(300);
      expect(json.truncated).toBe(true);
      expect(json.truncationReasons).toContain('node limit');
    });

    it('rejects a graph payload above the response byte limit', async () => {
      runRawReadQuery.mockResolvedValue({
        records: [fakeRecord({ n: fakeNode('large-node', ['Document'], { content: 'x'.repeat(2 * 1024 * 1024) }) })],
      });

      const res = await POST(createRequest({ query: 'MATCH (n:Document) RETURN n' }, uniqueHeaders()));
      const json = await res.json();

      expect(res.status).toBe(413);
      expect(json.error).toBe('Query result too large');
      expect(json.message).toContain('2 MiB');
    });
  });

  // ---- Comment-aware validation ----

  it('preserves block comments after validating their contents', async () => {
    const query = 'MATCH (n) /* comment */ RETURN n';
    const res = await POST(createRequest({ query }, uniqueHeaders()));

    expect(res.status).toBe(200);
    expect(runRawReadQuery).toHaveBeenCalledWith(query, {}, EXPECTED_QUERY_OPTIONS);
  });

  it('preserves line comments after validating their contents', async () => {
    const query = 'MATCH (n) RETURN n // line comment';
    const res = await POST(createRequest({ query }, uniqueHeaders()));

    expect(res.status).toBe(200);
    expect(runRawReadQuery).toHaveBeenCalledWith(query, {}, EXPECTED_QUERY_OPTIONS);
  });
});
