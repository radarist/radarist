/**
 * @file confidence-scale-migration.integration.test.ts
 * @description Real-Neo4j proof for the 2026-07-05-confidence-scale-0-100
 * migration (Task 16 / A1).
 *
 * SKIPPED BY DEFAULT. To run against an isolated disposable clone:
 * ```bash
 * NEO4J_URI=bolt://127.0.0.1:17687 \
 * NEO4J_INTEGRATION_DISPOSABLE=true npm run test:integration:neo4j
 * ```
 * Run only against the disposable Neo4j target established by the integration lane.
 *
 * ⚠️  RUNBOOK WARNING: the migration heals the WHOLE graph, not just this
 * file's fixtures — that IS its job (Firestore docs seeded with legacy 0-1
 * confidence re-poison healed edges on every re-sync otherwise). Running
 * this suite against a real dev/demo Neo4j instance HEALS its actual 0-1
 * edges for real, and leaves the migration recorded as applied. Discard or
 * restore the disposable clone after the lane finishes.
 *
 * Assertion design (adversarial R1 fix — a local dev DB is never a blank
 * slate, so "expect exactly N edges changed" is not a safe absolute
 * assertion against a real database that already has ~15k relationships):
 *   (a) fixture-scoped per-edge outcomes — every TEST_PREFIX-marked edge in
 *       this file's seed matrix is healed/untouched exactly as expected,
 *       independent of what else lives in the graph.
 *   (b) global invariants that hold regardless of foreign edges under the
 *       required serial lane: I1 conservation (after.total === before.total)
 *       and I2 (after.bucketOpen01 === 0).
 *   (c) I4 — re-running the (now-applied) migration heals 0 additional rows
 *       (confidencePre100 IS NULL guards make every heal pass idempotent).
 *   (d) I3 asserted marker-based: the VISIBLE@60 delta equals the count of
 *       edges healed IN THIS RUN (confidenceScaleMigratedAt inside the
 *       [t0, t1] window of this invocation) whose confidencePre100 >= 0.6 —
 *       computable post-hoc and safe regardless of foreign edges healed in
 *       the same run.
 *   (e) census transform-consistency — the :MigrationCensus 'after' bucket
 *       counts equal a DETERMINISTIC transform of the 'before' buckets
 *       (bucketOpen01 -> 0, bucket1To100 grows by exactly what moved out of
 *       bucketOpen01 + the healed exactly-1.0 cohort, bucketNull/bucketOther
 *       untouched) — NOT an absolute golden. Exact-bucket goldens are only
 *       valid on a fresh CI container and are intentionally not asserted
 *       here.
 */

import { checkHealth, runReadTransaction, runWriteTransaction, closeDriver } from '@/lib/graph/neo4j-client';
import { applyMigrationByName } from '../schema-migrations';

const TEST_PREFIX = 'conf-scale-test-';
const FORWARD_NAME = '2026-07-05-confidence-scale-0-100';

// ============================================================================
// FIXTURE MATRIX — 10 edges spanning every bucket the migration cares about,
// plus one bonus :Assertion node to exercise the node-heal pass for real.
// ============================================================================

interface FixtureEdge {
  marker: string;
  relType: string;
  properties: Record<string, unknown>;
  /** Expected r.confidence after the migration runs. */
  expectedConfidenceAfter: number | null;
  /** Whether confidencePre100 should be stamped (i.e., this edge got healed). */
  expectHealed: boolean;
}

const FIXTURE_EDGES: FixtureEdge[] = [
  // (0,1) open interval — the unambiguous heal case.
  {
    marker: `${TEST_PREFIX}open01-050`,
    relType: 'USES',
    properties: { confidence: 0.5 },
    expectedConfidenceAfter: 50,
    expectHealed: true,
  },
  {
    marker: `${TEST_PREFIX}open01-060`,
    relType: 'USES',
    properties: { confidence: 0.6 },
    expectedConfidenceAfter: 60,
    expectHealed: true,
  },
  {
    marker: `${TEST_PREFIX}open01-085`,
    relType: 'USES',
    properties: { confidence: 0.85 },
    expectedConfidenceAfter: 85,
    expectHealed: true,
  },
  // Exactly 1.0 — MENTIONS + system:chunk-mentions signature (healed).
  {
    marker: `${TEST_PREFIX}exactly1-mentions`,
    relType: 'MENTIONS',
    properties: { confidence: 1.0, assertedBy: 'system:chunk-mentions' },
    expectedConfidenceAfter: 100,
    expectHealed: true,
  },
  // Exactly 1.0 — relation-defaults signature (claimStatus + aiSuggested), healed.
  {
    marker: `${TEST_PREFIX}exactly1-reldefaults`,
    relType: 'USES',
    properties: { confidence: 1.0, claimStatus: 'curated', aiSuggested: false },
    expectedConfidenceAfter: 100,
    expectHealed: true,
  },
  // Exactly 1.0 — NO recognized signature (residual, left untouched by design).
  {
    marker: `${TEST_PREFIX}exactly1-bare`,
    relType: 'USES',
    properties: { confidence: 1.0 },
    expectedConfidenceAfter: 1.0,
    expectHealed: false,
  },
  // Already on the 0-100 scale — untouched.
  {
    marker: `${TEST_PREFIX}already-050`,
    relType: 'USES',
    properties: { confidence: 50 },
    expectedConfidenceAfter: 50,
    expectHealed: false,
  },
  {
    marker: `${TEST_PREFIX}already-074`,
    relType: 'USES',
    properties: { confidence: 74 },
    expectedConfidenceAfter: 74,
    expectHealed: false,
  },
  {
    marker: `${TEST_PREFIX}already-100`,
    relType: 'USES',
    properties: { confidence: 100 },
    expectedConfidenceAfter: 100,
    expectHealed: false,
  },
  // No confidence property at all — untouched.
  {
    marker: `${TEST_PREFIX}null-confidence`,
    relType: 'USES',
    properties: {},
    expectedConfidenceAfter: null,
    expectHealed: false,
  },
];

const FIXTURE_ASSERTION_MARKER = `${TEST_PREFIX}assertion-node-072`;

// ============================================================================
// HELPERS
// ============================================================================

async function cleanupFixtures(): Promise<void> {
  await runWriteTransaction(`MATCH ()-[r]->() WHERE r.testMarker STARTS WITH $prefix DELETE r`, {
    prefix: TEST_PREFIX,
  });
  await runWriteTransaction(`MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n`, { prefix: TEST_PREFIX });
  await runWriteTransaction(`MATCH (c:Assertion) WHERE c.testMarker STARTS WITH $prefix DETACH DELETE c`, {
    prefix: TEST_PREFIX,
  });
}

async function seedFixtures(): Promise<void> {
  // Two throwaway Technology nodes every fixture edge hangs off of.
  await runWriteTransaction(`MERGE (a:Technology {id: $sourceId}) MERGE (b:Technology {id: $targetId})`, {
    sourceId: `${TEST_PREFIX}source`,
    targetId: `${TEST_PREFIX}target`,
  });

  for (const edge of FIXTURE_EDGES) {
    await runWriteTransaction(
      `MATCH (a:Technology {id: $sourceId}), (b:Technology {id: $targetId})
       CREATE (a)-[r:${edge.relType}]->(b)
       SET r.testMarker = $marker, r += $properties`,
      {
        sourceId: `${TEST_PREFIX}source`,
        targetId: `${TEST_PREFIX}target`,
        marker: edge.marker,
        properties: edge.properties,
      }
    );
  }

  // Bonus: a real :Assertion node in the open (0,1) interval, to exercise
  // the node-heal pass against a real Neo4j MATCH (c:Assertion) query.
  await runWriteTransaction(
    `CREATE (c:Assertion {id: $id, testMarker: $marker, confidence: 0.72, status: 'proposed'})`,
    { id: `${TEST_PREFIX}assertion-1`, marker: FIXTURE_ASSERTION_MARKER }
  );
}

interface CensusRow {
  bucketNull: number;
  bucketOpen01: number;
  bucketExactly1: number;
  bucket1To100: number;
  bucketOther: number;
  visibleAt60: number;
  healCohortBecomingVisible: number;
  total: number;
}

async function readCensus(phase: 'before' | 'after'): Promise<CensusRow> {
  const result = await runReadTransaction<CensusRow>(
    `MATCH (mc:MigrationCensus {migrationName: $name, phase: $phase})
     RETURN mc.bucketNull AS bucketNull, mc.bucketOpen01 AS bucketOpen01, mc.bucketExactly1 AS bucketExactly1,
            mc.bucket1To100 AS bucket1To100, mc.bucketOther AS bucketOther, mc.visibleAt60 AS visibleAt60,
            mc.healCohortBecomingVisible AS healCohortBecomingVisible, mc.total AS total`,
    { name: FORWARD_NAME, phase }
  );
  const row = result.records[0];
  if (!row) throw new Error(`No :MigrationCensus node found for phase=${phase}`);
  return row;
}

// ============================================================================
// TEST SUITE
// ============================================================================

const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('confidence-scale-migration (real Neo4j, Task 16 A1)', () => {
  let t0 = 0;
  let t1 = 0;

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

    t0 = Date.now();
    await applyMigrationByName(FORWARD_NAME, { force: true });
    t1 = Date.now();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await closeDriver();
  });

  // --------------------------------------------------------------------------
  // (a) Fixture-scoped per-edge outcomes — 10 cases, one per seed-matrix row.
  // --------------------------------------------------------------------------

  it.each(FIXTURE_EDGES.map((e) => [e.marker, e] as const))('heals %s exactly as expected', async (_marker, edge) => {
    const result = await runReadTransaction<{ confidence: number | null; confidencePre100: number | null }>(
      `MATCH ()-[r {testMarker: $marker}]->() RETURN r.confidence AS confidence, r.confidencePre100 AS confidencePre100`,
      { marker: edge.marker }
    );
    const row = result.records[0];
    expect(row).toBeDefined();
    expect(row.confidence).toBe(edge.expectedConfidenceAfter);
    if (edge.expectHealed) {
      expect(row.confidencePre100).toBe(edge.properties.confidence);
    } else {
      expect(row.confidencePre100).toBeNull();
    }
  });

  it('heals the fixture :Assertion node in the open (0,1) interval', async () => {
    const result = await runReadTransaction<{ confidence: number; confidencePre100: number }>(
      `MATCH (c:Assertion {testMarker: $marker}) RETURN c.confidence AS confidence, c.confidencePre100 AS confidencePre100`,
      { marker: FIXTURE_ASSERTION_MARKER }
    );
    const row = result.records[0];
    expect(row).toBeDefined();
    expect(row.confidence).toBe(72);
    expect(row.confidencePre100).toBe(0.72);
  });

  // --------------------------------------------------------------------------
  // (b) Global invariants — hold regardless of foreign edges in the graph.
  // --------------------------------------------------------------------------

  it('I1: conserves the total relationship count', async () => {
    const before = await readCensus('before');
    const after = await readCensus('after');
    expect(after.total).toBe(before.total);
  });

  it('I2: leaves zero relationships in the open (0,1) interval', async () => {
    const after = await readCensus('after');
    expect(after.bucketOpen01).toBe(0);
  });

  // --------------------------------------------------------------------------
  // (d) I3 — VISIBLE@60 growth equals exactly the count of edges healed IN
  // THIS RUN whose pre-heal value was >= 0.6 (window-scoped, foreign-heal-safe).
  // --------------------------------------------------------------------------

  it('I3: VISIBLE@60 grows by exactly the count of edges healed this run with confidencePre100 >= 0.6', async () => {
    const before = await readCensus('before');
    const after = await readCensus('after');

    const healedGE60 = await runReadTransaction<{ n: number }>(
      `MATCH ()-[r]->()
       WHERE r.confidenceScaleMigratedAt >= $t0 AND r.confidenceScaleMigratedAt <= $t1 AND r.confidencePre100 >= 0.6
       RETURN count(r) AS n`,
      { t0, t1 }
    );

    expect(after.visibleAt60 - before.visibleAt60).toBe(healedGE60.records[0].n);
  });

  // --------------------------------------------------------------------------
  // (e) Census transform-consistency — NOT an absolute golden.
  // --------------------------------------------------------------------------

  it('census: after buckets equal a deterministic transform of before buckets', async () => {
    const before = await readCensus('before');
    const after = await readCensus('after');

    const healedExactly1 = before.bucketExactly1 - after.bucketExactly1;
    expect(healedExactly1).toBeGreaterThanOrEqual(0);

    expect(after.bucketNull).toBe(before.bucketNull);
    expect(after.bucketOther).toBe(before.bucketOther);
    expect(after.bucketOpen01).toBe(0);
    expect(after.bucket1To100).toBe(before.bucket1To100 + before.bucketOpen01 + healedExactly1);
    expect(after.total).toBe(before.total);
  });

  // --------------------------------------------------------------------------
  // (c) I4 — re-running the migration (now recorded as applied) is a no-op:
  // every heal pass matches 0 rows because confidencePre100 IS NULL guards
  // already-healed edges out.
  // --------------------------------------------------------------------------

  it('I4: re-running the migration heals 0 additional rows', async () => {
    const rerun = await applyMigrationByName(FORWARD_NAME, { force: true });

    const healPasses = rerun.passes.filter((p) => p.pass.startsWith('heal-'));
    expect(healPasses.length).toBeGreaterThan(0);
    for (const pass of healPasses) {
      expect(pass.updatedOrDeleted).toBe(0);
    }
  });
});
