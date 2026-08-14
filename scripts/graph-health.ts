/**
 * Graph health check — emits JSON metrics and exits non-zero if new-edge
 * temporal/confidence coverage falls below thresholds.
 *
 * Thresholds apply to edges created in the last 7 days. Historical edges
 * are reported but not gated (many predate the Claim model).
 *
 * Run: npm run graph:health
 */
// MUST be the first import — see scripts/load-env-local.ts for why.
// (`neo4j-client` reads env lazily so it would have worked with a
// body-level dotenv.config(), but using the bootstrap keeps the pattern
// consistent across scripts and survives future static-import additions.)
import './load-env-local';

import { runReadTransaction, closeDriver } from '../src/lib/graph/neo4j-client';
import { countOrphanedVerificationResults } from '../src/lib/graph/verification';
import { expectedSchemaObjects } from '../src/lib/graph/schema-manifest';
import { CLAIM_RELATION_PREDICATES } from '../src/lib/graph/relation-registry';
import { relationTypeLowerSchema } from '../src/lib/graph/validation';
import {
  collectSignalProjectionReferences,
  decideSignalProjection,
  type SignalProjectionDocumentLinkSource,
  type SignalProjectionRelationSource,
} from '../src/lib/graph/signal-projection-policy';
import {
  auditRelationTripleLocks,
  RELATION_TRIPLE_LOCK_COLLECTION,
  type RelationTripleLockAuditResult,
} from '../src/lib/relations-triple-key';
import {
  auditRadarPlacementPairLocks,
  RADAR_PLACEMENT_PAIR_LOCK_COLLECTION,
  type RadarPlacementPairAuditResult,
} from '../src/lib/radar-placement-pair-key';
import { evaluateCountDiff, type CountDiffEntry } from './lib/graph-count-diff';
import {
  evaluateDisconnectedEntityRates,
  measuredRatio,
  type DisconnectedEntityRate,
} from './lib/graph-health-diagnostics';

/**
 * Diff the live schema against the manifest. A zero-schema DB (the CRIT-2
 * failure mode) previously passed health green; now the missing objects are
 * reported. Gated by GRAPH_HEALTH_SKIP_SCHEMA so the pre-P2 live instance
 * (whose schema isn't applied until dedupe) can still run the coverage gate.
 */
async function assertSchema(): Promise<{ missing: string[] }> {
  const expected = expectedSchemaObjects();
  const liveConstraints = new Set<string>();
  const liveIndexes = new Set<string>();
  try {
    const c = await runReadTransaction<{ name: string }>('SHOW CONSTRAINTS YIELD name RETURN name');
    c.records.forEach((r) => liveConstraints.add(r.name));
    const i = await runReadTransaction<{ name: string }>('SHOW INDEXES YIELD name RETURN name');
    i.records.forEach((r) => liveIndexes.add(r.name));
  } catch {
    return { missing: ['<SHOW CONSTRAINTS/INDEXES failed>'] };
  }
  const missing: string[] = [];
  for (const n of expected.constraints) if (!liveConstraints.has(n)) missing.push(`constraint:${n}`);
  for (const n of [...expected.indexes, ...expected.vectorIndexes, ...expected.fulltextIndexes])
    if (!liveIndexes.has(n)) missing.push(`index:${n}`);
  return { missing };
}

const TEMPORAL_THRESHOLD = 0.95;
const CONFIDENCE_THRESHOLD = 0.95;
const ZOMBIE_EPISODE_LIMIT = 10;
const RECENT_EDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// The temporal/confidence gate applies to CLAIM-BEARING typed relations (the
// canonical relation-write predicates). Structural /
// provenance / agent edges (HAS_CONCEPT, ABOUT, CONTAINS, MENTIONS,
// ASSERTED_BY, SUPPORTED_BY, ABOUT_SUBJECT/OBJECT, EXECUTED, EXPLORED,
// VERIFIES, BELONGS_TO, …) legitimately carry no confidence and are excluded.
// Community reports are refreshed nightly — if the latest one is older than
// 48h something is wrong with the cron (gives one full day of grace).
const COMMUNITY_REPORT_STALENESS_MS = 48 * 60 * 60 * 1000;

interface Metrics {
  totalNodes: number;
  totalRelationships: number;
  gdsVersion: string | null;
  temporalCoverageAll: number;
  confidenceCoverageAll: number;
  temporalCoverageRecent: number | null;
  confidenceCoverageRecent: number | null;
  claimBearingEdgeCount: number;
  recentClaimBearingEdgeCount: number;
  claimCount: number;
  /** :Assertion node count — Graphiti-aligned alternative to :Claim. F1+ schema. */
  assertionCount: number;
  evidenceCount: number;
  /** :CommunityReport overlay node count (F2). */
  communityReportCount: number;
  /** ms since epoch of the most recent :CommunityReport, or null if none exist. */
  communityReportLatestMs: number | null;
  /** Edges with t_invalidated IS NULL and t_valid set — "what is still true". */
  activeEdgeCount: number;
  /** Edges with t_invalidated set — superseded facts, kept for history. */
  invalidatedEdgeCount: number;
  disconnectedEntityRates: DisconnectedEntityRate[];
  zombieEpisodes: number;
  /** GRAPH-061 — verifier verdicts whose target entity/relation no longer exists. */
  orphanedVerifierResults: { entityResults: number; edgeResults: number };
}

async function queryCounts(): Promise<{ totalNodes: number; totalRelationships: number }> {
  const nodes = await runReadTransaction<{ total: number }>('MATCH (n) RETURN count(n) AS total');
  const rels = await runReadTransaction<{ total: number }>('MATCH ()-[r]->() RETURN count(r) AS total');
  return {
    totalNodes: nodes.records[0]?.total ?? 0,
    totalRelationships: rels.records[0]?.total ?? 0,
  };
}

async function queryGdsVersion(): Promise<string | null> {
  try {
    const g = await runReadTransaction<{ version: string }>('RETURN gds.version() AS version');
    return g.records[0]?.version ?? null;
  } catch {
    return null;
  }
}

export const LIVE_CLAIM_COVERAGE_CYPHER = `
  MATCH ()-[r]->()
  WHERE type(r) IN $claimTypes AND r.t_invalidated IS NULL
  RETURN
    count(r) AS total,
    count(CASE WHEN r.t_observed IS NOT NULL THEN 1 END) AS withTemporal,
    count(CASE WHEN coalesce(r.effectiveConfidence, r.confidence) IS NOT NULL THEN 1 END) AS withConfidence,
    count(CASE WHEN r.createdAt IS NOT NULL AND toInteger(r.createdAt) >= $cutoff THEN 1 END) AS recentTotal,
    count(CASE WHEN r.createdAt IS NOT NULL AND toInteger(r.createdAt) >= $cutoff AND r.t_observed IS NOT NULL THEN 1 END) AS recentWithTemporal,
    count(CASE WHEN r.createdAt IS NOT NULL AND toInteger(r.createdAt) >= $cutoff AND coalesce(r.effectiveConfidence, r.confidence) IS NOT NULL THEN 1 END) AS recentWithConfidence
`;

interface ClaimCoverageRow {
  total: number;
  withTemporal: number;
  withConfidence: number;
  recentTotal: number;
  recentWithTemporal: number;
  recentWithConfidence: number;
}

export function evaluateClaimCoverageRow(r: ClaimCoverageRow): {
  temporalAll: number;
  confidenceAll: number;
  temporalRecent: number | null;
  confidenceRecent: number | null;
  total: number;
  recentTotal: number;
} {
  return {
    temporalAll: measuredRatio(r.withTemporal, r.total) ?? 0,
    confidenceAll: measuredRatio(r.withConfidence, r.total) ?? 0,
    temporalRecent: measuredRatio(r.recentWithTemporal, r.recentTotal),
    confidenceRecent: measuredRatio(r.recentWithConfidence, r.recentTotal),
    total: r.total,
    recentTotal: r.recentTotal,
  };
}

async function queryCoverage(): Promise<ReturnType<typeof evaluateClaimCoverageRow>> {
  const cutoff = Date.now() - RECENT_EDGE_WINDOW_MS;
  const result = await runReadTransaction<ClaimCoverageRow>(LIVE_CLAIM_COVERAGE_CYPHER, {
    cutoff,
    claimTypes: CLAIM_RELATION_PREDICATES,
  });
  return evaluateClaimCoverageRow(result.records[0]);
}

async function queryClaimCounts(): Promise<{
  claimCount: number;
  assertionCount: number;
  evidenceCount: number;
}> {
  const claims = await runReadTransaction<{ count: number }>('MATCH (c:Claim) RETURN count(c) AS count');
  const assertions = await runReadTransaction<{ count: number }>('MATCH (a:Assertion) RETURN count(a) AS count');
  const evidence = await runReadTransaction<{ count: number }>('MATCH (e:Evidence) RETURN count(e) AS count');
  return {
    claimCount: claims.records[0]?.count ?? 0,
    assertionCount: assertions.records[0]?.count ?? 0,
    evidenceCount: evidence.records[0]?.count ?? 0,
  };
}

async function queryCommunityReports(): Promise<{ count: number; latestMs: number | null }> {
  const result = await runReadTransaction<{ count: number; latest: number | null }>(
    'MATCH (c:CommunityReport) RETURN count(c) AS count, max(c.generatedAt) AS latest'
  );
  const row = result.records[0];
  return {
    count: row?.count ?? 0,
    latestMs: row?.latest != null ? Number(row.latest) : null,
  };
}

async function queryActiveEdgeCoverage(): Promise<{ active: number; invalidated: number }> {
  const result = await runReadTransaction<{ active: number; invalidated: number }>(
    `
    MATCH ()-[r]->()
    WHERE r.t_valid IS NOT NULL
    RETURN
      count(CASE WHEN r.t_invalidated IS NULL THEN 1 END) AS active,
      count(CASE WHEN r.t_invalidated IS NOT NULL THEN 1 END) AS invalidated
    `
  );
  const row = result.records[0];
  return {
    active: row?.active ?? 0,
    invalidated: row?.invalidated ?? 0,
  };
}

async function queryDisconnectedEntityRates(): Promise<DisconnectedEntityRate[]> {
  const result = await runReadTransaction<DisconnectedEntityRate>(
    `
    MATCH (n:Entity)
    WITH coalesce(head([l IN labels(n) WHERE l <> 'Entity']), 'EntityOnly') AS label,
         count(n) AS total,
         sum(CASE WHEN NOT (n)--() THEN 1 ELSE 0 END) AS disconnected
    RETURN label, total, disconnected, toFloat(disconnected) / toFloat(total) AS rate
    ORDER BY rate DESC
    `
  );
  return result.records;
}

/**
 * P3-B graph:health v2 — Firestore↔Neo4j per-type count diff (>5% fails).
 *
 * Env-gated behind GRAPH_HEALTH_COUNT_DIFF=1 because it needs BOTH stores up
 * (Firestore emulator/live + Neo4j); the default offline gate stays
 * Neo4j-only. Uses Firestore aggregate count() — ~1 read per collection.
 * Collection↔label pairs mirror reconcile-firestore-neo4j.ts.
 */
export const COUNT_DIFF_PAIRS: Array<{ collection: string; label: string }> = [
  { collection: 'companies', label: 'Company' },
  { collection: 'technologies', label: 'Technology' },
  { collection: 'strategies', label: 'Strategy' },
  { collection: 'painPoints', label: 'PainPoint' },
  { collection: 'use-cases', label: 'UseCase' },
  { collection: 'signals', label: 'Signal' },
  { collection: 'org-units', label: 'OrgUnit' },
  { collection: 'initiatives', label: 'Initiative' },
  { collection: 'prototypes', label: 'Prototype' },
];

export interface SignalProjectionCountInput {
  signals: ReadonlyArray<{ id: string; status?: unknown }>;
  relations?: readonly SignalProjectionRelationSource[];
  documentLinks?: readonly SignalProjectionDocumentLinkSource[];
}

export function countExpectedSignalProjections(input: SignalProjectionCountInput): number {
  const references = collectSignalProjectionReferences(input);
  return input.signals.filter((signal) => decideSignalProjection(signal.status, references.get(signal.id)).eligible)
    .length;
}

async function getAdminFirestore(): Promise<import('firebase-admin/firestore').Firestore> {
  // Direct admin-SDK init keeps this standalone operator command independent —
  // `src/lib/firebase-admin.ts` is `import 'server-only'` and can't load in a
  // plain Node script.
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (serviceAccountPath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const serviceAccount = require(serviceAccountPath);
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      // Default credentials (GOOGLE_APPLICATION_CREDENTIALS / emulator / Cloud Run)
      initializeApp();
    }
  }
  return getFirestore();
}

async function gatherCountDiff(): Promise<CountDiffEntry[]> {
  const db = await getAdminFirestore();

  const entries: CountDiffEntry[] = [];
  for (const { collection, label } of COUNT_DIFF_PAIRS) {
    let firestore: number;
    if (collection === 'signals') {
      const [signals, relations, documentLinks] = await Promise.all([
        db.collection('signals').select('status').get(),
        db.collection('relations').select('sourceSnapshot', 'targetSnapshot').get(),
        db.collection('entityDocumentLinks').where('entityType', '==', 'signal').select('entityId').get(),
      ]);
      firestore = countExpectedSignalProjections({
        signals: signals.docs.map((doc) => ({ ...doc.data(), id: doc.id })),
        relations: relations.docs.map((doc) => ({ ...doc.data(), id: doc.id })),
        documentLinks: documentLinks.docs.map((doc) => ({ ...doc.data(), id: doc.id, entityType: 'signal' })),
      });
    } else {
      const aggregate = await db.collection(collection).count().get();
      firestore = aggregate.data().count;
    }
    const neo4jResult = await runReadTransaction<{ count: number }>(`MATCH (n:${label}) RETURN count(n) AS count`);
    const neo4j = neo4jResult.records[0]?.count ?? 0;
    entries.push({ type: label, firestore, neo4j });
  }
  return entries;
}

async function gatherRelationTripleLockAudit(): Promise<RelationTripleLockAuditResult> {
  const db = await getAdminFirestore();
  const [relationSnapshot, lockSnapshot] = await Promise.all([
    db.collection('relations').select('sourceSnapshot', 'targetSnapshot', 'relationType').get(),
    db.collection(RELATION_TRIPLE_LOCK_COLLECTION).select('relationId').get(),
  ]);

  const relations = relationSnapshot.docs.map((document) => {
    const data = document.data();
    const sourceId = (data.sourceSnapshot as { id?: unknown } | undefined)?.id;
    const targetId = (data.targetSnapshot as { id?: unknown } | undefined)?.id;
    const relationType = relationTypeLowerSchema.safeParse(data.relationType);
    if (typeof sourceId !== 'string' || typeof targetId !== 'string' || !relationType.success) {
      throw new Error(`Malformed relation topology in relations/${document.id}`);
    }
    return { id: document.id, sourceId, targetId, relationType: relationType.data };
  });
  const locks = lockSnapshot.docs.map((document) => {
    const relationId = document.get('relationId');
    if (relationId !== undefined && typeof relationId !== 'string') {
      throw new Error(`Malformed relationId in ${RELATION_TRIPLE_LOCK_COLLECTION}/${document.id}`);
    }
    return { id: document.id, ...(relationId === undefined ? {} : { relationId }) };
  });
  return auditRelationTripleLocks(relations, locks);
}

export function evaluateRelationTripleLockAudit(result: RelationTripleLockAuditResult): string[] {
  if (result.healthy) return [];
  return [
    `Relation triple-lock drift: ${result.missingLockKeys.length} missing, ` +
      `${result.duplicateRelationKeys.length} duplicate triples, ` +
      `${result.mismatchedLocks.length} mismatched, ${result.orphanLockKeys.length} orphan locks`,
  ];
}

/**
 * GRAPH-066 #9 — Firestore-side pair-lock drift audit for RadarPlacements,
 * mirroring the relation triple-lock audit. Reads the placements + their pair
 * locks and runs the pure `auditRadarPlacementPairLocks` (missing / duplicate /
 * mismatched / orphan). Fails closed without mutating data.
 */
async function gatherRadarPlacementPairLockAudit(): Promise<RadarPlacementPairAuditResult> {
  const db = await getAdminFirestore();
  const [placementSnapshot, lockSnapshot] = await Promise.all([
    db.collection('radarPlacements').select('radarId', 'technologyId').get(),
    db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).select('placementId').get(),
  ]);

  const placements = placementSnapshot.docs.map((document) => {
    const radarId = document.get('radarId');
    const technologyId = document.get('technologyId');
    if (typeof radarId !== 'string' || typeof technologyId !== 'string') {
      throw new Error(`Malformed placement identity in radarPlacements/${document.id}`);
    }
    return { id: document.id, radarId, technologyId };
  });
  const locks = lockSnapshot.docs.map((document) => {
    const placementId = document.get('placementId');
    if (placementId !== undefined && typeof placementId !== 'string') {
      throw new Error(`Malformed placementId in ${RADAR_PLACEMENT_PAIR_LOCK_COLLECTION}/${document.id}`);
    }
    return { id: document.id, ...(placementId === undefined ? {} : { placementId }) };
  });
  return auditRadarPlacementPairLocks(placements, locks);
}

export function evaluateRadarPlacementPairLockAudit(result: RadarPlacementPairAuditResult): string[] {
  if (result.healthy) return [];
  return [
    `RadarPlacement pair-lock drift: ${result.missingLockKeys.length} missing, ` +
      `${result.duplicatePairKeys.length} duplicate pairs, ` +
      `${result.mismatchedLocks.length} mismatched, ${result.orphanLockKeys.length} orphan locks`,
  ];
}

interface RadarPlacementGraphIntegrity {
  duplicatePairKeys: number;
  missingPairKeys: number;
  duplicatePlacementIds: number;
  badPlacesCardinality: number;
  badOnRadarCardinality: number;
}

/**
 * GRAPH-066 #9 — Neo4j-side pair integrity: duplicate/missing pairKey, duplicate
 * placement ids, and PLACES / ON_RADAR cardinality (each converged placement has
 * exactly one of each). One bounded query returns the counts.
 */
async function queryRadarPlacementGraphIntegrity(): Promise<RadarPlacementGraphIntegrity> {
  const result = await runReadTransaction<RadarPlacementGraphIntegrity>(
    `
    CALL {
      MATCH (p:RadarPlacement) WHERE p.pairKey IS NOT NULL
      WITH p.pairKey AS k, count(*) AS c WHERE c > 1
      RETURN count(*) AS duplicatePairKeys
    }
    CALL {
      MATCH (p:RadarPlacement) WHERE p.pairKey IS NULL
      RETURN count(*) AS missingPairKeys
    }
    CALL {
      MATCH (p:RadarPlacement)
      WITH p.id AS id, count(*) AS c WHERE c > 1
      RETURN count(*) AS duplicatePlacementIds
    }
    CALL {
      MATCH (p:RadarPlacement)
      WITH p, size([(p)-[r:PLACES]->() | r]) AS places WHERE places <> 1
      RETURN count(*) AS badPlacesCardinality
    }
    CALL {
      MATCH (p:RadarPlacement)
      WITH p, size([(p)-[r:ON_RADAR]->() | r]) AS onRadar WHERE onRadar <> 1
      RETURN count(*) AS badOnRadarCardinality
    }
    RETURN duplicatePairKeys, missingPairKeys, duplicatePlacementIds, badPlacesCardinality, badOnRadarCardinality
    `,
    {}
  );
  return (
    result.records[0] ?? {
      duplicatePairKeys: 0,
      missingPairKeys: 0,
      duplicatePlacementIds: 0,
      badPlacesCardinality: 0,
      badOnRadarCardinality: 0,
    }
  );
}

export function evaluateRadarPlacementGraphIntegrity(m: RadarPlacementGraphIntegrity): string[] {
  const violations: string[] = [];
  if (m.duplicatePairKeys > 0)
    violations.push(`Neo4j has ${m.duplicatePairKeys} duplicate RadarPlacement.pairKey group(s)`);
  if (m.missingPairKeys > 0) violations.push(`Neo4j has ${m.missingPairKeys} RadarPlacement node(s) missing pairKey`);
  if (m.duplicatePlacementIds > 0)
    violations.push(`Neo4j has ${m.duplicatePlacementIds} duplicate RadarPlacement.id group(s)`);
  if (m.badPlacesCardinality > 0)
    violations.push(`Neo4j has ${m.badPlacesCardinality} RadarPlacement node(s) without exactly one PLACES edge`);
  if (m.badOnRadarCardinality > 0)
    violations.push(`Neo4j has ${m.badOnRadarCardinality} RadarPlacement node(s) without exactly one ON_RADAR edge`);
  return violations;
}

async function queryZombies(): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    `
    MATCH (e:Episode {status: 'active'})
    WHERE e.startedAt < datetime() - duration('PT1H')
    RETURN count(e) AS count
    `
  );
  return result.records[0]?.count ?? 0;
}

async function gather(): Promise<Metrics> {
  const [
    counts,
    gdsVersion,
    coverage,
    claimCounts,
    communityReports,
    activeEdges,
    disconnectedEntityRates,
    zombieEpisodes,
    orphanedVerifierResults,
  ] = await Promise.all([
    queryCounts(),
    queryGdsVersion(),
    queryCoverage(),
    queryClaimCounts(),
    queryCommunityReports(),
    queryActiveEdgeCoverage(),
    queryDisconnectedEntityRates(),
    queryZombies(),
    countOrphanedVerificationResults(),
  ]);

  return {
    totalNodes: counts.totalNodes,
    totalRelationships: counts.totalRelationships,
    gdsVersion,
    temporalCoverageAll: coverage.temporalAll,
    confidenceCoverageAll: coverage.confidenceAll,
    temporalCoverageRecent: coverage.temporalRecent,
    confidenceCoverageRecent: coverage.confidenceRecent,
    claimBearingEdgeCount: coverage.total,
    recentClaimBearingEdgeCount: coverage.recentTotal,
    claimCount: claimCounts.claimCount,
    assertionCount: claimCounts.assertionCount,
    evidenceCount: claimCounts.evidenceCount,
    communityReportCount: communityReports.count,
    communityReportLatestMs: communityReports.latestMs,
    activeEdgeCount: activeEdges.active,
    invalidatedEdgeCount: activeEdges.invalidated,
    disconnectedEntityRates,
    zombieEpisodes,
    orphanedVerifierResults,
  };
}

/**
 * GRAPH-061 — a verifier verdict about a target that no longer exists is a
 * trust claim with no subject. The deleters cascade on every supported path and
 * the 15-minute reconciler sweeps the rest, so a nonzero count here means one
 * of those two guarantees is broken. Warning, not violation: the sweep is
 * eventually consistent, and a release must not fail because a deletion
 * happened between the last reconcile tick and this gate.
 */
export function evaluateOrphanedVerifierResults(m: { entityResults: number; edgeResults: number }): string[] {
  const warnings: string[] = [];
  if (m.entityResults > 0) {
    warnings.push(
      `${m.entityResults} :VerificationResult node(s) have no VERIFIES target. ` +
        'The reconcile-firestore-neo4j sweep removes these; a persistent count means the deletion cascade is broken.'
    );
  }
  if (m.edgeResults > 0) {
    warnings.push(
      `${m.edgeResults} :EdgeVerificationResult node(s) reference a relationId with no projected edge. ` +
        'The reconcile-firestore-neo4j sweep removes these; a persistent count means the relation deleter is not cascading.'
    );
  }
  return warnings;
}

/**
 * Gate decision for a graph with zero claim-bearing edges (LOCAL-009).
 *
 * A genuinely blank workspace — no relationships of ANY type, no Claims, no
 * Assertions — is a valid durable state and must not fail the health gate:
 * coverage over an empty set is vacuously healthy ('vacuous'). But zero
 * claim-bearing edges alongside typed edges, Claims, or Assertions means the
 * claim-edge contract is broken and the gate must stay fail-closed
 * ('violation'). A Firestore-populated workspace whose sync never ran is
 * caught by the cross-store count audit, not this gate.
 */
export function classifyMissingClaimEdges(m: {
  claimBearingEdgeCount: number;
  claimCount?: number;
  assertionCount?: number;
}): 'measurable' | 'vacuous' | 'violation' {
  if (m.claimBearingEdgeCount > 0) return 'measurable';
  // Structural edges (ON_RADAR, ABOUT_*, projections) legitimately exist in a
  // workspace that has radars/placements but zero relations — only recorded
  // Claims/Assertions without materialized claim edges break the contract.
  // A never-synced populated Firestore is guarded by the entity count audit
  // and the relation triple-lock audit, not this gate.
  const vacuous = (m.claimCount ?? 0) === 0 && (m.assertionCount ?? 0) === 0;
  return vacuous ? 'vacuous' : 'violation';
}

export async function main() {
  const m = await gather();
  console.log(JSON.stringify(m, null, 2));

  const violations: string[] = [];
  const warnings: string[] = [];
  if (m.gdsVersion === null) violations.push('GDS plugin not installed');
  const claimEdgeState = classifyMissingClaimEdges(m);
  if (claimEdgeState === 'vacuous') {
    warnings.push(
      'No claims or assertions exist yet (blank or relation-free workspace); temporal/confidence coverage is vacuously healthy. Entity-count and relation-lock audits still guard a broken sync.'
    );
  } else if (claimEdgeState === 'violation') {
    violations.push('No claim-bearing relationship edges; temporal/confidence coverage is not measurable');
  } else if (m.recentClaimBearingEdgeCount === 0) {
    warnings.push('No claim-bearing edges were created in the last 7 days; recent coverage is not measurable.');
  }
  if (m.temporalCoverageRecent !== null && m.temporalCoverageRecent < TEMPORAL_THRESHOLD) {
    violations.push(
      `Recent temporal coverage ${(m.temporalCoverageRecent * 100).toFixed(1)}% < threshold ${TEMPORAL_THRESHOLD * 100}%`
    );
  }
  if (m.confidenceCoverageRecent !== null && m.confidenceCoverageRecent < CONFIDENCE_THRESHOLD) {
    violations.push(
      `Recent confidence coverage ${(m.confidenceCoverageRecent * 100).toFixed(1)}% < threshold ${CONFIDENCE_THRESHOLD * 100}%`
    );
  }
  if (m.zombieEpisodes > ZOMBIE_EPISODE_LIMIT) {
    violations.push(`${m.zombieEpisodes} zombie Episodes (active > 1h)`);
  }

  warnings.push(...evaluateDisconnectedEntityRates(m.disconnectedEntityRates));
  warnings.push(...evaluateOrphanedVerifierResults(m.orphanedVerifierResults));

  // Schema assertion (CRIT-2). Skippable while the live instance predates the
  // P2 dedupe+apply step, since uniqueness constraints can't land on dup data.
  if (!process.env.GRAPH_HEALTH_SKIP_SCHEMA) {
    const schema = await assertSchema();
    if (schema.missing.length > 0) {
      const preview = schema.missing.slice(0, 8).join(', ');
      violations.push(
        `${schema.missing.length} missing schema objects (${preview}${schema.missing.length > 8 ? ', …' : ''}). ` +
          'Run `npm run neo4j:init-schema` (dedupe first if constraints fail).'
      );
    }
  }

  // P3-B — Firestore↔Neo4j count-diff gate (>5% divergence per entity type).
  // Env-gated: needs both stores reachable, so it doesn't run in the default
  // offline invocation. Enable with GRAPH_HEALTH_COUNT_DIFF=1.
  if (process.env.GRAPH_HEALTH_COUNT_DIFF === '1') {
    try {
      const entries = await gatherCountDiff();
      console.log(JSON.stringify({ countDiff: entries }, null, 2));
      violations.push(...evaluateCountDiff(entries));
    } catch (e) {
      violations.push(
        `Count-diff gate could not run: ${e instanceof Error ? e.message : String(e)} ` +
          '(GRAPH_HEALTH_COUNT_DIFF=1 requires Firestore credentials/emulator AND Neo4j up)'
      );
    }
  }

  // Legacy relation rows can predate the deterministic relationTriples lock.
  // This opt-in audit reads both Firestore collections and fails closed without
  // modifying data. It is separate from the default Neo4j-only health check.
  if (process.env.GRAPH_HEALTH_RELATION_LOCKS === '1') {
    try {
      const audit = await gatherRelationTripleLockAudit();
      console.log(JSON.stringify({ relationTripleLocks: audit }, null, 2));
      violations.push(...evaluateRelationTripleLockAudit(audit));
    } catch (error) {
      violations.push(
        `Relation triple-lock audit could not run: ${error instanceof Error ? error.message : String(error)} ` +
          '(GRAPH_HEALTH_RELATION_LOCKS=1 requires Firestore credentials or an emulator)'
      );
    }
  }

  // GRAPH-066 #9 — RadarPlacement pair-lock drift. The Neo4j-side integrity
  // (duplicate/missing pairKey, duplicate placement ids, PLACES/ON_RADAR
  // cardinality) runs by default like every other graph-only check; the
  // Firestore-side lock audit + cross-store disagreement is env-gated because it
  // needs Firestore credentials/emulator.
  try {
    const graphIntegrity = await queryRadarPlacementGraphIntegrity();
    violations.push(...evaluateRadarPlacementGraphIntegrity(graphIntegrity));
  } catch (error) {
    // GRAPH-066 #5 — a critical Neo4j integrity query that cannot run is a
    // VIOLATION (fail the gate), never a downgraded warning: the gate must not
    // pass blind to placement/pair integrity.
    violations.push(
      `RadarPlacement graph integrity query failed (fail-closed): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (process.env.GRAPH_HEALTH_PAIR_LOCKS === '1') {
    try {
      const audit = await gatherRadarPlacementPairLockAudit();
      console.log(JSON.stringify({ radarPlacementPairLocks: audit }, null, 2));
      violations.push(...evaluateRadarPlacementPairLockAudit(audit));
    } catch (error) {
      violations.push(
        `RadarPlacement pair-lock audit could not run: ${error instanceof Error ? error.message : String(error)} ` +
          '(GRAPH_HEALTH_PAIR_LOCKS=1 requires Firestore credentials or an emulator)'
      );
    }
  }

  // F2 — community reports: missing entirely is a warning (overlay is optional
  // for a fresh install); stale reports indicate the nightly cron is broken.
  if (m.communityReportCount === 0) {
    warnings.push('No :CommunityReport nodes — F2 overlay is empty. Run buildCommunityReports() to populate.');
  } else if (m.communityReportLatestMs !== null) {
    const ageMs = Date.now() - m.communityReportLatestMs;
    if (ageMs > COMMUNITY_REPORT_STALENESS_MS) {
      warnings.push(
        `Latest :CommunityReport is ${Math.round(ageMs / 3_600_000)}h old (>48h). The nightly refresh cron may be stuck.`
      );
    }
  }

  await closeDriver();

  if (warnings.length > 0) {
    console.error('\nHealth warnings:');
    warnings.forEach((w) => console.error('  ! ' + w));
  }
  if (violations.length > 0) {
    console.error('\nHealth violations:');
    violations.forEach((v) => console.error('  ✗ ' + v));
    process.exit(1);
  }
  console.error('\n✓ Graph health OK');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
}
