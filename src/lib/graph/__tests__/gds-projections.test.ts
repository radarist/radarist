/**
 * @file gds-projections.test.ts
 * @description Unit tests for GDS projection lifecycle helpers.
 *
 * CRIT-3: gds.graph.project throws on relationship-type tokens that don't
 * exist in the live database (e.g. REQUIRES) — the requested types must be
 * intersected with `CALL db.relationshipTypes()` before projecting.
 * M7: a fixed projection name ('kg-default') + drop-before-project means two
 * concurrent GDS calls destroy each other's projection — every run must get
 * a unique per-run name and drop it in a finally.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

import * as neo4jClient from '../neo4j-client';
import {
  projectKnowledgeGraph,
  dropProjection,
  withProjection,
  projectionExists,
  DEFAULT_GRAPH_NAME,
  DEFAULT_NODE_LABELS,
  DEFAULT_RELATIONSHIP_TYPES,
  CURRENT_GDS_NODE_QUERY,
  CURRENT_GDS_RELATIONSHIP_QUERY,
} from '../gds-projections';
import { CLAIM_RELATION_PREDICATES } from '../relation-registry';

const mockedRead = neo4jClient.runReadTransaction as jest.Mock;
const mockedWrite = neo4jClient.runWriteTransaction as jest.Mock;

/**
 * Dispatch read-transaction mocks by query content so the relationship-type
 * probe and the projection-exists check can coexist in one test.
 */
function mockReads({
  exists = false,
  relationshipTypes = DEFAULT_RELATIONSHIP_TYPES,
}: {
  exists?: boolean;
  relationshipTypes?: string[];
} = {}) {
  mockedRead.mockImplementation(async (cypher: string) => {
    if (cypher.includes('db.relationshipTypes')) {
      return { records: relationshipTypes.map((t) => ({ relationshipType: t })) };
    }
    if (cypher.includes('gds.graph.exists')) {
      return { records: [{ exists }] };
    }
    return { records: [] };
  });
}

/** All gds.graph.project write calls. */
function projectCalls(): Array<[string, Record<string, unknown>]> {
  return mockedWrite.mock.calls.filter(([cypher]) => (cypher as string).includes('gds.graph.project')) as Array<
    [string, Record<string, unknown>]
  >;
}

/** All gds.graph.drop write calls. */
function dropCalls(): Array<[string, Record<string, unknown>]> {
  return mockedWrite.mock.calls.filter(([cypher]) => (cypher as string).includes('gds.graph.drop')) as Array<
    [string, Record<string, unknown>]
  >;
}

describe('projectionExists', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when GDS reports the graph exists', async () => {
    mockedRead.mockResolvedValue({ records: [{ exists: true }] });
    expect(await projectionExists('g1')).toBe(true);
  });

  it('returns false when GDS reports missing projection', async () => {
    mockedRead.mockResolvedValue({ records: [{ exists: false }] });
    expect(await projectionExists('g1')).toBe(false);
  });
});

describe('projectKnowledgeGraph', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the projection vocabulary in exact parity with canonical Relation writers', () => {
    expect(DEFAULT_RELATIONSHIP_TYPES).toEqual(CLAIM_RELATION_PREDICATES);
    expect(DEFAULT_RELATIONSHIP_TYPES).toEqual(
      expect.arrayContaining(['USER', 'COMPETITOR', 'OWNED_BY', 'SPONSORS', 'DRIVES', 'EVALUATES'])
    );
    expect(DEFAULT_RELATIONSHIP_TYPES).not.toContain('MENTIONS');
  });

  it('projects canonical labels + all relationship types when all exist in the DB', async () => {
    mockReads({ exists: false, relationshipTypes: DEFAULT_RELATIONSHIP_TYPES });
    mockedWrite.mockResolvedValue({
      records: [{ graphName: 'kg-default', nodeCount: 100, relationshipCount: 200 }],
    });

    const stats = await projectKnowledgeGraph();

    expect(stats).toEqual({ graphName: 'kg-default', nodeCount: 100, relationshipCount: 200 });
    const [cypher, params] = projectCalls()[0];
    expect(cypher).toContain('gds.graph.project');
    expect(params.graphName).toBe(DEFAULT_GRAPH_NAME);
    expect(params.labels).toEqual(DEFAULT_NODE_LABELS);
    expect(params.relTypes).toEqual(DEFAULT_RELATIONSHIP_TYPES);
    expect(cypher).toContain('gds.graph.project.cypher');
    expect(params.nodeQuery).toBe(CURRENT_GDS_NODE_QUERY);
    expect(params.relationshipQuery).toBe(CURRENT_GDS_RELATIONSHIP_QUERY);
    expect(params.relationshipQuery).toContain('relationship.t_invalidated IS NULL');
    expect(params.relationshipQuery).toContain("coalesce(relationship.claimStatus, 'curated') <> 'rejected'");
  });

  it('CRIT-3: intersects requested relationship types with db.relationshipTypes() — unknown tokens are dropped, not projected', async () => {
    // Live DB has everything except REQUIRES (the token that killed 14
    // consecutive nightly runs) and FUNDS.
    const live = DEFAULT_RELATIONSHIP_TYPES.filter((t) => t !== 'REQUIRES' && t !== 'FUNDS');
    mockReads({ exists: false, relationshipTypes: live });
    mockedWrite.mockResolvedValue({
      records: [{ graphName: 'kg-default', nodeCount: 10, relationshipCount: 20 }],
    });

    await projectKnowledgeGraph();

    const [, params] = projectCalls()[0];
    expect(params.relTypes).toEqual(live);
    expect(params.relTypes).not.toContain('REQUIRES');
    expect(params.relTypes).not.toContain('FUNDS');
  });

  it('CRIT-3: throws a clear error when none of the requested relationship types exist', async () => {
    mockReads({ exists: false, relationshipTypes: ['SOMETHING_UNRELATED'] });

    await expect(projectKnowledgeGraph()).rejects.toThrow(/relationship types/i);
    expect(projectCalls()).toHaveLength(0);
  });

  it('re-reads db.relationshipTypes() on every call (per-call, not per-process cache)', async () => {
    mockReads({ exists: false });
    mockedWrite.mockResolvedValue({
      records: [{ graphName: 'kg-default', nodeCount: 1, relationshipCount: 1 }],
    });

    await projectKnowledgeGraph('g-a');
    await projectKnowledgeGraph('g-b');

    const probeCalls = mockedRead.mock.calls.filter(([c]) => (c as string).includes('db.relationshipTypes'));
    expect(probeCalls).toHaveLength(2);
  });

  it('drops existing projection before re-creating (idempotent)', async () => {
    mockReads({ exists: true });
    mockedWrite.mockResolvedValue({
      records: [{ graphName: 'kg-default', nodeCount: 10, relationshipCount: 20 }],
    });

    await projectKnowledgeGraph();

    expect(dropCalls()).toHaveLength(1);
    expect(projectCalls()).toHaveLength(1);
  });
});

describe('withProjection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('M7: generates a unique per-run projection name (base name + suffix) and passes it to fn', async () => {
    mockReads({ exists: false });
    mockedWrite.mockImplementation(async (_cypher: string, params: Record<string, unknown>) => ({
      records: [{ graphName: params.graphName, nodeCount: 5, relationshipCount: 10 }],
    }));

    const seenNames: string[] = [];
    await withProjection(DEFAULT_GRAPH_NAME, async (stats) => {
      seenNames.push(stats.graphName);
      return null;
    });
    await withProjection(DEFAULT_GRAPH_NAME, async (stats) => {
      seenNames.push(stats.graphName);
      return null;
    });

    const projected = projectCalls().map(([, p]) => p.graphName as string);
    expect(projected).toHaveLength(2);
    for (const name of projected) {
      expect(name.startsWith(`${DEFAULT_GRAPH_NAME}-`)).toBe(true);
    }
    // Two concurrent (or sequential) runs must never share a projection name.
    expect(projected[0]).not.toBe(projected[1]);
    // fn must receive the actual per-run name so its GDS calls target it.
    expect(seenNames).toEqual(projected);
  });

  it('M7: drops the unique per-run projection in a finally — even on fn error', async () => {
    mockReads({ exists: false });
    mockedWrite.mockImplementation(async (_cypher: string, params: Record<string, unknown>) => ({
      records: [{ graphName: params.graphName, nodeCount: 5, relationshipCount: 10 }],
    }));

    await expect(
      withProjection(DEFAULT_GRAPH_NAME, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const projectedName = projectCalls()[0][1].graphName as string;
    const dropped = dropCalls().map(([, p]) => p.graphName as string);
    expect(dropped).toContain(projectedName);
  });
});

describe('dropProjection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues gds.graph.drop with force=false to avoid errors on missing projection', async () => {
    mockedWrite.mockResolvedValue({ records: [{ graphName: 'kg-default' }] });
    await dropProjection();
    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('gds.graph.drop');
    expect(cypher).toContain('false');
  });
});
