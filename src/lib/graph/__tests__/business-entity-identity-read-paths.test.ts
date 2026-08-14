/**
 * @file business-entity-identity-read-paths.test.ts
 * @description AI-026 — every retrieval entry point applies the identity
 * contract, proven per read rather than per module.
 *
 * The unit suite next door pins the RULE; this suite pins its REACH. The defect
 * survived a passing test suite because the identity envelope existed in two
 * places (`business-queries`'s allow-list, `vector-search`'s deny-list) and was
 * absent from the shared primitives every business read actually goes through.
 * A read added later that forgets the envelope is exactly the regression this
 * file is here to catch, so each entry point gets its own named assertion.
 *
 * Runs against a mocked `runReadTransaction`, so what is asserted is the query
 * the driver would receive and the parameters bound with it — the REAL identity
 * vocabulary, never a locally re-declared copy.
 *
 * @jest-environment node
 */

jest.mock('../neo4j-client', () => ({
  runReadTransaction: jest.fn(),
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  getDriver: jest.fn(),
  closeDriver: jest.fn(),
  checkHealth: jest.fn(async () => ({ healthy: true, latencyMs: 1 })),
}));
jest.mock('@/lib/ai/client', () => ({ generateEmbedding: jest.fn(async () => [0.1, 0.2]) }));

import { runReadTransaction } from '../neo4j-client';
import { Neo4jGraphService } from '../neo4j-graph-service';
import { resolveExactGraphEntity, extractSubgraph } from '../subgraph-rag';
import { resolveEntityByIdOrName } from '../resolve-entity';
import { searchEntitiesBySemantic } from '../vector-search';
import { executeQueryActiveEdges } from '@/lib/ai/tools/temporal-tools';
import { retrieveGraphFirst } from '@/lib/ai/retrieval/graph-first-retrieval';
import { GraphUnavailableError } from '../errors';
import {
  INTERNAL_MEMORY_ENTITY_TYPES,
  INTERNAL_MEMORY_GRAPH_LABELS,
  ENTITY_PROJECTION_GRAPH_LABELS,
} from '../business-entity-identity';
import { BUSINESS_ENTITY_GRAPH_LABELS } from '../entity-type-vocab';

const mockedRead = runReadTransaction as jest.Mock;

interface Call {
  cypher: string;
  params: Record<string, unknown>;
}

function calls(): Call[] {
  return mockedRead.mock.calls.map(([cypher, params]) => ({
    cypher: String(cypher),
    params: (params ?? {}) as Record<string, unknown>,
  }));
}

/**
 * The identity envelope, asserted structurally rather than by substring: the
 * query must refuse internal-memory labels, refuse any label outside the
 * projection set, refuse internal-memory `entityType` values, and bind the real
 * vocabulary for all three.
 */
function expectIdentityEnvelope(call: Call, variable: string): void {
  const flat = call.cypher.replace(/\s+/g, ' ');
  expect(flat).toContain(`NONE(identityLabel IN labels(${variable}) WHERE identityLabel IN $internalMemoryLabels)`);
  expect(flat).toContain(
    `NONE(identityLabel IN labels(${variable}) WHERE NOT identityLabel IN $entityProjectionLabels)`
  );
  expect(flat).toContain(`NOT toLower(coalesce(${variable}.entityType, '')) IN $internalMemoryEntityTypes`);
  expect(call.params).toMatchObject({
    internalMemoryLabels: INTERNAL_MEMORY_GRAPH_LABELS,
    internalMemoryEntityTypes: INTERNAL_MEMORY_ENTITY_TYPES,
    entityProjectionLabels: ENTITY_PROJECTION_GRAPH_LABELS,
    businessEntityLabels: BUSINESS_ENTITY_GRAPH_LABELS,
  });
}

/** Every node on a bound path variable must satisfy the envelope. */
function expectPathEnvelope(call: Call, pathVariable: string): void {
  expect(call.cypher.replace(/\s+/g, ' ')).toContain(`ALL(identityNode IN nodes(${pathVariable}) WHERE`);
  expectIdentityEnvelope(call, 'identityNode');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRead.mockResolvedValue({ records: [], summary: { counters: {} } });
});

describe('Neo4jGraphService', () => {
  const service = new Neo4jGraphService();

  it('getNeighbors bounds every path node and label-pins a requested type', async () => {
    await service.getNeighbors('tech-1', { entityTypes: ['company'] });

    const [call] = calls();
    expectPathEnvelope(call, 'p');
    expect(call.cypher.replace(/\s+/g, ' ')).toContain(
      'ANY(identityLabel IN labels(neighbor) WHERE identityLabel IN $targetLabels)'
    );
    expect(call.params.targetLabels).toEqual(['Company']);
  });

  it('getNeighbors bounds path nodes even with no entityTypes requested', async () => {
    // `/api/graph/neighbors` and `getEntityContext` both call it this way; it was
    // the widest leak — every bookkeeping neighbour came back untyped.
    await service.getNeighbors('tech-1', { depth: 2 });

    const [call] = calls();
    expectPathEnvelope(call, 'p');
    expect(call.params.targetLabels).toEqual([]);
    expect(call.params.targetTypes).toBeNull();
  });

  it('findConnected label-pins the target and bounds every hop', async () => {
    await service.findConnected('pain-1', 'technology', { maxDepth: 2 });

    const [call] = calls();
    expectPathEnvelope(call, 'path');
    expect(call.cypher.replace(/\s+/g, ' ')).toContain(
      'ANY(identityLabel IN labels(target) WHERE identityLabel IN $targetLabels)'
    );
    expect(call.params.targetLabels).toEqual(['Technology']);
    // The property vocabulary is still bound, for the placeholder branch only.
    expect(call.params.targetTypes).toEqual(['technology']);
  });

  it('findPath bounds every node on the path without the caller opting in', async () => {
    await service.findPath('tech-1', 'org-1');
    expectPathEnvelope(calls()[0], 'p');
  });

  it('findAllPaths bounds every node on every path', async () => {
    await service.findAllPaths('tech-1', 'org-1');
    expectPathEnvelope(calls()[0], 'p');
  });

  it('areConnected cannot report a connection through bookkeeping nodes', async () => {
    mockedRead.mockResolvedValue({ records: [{ connected: false }], summary: { counters: {} } });
    await service.areConnected('tech-1', 'org-1');
    expectPathEnvelope(calls()[0], 'p');
  });
});

describe('deterministic resolution (subgraph-rag)', () => {
  it('resolveExactGraphEntity applies the envelope to the stable-id lookup', async () => {
    await resolveExactGraphEntity('tech-1');

    const [byId] = calls();
    expect(byId.cypher).toContain('MATCH (n:Entity {id: $input})');
    expectIdentityEnvelope(byId, 'n');
    // An UNSCOPED resolution must admit any canonical label. Binding an empty
    // list here makes the label branch unsatisfiable and refuses every labelled
    // entity — a real regression the disposable-graph proof caught.
    expect(byId.params.entityLabels).toEqual([...BUSINESS_ENTITY_GRAPH_LABELS]);
  });

  it('resolveExactGraphEntity applies the envelope to the normalized-name lookup', async () => {
    await resolveExactGraphEntity('Atlas', { entityTypes: ['technology'] });

    const byName = calls()[1];
    expect(byName.cypher).toContain("db.index.fulltext.queryNodes('entity_name_idx'");
    expectIdentityEnvelope(byName, 'n');
    expect(byName.params.entityLabels).toEqual(['Technology']);
  });

  it('extractSubgraph applies the envelope to the center and every neighbour lane', async () => {
    mockedRead.mockResolvedValue({
      records: [{ id: 'tech-1', label: 'Technology', name: 'K8s', description: null }],
      summary: { counters: {} },
    });

    await extractSubgraph('tech-1', { chunks: 0 });

    const centerCall = calls().find((call) => call.cypher.includes('MATCH (n:Entity {id: $entityId})'));
    expect(centerCall).toBeDefined();
    expectIdentityEnvelope(centerCall as Call, 'n');

    const neighborCall = calls().find((call) => call.cypher.includes('(center:Entity {id: $entityId})-[r]-(other)'));
    expect(neighborCall).toBeDefined();
    expectIdentityEnvelope(neighborCall as Call, 'other');

    const temporalCall = calls().find((call) => call.cypher.includes('r.t_observed > $since'));
    expect(temporalCall).toBeDefined();
    expectIdentityEnvelope(temporalCall as Call, 'other');
  });
});

describe('name resolution helpers', () => {
  it('resolveEntityByIdOrName applies the envelope to both lanes', async () => {
    await resolveEntityByIdOrName('Atlas');

    const [byId, byName] = calls();
    expectIdentityEnvelope(byId, 'n');
    expectIdentityEnvelope(byName, 'n');
    // The reported type comes from the canonical label first.
    expect(byId.cypher).toContain('head([identityLabel IN $businessEntityLabels WHERE identityLabel IN labels(n)])');
  });

  it('the temporal-tool entityName resolver cannot match an observation title', async () => {
    // `:AgentObservation` nodes store `title`, and the old lookup matched
    // `coalesce(e.name, e.title, '')` on ANY node.
    await executeQueryActiveEdges({ entityName: 'Kubernetes' });

    const resolver = calls().find((call) => call.cypher.includes("toLower(coalesce(e.name, e.title, ''))"));
    expect(resolver).toBeDefined();
    expectIdentityEnvelope(resolver as Call, 'e');
  });
});

describe('outage degradation survives the narrowing', () => {
  /**
   * Drives `retrieveGraphFirst` through its REAL default dependencies
   * (`resolveExactGraphEntity` / `searchEntitiesBySemantic` / `extractSubgraph`),
   * not the injected fakes its own suite uses. That matters twice: it is the only
   * place the narrowed Cypher and the planner's degradation contract are
   * exercised together, and it proves a refusal caused by an OUTAGE stays
   * distinguishable from a refusal caused by identity — the narrowing must not
   * turn an unavailable graph into an honest-looking "not found".
   */
  it('reports an unavailable graph as unavailable, not as not-found', async () => {
    mockedRead.mockRejectedValue(new GraphUnavailableError('Neo4j is down', 'neo4j'));

    const result = await retrieveGraphFirst('kubernetes');

    expect(result.status).toBe('unavailable');
    expect(result.partial).toBe(true);
    expect(result.resolution.status).toBe('unavailable');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('graph-unavailable');
    expect(result.plan).toEqual([
      { stage: 'exact-resolution', outcome: 'unavailable' },
      { stage: 'semantic-resolution', outcome: 'skipped' },
      { stage: 'business-neighborhood', outcome: 'skipped' },
    ]);
  });

  it('reports a genuine miss as not-found through the same narrowed reads', async () => {
    mockedRead.mockResolvedValue({ records: [], summary: { counters: {} } });

    const result = await retrieveGraphFirst('kubernetes', { entityTypes: ['technology'] });

    expect(result.status).not.toBe('unavailable');
    expect(result.resolution.entity).toBeNull();
    // The exact lane ran and missed — it did not fail.
    expect(result.plan[0]).toEqual({ stage: 'exact-resolution', outcome: 'miss' });
  });
});

describe('semantic entity search', () => {
  it('pins each label-scoped vector index to that exact canonical label', async () => {
    await searchEntitiesBySemantic('kubernetes', 'Technology', { queryEmbedding: [0.1, 0.2] });

    const [call] = calls();
    expectIdentityEnvelope(call, 'n');
    expect(call.cypher.replace(/\s+/g, ' ')).toContain(
      'ANY(identityLabel IN labels(n) WHERE identityLabel IN $targetLabels)'
    );
    expect(call.params.targetLabels).toEqual(['Technology']);
    // A label-scoped index cannot contain a placeholder, so the property branch
    // is deliberately absent here.
    expect(call.cypher).not.toContain('$targetTypes');
  });
});
