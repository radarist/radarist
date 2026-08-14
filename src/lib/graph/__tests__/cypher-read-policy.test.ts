/** @jest-environment node */

import { hasExplainRoot, inspectCypherReadQuery, RAW_CYPHER_LIMITS } from '../cypher-read-policy';

describe('caller-supplied Cypher read policy', () => {
  it.each([
    ['CREATE', 'CREATE (:Unsafe)'],
    ['INSERT', 'INSERT (:Unsafe)'],
    ['MERGE', 'MERGE (:Unsafe)'],
    ['DELETE', 'MATCH (n) DELETE n'],
    ['mixed-case mutation', 'mAtCh (n) dEtAcH dElEtE n'],
    ['SET', 'MATCH (n) SET n.value = 1 RETURN n'],
    ['REMOVE', 'MATCH (n) REMOVE n.value RETURN n'],
    ['DROP', 'DROP INDEX unsafe_index'],
    ['FOREACH', 'WITH [1] AS xs FOREACH (x IN xs | CREATE (:Unsafe)) RETURN xs'],
    ['procedure', 'CALL db.labels() YIELD label RETURN label'],
    ['read subquery', 'CALL { MATCH (n) RETURN n LIMIT 1 } RETURN n'],
    ['plain LOAD CSV', 'LOAD CSV FROM "https://example.invalid/a.csv" AS row RETURN row'],
    ['block-comment LOAD CSV', 'LOAD /* hidden */ CSV FROM "https://example.invalid/a.csv" AS row RETURN row'],
    ['line-comment LOAD CSV', 'LOAD // hidden\n CSV FROM "https://example.invalid/a.csv" AS row RETURN row'],
    ['nested block comment opener', 'RETURN 1 /* outer /* nested */ CREATE (:Unsafe) */'],
    ['periodic commit', 'USING PERIODIC COMMIT LOAD CSV FROM "file:///a.csv" AS row RETURN row'],
    ['transaction listing', 'SHOW TRANSACTIONS YIELD transactionId RETURN transactionId'],
    ['transaction termination', 'TERMINATE TRANSACTIONS "neo4j-transaction-1"'],
    ['profile', 'PROFILE MATCH (n) RETURN n'],
    ['database selection', 'USE system SHOW USERS'],
    ['administration', 'GRANT MATCH {*} ON GRAPH neo4j TO reader'],
    ['administration after WITH', 'WITH "neo4j" AS name STOP DATABASE name'],
    [
      'dynamic APOC with split mutation string',
      'RETURN apoc.cypher.runFirstColumnSingle("CRE" + "ATE (:Unsafe) RETURN 1", {}) AS result',
    ],
    [
      'escaped dynamic APOC function',
      'RETURN `apoc.cypher.runFirstColumnSingle`("RETURN 1", {}) AS result',
    ],
    [
      'partially escaped dynamic APOC namespace',
      'RETURN apoc.`cypher`.runFirstColumnSingle("RETURN 1", {}) AS result',
    ],
    [
      'escaped APOC namespace prefix',
      'RETURN `apoc`.cypher.runFirstColumnSingle("RETURN 1", {}) AS result',
    ],
    ['unsupported SHOW root', 'SHOW INDEXES'],
    ['multiple statements', 'MATCH (n) RETURN n; MATCH (m) RETURN m'],
  ])('rejects %s', (_name, query) => {
    const decision = inspectCypherReadQuery(query);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it.each([
    ['simple match', 'MATCH (n) RETURN n LIMIT 10'],
    ['optional match', 'OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 10'],
    ['unwind', 'UNWIND range(1, 3) AS value RETURN value'],
    ['with', 'WITH 1 AS value RETURN value'],
    ['return', 'RETURN 1 AS value'],
    ['explain', 'EXPLAIN MATCH (n) RETURN n LIMIT 1'],
    ['trailing semicolon', 'MATCH (n) RETURN n LIMIT 1;'],
    ['keyword string', "RETURN 'CREATE DELETE CALL LOAD CSV TERMINATE' AS text"],
    ['URL string', 'RETURN "https://example.test/a//b/*c*/" AS url'],
    ['keyword comments', 'MATCH (n) /* DELETE n; CALL db.labels() */ RETURN n // CREATE\nLIMIT 1'],
    ['escaped keyword property', 'MATCH (n) RETURN n.`DELETE` AS value LIMIT 1'],
    ['keyword substring', 'MATCH (n) RETURN n.createdAt, n.settings LIMIT 1'],
    ['APOC text only', "RETURN 'apoc.cypher.runFirstColumnSingle' AS documentation"],
    ['nested comment markers in a string', "RETURN '/* outer /* nested */' AS documentation"],
  ])('allows %s', (_name, query) => {
    expect(inspectCypherReadQuery(query)).toEqual(
      expect.objectContaining({ allowed: true })
    );
  });

  it('rejects comments-only input as empty', () => {
    expect(inspectCypherReadQuery('/* no query */ // still no query')).toEqual(
      expect.objectContaining({ allowed: false, code: 'EMPTY_QUERY' })
    );
  });

  it('reports nested block comments as an explicit grammar violation', () => {
    expect(inspectCypherReadQuery('MATCH (n) /* outer /* nested */ RETURN n */')).toEqual(
      expect.objectContaining({ allowed: false, code: 'NESTED_BLOCK_COMMENT' })
    );
  });

  it.each(["RETURN 'unterminated", 'MATCH (`unterminated) RETURN 1', 'MATCH (n) /* unterminated']) (
    'rejects unterminated lexical input: %s',
    (query) => {
      expect(inspectCypherReadQuery(query)).toEqual(
        expect.objectContaining({ allowed: false, code: 'UNTERMINATED_LITERAL' })
      );
    }
  );

  it('enforces the UTF-8 query byte limit', () => {
    const query = `RETURN 1 /* ${'x'.repeat(RAW_CYPHER_LIMITS.queryBytes)} */`;

    expect(inspectCypherReadQuery(query)).toEqual(
      expect.objectContaining({ allowed: false, code: 'QUERY_TOO_LARGE' })
    );
  });

  it('enforces the serialized parameter byte limit', () => {
    const params = { value: 'x'.repeat(RAW_CYPHER_LIMITS.paramsBytes) };

    expect(inspectCypherReadQuery('RETURN $value AS value', params)).toEqual(
      expect.objectContaining({ allowed: false, code: 'PARAMS_TOO_LARGE' })
    );
  });

  it.each([null, [], 'not-an-object', 1])('rejects non-object params: %p', (params) => {
    expect(inspectCypherReadQuery('RETURN 1', params)).toEqual(
      expect.objectContaining({ allowed: false, code: 'INVALID_PARAMS' })
    );
  });

  it('rejects cyclic parameters without throwing', () => {
    const params: Record<string, unknown> = {};
    params.self = params;

    expect(inspectCypherReadQuery('RETURN $self', params)).toEqual(
      expect.objectContaining({ allowed: false, code: 'INVALID_PARAMS' })
    );
  });

  it('recognizes EXPLAIN after leading comments without inspecting comment text', () => {
    expect(hasExplainRoot('/* PROFILE */ // MATCH\n EXPLAIN MATCH (n) RETURN n')).toBe(true);
    expect(hasExplainRoot("RETURN 'EXPLAIN' AS text")).toBe(false);
  });
});
