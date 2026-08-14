jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn().mockResolvedValue({
    records: [{ edgesCreated: 1 }],
  }),
}));

import { getEdgeRulesForType, ensureEdgesForNode } from '../ensure-edges';
import { runWriteTransaction } from '@/lib/graph/neo4j-client';

const mockRunWrite = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;

describe('getEdgeRulesForType', () => {
  it('should return Chunk rules with CONTAINS', () => {
    const rules = getEdgeRulesForType('Chunk');
    expect(rules).toHaveLength(1);
    expect(rules[0].relationship).toBe('CONTAINS');
    expect(rules[0].direction).toBe('incoming');
  });

  it('should return Episode rules', () => {
    const rules = getEdgeRulesForType('Episode');
    expect(rules.some((r) => r.relationship === 'BELONGS_TO')).toBe(true);
    expect(rules.some((r) => r.relationship === 'FOR_MISSION')).toBe(false);
  });

  it('should return AgentRun rules', () => {
    const rules = getEdgeRulesForType('AgentRun');
    expect(rules.some((r) => r.relationship === 'EXECUTED')).toBe(true);
    expect(rules.some((r) => r.relationship === 'EXECUTED_DURING')).toBe(false);
  });

  it('should return CuriosityGap rules', () => {
    const rules = getEdgeRulesForType('CuriosityGap');
    expect(rules.some((r) => r.relationship === 'RELEVANT_TO')).toBe(true);
  });

  it('should return empty for unknown type', () => {
    expect(getEdgeRulesForType('Unknown')).toEqual([]);
  });
});

describe('ensureEdgesForNode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should run MERGE for Chunk with documentId', async () => {
    const result = await ensureEdgesForNode('chunk-1', 'Chunk', { documentId: 'doc-1' });
    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    expect(mockRunWrite.mock.calls[0][0]).toContain('CONTAINS');
    expect(result.edgesCreated).toBe(1);
  });

  it('should skip when source property is missing', async () => {
    const result = await ensureEdgesForNode('chunk-1', 'Chunk', {});
    expect(mockRunWrite).not.toHaveBeenCalled();
    expect(result.edgesCreated).toBe(0);
  });

  it('should handle array properties (UNWIND)', async () => {
    await ensureEdgesForNode('gap-1', 'CuriosityGap', { entityIds: ['e1', 'e2'] });
    expect(mockRunWrite).toHaveBeenCalled();
    expect(mockRunWrite.mock.calls[0][0]).toContain('UNWIND');
    expect(mockRunWrite.mock.calls[0][0]).toContain('RELEVANT_TO');
  });

  it('should skip empty arrays', async () => {
    await ensureEdgesForNode('gap-1', 'CuriosityGap', { entityIds: [] });
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it('should return 0 for unknown type', async () => {
    const result = await ensureEdgesForNode('x', 'UnknownType', {});
    expect(result.edgesCreated).toBe(0);
  });

  it('should handle incoming direction', async () => {
    await ensureEdgesForNode('chunk-1', 'Chunk', { documentId: 'doc-1' });
    const cypher = mockRunWrite.mock.calls[0][0];
    // For incoming: (tgt)-[:REL]->(src)
    expect(cypher).toContain('(tgt)-[:CONTAINS]->(src)');
  });

  it('should handle multiple rules for one type', async () => {
    await ensureEdgesForNode('gap-1', 'CuriosityGap', { entityIds: ['e1'], missionId: 'm1' });
    expect(mockRunWrite).toHaveBeenCalledTimes(2);
  });

  it('should not throw on Neo4j errors', async () => {
    mockRunWrite.mockRejectedValueOnce(new Error('Neo4j down'));
    const result = await ensureEdgesForNode('chunk-1', 'Chunk', { documentId: 'doc-1' });
    expect(result.edgesCreated).toBe(0);
  });
});
