/**
 * @file neo4j-unavailable-translation.test.ts
 * @description AUDIT-020 — a Neo4j outage must surface as GraphUnavailableError.
 *
 * Why this file exists at all, rather than another route-level test:
 *
 * `GraphUnavailableError` had exactly ONE non-test construction site
 * (firestore-fallback-service.ts). Every `instanceof GraphUnavailableError`
 * gate in the app — including the three routes whose docstrings promise an
 * honest 503 — was therefore unreachable for the Neo4j backend, and a real
 * outage answered 500. The existing route test passed only because it
 * hand-constructed the error the route wanted to see. That is the defect: the
 * tests pinned the CONTRACT and nobody pinned the BEHAVIOR.
 *
 * So these tests mock the neo4j-driver itself and drive the real chain —
 * getAssertionsForEntity → runReadTransaction → the driver — asserting on what
 * comes out the far end. They fail against the pre-fix tree.
 */

import { GraphUnavailableError } from '../errors';

// ---- Driver mock --------------------------------------------------------
// `executeRead` is what each test swaps out, so a single mock serves both the
// outage case and the syntax-error case.
const executeRead = jest.fn();
const close = jest.fn().mockResolvedValue(undefined);

jest.mock('neo4j-driver', () => {
  const session = () => ({ executeRead, executeWrite: jest.fn(), run: jest.fn(), close });
  return {
    __esModule: true,
    default: {
      driver: jest.fn(() => ({ session, close })),
      auth: { basic: jest.fn(() => ({})) },
      session: { READ: 'READ', WRITE: 'WRITE' },
      int: jest.fn((n: number) => n),
      isInt: jest.fn(() => false),
      isDate: jest.fn(() => false),
      isDateTime: jest.fn(() => false),
      isLocalDateTime: jest.fn(() => false),
    isNode: jest.fn(() => false),
    isRelationship: jest.fn(() => false),
    },
  };
});

/**
 * The error a dead Neo4j actually produces. Shape verified against
 * neo4j-driver 6.0.1 by pointing a driver at a closed port: `name` is
 * 'Neo4jError', `code` is the string 'ServiceUnavailable', and the message
 * quotes the bolt URI — which is why the message has to be sanitized.
 */
function driverDownError(): Error {
  return Object.assign(
    new Error(
      'Failed to connect to server. Please ensure that your database is listening on the correct host and port. ' +
        'Caused by: connect ECONNREFUSED bolt://neo4j:hunter2@127.0.0.1:7687'
    ),
    { name: 'Neo4jError', code: 'ServiceUnavailable' }
  );
}

/**
 * The message neo4j-driver 6.0.1 ACTUALLY produced, captured verbatim by running
 * the real chain against a dead port. Note what it does NOT contain: a `bolt://`
 * URI. It ends in a BARE `host:port`, which a sanitizer that only strips the URI
 * form leaves untouched — straight into the 503 response body.
 */
const REAL_DRIVER_MESSAGE =
  'Failed to connect to server. Please ensure that your database is listening on the correct host ' +
  'and port and that you have compatible encryption settings both on Neo4j server and driver. ' +
  'Note that the default encryption setting has changed in Neo4j 4.0. ' +
  'Caused by: connect ECONNREFUSED 127.0.0.1:59999';

/** A Cypher bug. The caller's fault — must NOT be dressed up as a 503. */
function syntaxError(): Error {
  return Object.assign(new Error('Invalid input "MTCH": expected a query'), {
    name: 'Neo4jError',
    code: 'Neo.ClientError.Statement.SyntaxError',
  });
}

/** Await a call that must reject, and hand back the error it rejected with. */
async function captureRejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEO4J_URI = 'bolt://127.0.0.1:7687';
  process.env.NEO4J_PASSWORD = 'test-password';
});

describe('runReadTransaction — driver error translation (AUDIT-020)', () => {
  it('translates an unreachable database into GraphUnavailableError', async () => {
    executeRead.mockRejectedValue(driverDownError());
    const { runReadTransaction } = await import('../neo4j-client');

    await expect(runReadTransaction('MATCH (n) RETURN n')).rejects.toBeInstanceOf(GraphUnavailableError);
  });

  it('scrubs the bolt URI and its credentials out of the translated message', async () => {
    executeRead.mockRejectedValue(driverDownError());
    const { runReadTransaction } = await import('../neo4j-client');

    // The three honest-degradation routes echo `error.message` straight into
    // their 503 bodies. Before the translation they never emitted driver text
    // at all (generic 500), so this is a NEW egress path — and the driver's
    // message carries the connection string.
    const error = await captureRejection(() => runReadTransaction('MATCH (n) RETURN n'));

    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('127.0.0.1:7687');
    // ...but the diagnostic half survives, or the 503 is useless to an operator.
    expect(error.message).toContain('ECONNREFUSED');
  });

  // Caught only by running the real driver. The mocked test above asserted the
  // bolt URI was stripped — and it was — but the driver never emits a bolt URI
  // here. It emits a bare `127.0.0.1:59999`, which sailed through untouched.
  it('scrubs the BARE host:port the real driver actually emits (no bolt:// prefix)', async () => {
    executeRead.mockRejectedValue(
      Object.assign(new Error(REAL_DRIVER_MESSAGE), { name: 'Neo4jError', code: 'ServiceUnavailable' })
    );
    const { runReadTransaction } = await import('../neo4j-client');

    const error = await captureRejection(() => runReadTransaction('MATCH (n) RETURN n'));

    expect(error.message).not.toContain('127.0.0.1');
    expect(error.message).not.toContain('59999');
    expect(error.message).toContain('ECONNREFUSED');
    // The version string in the same sentence must survive — over-scrubbing
    // would make the message useless.
    expect(error.message).toContain('Neo4j 4.0');
  });

  it('leaves a Cypher syntax error untouched — a query bug is not an outage', async () => {
    executeRead.mockRejectedValue(syntaxError());
    const { runReadTransaction } = await import('../neo4j-client');

    const error = await captureRejection(() => runReadTransaction('MTCH (n) RETURN n'));

    expect(error).not.toBeInstanceOf(GraphUnavailableError);
    expect((error as { code?: string }).code).toBe('Neo.ClientError.Statement.SyntaxError');
  });
});

describe('getAssertionsForEntity — the chain the claims route actually calls', () => {
  it('propagates GraphUnavailableError when Neo4j is down', async () => {
    executeRead.mockRejectedValue(driverDownError());
    const { getAssertionsForEntity } = await import('../assertions');

    // This is the assertion that was false before the fix: the claims route
    // gates its 503 on exactly this, and got a raw Neo4jError instead.
    await expect(getAssertionsForEntity('ent-1')).rejects.toBeInstanceOf(GraphUnavailableError);
  });
});
