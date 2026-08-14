/**
 * @file confidence-reader-visibility.integration.test.ts
 * @description Real-Neo4j proof of the B0 two-field confidence authority's
 * reader-visibility law (Task 17).
 *
 * SKIPPED BY DEFAULT. To run against an isolated disposable clone:
 * ```bash
 * NEO4J_URI=bolt://127.0.0.1:17687 \
 * NEO4J_INTEGRATION_DISPOSABLE=true npm run test:integration:neo4j
 * ```
 * Run only against the disposable Neo4j target established by the integration lane.
 *
 * The law being proven: every reader now evaluates
 * `COALESCE(r.effectiveConfidence, r.confidence, <site default>)` instead of
 * the legacy `COALESCE(r.confidence, <site default>)`. For a LEGACY edge
 * (written before B0 — no effectiveConfidence/assertedConfidence at all)
 * these two expressions must be IDENTICAL — that is the before/after
 * visibility identity B0 is not allowed to break. For an edge that HAS an
 * effectiveConfidence, the new expression must prefer it over confidence at
 * every threshold — that is the whole point of the two-field split.
 *
 * ⚠️ The dev graph this suite may run against already has the
 * 2026-07-05-confidence-scale-0-100 migration applied, which stamps
 * `confidencePre100` / `confidenceScaleMigratedAt` on ~98 healed edges.
 * Those markers are A1 vocabulary and inert to this test's COALESCE
 * expressions — this suite doesn't touch or assert on them.
 *
 * ⚠️ RUNBOOK: the backfill test in this file runs the REAL
 * '2026-07-05-confidence-two-field-backfill' migration, which backfills the
 * WHOLE graph (copy-where-absent, never clobbers) — same class of side
 * effect as the A1 confidence-scale migration integration test. It is
 * idempotent, but the disposable clone still must be discarded or restored.
 */

import { checkHealth, runReadTransaction, runWriteTransaction, closeDriver } from '@/lib/graph/neo4j-client';
import { Neo4jGraphService } from '../neo4j-graph-service';
import { applyMigrationByName } from '../schema-migrations';

const TEST_PREFIX = 'b0-vis-test-';
const BACKFILL_NAME = '2026-07-05-confidence-two-field-backfill';

// ============================================================================
// FIXTURE MATRIX
// ============================================================================

const SHARED_SOURCE = `${TEST_PREFIX}shared-source`;
const SHARED_TARGET = `${TEST_PREFIX}shared-target`;

/** Legacy edges — ONLY the raw `confidence` field, exactly as B0-era rows are. */
const LEGACY_EDGES: Array<{ marker: string; properties: Record<string, unknown> }> = [
  { marker: `${TEST_PREFIX}legacy-000`, properties: { confidence: 0 } },
  { marker: `${TEST_PREFIX}legacy-060`, properties: { confidence: 60 } },
  { marker: `${TEST_PREFIX}legacy-075`, properties: { confidence: 75 } },
  { marker: `${TEST_PREFIX}legacy-100`, properties: { confidence: 100 } },
  { marker: `${TEST_PREFIX}legacy-null`, properties: {} }, // no confidence at all — exercises the <default> arm
];

/** Divergent edges — confidence and effectiveConfidence disagree (or confidence is absent). */
const DIVERGENT_EDGES: Array<{ marker: string; properties: Record<string, unknown>; expectedResolved: number }> = [
  {
    marker: `${TEST_PREFIX}divergent-100-eff50`,
    properties: { confidence: 100, effectiveConfidence: 50 },
    expectedResolved: 50,
  },
  {
    marker: `${TEST_PREFIX}divergent-50-eff100`,
    properties: { confidence: 50, effectiveConfidence: 100 },
    expectedResolved: 100,
  },
  { marker: `${TEST_PREFIX}effonly-060`, properties: { effectiveConfidence: 60 }, expectedResolved: 60 },
];

const FINDPATH_SOURCE = `${TEST_PREFIX}findpath-source`;
const FINDPATH_TARGET = `${TEST_PREFIX}findpath-target`;
const FINDPATH_MARKER = `${TEST_PREFIX}findpath-edge`;

const BACKFILL_SOURCE = `${TEST_PREFIX}backfill-source`;
const BACKFILL_TARGET = `${TEST_PREFIX}backfill-target`;
const BACKFILL_MARKER = `${TEST_PREFIX}backfill-edge`;

// ============================================================================
// HELPERS
// ============================================================================

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(`MATCH ()-[r]->() WHERE r.testMarker STARTS WITH $prefix DELETE r`, {
    prefix: TEST_PREFIX,
  });
  await runWriteTransaction(`MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n`, { prefix: TEST_PREFIX });
}

async function seedFixtures(): Promise<void> {
  await runWriteTransaction(`MERGE (a:Technology {id: $sharedSource}) MERGE (b:Technology {id: $sharedTarget})`, {
    sharedSource: SHARED_SOURCE,
    sharedTarget: SHARED_TARGET,
  });

  for (const edge of [...LEGACY_EDGES, ...DIVERGENT_EDGES]) {
    await runWriteTransaction(
      `MATCH (a:Technology {id: $sourceId}), (b:Technology {id: $targetId})
       CREATE (a)-[r:USES]->(b)
       SET r.testMarker = $marker, r += $properties`,
      { sourceId: SHARED_SOURCE, targetId: SHARED_TARGET, marker: edge.marker, properties: edge.properties }
    );
  }

  // Isolated pair for the findPath end-to-end proof — exactly ONE edge so the
  // shortestPath traversal is deterministic (no multigraph ambiguity).
  await runWriteTransaction(
    `MERGE (a:Technology {id: $sourceId}) MERGE (b:Technology {id: $targetId})
     CREATE (a)-[r:USES]->(b)
     SET r.testMarker = $marker, r.confidence = 100, r.effectiveConfidence = 50`,
    { sourceId: FINDPATH_SOURCE, targetId: FINDPATH_TARGET, marker: FINDPATH_MARKER }
  );

  // Isolated pair for the backfill proof — a pure legacy edge (no
  // assertedConfidence/effectiveConfidence at all).
  await runWriteTransaction(
    `MERGE (a:Technology {id: $sourceId}) MERGE (b:Technology {id: $targetId})
     CREATE (a)-[r:USES]->(b)
     SET r.testMarker = $marker, r.confidence = 42`,
    { sourceId: BACKFILL_SOURCE, targetId: BACKFILL_TARGET, marker: BACKFILL_MARKER }
  );
}

interface ResolvedRow {
  marker: string;
  newExpr: number;
  oldExpr: number;
}

async function readResolved(markers: string[]): Promise<ResolvedRow[]> {
  const result = await runReadTransaction<ResolvedRow>(
    `MATCH ()-[r]->() WHERE r.testMarker IN $markers
     RETURN r.testMarker AS marker,
            coalesce(r.effectiveConfidence, r.confidence, 100) AS newExpr,
            coalesce(r.confidence, 100) AS oldExpr`,
    { markers }
  );
  return result.records;
}

// ============================================================================
// TEST SUITE
// ============================================================================

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('confidence-reader-visibility (real Neo4j, Task 17 B0)', () => {
  beforeAll(async () => {
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(
        `[Integration Tests] NEO4J_INTEGRATION_TESTS is set but Neo4j is not healthy: ${
          health.error ?? 'unknown error'
        }. Start the disposable Neo4j integration target.`
      );
    }
    await cleanupFixtures();
    await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await closeDriver();
  });

  // --------------------------------------------------------------------------
  // (1) Legacy edges: the new expression must equal the old expression —
  // this IS the before/after visibility identity for rows B0 doesn't touch.
  // --------------------------------------------------------------------------

  it('legacy edges: the new expression equals COALESCE(r.confidence, 100) at every seeded threshold (0/60/75/100/null)', async () => {
    const rows = await readResolved(LEGACY_EDGES.map((e) => e.marker));
    expect(rows).toHaveLength(LEGACY_EDGES.length);
    for (const row of rows) {
      expect(row.newExpr).toBe(row.oldExpr);
    }
  });

  it('legacy edges resolve to their seeded confidence (or 100 when absent)', async () => {
    const rows = await readResolved(LEGACY_EDGES.map((e) => e.marker));
    const byMarker = new Map(rows.map((r) => [r.marker, r]));
    expect(byMarker.get(`${TEST_PREFIX}legacy-000`)?.newExpr).toBe(0);
    expect(byMarker.get(`${TEST_PREFIX}legacy-060`)?.newExpr).toBe(60);
    expect(byMarker.get(`${TEST_PREFIX}legacy-075`)?.newExpr).toBe(75);
    expect(byMarker.get(`${TEST_PREFIX}legacy-100`)?.newExpr).toBe(100);
    expect(byMarker.get(`${TEST_PREFIX}legacy-null`)?.newExpr).toBe(100);
  });

  // --------------------------------------------------------------------------
  // (2) effectiveConfidence takes precedence at every threshold.
  // --------------------------------------------------------------------------

  it('effectiveConfidence takes precedence over confidence (and over absence of confidence) at every threshold', async () => {
    const rows = await readResolved(DIVERGENT_EDGES.map((e) => e.marker));
    const byMarker = new Map(rows.map((r) => [r.marker, r]));

    for (const edge of DIVERGENT_EDGES) {
      const resolved = byMarker.get(edge.marker)?.newExpr;
      expect(resolved).toBe(edge.expectedResolved);
    }
  });

  it.each([0, 60, 75, 100])(
    'threshold >= %d: visibility follows effectiveConfidence, not the legacy confidence mirror',
    async (threshold) => {
      const rows = await readResolved(DIVERGENT_EDGES.map((e) => e.marker));
      const byMarker = new Map(rows.map((r) => [r.marker, r]));

      for (const edge of DIVERGENT_EDGES) {
        const resolved = byMarker.get(edge.marker)!.newExpr;
        expect(resolved >= threshold).toBe(edge.expectedResolved >= threshold);
      }
    }
  );

  // --------------------------------------------------------------------------
  // (3) findPath minConfidence honours precedence end-to-end.
  // --------------------------------------------------------------------------

  it('findPath: a below-threshold effectiveConfidence excludes the path even though the legacy confidence would have passed', async () => {
    const service = new Neo4jGraphService();

    // Legacy behavior (raw confidence=100) would include this edge at
    // minConfidence=75. The B0 read rule must exclude it: effectiveConfidence=50 < 75.
    const path = await service.findPath(FINDPATH_SOURCE, FINDPATH_TARGET, { minConfidence: 75, maxDepth: 1 });
    expect(path).toBeNull();
  });

  it('findPath: the same edge IS included once the threshold drops below its effectiveConfidence', async () => {
    const service = new Neo4jGraphService();

    const path = await service.findPath(FINDPATH_SOURCE, FINDPATH_TARGET, { minConfidence: 50, maxDepth: 1 });
    expect(path).not.toBeNull();
    expect(path?.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // (4) Backfill copies confidence into both fields where absent; re-run = 0 rows.
  // --------------------------------------------------------------------------

  it('backfill copies confidence into both new fields for a pure-legacy edge, and a re-run backfills it 0 additional times', async () => {
    const before = await runReadTransaction<{
      confidence: number;
      assertedConfidence: number | null;
      effectiveConfidence: number | null;
    }>(
      `MATCH ()-[r {testMarker: $marker}]->() RETURN r.confidence AS confidence, r.assertedConfidence AS assertedConfidence, r.effectiveConfidence AS effectiveConfidence`,
      { marker: BACKFILL_MARKER }
    );
    expect(before.records[0]?.assertedConfidence).toBeNull();
    expect(before.records[0]?.effectiveConfidence).toBeNull();

    await applyMigrationByName(BACKFILL_NAME, { force: true });

    const after = await runReadTransaction<{
      confidence: number;
      assertedConfidence: number;
      effectiveConfidence: number;
    }>(
      `MATCH ()-[r {testMarker: $marker}]->() RETURN r.confidence AS confidence, r.assertedConfidence AS assertedConfidence, r.effectiveConfidence AS effectiveConfidence`,
      { marker: BACKFILL_MARKER }
    );
    expect(after.records[0]?.assertedConfidence).toBe(42);
    expect(after.records[0]?.effectiveConfidence).toBe(42);

    // Re-run: this fixture edge now has both fields populated, so the
    // copy-where-absent guard must skip it on a second pass.
    const rerun = await applyMigrationByName(BACKFILL_NAME, { force: true });
    const stillAfter = await runReadTransaction<{ assertedConfidence: number; effectiveConfidence: number }>(
      `MATCH ()-[r {testMarker: $marker}]->() RETURN r.assertedConfidence AS assertedConfidence, r.effectiveConfidence AS effectiveConfidence`,
      { marker: BACKFILL_MARKER }
    );
    expect(stillAfter.records[0]?.assertedConfidence).toBe(42);
    expect(stillAfter.records[0]?.effectiveConfidence).toBe(42);
    expect(rerun.passes.find((p) => p.pass === 'verify-zero-residual')?.updatedOrDeleted).toBe(0);
  });
});
