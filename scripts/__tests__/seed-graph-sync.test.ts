/** @jest-environment node */

const mockRunWriteTransaction = jest.fn(async (..._args: unknown[]) => ({ records: [] }));
const mockDeleteEntityFromGraph = jest.fn(async (_id: string, _type: string) => ({
  assertionsDeleted: 1,
  evidenceDeleted: 1,
  projectionsDeleted: 1,
  chunksDeleted: 0,
  endpointsDeleted: 1,
}));
const mockSyncRelationAsAssertion = jest.fn(async (_input: unknown) => undefined);
const mockSyncRelationAsEdge = jest.fn(async (_input: unknown) => undefined);

jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: (...args: unknown[]) => mockRunWriteTransaction(...args),
}));
jest.mock('@/lib/graph/assertions', () => ({
  deleteEntityFromGraph: (id: string, type: string) => mockDeleteEntityFromGraph(id, type),
}));
jest.mock('@/lib/graph/relation-assertion-sync', () => ({
  syncRelationAsAssertion: (input: unknown) => mockSyncRelationAsAssertion(input),
  syncRelationAsEdge: (input: unknown) => mockSyncRelationAsEdge(input),
}));

import {
  selectSeedProjectionEntities,
  syncSeedToNeo4j,
  type SeedGraphSyncInput,
} from '../lib/seed-graph-sync';

function fixture(): SeedGraphSyncInput {
  return {
    entities: [
      { id: 'company-1', type: 'company', name: 'Company' },
      { id: 'approved', type: 'signal', name: 'Approved', properties: { status: 'Approved' } },
      { id: 'imported', type: 'signal', name: 'Imported', properties: { status: 'Imported' } },
      { id: 'detected', type: 'signal', name: 'Detected', properties: { status: 'Detected' } },
      { id: 'relation-retained', type: 'signal', name: 'Validated', properties: { status: 'Validated' } },
      { id: 'link-retained', type: 'signal', name: 'Rejected', properties: { status: 'Rejected' } },
      { id: 'archived', type: 'signal', name: 'Archived', properties: { status: 'Archived' } },
    ],
    relations: [
      {
        id: 'relation-1',
        relationType: 'uses',
        sourceSnapshot: { id: 'relation-retained', type: 'signal', name: 'Validated' },
        targetSnapshot: { id: 'company-1', type: 'company', name: 'Company' },
      },
    ],
    documentLinks: [{ id: 'link-1', entityType: 'signal', entityId: 'link-retained' }],
  };
}

describe('seed graph Signal projection parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('selects Approved/Imported and reference-required Signals only', () => {
    const selection = selectSeedProjectionEntities(fixture());

    expect(selection.entities.map((entity) => entity.id)).toEqual([
      'company-1',
      'approved',
      'imported',
      'relation-retained',
      'link-retained',
    ]);
    expect(selection.excludedSignalIds).toEqual(['detected', 'archived']);
  });

  it('applies that selection before any Neo4j entity write', async () => {
    const result = await syncSeedToNeo4j(fixture());

    expect(result.entities).toMatchObject({ selected: 5, excludedSignals: 2, synced: 5, failed: 0 });
    expect(mockRunWriteTransaction).toHaveBeenCalledTimes(5);
    expect(mockDeleteEntityFromGraph).toHaveBeenCalledTimes(2);
    expect(mockSyncRelationAsEdge).toHaveBeenCalledTimes(1);
    expect(mockSyncRelationAsAssertion).not.toHaveBeenCalled();
  });

  it('converges the same exact excluded Signal IDs on every rerun', async () => {
    await syncSeedToNeo4j(fixture());
    await syncSeedToNeo4j(fixture());

    expect(mockDeleteEntityFromGraph.mock.calls).toEqual([
      ['detected', 'signal'],
      ['archived', 'signal'],
      ['detected', 'signal'],
      ['archived', 'signal'],
    ]);
  });
});
