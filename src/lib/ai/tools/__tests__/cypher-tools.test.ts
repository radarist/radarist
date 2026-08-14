/**
 * @file cypher-tools.test.ts
 * @description Tests for the Cypher tool surface — the schema/examples this
 * tool emits are what the LLM copies into real queries.
 *
 * H2 regression: the schema taught lowercase labels (`:technology` matches 0
 * nodes vs `:Technology` = 771) and snake_case entityType values
 * ('org_unit'/'pain_point') that no writer ever stores (writers store
 * 'orgUnit'/'painPoint').
 */

jest.mock('@/lib/ai/client', () => ({
  generateStructuredContent: jest.fn(),
}));
jest.mock('@/lib/graph/service-factory', () => ({
  getGraphService: jest.fn(),
}));
const mockRunRawReadQuery = jest.fn();
jest.mock('@/lib/graph/neo4j-client', () => ({
  ...jest.requireActual('@/lib/graph/neo4j-client'),
  runRawReadQuery: (...args: unknown[]) => mockRunRawReadQuery(...args),
}));
jest.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { createLogger: () => mockLogger, __mockLogger: mockLogger };
});

import {
  CYPHER_TOOLS,
  executeExecuteCypher,
  executeGenerateCypher,
  executeGetCypherSchema,
  executeValidateCypher,
} from '../cypher-tools';
import { RAW_CYPHER_LIMITS } from '@/lib/graph/cypher-read-policy';
import { CLAIM_RELATION_PREDICATES } from '@/lib/graph/relation-registry';

const mockLogger = jest.requireMock('@/lib/logger').__mockLogger as { error: jest.Mock };

describe('getCypherSchema (H2 vocabulary)', () => {
  it('teaches camelCase entityType values, never the snake_case forms writers do not store', async () => {
    const result = await executeGetCypherSchema({});

    expect(result.success).toBe(true);
    const types = result.schema!.nodeTypes.map((n) => n.type);
    expect(types).toContain('orgUnit');
    expect(types).toContain('painPoint');
    expect(types).not.toContain('org_unit');
    expect(types).not.toContain('pain_point');
  });

  it('teaches PascalCase node labels for every node type (lowercase labels match 0 nodes)', async () => {
    const result = await executeGetCypherSchema({});

    const labels = result.schema!.nodeTypes.map((n) => (n as { label?: string }).label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Technology',
        'Company',
        'UseCase',
        'Prototype',
        'Strategy',
        'Signal',
        'OrgUnit',
        'Initiative',
        'PainPoint',
        'Document',
        'RadarPlacement',
      ])
    );
  });

  it('distinguishes entityType-backed nodes from label-only graph nodes', async () => {
    const result = await executeGetCypherSchema({});
    const byLabel = new Map(result.schema!.nodeTypes.map((node) => [node.label, node]));

    expect(byLabel.get('OrgUnit')?.entityTypeProperty).toBe('orgUnit');
    expect(byLabel.get('Document')?.entityTypeProperty).toBeNull();
    expect(byLabel.get('RadarPlacement')?.entityTypeProperty).toBeNull();
  });

  it('emits no snake_case vocabulary anywhere in the schema payload', async () => {
    const result = await executeGetCypherSchema({});
    const payload = JSON.stringify(result.schema);
    expect(payload).not.toContain('org_unit');
    expect(payload).not.toContain('pain_point');
  });

  it('advertises exactly the predicates produced by the canonical Relation writer', async () => {
    const result = await executeGetCypherSchema({});

    expect(result.schema!.relationshipTypes.map((relationship) => relationship.type)).toEqual(
      CLAIM_RELATION_PREDICATES
    );
    expect(result.schema!.relationshipTypes.map((relationship) => relationship.type)).not.toEqual(
      expect.arrayContaining(['PARTNERS_WITH', 'PROVIDES', 'DEVELOPS', 'EXPERIENCES', 'OWNS', 'MENTIONED_IN'])
    );
  });

  it('lists structural graph edges separately from canonical Relation predicates', async () => {
    const result = await executeGetCypherSchema({});
    const structural = result.schema!.structuralRelationshipTypes.map((relationship) => relationship.type);

    expect(structural).toEqual(
      expect.arrayContaining(['ABOUT_SUBJECT', 'SUPPORTED_BY', 'MENTIONS', 'DOCUMENTED_BY', 'PLACES', 'ON_RADAR'])
    );
    expect(structural.some((type) => CLAIM_RELATION_PREDICATES.includes(type))).toBe(false);
  });
});

describe('CYPHER_TOOLS declarations (H2 examples)', () => {
  it('never shows the LLM a lowercase-label Cypher pattern', () => {
    // (x:technology), (c:company), … — these labels match 0 nodes. Every
    // example the tool descriptions emit must use PascalCase labels.
    const lowercaseLabelPattern =
      /\(\s*\w+\s*:\s*(technology|company|useCase|prototype|strategy|signal|org_unit|initiative|pain_point)\b/;
    for (const tool of CYPHER_TOOLS) {
      expect(tool.description ?? '').not.toMatch(lowercaseLabelPattern);
    }
  });

  it('does not advertise snake_case node types in the getCypherSchema description', () => {
    const schemaTool = CYPHER_TOOLS.find((t) => t.name === 'getCypherSchema');
    expect(schemaTool!.description).not.toContain('org_unit');
    expect(schemaTool!.description).not.toContain('pain_point');
  });

  it('does not advertise relationship predicates that canonical Relation writers never emit', () => {
    const forbiddenPredicates = ['PROVIDES', 'PARTNERS_WITH', 'DEVELOPS', 'EXPERIENCES', 'OWNS', 'MENTIONED_IN'];
    const declarations = JSON.stringify(CYPHER_TOOLS);

    for (const predicate of forbiddenPredicates) {
      expect(declarations).not.toContain(predicate);
    }
  });
});

describe('bounded Cypher execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRawReadQuery.mockResolvedValue({
      records: [],
      nativeRecords: [{ name: 'Neo4j' }],
      summary: {},
      truncated: false,
      truncationReasons: [],
      payloadBytes: 20,
    });
  });

  it('executes raw reads through the exact bounded client contract', async () => {
    const result = await executeExecuteCypher({
      cypher: 'MATCH (n:Technology) RETURN n.name AS name',
      params: {},
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        results: [{ name: 'Neo4j' }],
        resultCount: 1,
        truncated: false,
        truncationReasons: [],
        limits: RAW_CYPHER_LIMITS,
        payloadBytes: 20,
      })
    );
    expect(mockRunRawReadQuery).toHaveBeenCalledWith(
      'MATCH (n:Technology) RETURN n.name AS name',
      {},
      {
        transactionTimeoutMs: 10_000,
        wallTimeoutMs: 12_000,
        maxRecords: 100,
        maxPayloadBytes: 256 * 1024,
        recordMode: 'native',
        metadata: { application: 'radarist', surface: 'ai-cypher-raw' },
      }
    );
  });

  it('preserves explicit record and payload truncation metadata', async () => {
    mockRunRawReadQuery.mockResolvedValueOnce({
      records: [],
      nativeRecords: [{ value: 1 }],
      summary: {},
      truncated: true,
      truncationReasons: ['payload limit'],
      payloadBytes: RAW_CYPHER_LIMITS.responseBytes,
    });

    const result = await executeExecuteCypher({ cypher: 'RETURN 1 AS value' });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        truncated: true,
        truncationReasons: ['payload limit'],
        payloadBytes: RAW_CYPHER_LIMITS.responseBytes,
      })
    );
  });

  it.each([
    'MATCH (n) INSERT (:Unsafe) RETURN n',
    'LOAD /* hidden */ CSV FROM "https://example.invalid/a.csv" AS row RETURN row',
    'RETURN 1 /* outer /* nested */ CREATE (:Unsafe) */',
    'RETURN apoc.cypher.runFirstColumnSingle("CRE" + "ATE (:Unsafe)", {})',
    'TERMINATE TRANSACTIONS "neo4j-transaction-1"',
  ])('rejects unsafe raw input before the driver: %s', async (cypher) => {
    const result = await executeExecuteCypher({ cypher });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(mockRunRawReadQuery).not.toHaveBeenCalled();
  });

  it('rejects oversized query text before the driver', async () => {
    const result = await executeExecuteCypher({
      cypher: `RETURN 1 /* ${'x'.repeat(RAW_CYPHER_LIMITS.queryBytes)} */`,
    });

    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(mockRunRawReadQuery).not.toHaveBeenCalled();
  });

  it('sanitizes driver errors returned through the tool', async () => {
    mockRunRawReadQuery.mockRejectedValueOnce(
      new Error('Failed bolt://neo4j:p4ss@localhost:7687 password="two words" access_token=>abc')
    );

    const result = await executeExecuteCypher({ cypher: 'RETURN 1' });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('bolt://');
    expect(result.error).not.toMatch(/password|token|p4ss|two words|abc/i);
    const loggedError = mockLogger.error.mock.calls.at(-1)?.[1] as Error;
    expect(loggedError.message).not.toMatch(/bolt:\/\/|password|token|p4ss|two words|abc/i);
  });

  it('routes generateCypher execute=true through the same bounded client', async () => {
    const { generateStructuredContent } = jest.requireMock('@/lib/ai/client');
    generateStructuredContent.mockResolvedValueOnce({
      intent: 'find_by_type',
      entities: [{ name: 'technologies', type: 'technology', role: 'subject' }],
      normalizedQuery: 'list technologies',
      confidence: 95,
    });

    const result = await executeGenerateCypher({
      question: 'List technologies',
      execute: true,
      limit: 500,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        executed: true,
        results: [{ name: 'Neo4j' }],
        limits: RAW_CYPHER_LIMITS,
      })
    );
    expect(mockRunRawReadQuery).toHaveBeenCalledWith(
      expect.stringContaining('MATCH (n:Entity'),
      expect.objectContaining({ entityType: 'technology' }),
      expect.objectContaining({
        transactionTimeoutMs: RAW_CYPHER_LIMITS.transactionTimeoutMs,
        maxRecords: RAW_CYPHER_LIMITS.records,
        maxPayloadBytes: RAW_CYPHER_LIMITS.responseBytes,
        recordMode: 'native',
        metadata: { application: 'radarist', surface: 'ai-cypher-generated' },
      })
    );
  });

  it('does not execute generated Cypher unless execute is the boolean true', async () => {
    const { generateStructuredContent } = jest.requireMock('@/lib/ai/client');
    generateStructuredContent.mockResolvedValueOnce({
      intent: 'statistics',
      entities: [],
      normalizedQuery: 'count entities',
      confidence: 90,
    });

    const result = await executeGenerateCypher({ question: 'Count entities', execute: 'true' });

    expect(result).toEqual(expect.objectContaining({ success: true, executed: false }));
    expect(mockRunRawReadQuery).not.toHaveBeenCalled();
  });

  it('validates literals/comments without false positives and catches obfuscated loading', async () => {
    const harmless = await executeValidateCypher({
      cypher: "MATCH (n) /* DELETE n */ RETURN 'CREATE CALL LOAD CSV' AS text LIMIT 1",
    });
    const unsafe = await executeValidateCypher({
      cypher: 'LOAD /* hidden */ CSV FROM "https://example.invalid/a.csv" AS row RETURN row',
    });

    expect(harmless).toEqual(expect.objectContaining({ success: true, isSafe: true }));
    expect(unsafe).toEqual(expect.objectContaining({ success: true, isSafe: false }));
    expect(unsafe.issues).toEqual(expect.arrayContaining([expect.stringContaining('LOAD')]));
  });
});
