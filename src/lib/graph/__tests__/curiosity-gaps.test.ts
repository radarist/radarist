jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn().mockResolvedValue({
    records: [{ id: 'gap-123' }],
  }),
  runReadTransaction: jest.fn().mockResolvedValue({
    records: [],
  }),
}));

jest.mock('@/lib/graph/ensure-edges', () => ({
  ensureEdgesForNode: jest.fn().mockResolvedValue({ edgesCreated: 2 }),
}));

import { recordCuriosityGap, resolveCuriosityGap, getOpenGaps } from '../curiosity-gaps';
import { runWriteTransaction, runReadTransaction } from '@/lib/graph/neo4j-client';
import { ensureEdgesForNode } from '@/lib/graph/ensure-edges';

const mockWrite = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;
const mockRead = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;
const mockEnsureEdges = ensureEdgesForNode as jest.MockedFunction<typeof ensureEdgesForNode>;

describe('recordCuriosityGap', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should create a CuriosityGap node', async () => {
    const id = await recordCuriosityGap({
      question: 'What is Company X pricing?',
      entityIds: ['company-1'],
      agentName: 'scout',
      priority: 'high',
      gapType: 'missing_data',
    });
    expect(mockWrite).toHaveBeenCalled();
    expect(mockWrite.mock.calls[0][0]).toContain('CREATE (g:CuriosityGap');
    expect(id).toContain('gap-');
  });

  it('should call ensureEdgesForNode', async () => {
    await recordCuriosityGap({
      question: 'Missing relation',
      entityIds: ['ent-1', 'ent-2'],
      agentName: 'linker',
      priority: 'medium',
      gapType: 'missing_relation',
    });
    expect(mockEnsureEdges).toHaveBeenCalledWith(
      expect.stringContaining('gap-'),
      'CuriosityGap',
      expect.objectContaining({ entityIds: ['ent-1', 'ent-2'] })
    );
  });
});

describe('resolveCuriosityGap', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should set resolvedAt and resolution', async () => {
    await resolveCuriosityGap('gap-1', 'Found via research');
    expect(mockWrite).toHaveBeenCalled();
    expect(mockWrite.mock.calls[0][0]).toContain('resolvedAt');
  });
});

describe('getOpenGaps', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should query unresolved gaps', async () => {
    await getOpenGaps(10);
    expect(mockRead).toHaveBeenCalled();
    expect(mockRead.mock.calls[0][0]).toContain('resolvedAt IS NULL');
    expect(mockRead.mock.calls[0][0]).toContain('LIMIT');
  });
});
