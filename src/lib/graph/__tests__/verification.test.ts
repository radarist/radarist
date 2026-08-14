/**
 * @jest-environment node
 */

export {};

const mockRunWriteTransaction = jest.fn();
const mockRunReadTransaction = jest.fn();

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: (...args: unknown[]) => mockRunWriteTransaction(...args),
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const {
  createVerificationResult,
  createEdgeVerificationResult,
  getVerificationForEntity,
  deleteVerificationResultsForRelation,
  reconcileOrphanedVerificationResults,
  countOrphanedVerificationResults,
  VerificationTargetMissingError,
} = require('../verification');

const ENTITY_INPUT = {
  entityId: 'tech-1',
  status: 'verified' as const,
  score: 85,
  sourcesChecked: 3,
  sourcesConfirming: 2,
  sourcesContradicting: 0,
  verifierModel: 'gemini-2.5-pro',
  reasoning: 'Confirmed by 2 independent sources',
  strictnessLevel: 'standard' as const,
};

const EDGE_INPUT = {
  relationId: 'relation-1',
  sourceEntityId: 'tech-1',
  targetEntityId: 'company-1',
  status: 'verified' as const,
  score: 80,
  sourcesChecked: 2,
  sourcesConfirming: 2,
  sourcesContradicting: 0,
  verifierModel: 'defense-minister-v1-edge',
  reasoning: 'Both endpoints confirmed',
};

describe('verification', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createVerificationResult', () => {
    it('should create a VerificationResult node with VERIFIES relationship', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [
          {
            get: (key: string) => {
              if (key === 'id') return 'vr-1';
              return null;
            },
          },
        ],
      });

      await createVerificationResult({
        entityId: 'tech-1',
        status: 'verified',
        score: 85,
        sourcesChecked: 3,
        sourcesConfirming: 2,
        sourcesContradicting: 0,
        verifierModel: 'gemini-2.5-pro',
        reasoning: 'Confirmed by 2 independent sources',
        strictnessLevel: 'standard',
      });

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('VerificationResult');
      expect(cypher).toContain('VERIFIES');
    });

    // GRAPH-061: Cypher commits a CREATE even when a later MATCH yields no
    // rows, so the target MUST be matched before the node is created.
    it('matches the target entity before creating the node', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ id: 'vr-1', targetGeneration: null }] });

      await createVerificationResult(ENTITY_INPUT);

      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher.indexOf('MATCH (e { id: $entityId })')).toBeGreaterThanOrEqual(0);
      expect(cypher.indexOf('MATCH (e { id: $entityId })')).toBeLessThan(
        cypher.indexOf('CREATE (vr:VerificationResult')
      );
    });

    it('refuses to record a verdict when the entity is not in the graph', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await expect(createVerificationResult(ENTITY_INPUT)).rejects.toThrow(VerificationTargetMissingError);
      await expect(createVerificationResult(ENTITY_INPUT)).rejects.toMatchObject({
        name: 'VerificationTargetMissingError',
        targetKind: 'entity',
        targetId: 'tech-1',
      });
    });

    it('binds the verdict to the target generation it verified', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [{ id: 'vr-1', targetGeneration: 'fingerprint-a' }],
      });

      const created = await createVerificationResult(ENTITY_INPUT);

      expect(created.targetGeneration).toBe('fingerprint-a');
      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('targetGeneration: e.sourceFingerprint');
    });
  });

  describe('createEdgeVerificationResult', () => {
    it('refuses to record a verdict when the relation has no projected edge', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [] });

      await expect(createEdgeVerificationResult(EDGE_INPUT)).rejects.toMatchObject({
        name: 'VerificationTargetMissingError',
        targetKind: 'relation',
        targetId: 'relation-1',
      });
    });

    it('requires the exact endpoint pair and stamps the edge generation', async () => {
      mockRunWriteTransaction.mockResolvedValue({
        records: [{ id: 'evr-1', targetGeneration: 'edge-fingerprint' }],
      });

      const created = await createEdgeVerificationResult(EDGE_INPUT);

      expect(created.targetGeneration).toBe('edge-fingerprint');
      const cypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('MATCH (source { id: $sourceEntityId })-[edge { relationId: $relationId }]->');
      expect(cypher.indexOf('MATCH (source')).toBeLessThan(cypher.indexOf('CREATE (evr:EdgeVerificationResult'));
      expect(cypher).toContain('targetGeneration: edge.sourceFingerprint');
    });
  });

  describe('getVerificationForEntity', () => {
    it('should return latest verification for an entity', async () => {
      const recordData: Record<string, unknown> = {
        id: 'vr-1',
        status: 'verified',
        score: 85,
        sourcesChecked: 3,
        sourcesConfirming: 2,
        sourcesContradicting: 0,
        verifierModel: 'gemini-2.5-pro',
        reasoning: 'Confirmed',
        strictnessLevel: 'standard',
        checkedAt: '2026-03-14T00:00:00Z',
        entityId: 'tech-1',
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [
          {
            ...recordData,
            get: (key: string) => recordData[key] ?? null,
          },
        ],
      });

      const result = await getVerificationForEntity('tech-1');
      expect(result).toBeDefined();
      expect(result.status).toBe('verified');
      expect(result.score).toBe(85);
    });

    it('should return null when no verification exists', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      const result = await getVerificationForEntity('tech-999');
      expect(result).toBeNull();
    });

    it('reads through the VERIFIES binding rather than the scalar entityId', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [] });

      await getVerificationForEntity('tech-1');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('MATCH (vr:VerificationResult)-[:VERIFIES]->(e { id: $entityId })');
    });

    it('flags a verdict whose target generation has moved on', async () => {
      const recordData: Record<string, unknown> = {
        id: 'vr-1',
        status: 'verified',
        score: 85,
        sourcesChecked: 3,
        sourcesConfirming: 2,
        sourcesContradicting: 0,
        verifierModel: 'gemini-2.5-pro',
        reasoning: 'Confirmed',
        strictnessLevel: 'standard',
        checkedAt: '2026-03-14T00:00:00Z',
        entityId: 'tech-1',
        targetGeneration: 'fingerprint-a',
        currentGeneration: 'fingerprint-b',
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [{ ...recordData, get: (key: string) => recordData[key] ?? null }],
      });

      const result = await getVerificationForEntity('tech-1');
      expect(result.stale).toBe(true);
      expect(result.targetGeneration).toBe('fingerprint-a');
    });

    it('leaves staleness unlabelled when either generation is unknown', async () => {
      const recordData: Record<string, unknown> = {
        id: 'vr-legacy',
        status: 'verified',
        score: 60,
        sourcesChecked: 1,
        sourcesConfirming: 1,
        sourcesContradicting: 0,
        verifierModel: 'legacy',
        reasoning: 'Legacy verdict',
        strictnessLevel: 'standard',
        checkedAt: '2026-01-01T00:00:00Z',
        entityId: 'tech-1',
        targetGeneration: null,
        currentGeneration: 'fingerprint-b',
      };
      mockRunReadTransaction.mockResolvedValue({
        records: [{ ...recordData, get: (key: string) => recordData[key] ?? null }],
      });

      const result = await getVerificationForEntity('tech-1');
      expect(result.stale).toBeUndefined();
      expect(result.targetGeneration).toBeUndefined();
    });
  });

  describe('lifecycle cleanup (GRAPH-061)', () => {
    it('removes edge verdicts by relationId when a relation projection is torn down', async () => {
      mockRunWriteTransaction.mockResolvedValue({ records: [{ deleted: 3 }] });

      await expect(deleteVerificationResultsForRelation('relation-1')).resolves.toBe(3);
      expect(mockRunWriteTransaction.mock.calls[0][1]).toEqual({ relationId: 'relation-1' });
    });

    it('sweeps verdicts with no surviving target', async () => {
      mockRunWriteTransaction.mockResolvedValueOnce({ records: [{ deleted: 2 }] });
      mockRunWriteTransaction.mockResolvedValueOnce({ records: [{ deleted: 5 }] });

      const result = await reconcileOrphanedVerificationResults();

      expect(result).toEqual({ entityResultsDeleted: 2, edgeResultsDeleted: 5 });
      const entityCypher = mockRunWriteTransaction.mock.calls[0][0] as string;
      const edgeCypher = mockRunWriteTransaction.mock.calls[1][0] as string;
      expect(entityCypher).toContain('WHERE NOT (vr)-[:VERIFIES]->()');
      expect(edgeCypher).toContain('NOT EXISTS { MATCH ()-[edge { relationId: evr.relationId }]->() }');
    });

    it('counts orphans without deleting them', async () => {
      mockRunReadTransaction.mockResolvedValue({ records: [{ entityResults: 4, edgeResults: 1 }] });

      await expect(countOrphanedVerificationResults()).resolves.toEqual({ entityResults: 4, edgeResults: 1 });
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });
});
