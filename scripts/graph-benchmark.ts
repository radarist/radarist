/**
 * Graph foundation benchmark — a repeatable, scored health scorecard for the
 * Neo4j graph layer. Unlike `graph:health` (a CI gate that only checks recent-
 * edge temporal/confidence coverage), this scores ALL the dimensions the
 * foundation-elevation plan cares about, so we can measure before/after each
 * phase.
 *
 * READ-ONLY: runs MATCH / SHOW / CALL db.* only. Never writes.
 *
 * Run:   npx tsx scripts/graph-benchmark.ts [--json out.json] [--label P0]
 * Output: a per-dimension 0-100 scorecard + an overall weighted score, and
 *         (optionally) a JSON snapshot for archival / diffing.
 */
import './load-env-local';

import { runReadTransaction, closeDriver } from '../src/lib/graph/neo4j-client';
import { ASSERTION_STRUCTURAL_DRIFT_CYPHER } from '../src/lib/graph/assertion-integrity';
import { CLAIM_RELATION_PREDICATES } from '../src/lib/graph/relation-registry';
import {
  evaluateGraphMemoryLiveness,
  readGraphMemoryLiveness,
  type GraphMemoryLivenessCounts,
} from '../src/lib/graph/memory-liveness';

export { ASSERTION_STRUCTURAL_DRIFT_CYPHER } from '../src/lib/graph/assertion-integrity';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run a read query, returning the first record's field or a fallback. */
let strictQueries = false;

async function scalar<T = number>(
  cypher: string,
  field: string,
  fallback: T,
  params: Record<string, unknown> = {}
): Promise<T> {
  try {
    const res = await runReadTransaction<Record<string, T>>(cypher, params);
    const v = res.records[0]?.[field];
    return v === undefined || v === null ? fallback : v;
  } catch (error) {
    if (strictQueries) {
      throw new Error(
        `Strict benchmark query failed for field "${field}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return fallback;
  }
}

/** True if the query runs without throwing (used for capability probes). */
async function probe(cypher: string): Promise<boolean> {
  try {
    await runReadTransaction(cypher);
    return true;
  } catch {
    return false;
  }
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ---------------------------------------------------------------------------
// dimensions
// ---------------------------------------------------------------------------

export interface Dimension {
  key: string;
  weight: number;
  score: number;
  metrics: Record<string, unknown>;
}

export interface GraphBenchmarkSnapshot {
  label: string;
  inventory: { totalNodes: number; totalRels: number };
  overall: number;
  dimensions: Dimension[];
}

const EXPECTED_VECTOR_INDEXES = ['chunk_embedding'];
const EXPECTED_ENTITY_VECTOR_INDEXES = ['technology_embedding', 'company_embedding', 'signal_embedding'];

async function dimSchema(): Promise<Dimension> {
  const constraints = await scalar('SHOW CONSTRAINTS YIELD name RETURN count(*) AS c', 'c', 0);
  const allIndexes = await scalar("SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN count(*) AS c", 'c', 0);
  const vectorIndexNames = new Set<string>();
  try {
    const res = await runReadTransaction<{ name: string }>(
      "SHOW INDEXES YIELD name, type WHERE type = 'VECTOR' RETURN name"
    );
    res.records.forEach((r) => vectorIndexNames.add(r.name));
  } catch {
    /* ignore */
  }
  const fulltextPresent = await scalar(
    "SHOW INDEXES YIELD name, type WHERE type = 'FULLTEXT' AND name = 'entity_name_idx' RETURN count(*) AS c",
    'c',
    0
  );
  const chunkVectorPresent = EXPECTED_VECTOR_INDEXES.every((n) => vectorIndexNames.has(n));
  const entityVectorPresent = EXPECTED_ENTITY_VECTOR_INDEXES.filter((n) => vectorIndexNames.has(n)).length;

  // Weighted schema score: chunk vector index (35) + ≥1 constraint (20) +
  // entity vector indexes (20, pro-rated) + fulltext (10) + any app index (15).
  const score =
    (chunkVectorPresent ? 35 : 0) +
    (constraints > 0 ? 20 : 0) +
    (entityVectorPresent / EXPECTED_ENTITY_VECTOR_INDEXES.length) * 20 +
    (fulltextPresent > 0 ? 10 : 0) +
    (allIndexes > 0 ? 15 : 0);

  return {
    key: 'schema',
    weight: 20,
    score: clamp(score),
    metrics: {
      constraints,
      appIndexes: allIndexes,
      chunkVectorIndex: chunkVectorPresent,
      entityVectorIndexes: `${entityVectorPresent}/${EXPECTED_ENTITY_VECTOR_INDEXES.length}`,
      entityNameFulltext: fulltextPresent > 0,
    },
  };
}

async function dimRetrieval(): Promise<Dimension> {
  // 768-dim unit-ish probe vector (non-zero norm so cosine doesn't reject it).
  const vec = `[1.0${',0.0'.repeat(767)}]`;
  const chunkQueryable = await probe(
    `CALL db.index.vector.queryNodes('chunk_embedding', 1, ${vec}) YIELD node RETURN node LIMIT 1`
  );
  const entityQueryable = await probe(
    `CALL db.index.vector.queryNodes('technology_embedding', 1, ${vec}) YIELD node RETURN node LIMIT 1`
  );
  const fulltextQueryable = await probe(
    "CALL db.index.fulltext.queryNodes('entity_name_idx', 'test') YIELD node RETURN node LIMIT 1"
  );
  const score = (chunkQueryable ? 50 : 0) + (entityQueryable ? 30 : 0) + (fulltextQueryable ? 20 : 0);
  return {
    key: 'retrieval',
    weight: 15,
    score: clamp(score),
    metrics: { chunkVectorQueryable: chunkQueryable, entityVectorQueryable: entityQueryable, fulltextQueryable },
  };
}

export interface GraphIntegrityMetrics {
  [key: string]: number;
  dupIdGroups: number;
  shadowDocuments: number;
  rejectedLiveProjectionEdges: number;
  assertionStructuralDrift: number;
  projectionTopologyMismatch: number;
  projectionStatusMismatch: number;
  curatedWithoutLiveProjection: number;
  duplicateLiveProjectionGroups: number;
  confidenceScaleLeakEdges: number;
  emptyEmbeddingChunks: number;
  testResidueNodes: number;
}

export function scoreGraphIntegrity(metrics: GraphIntegrityMetrics): number {
  const defectCategories = Object.values(metrics).filter((value) => value > 0).length;
  return 100 - Math.min(10, defectCategories) * 10;
}

export const PROJECTION_TOPOLOGY_MISMATCH_CYPHER = `
  MATCH (s)-[r]->(o)
  WHERE r.claimId IS NOT NULL AND r.t_invalidated IS NULL
  OPTIONAL MATCH (a:Assertion {id: r.claimId})
  WITH s, r, o, a
  WHERE a IS NULL
     OR coalesce(s.id, '') <> coalesce(a.subjectId, '')
     OR coalesce(o.id, '') <> coalesce(a.objectId, '')
     OR type(r) <> a.predicate
  RETURN count(r) AS c
`;

// The materializer preserves the Assertion's actual status for every asserter.
// Missing legacy edge status still reads as curated, but a missing Assertion
// status follows the Assertion creation default (proposed). Any disagreement is
// therefore real writer/reader drift rather than an asserter-type heuristic.
export const NORMALIZED_ASSERTION_STATUS_CYPHER = `coalesce(a.status, 'proposed')`;

export const NORMALIZED_PROJECTION_STATUS_CYPHER = `coalesce(r.claimStatus, 'curated')`;

export const PROJECTION_STATUS_MISMATCH_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.claimId IS NOT NULL AND r.t_invalidated IS NULL
  OPTIONAL MATCH (a:Assertion {id: r.claimId})
  WITH r, a,
       ${NORMALIZED_ASSERTION_STATUS_CYPHER} AS assertionStatus,
       ${NORMALIZED_PROJECTION_STATUS_CYPHER} AS projectionStatus
  WHERE a IS NOT NULL AND projectionStatus <> assertionStatus
  RETURN count(r) AS c
`;

async function dimIntegrity(): Promise<Dimension> {
  const dupIdGroups = await scalar(
    'MATCH (n) WHERE n.id IS NOT NULL WITH n.id AS id, count(*) AS c WHERE c > 1 RETURN count(*) AS c',
    'c',
    0
  );
  const shadowDocs = await scalar(
    'MATCH (d:Document) WHERE d.id IS NOT NULL AND EXISTS { MATCH (e:Entity) WHERE e.id = d.id AND NOT e:Document } RETURN count(DISTINCT d) AS c',
    'c',
    0
  );
  // A rejected assertion must never retain an active materialized projection.
  // Invalidated historical projections are healthy history and are deliberately
  // excluded; the previous benchmark incorrectly counted them as corruption.
  const rejectedLiveProjectionEdges = await scalar(
    `MATCH (a:Assertion {status: 'rejected'})
     MATCH ()-[r]->()
     WHERE r.claimId = a.id AND r.t_invalidated IS NULL
     RETURN count(r) AS c`,
    'c',
    0
  );
  // Assertion properties and the four structural relationships are redundant
  // by design. They must describe the same subject, object, predicate, and
  // asserter or readers can return different claims for the same node.
  const assertionStructuralDrift = await scalar(
    ASSERTION_STRUCTURAL_DRIFT_CYPHER,
    'c',
    0
  );
  // Every live claimId projection must point at an Assertion and match its
  // declared topology. Orphan projections are included in this defect count.
  const projectionTopologyMismatch = await scalar(
    PROJECTION_TOPOLOGY_MISMATCH_CYPHER,
    'c',
    0
  );
  const projectionStatusMismatch = await scalar(
    PROJECTION_STATUS_MISMATCH_CYPHER,
    'c',
    0
  );
  const curatedWithoutLiveProjection = await scalar(
    `MATCH (a:Assertion {status: 'curated'})
     WHERE NOT EXISTS {
       MATCH ()-[r]->()
       WHERE r.claimId = a.id AND r.t_invalidated IS NULL
     }
     RETURN count(a) AS c`,
    'c',
    0
  );
  const duplicateLiveProjectionGroups = await scalar(
    `MATCH ()-[r]->()
     WHERE r.claimId IS NOT NULL AND r.t_invalidated IS NULL
     WITH r.claimId AS claimId, count(r) AS projectionCount
     WHERE projectionCount > 1
     RETURN count(*) AS c`,
    'c',
    0
  );
  // Confidence-scale leak: values in (0,1] — the 0-1 seeds vs 0-100 contract.
  // Widened from `< 1` to `<= 1` (Task 16 A1, same commit as the migration's
  // leak-close): the migration heals the open (0,1) interval AND the two
  // known exactly-1.0 minter signatures, but leaves an UNSIGNATURED
  // exactly-1.0 edge as a residual on purpose (we only heal cases we can
  // prove came from a 0-1 minter). That residual is still a scale leak from
  // the reader's point of view — count it here so it stays visible instead
  // of quietly falling out of the metric the moment `< 1` stopped matching it.
  // B0: this is a by-design raw-field probe (allowlisted in the no-fossil
  // static gate) — it ORs BOTH raw fields so a leak minted straight into
  // effectiveConfidence (bypassing the legacy mirror) is still caught.
  const confidenceLeak = await scalar(
    `MATCH ()-[r]->()
     WHERE (r.confidence IS NOT NULL AND r.confidence > 0 AND r.confidence <= 1)
        OR (r.effectiveConfidence IS NOT NULL AND r.effectiveConfidence > 0 AND r.effectiveConfidence <= 1)
     RETURN count(r) AS c`,
    'c',
    0
  );
  const emptyEmbeddingChunks = await scalar(
    'MATCH (c:Chunk) WHERE c.embedding IS NULL OR size(c.embedding) = 0 RETURN count(c) AS c',
    'c',
    0
  );
  // Test-principal residue (census 10c): e2e/smoke writes that leaked into the
  // dev graph. P2 deletes the backlog; this metric is the non-growth probe.
  const testResidue = await scalar(
    `MATCH (n) WHERE (n:Episode AND n.userId = 'user-123')
        OR (n:AgentRun AND n.userId = 'user-test-789')
        OR (n:Entity AND toLower(coalesce(n.name,'')) = 'e2e test'
            AND NOT EXISTS { MATCH (n)-[:ON_RADAR]->() })
     RETURN count(n) AS c`,
    'c',
    0
  );
  const metrics: GraphIntegrityMetrics = {
    dupIdGroups,
    shadowDocuments: shadowDocs,
    rejectedLiveProjectionEdges,
    assertionStructuralDrift,
    projectionTopologyMismatch,
    projectionStatusMismatch,
    curatedWithoutLiveProjection,
    duplicateLiveProjectionGroups,
    confidenceScaleLeakEdges: confidenceLeak,
    emptyEmbeddingChunks,
    testResidueNodes: testResidue,
  };
  return {
    key: 'integrity',
    weight: 20,
    score: clamp(scoreGraphIntegrity(metrics)),
    metrics,
  };
}

async function dimCoverage(): Promise<Dimension> {
  const totalClaim = await scalar(
    'MATCH ()-[r]->() WHERE type(r) IN $claimTypes AND r.t_invalidated IS NULL RETURN count(r) AS c',
    'c',
    0,
    { claimTypes: CLAIM_RELATION_PREDICATES }
  );
  const withTemporal = await scalar(
    `MATCH ()-[r]->()
     WHERE type(r) IN $claimTypes AND r.t_invalidated IS NULL AND r.t_observed IS NOT NULL
     RETURN count(r) AS c`,
    'c',
    0,
    { claimTypes: CLAIM_RELATION_PREDICATES }
  );
  const withConfidence = await scalar(
    `MATCH ()-[r]->()
     WHERE type(r) IN $claimTypes AND r.t_invalidated IS NULL
       AND coalesce(r.effectiveConfidence, r.confidence) IS NOT NULL
     RETURN count(r) AS c`,
    'c',
    0,
    { claimTypes: CLAIM_RELATION_PREDICATES }
  );
  const temporalCoverage = pct(withTemporal, totalClaim);
  const confidenceCoverage = pct(withConfidence, totalClaim);
  const score = (temporalCoverage + confidenceCoverage) / 2;
  return {
    key: 'coverage',
    weight: 15,
    score: clamp(score),
    metrics: {
      claimEdgesLive: totalClaim,
      temporalCoveragePct: temporalCoverage,
      confidenceCoveragePct: confidenceCoverage,
    },
  };
}

async function dimGds(): Promise<Dimension> {
  const communityReports = await scalar('MATCH (c:CommunityReport) RETURN count(c) AS c', 'c', 0);
  const totalEntities = await scalar('MATCH (e:Entity) RETURN count(e) AS c', 'c', 0);
  const withCommunity = await scalar('MATCH (e:Entity) WHERE e.gdsCommunity IS NOT NULL RETURN count(e) AS c', 'c', 0);
  const gdsAvailable = await probe('RETURN gds.version() AS v');
  const communityCoverage = pct(withCommunity, totalEntities);
  // Score: GDS plugin present (20) + community coverage (40) + reports exist (40).
  const score = (gdsAvailable ? 20 : 0) + (communityCoverage / 100) * 40 + (communityReports > 0 ? 40 : 0);
  return {
    key: 'gds',
    weight: 15,
    score: clamp(score),
    metrics: { gdsPluginAvailable: gdsAvailable, communityReports, gdsCommunityCoveragePct: communityCoverage },
  };
}

export interface GraphMemoryMetrics extends GraphMemoryLivenessCounts {
  /** Diagnostic only. Embeddings belong to semantic retrieval, not episodic-memory liveness. */
  entityEmbeddingCoveragePct: number;
}

export function buildGraphMemoryDimension(metrics: GraphMemoryMetrics): Dimension {
  const liveness = evaluateGraphMemoryLiveness(metrics);
  const missionCoverage = Math.min(
    liveness.mission.groupingCoveragePct ?? 0,
    liveness.mission.provenanceCoveragePct ?? 0
  );
  const proactiveCoverage = Math.min(
    liveness.proactiveSweep.groupingCoveragePct ?? 0,
    liveness.proactiveSweep.provenanceCoveragePct ?? 0
  );
  const runCoverage = liveness.agentRuns.linkageCoveragePct ?? 0;
  // Both supported observation lanes are independently required. A zero
  // denominator earns zero rather than masquerading as 100% coverage.
  const score = missionCoverage * 0.375 + proactiveCoverage * 0.375 + runCoverage * 0.25;
  return {
    key: 'memory',
    weight: 15,
    score: clamp(score),
    metrics: {
      mission: liveness.mission,
      proactiveSweep: liveness.proactiveSweep,
      agentRunLineage: liveness.agentRuns,
      standaloneMissionObservations: metrics.mission.total - metrics.mission.eligible,
      standaloneProactiveObservations: metrics.proactiveSweep.total - metrics.proactiveSweep.eligible,
      unattributedAgentRuns: metrics.agentRuns.total - metrics.agentRuns.eligible,
      entityEmbeddingCoveragePct: metrics.entityEmbeddingCoveragePct,
      entityEmbeddingCoverageRole: 'diagnostic-semantic-retrieval',
    },
  };
}

async function dimMemory(): Promise<Dimension> {
  const [totalEntities, entityEmbeddings] = await Promise.all([
    scalar('MATCH (e:Entity) RETURN count(e) AS c', 'c', 0),
    scalar('MATCH (e:Entity) WHERE e.embedding IS NOT NULL RETURN count(e) AS c', 'c', 0),
  ]);
  let liveness;
  try {
    liveness = await readGraphMemoryLiveness();
  } catch (error) {
    if (strictQueries) {
      throw new Error(
        `Strict benchmark graph-memory query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    liveness = evaluateGraphMemoryLiveness({
      mission: { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
      proactiveSweep: { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
      agentRuns: { total: 0, eligible: 0, linked: 0 },
    });
  }

  return buildGraphMemoryDimension({
    mission: liveness.mission,
    proactiveSweep: liveness.proactiveSweep,
    agentRuns: liveness.agentRuns,
    entityEmbeddingCoveragePct: pct(entityEmbeddings, totalEntities),
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const STRICT_DIMENSIONS = ['schema', 'retrieval', 'integrity', 'coverage'] as const;

export function evaluateStrictGraphBenchmark(snapshot: GraphBenchmarkSnapshot): string[] {
  const violations: string[] = [];
  for (const key of STRICT_DIMENSIONS) {
    const dimension = snapshot.dimensions.find((candidate) => candidate.key === key);
    if (!dimension) {
      violations.push(`Missing required benchmark dimension: ${key}`);
    } else if (dimension.score !== 100) {
      violations.push(`${key} score ${dimension.score}/100; strict fixture threshold is 100/100`);
    }
  }

  const coverage = snapshot.dimensions.find((candidate) => candidate.key === 'coverage');
  const claimEdges = Number(coverage?.metrics.claimEdgesLive ?? 0);
  if (claimEdges < 2) {
    violations.push(`coverage fixture is vacuous: expected at least 2 live claim edges, found ${claimEdges}`);
  }
  if (snapshot.inventory.totalNodes < 3) {
    violations.push(`fixture inventory is vacuous: expected at least 3 nodes, found ${snapshot.inventory.totalNodes}`);
  }
  return violations;
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const strict = args.includes('--strict');
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'adhoc';
  const jsonPath = argValue(args, '--json');
  if (!label || label.startsWith('--')) throw new Error('--label requires a value');

  try {
    strictQueries = strict;
    const totalNodes = await scalar('MATCH (n) RETURN count(n) AS c', 'c', 0);
    const totalRels = await scalar('MATCH ()-[r]->() RETURN count(r) AS c', 'c', 0);

    const requiredDimensions = await Promise.all([dimSchema(), dimRetrieval(), dimIntegrity(), dimCoverage()]);
    // GDS overlays and episodic memory are valuable diagnostics, but a fresh
    // deterministic fixture intentionally does not populate them. Their query
    // failures and scores therefore do not decide strict fixture validity.
    strictQueries = false;
    const optionalDimensions = await Promise.all([dimGds(), dimMemory()]);
    const dims = [...requiredDimensions, ...optionalDimensions];

    const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
    const overall = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight);

    const snapshot: GraphBenchmarkSnapshot = {
      label,
      inventory: { totalNodes, totalRels },
      overall,
      dimensions: dims,
    };

    console.log('');
    console.log(`GRAPH BENCHMARK  [${label}]   overall: ${overall}/100`);
    console.log(`inventory: ${totalNodes} nodes / ${totalRels} rels`);
    console.log('─'.repeat(72));
    for (const d of dims) {
      const bar = '█'.repeat(Math.round(d.score / 5)).padEnd(20, '░');
      console.log(`${d.key.padEnd(11)} ${String(d.score).padStart(3)}/100 (w${d.weight}) ${bar}`);
      console.log(`            ${JSON.stringify(d.metrics)}`);
    }
    console.log('─'.repeat(72));

    if (jsonPath) {
      const fs = await import('fs');
      const path = await import('path');
      fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
      fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
      console.log(`snapshot written → ${jsonPath}`);
    }

    if (strict) {
      const violations = evaluateStrictGraphBenchmark(snapshot);
      if (violations.length > 0) {
        throw new Error(`Strict graph benchmark failed:\n- ${violations.join('\n- ')}`);
      }
      console.log('strict fixture gate: PASS');
    }
  } finally {
    strictQueries = false;
    await closeDriver();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('benchmark failed:', e);
    process.exitCode = 1;
  });
}
