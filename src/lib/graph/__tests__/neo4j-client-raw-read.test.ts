/** @jest-environment node */

const mockSessionRun = jest.fn();
const mockSessionClose = jest.fn().mockResolvedValue(undefined);
const mockDriverClose = jest.fn().mockResolvedValue(undefined);
const mockSession = jest.fn(() => ({
  run: mockSessionRun,
  close: mockSessionClose,
}));

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    driver: jest.fn(() => ({ session: mockSession, close: mockDriverClose })),
    auth: { basic: jest.fn(() => ({})) },
    session: { READ: 'READ', WRITE: 'WRITE' },
    isInt: jest.fn((value: unknown) => Boolean(value && (value as { __isInt?: boolean }).__isInt)),
    isDate: jest.fn(() => false),
    isDateTime: jest.fn(() => false),
    isLocalDateTime: jest.fn(() => false),
    // Marker-based stand-ins for the driver's exact graph-entity guards. A plain
    // Cypher map carries no marker, which is what lets the tests below prove a
    // map is not mistaken for a node (GRAPH-062).
    isNode: jest.fn((value: unknown) => Boolean(value && (value as { __isNode?: boolean }).__isNode)),
    isRelationship: jest.fn((value: unknown) =>
      Boolean(value && (value as { __isRelationship?: boolean }).__isRelationship)
    ),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  closeDriver,
  CypherQueryClassificationError,
  CypherQueryWallTimeoutError,
  runRawReadQuery,
  sanitizeNeo4jErrorMessage,
} from '../neo4j-client';
import { CypherReadPolicyError } from '../cypher-read-policy';

/** Limits generous enough that a conversion test never trips truncation. */
const RAW_READ_LIMITS = { recordMode: 'native', maxRecords: 10, maxPayloadBytes: 4096 } as const;

function summary(queryType = 'r', containsUpdates = false) {
  return {
    counters: {
      updates: () => ({
        nodesCreated: containsUpdates ? 1 : 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
      }),
      containsUpdates: () => containsUpdates,
      containsSystemUpdates: () => false,
    },
    queryType,
    resultAvailableAfter: { toNumber: () => 1 },
    resultConsumedAfter: { toNumber: () => 2 },
  };
}

function eagerResult(queryType = 'r', containsUpdates = false) {
  return { records: [], summary: summary(queryType, containsUpdates) };
}

function fakeRecord(values: Record<string, unknown>) {
  return {
    keys: Object.keys(values),
    get: (key: string) => values[key],
  };
}

function streamingResult(records: unknown[], resultSummary = summary()) {
  let index = 0;
  let cancelled = false;
  const iterator = {
    next: jest.fn(async () =>
      index < records.length
        ? { done: false as const, value: records[index++] }
        : { done: true as const, value: resultSummary }
    ),
    return: jest.fn(async () => {
      cancelled = true;
      index = records.length;
      return { done: true as const, value: resultSummary };
    }),
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    summary: jest.fn(async () => resultSummary),
    iterator,
    wasCancelled: () => cancelled,
  };
}

function hangingResult() {
  const iterator = {
    next: jest.fn(() => new Promise<never>(() => undefined)),
    return: jest.fn(async () => ({ done: true as const, value: summary() })),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    summary: jest.fn(async () => summary()),
    iterator,
  };
}

function arrangeActualResult(result: unknown, preflightQueryType = 'r') {
  mockSessionRun.mockResolvedValueOnce(eagerResult(preflightQueryType)).mockReturnValueOnce(result);
}

describe('runRawReadQuery bounded caller-supplied reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEO4J_URI = 'bolt://127.0.0.1:17687';
    delete process.env.RADARIST_GRAPH_RUNTIME_MODE;
    mockSessionClose.mockResolvedValue(undefined);
    mockDriverClose.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await closeDriver();
  });

  it('EXPLAIN-classifies first and passes the server timeout to both queries', async () => {
    arrangeActualResult(streamingResult([]));

    await runRawReadQuery('MATCH (n) RETURN n', {}, 30_000);

    expect(mockSessionRun).toHaveBeenNthCalledWith(1, 'EXPLAIN MATCH (n) RETURN n', {}, { timeout: 30_000 });
    expect(mockSessionRun).toHaveBeenNthCalledWith(2, 'MATCH (n) RETURN n', {}, { timeout: 30_000 });
    expect(mockSessionClose).toHaveBeenCalledTimes(1);
  });

  it('attaches caller metadata to preflight and execution', async () => {
    arrangeActualResult(streamingResult([]));

    await runRawReadQuery(
      'RETURN 1',
      {},
      {
        transactionTimeoutMs: 10_000,
        metadata: { application: 'radarist', surface: 'test' },
      }
    );

    const config = {
      timeout: 10_000,
      metadata: { application: 'radarist', surface: 'test' },
    };
    expect(mockSessionRun).toHaveBeenNthCalledWith(1, 'EXPLAIN RETURN 1', {}, config);
    expect(mockSessionRun).toHaveBeenNthCalledWith(2, 'RETURN 1', {}, config);
  });

  it('applies bounded timeout and record defaults when options are omitted', async () => {
    const stream = streamingResult([]);
    arrangeActualResult(stream);

    await runRawReadQuery('RETURN 1');

    const queryConfig = { timeout: 10_000 };
    expect(mockSessionRun).toHaveBeenNthCalledWith(1, 'EXPLAIN RETURN 1', {}, queryConfig);
    expect(mockSessionRun).toHaveBeenNthCalledWith(2, 'RETURN 1', {}, queryConfig);
  });

  it('stops at the default 100-record cap when a caller supplies no options', async () => {
    const stream = streamingResult(Array.from({ length: 101 }, (_, value) => fakeRecord({ value })));
    arrangeActualResult(stream);

    const result = await runRawReadQuery('UNWIND range(0, 100) AS value RETURN value');

    expect(result.records).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['record limit']);
    expect(stream.iterator.return).toHaveBeenCalledTimes(1);
  });

  it('does not prepend a second EXPLAIN after leading comments', async () => {
    const query = '/* inspection */ EXPLAIN MATCH (n) RETURN n LIMIT 1';
    arrangeActualResult(streamingResult([]));

    await runRawReadQuery(query);

    expect(mockSessionRun).toHaveBeenNthCalledWith(1, query, {}, { timeout: 10_000 });
    expect(mockSessionRun).toHaveBeenNthCalledWith(2, query, {}, { timeout: 10_000 });
  });

  it('streams only the requested record count and cancels the remaining result', async () => {
    const stream = streamingResult([fakeRecord({ id: 1 }), fakeRecord({ id: 2 }), fakeRecord({ id: 3 })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery('MATCH (n) RETURN n', {}, 30_000, 2);

    expect(result.records).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['record limit']);
    expect(stream.iterator.return).toHaveBeenCalledTimes(1);
    expect(stream.wasCancelled()).toBe(true);
  });

  it('does not report truncation when a stream ends exactly at the record cap', async () => {
    const stream = streamingResult([fakeRecord({ id: 1 }), fakeRecord({ id: 2 })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery('RETURN 1', {}, undefined, 2);

    expect(result.records).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.truncationReasons).toEqual([]);
    expect(stream.iterator.return).not.toHaveBeenCalled();
  });

  it('rejects invalid resource limits before opening a session', async () => {
    await expect(runRawReadQuery('RETURN 1', {}, { maxRecords: 0 })).rejects.toThrow(
      'maxRecords must be a positive safe integer'
    );

    expect(mockSession).not.toHaveBeenCalled();
  });

  it('rejects policy violations before opening a session', async () => {
    await expect(runRawReadQuery('MATCH (n) DELETE n')).rejects.toBeInstanceOf(CypherReadPolicyError);

    expect(mockSession).not.toHaveBeenCalled();
  });

  it.each(['w', 'rw', 's'])('rejects EXPLAIN query type %s before execution', async (queryType) => {
    mockSessionRun.mockResolvedValueOnce(eagerResult(queryType));

    await expect(runRawReadQuery('MATCH (n) RETURN n')).rejects.toBeInstanceOf(CypherQueryClassificationError);
    expect(mockSessionRun).toHaveBeenCalledTimes(1);
  });

  it('rejects an execution summary that reports updates', async () => {
    const stream = streamingResult([fakeRecord({ value: 1 })], summary('r', true));
    arrangeActualResult(stream);

    await expect(runRawReadQuery('RETURN 1 AS value', {}, { maxRecords: 2 })).rejects.toBeInstanceOf(
      CypherQueryClassificationError
    );
  });

  it('returns native records and stops before crossing the serialized payload limit', async () => {
    const stream = streamingResult([
      fakeRecord({ value: '1234567890' }),
      fakeRecord({ value: 'abcdefghij' }),
      fakeRecord({ value: 'not-reached' }),
    ]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery(
      'UNWIND [1, 2, 3] AS n RETURN n',
      {},
      {
        recordMode: 'native',
        maxRecords: 10,
        maxPayloadBytes: 25,
      }
    );

    expect(result.nativeRecords).toEqual([{ value: '1234567890' }]);
    expect(result.records).toEqual([]);
    expect(result.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(result.nativeRecords)));
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(['payload limit']);
    expect(stream.iterator.return).toHaveBeenCalledTimes(1);
  });

  it('serializes unsafe Neo4j integers as strings instead of losing precision', async () => {
    const unsafeInteger = {
      __isInt: true,
      inSafeRange: () => false,
      toNumber: () => Number.MAX_SAFE_INTEGER + 10,
      toString: () => '9007199254741001',
    };
    const stream = streamingResult([fakeRecord({ value: unsafeInteger })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery(
      'RETURN 9007199254741001 AS value',
      {},
      {
        recordMode: 'native',
        maxRecords: 2,
        maxPayloadBytes: 1024,
      }
    );

    expect(result.nativeRecords).toEqual([{ value: '9007199254741001' }]);
  });

  // GRAPH-062 — the conversion used to treat ANY object with a `properties` key
  // as a graph entity and collapse it into that key's contents. `findPath`
  // projects `{id, type, sourceId, targetId, properties}` per hop, so every
  // sibling field was silently dropped: paths reported no predicate and no edge
  // confidence, and strategic alignment scored co-views at the default.
  it('keeps a plain map whose key happens to be named "properties" intact', async () => {
    const pathRel = {
      id: '5:abc:64',
      type: 'ALIGNS_WITH',
      sourceId: 'tech-1',
      targetId: 'strategy-1',
      properties: { effectiveConfidence: 95, claimStatus: 'curated' },
    };
    const stream = streamingResult([fakeRecord({ pathRels: [pathRel] })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery('MATCH p = shortestPath(()-[*..3]-()) RETURN p', {}, RAW_READ_LIMITS);

    expect(result.nativeRecords).toEqual([{ pathRels: [pathRel] }]);
  });

  it('still flattens a real node into its property bag', async () => {
    const node = {
      __isNode: true,
      labels: ['Entity', 'Technology'],
      properties: { id: 'tech-1', name: 'React' },
    };
    const stream = streamingResult([fakeRecord({ n: node })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery('MATCH (n) RETURN n', {}, RAW_READ_LIMITS);

    expect(result.nativeRecords).toEqual([{ n: { id: 'tech-1', name: 'React', _labels: ['Entity', 'Technology'] } }]);
  });

  it('still flattens a real relationship into its property bag', async () => {
    const relationship = {
      __isRelationship: true,
      type: 'ALIGNS_WITH',
      properties: { relationId: 'rel-1', effectiveConfidence: 90 },
    };
    const stream = streamingResult([fakeRecord({ r: relationship })]);
    arrangeActualResult(stream);

    const result = await runRawReadQuery('MATCH ()-[r]->() RETURN r', {}, RAW_READ_LIMITS);

    expect(result.nativeRecords).toEqual([{ r: { relationId: 'rel-1', effectiveConfidence: 90, _labels: undefined } }]);
  });

  it('closes the session and returns a typed wall-time error', async () => {
    jest.useFakeTimers();
    const stream = hangingResult();
    arrangeActualResult(stream);

    const promise = runRawReadQuery(
      'RETURN 1',
      {},
      {
        recordMode: 'native',
        maxRecords: 2,
        maxPayloadBytes: 1024,
        wallTimeoutMs: 50,
      }
    );
    await Promise.resolve();
    jest.advanceTimersByTime(50);

    await expect(promise).rejects.toBeInstanceOf(CypherQueryWallTimeoutError);
    expect(mockSessionClose).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it.each([
    'Failed bolt://neo4j:p4ss@localhost:7687?password=secret',
    'password123 token=abc secret:xyz',
    'PASSWORD = "two words" ACCESS_TOKEN=>abc client-secret: xyz',
    'password is hunter2; token is bearer-value',
    '{"neo4j_password":"abc","auth-token":"def","clientSecret":"ghi"}',
  ])('sanitizes connection and credential-like details: %s', (message) => {
    const sanitized = sanitizeNeo4jErrorMessage(message);

    expect(sanitized).not.toMatch(/bolt:\/\//i);
    expect(sanitized).not.toMatch(/password|token|secret/i);
    expect(sanitized).not.toMatch(/p4ss|two words|hunter2|bearer-value|\babc\b|\bdef\b|\bghi\b|\bxyz\b/i);
    expect(sanitized).toMatch(/\[(?:neo4j|redacted)\]/);
  });
});
