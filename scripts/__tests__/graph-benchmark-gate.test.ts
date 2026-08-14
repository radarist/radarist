/** @jest-environment node */

import {
  ASSERTION_STRUCTURAL_DRIFT_CYPHER,
  NORMALIZED_ASSERTION_STATUS_CYPHER,
  NORMALIZED_PROJECTION_STATUS_CYPHER,
  PROJECTION_STATUS_MISMATCH_CYPHER,
  buildGraphMemoryDimension,
  evaluateStrictGraphBenchmark,
  scoreGraphIntegrity,
  type Dimension,
  type GraphBenchmarkSnapshot,
  type GraphIntegrityMetrics,
  type GraphMemoryMetrics,
} from '../graph-benchmark';

const CLEAN_INTEGRITY: GraphIntegrityMetrics = {
  dupIdGroups: 0,
  shadowDocuments: 0,
  rejectedLiveProjectionEdges: 0,
  assertionStructuralDrift: 0,
  projectionTopologyMismatch: 0,
  projectionStatusMismatch: 0,
  curatedWithoutLiveProjection: 0,
  duplicateLiveProjectionGroups: 0,
  confidenceScaleLeakEdges: 0,
  emptyEmbeddingChunks: 0,
  testResidueNodes: 0,
};

function dimension(key: string, score = 100, metrics: Record<string, unknown> = {}): Dimension {
  return { key, weight: 1, score, metrics };
}

function snapshot(overrides: Partial<GraphBenchmarkSnapshot> = {}): GraphBenchmarkSnapshot {
  return {
    label: 'test-fixture',
    inventory: { totalNodes: 3, totalRels: 2 },
    overall: 100,
    dimensions: [
      dimension('schema'),
      dimension('retrieval'),
      dimension('integrity'),
      dimension('coverage', 100, { claimEdgesLive: 2 }),
      dimension('gds', 0),
      dimension('memory', 0),
    ],
    ...overrides,
  };
}

describe('strict graph benchmark gate', () => {
  it('scores a clean integrity fixture at 100', () => {
    expect(scoreGraphIntegrity(CLEAN_INTEGRITY)).toBe(100);
  });

  it('deducts by defect category and caps the deduction at zero', () => {
    expect(scoreGraphIntegrity({ ...CLEAN_INTEGRITY, rejectedLiveProjectionEdges: 7 })).toBe(90);
    expect(
      scoreGraphIntegrity(Object.fromEntries(Object.keys(CLEAN_INTEGRITY).map((key) => [key, 1])) as GraphIntegrityMetrics)
    ).toBe(0);
  });

  it('counts exact structural role cardinality instead of distinct target values', () => {
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(subjects) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(objects) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(predicates) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(actors) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).not.toContain('collect(DISTINCT');
  });

  it('measures projection status against the materializer contract', () => {
    expect(NORMALIZED_ASSERTION_STATUS_CYPHER).toBe("coalesce(a.status, 'proposed')");
    expect(NORMALIZED_PROJECTION_STATUS_CYPHER).toBe("coalesce(r.claimStatus, 'curated')");
    expect(PROJECTION_STATUS_MISMATCH_CYPHER).toContain('projectionStatus <> assertionStatus');
    expect(PROJECTION_STATUS_MISMATCH_CYPHER).toContain('r.t_invalidated IS NULL');
  });

  it('accepts perfect required dimensions without requiring optional overlay data', () => {
    expect(evaluateStrictGraphBenchmark(snapshot())).toEqual([]);
  });

  it('rejects missing, imperfect, and vacuous required evidence', () => {
    const violations = evaluateStrictGraphBenchmark(
      snapshot({
        inventory: { totalNodes: 2, totalRels: 0 },
        dimensions: [
          dimension('schema', 99),
          dimension('integrity'),
          dimension('coverage', 100, { claimEdgesLive: 0 }),
        ],
      })
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('schema score 99/100'),
        expect.stringContaining('Missing required benchmark dimension: retrieval'),
        expect.stringContaining('coverage fixture is vacuous'),
        expect.stringContaining('fixture inventory is vacuous'),
      ])
    );
  });
});

const EMPTY_MEMORY: GraphMemoryMetrics = {
  mission: { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
  proactiveSweep: { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
  agentRuns: { total: 0, eligible: 0, linked: 0 },
  entityEmbeddingCoveragePct: 0,
};

describe('graph memory benchmark', () => {
  it('requires a non-vacuous, complete mission lane', () => {
    const dimension = buildGraphMemoryDimension({
      ...EMPTY_MEMORY,
      mission: { total: 4, eligible: 2, grouped: 2, provenanceComplete: 2 },
    });

    expect(dimension.score).toBe(38);
    expect(dimension.metrics).toMatchObject({
      mission: { eligible: 2, groupingCoveragePct: 100, provenanceCoveragePct: 100, alive: true },
      proactiveSweep: { eligible: 0, groupingCoveragePct: null, alive: false },
      standaloneMissionObservations: 2,
    });
  });

  it('requires the proactive denominator to be sweep-owned rather than every AgentObservation', () => {
    const dimension = buildGraphMemoryDimension({
      ...EMPTY_MEMORY,
      proactiveSweep: { total: 987, eligible: 1, grouped: 1, provenanceComplete: 1 },
    });

    expect(dimension.score).toBe(38);
    expect(dimension.metrics).toMatchObject({
      proactiveSweep: { eligible: 1, groupingCoveragePct: 100, provenanceCoveragePct: 100, alive: true },
      standaloneProactiveObservations: 986,
    });
  });

  it('scores complete mission, proactive, and run-lineage fixtures at 100', () => {
    const dimension = buildGraphMemoryDimension({
      mission: { total: 1, eligible: 1, grouped: 1, provenanceComplete: 1 },
      proactiveSweep: { total: 1, eligible: 1, grouped: 1, provenanceComplete: 1 },
      agentRuns: { total: 2, eligible: 2, linked: 2 },
      entityEmbeddingCoveragePct: 3.6,
    });

    expect(dimension.score).toBe(100);
    expect(dimension.metrics).toMatchObject({
      agentRunLineage: { linkageCoveragePct: 100, alive: true },
      entityEmbeddingCoveragePct: 3.6,
      entityEmbeddingCoverageRole: 'diagnostic-semantic-retrieval',
    });
  });

  it('scores partial coverage by the supported denominators', () => {
    const dimension = buildGraphMemoryDimension({
      mission: { total: 2, eligible: 2, grouped: 1, provenanceComplete: 2 },
      proactiveSweep: { total: 2, eligible: 2, grouped: 2, provenanceComplete: 1 },
      agentRuns: { total: 4, eligible: 2, linked: 1 },
      entityEmbeddingCoveragePct: 100,
    });

    expect(dimension.score).toBe(50);
  });

  it('does not infer liveness from standalone history or embedding coverage', () => {
    const noEmbeddings = buildGraphMemoryDimension({
      ...EMPTY_MEMORY,
      mission: { ...EMPTY_MEMORY.mission, total: 10 },
      proactiveSweep: { ...EMPTY_MEMORY.proactiveSweep, total: 987 },
      agentRuns: { ...EMPTY_MEMORY.agentRuns, total: 62 },
    });
    const fullEmbeddings = buildGraphMemoryDimension({
      ...EMPTY_MEMORY,
      entityEmbeddingCoveragePct: 100,
    });

    expect(noEmbeddings.score).toBe(0);
    expect(fullEmbeddings.score).toBe(0);
    expect(noEmbeddings.metrics).toMatchObject({
      standaloneMissionObservations: 10,
      standaloneProactiveObservations: 987,
      unattributedAgentRuns: 62,
    });
  });
});
