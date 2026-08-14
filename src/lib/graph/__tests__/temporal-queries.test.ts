/**
 * @jest-environment node
 */

export {};

const mockRunReadTransaction = jest.fn();
const mockRunWriteTransaction = jest.fn();

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
  runWriteTransaction: (...args: unknown[]) => mockRunWriteTransaction(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { getChangedSince, getEntityTimeline, invalidatePriorEdges } = require('../temporal-queries');

describe('temporal-queries', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getChangedSince', () => {
    it('should query edges changed since a given date', async () => {
      const recordData: Record<string, unknown> = {
        sourceId: 'tech-1',
        targetId: 'company-1',
        relType: 'USES',
        t_observed: '2026-03-14T00:00:00Z',
        t_valid: '2026-03-01T00:00:00Z',
        t_invalidated: null,
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            ...recordData,
            get: (key: string) => recordData[key] ?? null,
          },
        ],
      });

      const result = await getChangedSince(new Date('2026-03-13'));
      expect(result).toHaveLength(1);
      expect(result[0].sourceId).toBe('tech-1');
      expect(result[0].relType).toBe('USES');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('t_observed');
    });

    it('should return empty array when no changes', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      const result = await getChangedSince(new Date('2026-03-14'));
      expect(result).toHaveLength(0);
    });
  });

  describe('getEntityTimeline', () => {
    it('should return ordered timeline for an entity', async () => {
      const recordData: Record<string, unknown> = {
        relType: 'USES',
        connectedEntityId: 'company-1',
        connectedEntityName: 'Acme Corp',
        t_valid: '2026-01-01T00:00:00Z',
        t_observed: '2026-02-01T00:00:00Z',
        t_invalidated: null,
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            ...recordData,
            get: (key: string) => recordData[key] ?? null,
          },
        ],
      });

      const timeline = await getEntityTimeline('tech-1');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].relType).toBe('USES');
      expect(timeline[0].connectedEntityName).toBe('Acme Corp');
    });

    it('should return empty timeline for entity with no edges', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      const timeline = await getEntityTimeline('tech-999');
      expect(timeline).toHaveLength(0);
    });
  });

  describe('invalidatePriorEdges', () => {
    it('returns 0 when the predicate fails the safe-character check', async () => {
      const n = await invalidatePriorEdges({
        subjectId: 's',
        predicate: 'uses; DROP',
        objectId: 'o',
      });
      expect(n).toBe(0);
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('sets t_invalidated on prior edges with same triple, excluding the new one', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ n: 2 }] });
      const n = await invalidatePriorEdges({
        subjectId: 'tech-1',
        predicate: 'USES',
        objectId: 'tech-2',
        excludeRelationId: 'rel-new',
      });
      expect(n).toBe(2);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(cypher).toContain('r.t_invalidated IS NULL');
      expect(cypher).toContain('SET r.t_invalidated');
      expect(cypher).toContain('[r:`USES`]');
      expect(params.excludeRelationId).toBe('rel-new');
    });

    it('returns 0 and logs when the Cypher throws', async () => {
      mockRunWriteTransaction.mockRejectedValueOnce(new Error('neo4j down'));
      const n = await invalidatePriorEdges({ subjectId: 's', predicate: 'USES', objectId: 'o' });
      expect(n).toBe(0);
    });
  });
});
