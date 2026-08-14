/**
 * @file graph/schema-migrations.ts
 * @description Lightweight migration runner for one-shot Neo4j schema changes.
 *
 * Each migration is a named, idempotent bundle of Cypher statements embedded
 * directly in this module (so the runtime doesn't need filesystem access).
 * The `:SchemaMigration` node records which migrations have already been
 * applied so subsequent runs (staging, prod, local dev) short-circuit.
 *
 * Dev-loop:
 *   - Land a new migration by adding it to the `MIGRATIONS` array below.
 *   - Run through the protected /api/debug/apply-schema-migration route.
 *   - The runner reads :SchemaMigration {name} nodes and skips anything
 *     already present.
 */
import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { TOPIC_SEPARATOR_CHARACTERS } from '@/lib/discovery/candidate-topic';
import { planRadarPlacementPairMigration } from '@/lib/radar-placement-pair-key';
import { planRadarIdentityDedupe, type RadarIdentityEdgeDirection } from './radar-identity-dedupe';
import { UNREVIEWED_MENTION_CONFIDENCE } from './mention-trust';

const log = createLogger('graph/schema-migrations');

export interface SchemaMigration {
  name: string;
  description: string;
  apply(): Promise<MigrationPassResult[]>;
  /**
   * Zero-mutation preview of what `apply()` would do against the CURRENT graph.
   *
   * Optional because most migrations here are pure schema statements with
   * nothing to preview. Any migration that MUTATES retained data must implement
   * it: an operator cannot authorize a write they cannot see first, and
   * destructive operations require a `--dry-run` preview.
   *
   * Implementations MUST share their read + planning code with `apply()` so the
   * preview cannot drift from the write it describes.
   */
  plan?(): Promise<MigrationPlan>;
}

export interface MigrationPassResult {
  pass: string;
  updatedOrDeleted: number;
}

/** One prospective change in a migration preview. */
export interface MigrationPlanStep {
  step: string;
  /** Rows the step would write or delete. */
  affected: number;
  /** Exact ids the step would touch, when the step is id-addressable. */
  ids?: string[];
}

export interface MigrationPlan {
  name: string;
  description: string;
  /** True when at least one step would change data. */
  mutating: boolean;
  steps: MigrationPlanStep[];
  /** Drift that would make `apply()` abort before its first write. */
  violations: string[];
  /** How to recover if an applied run must be undone. */
  recovery: string;
}

export interface MigrationRunResult {
  name: string;
  description: string;
  alreadyApplied: boolean;
  passes: MigrationPassResult[];
  durationMs: number;
  appliedAt: number;
}

// ============================================================================
// Migration definitions
// ============================================================================

const MIGRATION_2026_04_18_SCHEMA_SIMPLIFICATION: SchemaMigration = {
  name: '2026-04-18-schema-simplification',
  description:
    'Drop Claim plumbing for backfill/curated claims + stub Evidence; rename surviving Claims to :Assertion; drop orphan RelationType/Agent/User/System nodes.',
  async apply() {
    const passes: MigrationPassResult[] = [];

    // Pass 1 — project claim metadata onto the materialized typed edge.
    const p1 = await runWriteTransaction<{ n: number }>(
      `MATCH (c) WHERE (c:Claim OR c:Assertion)
       MATCH ()-[r {claimId: c.id}]->()
       WITH r, c WHERE r.notes IS NULL OR r.confidence IS NULL OR r.assertedBy IS NULL
       SET r.notes = coalesce(r.notes, c.reasoningSummary),
           r.confidence = coalesce(r.confidence, c.confidence),
           r.assertedBy = coalesce(r.assertedBy, c.assertedBy)
       RETURN count(r) AS n`,
      {}
    );
    passes.push({ pass: 'project-claim-properties-to-edge', updatedOrDeleted: p1.records[0]?.n ?? 0 });

    // Pass 2 — detach-delete backfill/curated Claims + stub Evidence.
    const p2 = await runWriteTransaction<{ n: number }>(
      `MATCH (c) WHERE (c:Claim OR c:Assertion) AND (
         c.asserterType = 'backfill'
         OR c.status IS NULL
         OR c.status = 'curated'
       )
       OPTIONAL MATCH (c)-[:SUPPORTED_BY]->(e:Evidence)
       WHERE e.snippet IS NULL OR e.snippet STARTS WITH 'Backfilled from pre-contract'
       WITH collect(DISTINCT c) AS cs, collect(DISTINCT e) AS es
       WITH cs, es, size(cs) AS nClaims, size([x IN es WHERE x IS NOT NULL]) AS nEv
       FOREACH (c IN cs | DETACH DELETE c)
       FOREACH (e IN es | DETACH DELETE e)
       RETURN nClaims + nEv AS n`,
      {}
    );
    passes.push({ pass: 'drop-backfill-claims-and-stub-evidence', updatedOrDeleted: p2.records[0]?.n ?? 0 });

    // Pass 3 — rename surviving :Claim → :Assertion.
    const p3 = await runWriteTransaction<{ n: number }>(
      `MATCH (c:Claim)
       WITH collect(c) AS cs
       FOREACH (c IN cs | SET c:Assertion REMOVE c:Claim)
       RETURN size(cs) AS n`,
      {}
    );
    passes.push({ pass: 'rename-claim-to-assertion', updatedOrDeleted: p3.records[0]?.n ?? 0 });

    // Pass 4 — drop orphan RelationType nodes. Guard (repair-safety review):
    // seeded metadata nodes are edgeless BY DESIGN but carry a description —
    // pruning on edgelessness alone would garbage-collect every reseed. Only
    // prune nodes that are both edgeless AND unseeded (no description).
    const p4 = await runWriteTransaction<{ n: number }>(
      `MATCH (rt:RelationType) WHERE rt.description IS NULL AND NOT (rt)--()
       WITH collect(rt) AS rts
       FOREACH (rt IN rts | DETACH DELETE rt)
       RETURN size(rts) AS n`,
      {}
    );
    passes.push({ pass: 'drop-orphan-relation-types', updatedOrDeleted: p4.records[0]?.n ?? 0 });

    // Pass 5 — drop orphan asserter nodes.
    const p5 = await runWriteTransaction<{ n: number }>(
      `MATCH (a) WHERE (a:Agent OR a:User OR a:System) AND NOT (a)--()
       WITH collect(a) AS asserters
       FOREACH (a IN asserters | DETACH DELETE a)
       RETURN size(asserters) AS n`,
      {}
    );
    passes.push({ pass: 'drop-orphan-asserters', updatedOrDeleted: p5.records[0]?.n ?? 0 });

    return passes;
  },
};

const MIGRATION_2026_06_23_INTEREST_PROFILE: SchemaMigration = {
  name: '2026-06-23-interest-profile',
  description:
    'Add the InterestProfile uniqueness constraint (userId) + updatedAt index backing the discovery loop learning store.',
  async apply() {
    const passes: MigrationPassResult[] = [];

    // Uniqueness constraint — one InterestProfile per user (also indexes userId).
    await runWriteTransaction(
      `CREATE CONSTRAINT ip_userId IF NOT EXISTS FOR (ip:InterestProfile) REQUIRE ip.userId IS UNIQUE`,
      {}
    );
    passes.push({ pass: 'create-interest-profile-userId-constraint', updatedOrDeleted: 0 });

    // updatedAt index — supports recency ordering of profiles.
    await runWriteTransaction(`CREATE INDEX ip_updatedAt IF NOT EXISTS FOR (ip:InterestProfile) ON (ip.updatedAt)`, {});
    passes.push({ pass: 'create-interest-profile-updatedAt-index', updatedOrDeleted: 0 });

    return passes;
  },
};

// ============================================================================
// 2026-07-12-user-preference-identity
// ============================================================================

const USER_PREFERENCE_IDENTITY_MIGRATION_NAME = '2026-07-12-user-preference-identity';
const USER_PREFERENCE_ALLOWED_PROPERTIES = [
  'id',
  'userId',
  'topic',
  'acted_count',
  'dismissed_count',
  'seeded',
  'lastUpdated',
] as const;

const USER_PREFERENCE_PREFLIGHT_CYPHER = `
  MATCH (up:UserPreference)
  WITH up,
       reduce(normalized = '', character IN split(toLower(toString(up.topic)), '') |
         CASE WHEN character IN $topicSeparators
           THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
           ELSE normalized + character
         END
       ) AS canonicalWithPossibleTrailingSeparator
  WITH up,
       CASE WHEN right(canonicalWithPossibleTrailingSeparator, 1) = '-'
         THEN left(canonicalWithPossibleTrailingSeparator, size(canonicalWithPossibleTrailingSeparator) - 1)
         ELSE canonicalWithPossibleTrailingSeparator
       END AS canonicalTopic,
       [key IN keys(up) WHERE NOT key IN $allowedProperties] AS unexpectedProperties
  OPTIONAL MATCH (up)-[relationship]-()
  WITH up, canonicalTopic, unexpectedProperties, count(relationship) AS relationshipCount
  RETURN count(CASE WHEN
           (up.id IS NOT NULL AND (up.id <> toString(up.id) OR trim(toString(up.id)) = '')) OR
           up.userId IS NULL OR up.userId <> toString(up.userId) OR
           trim(toString(up.userId)) = '' OR trim(toString(up.userId)) <> toString(up.userId) OR
           up.topic IS NULL OR up.topic <> toString(up.topic) OR canonicalTopic = ''
         THEN 1 END) AS malformedRows,
         count(CASE WHEN
           (up.acted_count IS NOT NULL AND
             (toInteger(up.acted_count) IS NULL OR up.acted_count <> toInteger(up.acted_count) OR toInteger(up.acted_count) < 0)) OR
           (up.dismissed_count IS NOT NULL AND
             (toInteger(up.dismissed_count) IS NULL OR up.dismissed_count <> toInteger(up.dismissed_count) OR toInteger(up.dismissed_count) < 0)) OR
           (up.seeded IS NOT NULL AND up.seeded <> true AND up.seeded <> false)
         THEN 1 END) AS invalidCounterRows,
         count(CASE WHEN size(unexpectedProperties) > 0 THEN 1 END) AS unexpectedPropertyRows,
         count(CASE WHEN relationshipCount > 0 THEN 1 END) AS relatedRows
`;

const CONSOLIDATE_USER_PREFERENCES_CYPHER = `
  MATCH (up:UserPreference)
  SET up._preferenceIdentityMigrationLock = true
  WITH up,
       reduce(normalized = '', character IN split(toLower(up.topic), '') |
         CASE WHEN character IN $topicSeparators
           THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
           ELSE normalized + character
         END
       ) AS canonicalWithPossibleTrailingSeparator
  WITH up, CASE WHEN right(canonicalWithPossibleTrailingSeparator, 1) = '-'
         THEN left(canonicalWithPossibleTrailingSeparator, size(canonicalWithPossibleTrailingSeparator) - 1)
         ELSE canonicalWithPossibleTrailingSeparator
       END AS canonicalTopic
  ORDER BY up.userId ASC,
           canonicalTopic ASC,
           CASE WHEN up.topic = canonicalTopic THEN 0 ELSE 1 END ASC,
           CASE WHEN up.id IS NULL THEN 1 ELSE 0 END ASC,
           up.id ASC,
           elementId(up) ASC
  WITH up.userId AS userId, canonicalTopic, collect(up) AS rows
  WITH userId, canonicalTopic, rows, head(rows) AS target,
       reduce(total = 0, row IN rows | total + coalesce(row.acted_count, 0)) AS actedTotal,
       reduce(total = 0, row IN rows | total + coalesce(row.dismissed_count, 0)) AS dismissedTotal,
       any(row IN rows WHERE coalesce(row.seeded, false)) AS wasSeeded,
       reduce(latest = null, row IN rows |
         CASE WHEN row.lastUpdated IS NULL THEN latest
              WHEN latest IS NULL OR row.lastUpdated > latest THEN row.lastUpdated
              ELSE latest END
       ) AS latestUpdated
  WITH userId, canonicalTopic, rows, target, actedTotal, dismissedTotal, wasSeeded, latestUpdated,
       [row IN rows WHERE row <> target] AS duplicates
  WITH userId, canonicalTopic, target, actedTotal, dismissedTotal, wasSeeded, latestUpdated,
       duplicates, size(duplicates) AS duplicateCount
  FOREACH (duplicate IN duplicates | DELETE duplicate)
  SET target.id = coalesce(target.id, randomUUID()),
      target.userId = userId,
      target.topic = canonicalTopic,
      target.acted_count = actedTotal,
      target.dismissed_count = dismissedTotal,
      target.lastUpdated = coalesce(latestUpdated, datetime())
  FOREACH (_ IN CASE WHEN wasSeeded THEN [1] ELSE [] END | SET target.seeded = true)
  FOREACH (_ IN CASE WHEN wasSeeded THEN [] ELSE [1] END | REMOVE target.seeded)
  REMOVE target._preferenceIdentityMigrationLock
  RETURN count(*) AS canonicalGroups, sum(duplicateCount) AS consolidatedRows
`;

const VERIFY_USER_PREFERENCE_IDENTITY_CYPHER = `
  CALL {
    MATCH (up:UserPreference)
    WITH up,
         reduce(normalized = '', character IN split(toLower(up.topic), '') |
           CASE WHEN character IN $topicSeparators
             THEN CASE WHEN normalized = '' OR right(normalized, 1) = '-' THEN normalized ELSE normalized + '-' END
             ELSE normalized + character
           END
         ) AS canonicalWithPossibleTrailingSeparator
    WITH up, CASE WHEN right(canonicalWithPossibleTrailingSeparator, 1) = '-'
           THEN left(canonicalWithPossibleTrailingSeparator, size(canonicalWithPossibleTrailingSeparator) - 1)
           ELSE canonicalWithPossibleTrailingSeparator
         END AS canonicalTopic
    RETURN count(CASE WHEN up.topic <> canonicalTopic THEN 1 END) AS nonCanonicalRows,
           count(CASE WHEN up._preferenceIdentityMigrationLock IS NOT NULL THEN 1 END) AS lockResidue
  }
  CALL {
    MATCH (up:UserPreference)
    WITH up.userId AS userId, up.topic AS topic, count(*) AS rowCount
    WHERE rowCount > 1
    RETURN coalesce(sum(rowCount - 1), 0) AS duplicateRows
  }
  RETURN nonCanonicalRows, lockResidue, duplicateRows
`;

interface UserPreferencePreflightRow {
  malformedRows: number;
  invalidCounterRows: number;
  unexpectedPropertyRows: number;
  relatedRows: number;
}

interface UserPreferenceVerificationRow {
  nonCanonicalRows: number;
  lockResidue: number;
  duplicateRows: number;
}

const EMPTY_USER_PREFERENCE_PREFLIGHT: UserPreferencePreflightRow = {
  malformedRows: 0,
  invalidCounterRows: 0,
  unexpectedPropertyRows: 0,
  relatedRows: 0,
};

function assertSafeUserPreferenceRows(row: UserPreferencePreflightRow, phase: 'preflight' | 'postflight'): void {
  if (
    row.malformedRows !== 0 ||
    row.invalidCounterRows !== 0 ||
    row.unexpectedPropertyRows !== 0 ||
    row.relatedRows !== 0
  ) {
    throw new Error(
      `user-preference identity ${phase} failed: malformed=${row.malformedRows}, invalidCounters=${row.invalidCounterRows}, unexpectedProperties=${row.unexpectedPropertyRows}, related=${row.relatedRows}`
    );
  }
}

const MIGRATION_2026_07_12_USER_PREFERENCE_IDENTITY: SchemaMigration = {
  name: USER_PREFERENCE_IDENTITY_MIGRATION_NAME,
  description:
    'Canonicalize and deterministically consolidate legacy UserPreference identities before adding composite (userId, topic) and replay-receipt uniqueness constraints.',
  async apply() {
    const passes: MigrationPassResult[] = [];
    const params = {
      topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
      allowedProperties: USER_PREFERENCE_ALLOWED_PROPERTIES,
    };

    const preflight = await runReadTransaction<UserPreferencePreflightRow>(USER_PREFERENCE_PREFLIGHT_CYPHER, params);
    assertSafeUserPreferenceRows(preflight.records[0] ?? EMPTY_USER_PREFERENCE_PREFLIGHT, 'preflight');
    passes.push({ pass: 'preflight-safe-legacy-preferences', updatedOrDeleted: 0 });

    const consolidation = await runWriteTransaction<{ consolidatedRows: number }>(CONSOLIDATE_USER_PREFERENCES_CYPHER, {
      topicSeparators: TOPIC_SEPARATOR_CHARACTERS,
    });
    passes.push({
      pass: 'canonicalize-and-consolidate-user-preferences',
      updatedOrDeleted: consolidation.records[0]?.consolidatedRows ?? 0,
    });

    await runWriteTransaction(
      `CREATE CONSTRAINT user_preference_user_topic IF NOT EXISTS
       FOR (up:UserPreference) REQUIRE (up.userId, up.topic) IS UNIQUE`,
      {}
    );
    passes.push({ pass: 'create-user-preference-user-topic-constraint', updatedOrDeleted: 0 });

    await runWriteTransaction(
      `CREATE CONSTRAINT preference_engagement_receipt_id IF NOT EXISTS
       FOR (receipt:PreferenceEngagementReceipt) REQUIRE receipt.id IS UNIQUE`,
      {}
    );
    passes.push({ pass: 'create-preference-engagement-receipt-id-constraint', updatedOrDeleted: 0 });

    const postflight = await runReadTransaction<UserPreferencePreflightRow>(USER_PREFERENCE_PREFLIGHT_CYPHER, params);
    assertSafeUserPreferenceRows(postflight.records[0] ?? EMPTY_USER_PREFERENCE_PREFLIGHT, 'postflight');
    passes.push({ pass: 'postflight-safe-user-preferences', updatedOrDeleted: 0 });

    const verification = await runReadTransaction<UserPreferenceVerificationRow>(
      VERIFY_USER_PREFERENCE_IDENTITY_CYPHER,
      { topicSeparators: TOPIC_SEPARATOR_CHARACTERS }
    );
    const remaining = verification.records[0] ?? {
      nonCanonicalRows: 0,
      lockResidue: 0,
      duplicateRows: 0,
    };
    if (remaining.nonCanonicalRows !== 0 || remaining.lockResidue !== 0 || remaining.duplicateRows !== 0) {
      throw new Error(
        `user-preference identity verification failed: nonCanonical=${remaining.nonCanonicalRows}, duplicates=${remaining.duplicateRows}, lockResidue=${remaining.lockResidue}`
      );
    }
    passes.push({ pass: 'verify-user-preference-identity', updatedOrDeleted: 0 });

    return passes;
  },
};

// ============================================================================
// 2026-07-05-confidence-scale-0-100 (Task 16 / A1)
// ============================================================================
//
// Heals the confidence-scale split: relation-defaults.ts and chunk-mentions.ts
// used to mint confidence on a 0-1 scale (0.5/1.0) while the rest of the
// contract (Relation.confidence, r.confidence everywhere else,
// shouldMaterializeAssertion's >=75 gate) is 0-100 — hiding those edges from
// any confidence-filtered read (e.g. `WHERE r.confidence >= 60`).
//
// Type-aware + reversible: every healed property is stamped with
// `confidencePre100` (the original value) and `confidenceScaleMigratedAt`
// before being overwritten, so the MANUAL-only rollback below can restore it
// exactly. Four heal passes, most-general-safe first:
//   1. open interval (0,1)          — the unambiguous case, any r.confidence
//   2. MENTIONS + system:chunk-mentions signature, exactly 1.0
//   3. claimStatus+aiSuggested signature (relation-defaults), exactly 1.0
//   4. :Assertion nodes, open interval (0,1)
// Edges at exactly 1.0 with NEITHER known minter signature are left
// untouched by design (residual, logged) — we only heal cases we can prove
// came from a 0-1 minter, never guess.

const CONFIDENCE_SCALE_MIGRATION_NAME = '2026-07-05-confidence-scale-0-100';
const CONFIDENCE_SCALE_ROLLBACK_NAME = '2026-07-05-confidence-scale-0-100-rollback';

interface ConfidenceScaleCensusRow {
  bucketNull: number;
  bucketOpen01: number;
  bucketExactly1: number;
  bucket1To100: number;
  bucketOther: number;
  visibleAt60: number;
  healCohortBecomingVisible: number;
  total: number;
}

const CONFIDENCE_SCALE_CENSUS_CYPHER = `
  MATCH ()-[r]->()
  WITH r.confidence AS c
  WITH
    count(CASE WHEN c IS NULL THEN 1 END)                              AS bucketNull,
    count(CASE WHEN c > 0 AND c < 1 THEN 1 END)                        AS bucketOpen01,
    count(CASE WHEN c = 1.0 THEN 1 END)                                AS bucketExactly1,
    count(CASE WHEN c > 1 AND c <= 100 THEN 1 END)                     AS bucket1To100,
    count(CASE WHEN c IS NOT NULL AND (c <= 0 OR c > 100) THEN 1 END)  AS bucketOther,
    count(CASE WHEN coalesce(c, 100) >= 60 THEN 1 END)                 AS visibleAt60,
    count(CASE WHEN c >= 0.6 AND c <= 1 THEN 1 END)                    AS healCohortBecomingVisible,
    count(*)                                                           AS total
  MERGE (mc:MigrationCensus {migrationName: $name, phase: $phase})
  SET mc.at = $now, mc.bucketNull = bucketNull, mc.bucketOpen01 = bucketOpen01,
      mc.bucketExactly1 = bucketExactly1, mc.bucket1To100 = bucket1To100, mc.bucketOther = bucketOther,
      mc.visibleAt60 = visibleAt60, mc.healCohortBecomingVisible = healCohortBecomingVisible, mc.total = total
  RETURN bucketNull, bucketOpen01, bucketExactly1, bucket1To100, bucketOther,
         visibleAt60, healCohortBecomingVisible, total
`;

async function runConfidenceScaleCensus(phase: 'before' | 'after', now: number): Promise<ConfidenceScaleCensusRow> {
  const result = await runWriteTransaction<ConfidenceScaleCensusRow>(CONFIDENCE_SCALE_CENSUS_CYPHER, {
    name: CONFIDENCE_SCALE_MIGRATION_NAME,
    phase,
    now,
  });
  const row = result.records[0];
  return {
    bucketNull: row?.bucketNull ?? 0,
    bucketOpen01: row?.bucketOpen01 ?? 0,
    bucketExactly1: row?.bucketExactly1 ?? 0,
    bucket1To100: row?.bucket1To100 ?? 0,
    bucketOther: row?.bucketOther ?? 0,
    visibleAt60: row?.visibleAt60 ?? 0,
    healCohortBecomingVisible: row?.healCohortBecomingVisible ?? 0,
    total: row?.total ?? 0,
  };
}

const HEAL_OPEN_INTERVAL_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.confidence > 0 AND r.confidence < 1 AND r.confidencePre100 IS NULL
  SET r.confidencePre100 = r.confidence,
      r.confidence = toInteger(round(r.confidence * 100)),
      r.confidenceScaleMigratedAt = $now
  RETURN count(r) AS n
`;

const HEAL_MENTIONS_SIGNATURE_CYPHER = `
  MATCH ()-[r:MENTIONS]->()
  WHERE r.confidence = 1.0 AND r.assertedBy = 'system:chunk-mentions' AND r.confidencePre100 IS NULL
  SET r.confidencePre100 = r.confidence,
      r.confidence = 100,
      r.confidenceScaleMigratedAt = $now
  RETURN count(r) AS n
`;

const HEAL_RELATION_DEFAULTS_SIGNATURE_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.confidence = 1.0 AND r.claimStatus IS NOT NULL AND r.aiSuggested IS NOT NULL AND r.confidencePre100 IS NULL
  SET r.confidencePre100 = r.confidence,
      r.confidence = 100,
      r.confidenceScaleMigratedAt = $now
  RETURN count(r) AS n
`;

const HEAL_ASSERTION_NODES_CYPHER = `
  MATCH (c:Assertion)
  WHERE c.confidence > 0 AND c.confidence < 1 AND c.confidencePre100 IS NULL
  SET c.confidencePre100 = c.confidence,
      c.confidence = toInteger(round(c.confidence * 100)),
      c.confidenceScaleMigratedAt = $now
  RETURN count(c) AS n
`;

const HEALED_GE_60_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.confidenceScaleMigratedAt = $now AND r.confidencePre100 >= 0.6
  RETURN count(r) AS n
`;

const MIGRATION_2026_07_05_CONFIDENCE_SCALE_0_100: SchemaMigration = {
  name: CONFIDENCE_SCALE_MIGRATION_NAME,
  description:
    'Heal the 0-1 vs 0-100 confidence-scale split (relation-defaults + chunk-mentions minted 0-1 while the rest of the contract is 0-100), hiding those edges from confidence-filtered reads. Type-aware and reversible via confidencePre100.',
  async apply() {
    const passes: MigrationPassResult[] = [];
    const now = Date.now();

    const before = await runConfidenceScaleCensus('before', now);
    passes.push({ pass: 'census-before', updatedOrDeleted: before.total });

    const openInterval = await runWriteTransaction<{ n: number }>(HEAL_OPEN_INTERVAL_CYPHER, { now });
    passes.push({ pass: 'heal-open-interval', updatedOrDeleted: openInterval.records[0]?.n ?? 0 });

    const mentions = await runWriteTransaction<{ n: number }>(HEAL_MENTIONS_SIGNATURE_CYPHER, { now });
    passes.push({ pass: 'heal-exactly-one-mentions', updatedOrDeleted: mentions.records[0]?.n ?? 0 });

    const relationDefaults = await runWriteTransaction<{ n: number }>(HEAL_RELATION_DEFAULTS_SIGNATURE_CYPHER, { now });
    passes.push({ pass: 'heal-exactly-one-relation-defaults', updatedOrDeleted: relationDefaults.records[0]?.n ?? 0 });

    const assertionNodes = await runWriteTransaction<{ n: number }>(HEAL_ASSERTION_NODES_CYPHER, { now });
    passes.push({ pass: 'heal-assertion-nodes', updatedOrDeleted: assertionNodes.records[0]?.n ?? 0 });

    const after = await runConfidenceScaleCensus('after', now);
    passes.push({ pass: 'census-after-and-verify', updatedOrDeleted: after.total });

    // I1 — conservation: healing only ever rewrites r.confidence in place;
    // it never creates or deletes a relationship.
    if (after.total !== before.total) {
      throw new Error(
        `confidence-scale migration I1 (conservation) violated: relationship total changed ${before.total} -> ${after.total}`
      );
    }
    // I2 — every open-(0,1) edge must be healed by one of the passes above.
    if (after.bucketOpen01 !== 0) {
      throw new Error(
        `confidence-scale migration I2 (no residual open-(0,1)) violated: ${after.bucketOpen01} edge(s) still in (0,1) after healing`
      );
    }
    // I3 — VISIBLE@60 grows by EXACTLY the count of edges healed in this run
    // whose pre-heal value was >= 0.6 (any lower pre-value stays invisible
    // even after ×100, e.g. 0.5 -> 50 < 60).
    const healedGE60 = await runReadTransaction<{ n: number }>(HEALED_GE_60_CYPHER, { now });
    const healedGE60Count = healedGE60.records[0]?.n ?? 0;
    const expectedVisibleAt60 = before.visibleAt60 + healedGE60Count;
    if (after.visibleAt60 !== expectedVisibleAt60) {
      throw new Error(
        `confidence-scale migration I3 (precise VISIBLE@60 growth) violated: went ${before.visibleAt60} -> ${after.visibleAt60}, expected ${expectedVisibleAt60}`
      );
    }

    // Residual — edges still exactly 1.0 with no recognized minter signature.
    // Left untouched by design; logged so the leak metric + operators can see
    // the known gap instead of it being silently invisible.
    passes.push({ pass: 'residual-exactly-one-unhealed', updatedOrDeleted: after.bucketExactly1 });

    return passes;
  },
};

// ── Rollback (MANUAL-only — see MANUAL_MIGRATIONS below) ───────────────────

const ROLLBACK_EDGES_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.confidencePre100 IS NOT NULL AND r.integrityRepairPlanSha IS NULL
  SET r.confidence = r.confidencePre100
  REMOVE r.confidencePre100, r.confidenceScaleMigratedAt
  RETURN count(r) AS n
`;

const ROLLBACK_ASSERTION_NODES_CYPHER = `
  MATCH (c:Assertion) WHERE c.confidencePre100 IS NOT NULL
  SET c.confidence = c.confidencePre100
  REMOVE c.confidencePre100, c.confidenceScaleMigratedAt
  RETURN count(c) AS n
`;

const ROLLBACK_UNRECORD_FORWARD_MIGRATION_CYPHER = `
  MATCH (m:SchemaMigration {name: $migrationName})
  WITH collect(m) AS ms
  FOREACH (m IN ms | DETACH DELETE m)
  RETURN size(ms) AS n
`;

const ROLLBACK_DELETE_CENSUS_CYPHER = `
  MATCH (mc:MigrationCensus {migrationName: $migrationName})
  WITH collect(mc) AS css
  FOREACH (c IN css | DETACH DELETE c)
  RETURN size(css) AS n
`;

const MIGRATION_2026_07_05_CONFIDENCE_SCALE_0_100_ROLLBACK: SchemaMigration = {
  name: CONFIDENCE_SCALE_ROLLBACK_NAME,
  description:
    'Rollback for 2026-07-05-confidence-scale-0-100: restores r.confidence / c.confidence from confidencePre100, removes the migration markers, and DETACH DELETEs the forward migration record + its census nodes so it can be cleanly re-applied. MANUAL-only — must never auto-apply via applyPendingMigrations.',
  async apply() {
    const passes: MigrationPassResult[] = [];

    const edges = await runWriteTransaction<{ n: number }>(ROLLBACK_EDGES_CYPHER, {});
    passes.push({ pass: 'restore-edges-from-confidencePre100', updatedOrDeleted: edges.records[0]?.n ?? 0 });

    const assertionNodes = await runWriteTransaction<{ n: number }>(ROLLBACK_ASSERTION_NODES_CYPHER, {});
    passes.push({
      pass: 'restore-assertion-nodes-from-confidencePre100',
      updatedOrDeleted: assertionNodes.records[0]?.n ?? 0,
    });

    const unrecord = await runWriteTransaction<{ n: number }>(ROLLBACK_UNRECORD_FORWARD_MIGRATION_CYPHER, {
      migrationName: CONFIDENCE_SCALE_MIGRATION_NAME,
    });
    passes.push({ pass: 'unrecord-forward-migration', updatedOrDeleted: unrecord.records[0]?.n ?? 0 });

    const census = await runWriteTransaction<{ n: number }>(ROLLBACK_DELETE_CENSUS_CYPHER, {
      migrationName: CONFIDENCE_SCALE_MIGRATION_NAME,
    });
    passes.push({ pass: 'delete-census-nodes', updatedOrDeleted: census.records[0]?.n ?? 0 });

    return passes;
  },
};

// ============================================================================
// 2026-07-05-confidence-two-field-backfill (Task 17 / B0)
// ============================================================================
//
// B0 introduces the two-field confidence authority: assertedConfidence
// (refreshed every sync) and effectiveConfidence (the system's belief, set
// once, never clobbered). Every reader now reads
// COALESCE(effectiveConfidence, confidence, <site default>), so rows written
// before B0 (which only carry the legacy `confidence` field) are already
// visible — this migration is pure backfill-on-touch cleanup, not a
// visibility fix. It copies the legacy confidence value into both new
// fields wherever EITHER is absent (copy-where-absent, never overwrite an
// existing value), for both typed edges and :Assertion nodes, then verifies
// zero residual (a row with confidence set but effectiveConfidence still
// missing) — idempotent, safe to re-run, and safe to auto-apply.

const CONFIDENCE_TWO_FIELD_BACKFILL_NAME = '2026-07-05-confidence-two-field-backfill';

const BACKFILL_EDGES_CYPHER = `
  MATCH ()-[r]->()
  WHERE r.confidence IS NOT NULL AND (r.effectiveConfidence IS NULL OR r.assertedConfidence IS NULL)
  SET r.assertedConfidence = coalesce(r.assertedConfidence, r.confidence),
      r.effectiveConfidence = coalesce(r.effectiveConfidence, r.confidence)
  RETURN count(r) AS n
`;

const BACKFILL_ASSERTION_NODES_CYPHER = `
  MATCH (c:Assertion)
  WHERE c.confidence IS NOT NULL AND (c.effectiveConfidence IS NULL OR c.assertedConfidence IS NULL)
  SET c.assertedConfidence = coalesce(c.assertedConfidence, c.confidence),
      c.effectiveConfidence = coalesce(c.effectiveConfidence, c.confidence)
  RETURN count(c) AS n
`;

const VERIFY_ZERO_RESIDUAL_CYPHER = `
  MATCH ()-[r]->() WHERE r.confidence IS NOT NULL AND r.effectiveConfidence IS NULL
  WITH count(r) AS edgeResidual
  MATCH (c:Assertion) WHERE c.confidence IS NOT NULL AND c.effectiveConfidence IS NULL
  WITH edgeResidual, count(c) AS assertionResidual
  RETURN edgeResidual + assertionResidual AS n
`;

const MIGRATION_2026_07_05_CONFIDENCE_TWO_FIELD_BACKFILL: SchemaMigration = {
  name: CONFIDENCE_TWO_FIELD_BACKFILL_NAME,
  description:
    'B0 backfill: copy legacy confidence into assertedConfidence/effectiveConfidence wherever either is absent, for typed edges and :Assertion nodes. Copy-where-absent (never clobbers an existing value); idempotent cleanup, not a visibility fix (readers already COALESCE).',
  async apply() {
    const passes: MigrationPassResult[] = [];

    const edges = await runWriteTransaction<{ n: number }>(BACKFILL_EDGES_CYPHER, {});
    passes.push({ pass: 'copy-edges-where-absent', updatedOrDeleted: edges.records[0]?.n ?? 0 });

    const assertionNodes = await runWriteTransaction<{ n: number }>(BACKFILL_ASSERTION_NODES_CYPHER, {});
    passes.push({ pass: 'copy-assertions-where-absent', updatedOrDeleted: assertionNodes.records[0]?.n ?? 0 });

    const verify = await runReadTransaction<{ n: number }>(VERIFY_ZERO_RESIDUAL_CYPHER, {});
    const residual = verify.records[0]?.n ?? 0;
    if (residual !== 0) {
      throw new Error(
        `confidence-two-field-backfill verify failed: ${residual} residual row(s) with confidence set but effectiveConfidence missing`
      );
    }
    passes.push({ pass: 'verify-zero-residual', updatedOrDeleted: residual });

    return passes;
  },
};

// ============================================================================
// 2026-07-22-radar-placement-pair-identity (GRAPH-066)
// ============================================================================
//
// Backfills the deterministic pair key onto RadarPlacement nodes and installs
// guarded uniqueness for Radar.id, RadarPlacement.id, and RadarPlacement.pairKey.
//
// The pair key is a base64url encoding of the JSON `[radarId, technologyId]`
// tuple — not computable in pure Cypher — so the backfill reads the pairs in
// JS and writes them back via a bounded UNWIND. The migration is
// SAFE-BY-CONSTRUCTION: it PREFLIGHTS for duplicate ids / pair keys and ABORTS
// (throws) rather than deleting anything, so a genuine drift halts migration for
// an operator to resolve instead of a silent auto-delete choosing a winner. It
// is registered as a MANUAL migration (named execution only) because it adds
// constraints and its preflight can fail closed against real data.
const RADAR_PLACEMENT_PAIR_IDENTITY_MIGRATION_NAME = '2026-07-22-radar-placement-pair-identity';

interface RadarPlacementPairRow {
  id: string;
  radarId: string | null;
  technologyId: string | null;
}

const RADAR_PLACEMENT_PAIR_IDENTITY_RECOVERY =
  'This migration only ADDS RadarPlacement.pairKey and three uniqueness constraints; it deletes nothing. ' +
  'To undo: DROP CONSTRAINT radar_id / radar_placement_id / radar_placement_pair_key IF EXISTS, then ' +
  '`MATCH (p:RadarPlacement) REMOVE p.pairKey`, and delete the :SchemaMigration record for this name.';

/**
 * The ONE read + preflight both `plan()` and `apply()` go through, so the
 * dry-run preview cannot describe a different write than the one that runs.
 */
async function readRadarPlacementPairPlan() {
  const placementRows = await runReadTransaction<RadarPlacementPairRow & { pairKey: string | null }>(
    `MATCH (p:RadarPlacement)
       RETURN p.id AS id, p.radarId AS radarId, p.technologyId AS technologyId, p.pairKey AS pairKey`,
    {}
  );
  const radarRows = await runReadTransaction<{ id: string }>(`MATCH (r:Radar) RETURN r.id AS id`, {});

  return planRadarPlacementPairMigration(
    placementRows.records.map((r) => ({
      id: r.id,
      radarId: r.radarId,
      technologyId: r.technologyId,
      pairKey: r.pairKey,
    })),
    radarRows.records.map((r) => r.id)
  );
}

const MIGRATION_2026_07_22_RADAR_PLACEMENT_PAIR_IDENTITY: SchemaMigration = {
  name: RADAR_PLACEMENT_PAIR_IDENTITY_MIGRATION_NAME,
  description:
    'Backfill RadarPlacement.pairKey from [radarId, technologyId] and install guarded Radar.id / RadarPlacement.id / RadarPlacement.pairKey uniqueness (aborts on duplicate drift).',
  async plan(): Promise<MigrationPlan> {
    const plan = await readRadarPlacementPairPlan();
    return {
      name: RADAR_PLACEMENT_PAIR_IDENTITY_MIGRATION_NAME,
      description: MIGRATION_2026_07_22_RADAR_PLACEMENT_PAIR_IDENTITY.description,
      mutating: plan.backfill.length > 0,
      steps: [
        {
          step: 'backfill-radar-placement-pair-key',
          affected: plan.backfill.length,
          ids: plan.backfill.map((row) => row.id),
        },
        { step: 'create-radar-id-constraint', affected: 0 },
        { step: 'create-radar-placement-id-constraint', affected: 0 },
        { step: 'create-radar-placement-pair-key-constraint', affected: 0 },
      ],
      violations: plan.violations,
      recovery: RADAR_PLACEMENT_PAIR_IDENTITY_RECOVERY,
    };
  },
  async apply() {
    const passes: MigrationPassResult[] = [];

    // (1) Read EVERYTHING first and (2) PREFLIGHT the complete plan (compute all
    //     prospective pair keys) through the SAME helper `plan()` uses. Pure, and
    //     produces NO mutation — a malformed/duplicate input aborts here, BEFORE
    //     the first write, so a failed migration never partially backfills.
    const plan = await readRadarPlacementPairPlan();
    if (plan.violations.length > 0) {
      throw new Error(
        `radar-placement pair-identity preflight failed (zero mutation applied): ${plan.violations.slice(0, 5).join('; ')}`
      );
    }
    passes.push({ pass: 'preflight-no-duplicate-identities', updatedOrDeleted: 0 });

    // (3) Only now — after a clean preflight — backfill the missing pair keys.
    if (plan.backfill.length > 0) {
      await runWriteTransaction(
        `UNWIND $rows AS row
         MATCH (p:RadarPlacement {id: row.id})
         SET p.pairKey = row.pairKey`,
        { rows: plan.backfill }
      );
    }
    passes.push({ pass: 'backfill-radar-placement-pair-key', updatedOrDeleted: plan.backfill.length });

    // (4) Install the uniqueness constraints (idempotent).
    await runWriteTransaction('CREATE CONSTRAINT radar_id IF NOT EXISTS FOR (r:Radar) REQUIRE r.id IS UNIQUE', {});
    passes.push({ pass: 'create-radar-id-constraint', updatedOrDeleted: 0 });
    await runWriteTransaction(
      'CREATE CONSTRAINT radar_placement_id IF NOT EXISTS FOR (p:RadarPlacement) REQUIRE p.id IS UNIQUE',
      {}
    );
    passes.push({ pass: 'create-radar-placement-id-constraint', updatedOrDeleted: 0 });
    await runWriteTransaction(
      'CREATE CONSTRAINT radar_placement_pair_key IF NOT EXISTS FOR (p:RadarPlacement) REQUIRE p.pairKey IS UNIQUE',
      {}
    );
    passes.push({ pass: 'create-radar-placement-pair-key-constraint', updatedOrDeleted: 0 });

    // (5) Verify: after backfill + constraints, no RadarPlacement lacks a pairKey
    //     (for a well-formed node) and no pairKey duplicates survived.
    const verify = await runReadTransaction<{ missingPairKeys: number; duplicatePairKeys: number }>(
      `CALL {
         MATCH (p:RadarPlacement) WHERE p.pairKey IS NULL AND p.radarId IS NOT NULL AND p.technologyId IS NOT NULL
         RETURN count(*) AS missingPairKeys
       }
       CALL {
         MATCH (p:RadarPlacement) WHERE p.pairKey IS NOT NULL
         WITH p.pairKey AS k, count(*) AS c WHERE c > 1
         RETURN count(*) AS duplicatePairKeys
       }
       RETURN missingPairKeys, duplicatePairKeys`,
      {}
    );
    const remaining = verify.records[0] ?? { missingPairKeys: 0, duplicatePairKeys: 0 };
    if (remaining.missingPairKeys !== 0 || remaining.duplicatePairKeys !== 0) {
      throw new Error(
        `radar-placement pair-identity verification failed: missing=${remaining.missingPairKeys}, duplicates=${remaining.duplicatePairKeys}`
      );
    }
    passes.push({ pass: 'verify-radar-placement-pair-identity', updatedOrDeleted: 0 });

    return passes;
  },
};

// ============================================================================
// 2026-07-31-radar-identity-dedupe (GRAPH-071)
// ============================================================================
//
// Collapses duplicate `:Radar` nodes that share one `id`. This is the ROOT of
// two separate `graph:health` violations at once — the missing `radar_id`
// constraint (which cannot be created while a duplicate exists) and
// RadarPlacement nodes "without exactly one ON_RADAR" (because
// `MATCH (r:Radar {id:$radarId}) MERGE (p)-[:ON_RADAR]->(r)` binds every copy).
// It must therefore run BEFORE `2026-07-22-radar-placement-pair-identity`,
// whose preflight correctly refuses to write anything while `Radar.id` is
// duplicated.
//
// MANUAL, and narrow by construction: `planRadarIdentityDedupe` authorizes
// deleting a duplicate ONLY when it is provably redundant (identical properties
// and an incident-edge set contained in the survivor's). Any other drift is a
// violation that aborts before the first write.
const RADAR_IDENTITY_DEDUPE_MIGRATION_NAME = '2026-07-31-radar-identity-dedupe';

const RADAR_IDENTITY_DEDUPE_RECOVERY =
  'This migration DELETES redundant duplicate :Radar nodes. Take a backup first (`npm run neo4j:backup:operator`); ' +
  'recovery is a restore from that backup. Each deleted node was proven to have identical properties to the ' +
  'survivor and no edge the survivor lacks, so re-running the placement projection ' +
  '(`sync-placement-to-neo4j`) rebuilds nothing that was lost.';

interface RadarIdentityRow {
  elementId: string;
  id: string;
  properties: Record<string, unknown>;
  edges: Array<{ type: string; direction: RadarIdentityEdgeDirection; otherElementId: string; otherId: string | null }>;
}

/**
 * The ONE read + plan both `plan()` and `apply()` go through. Reads only the
 * `:Radar` nodes whose id is genuinely duplicated, with their full property bag
 * and every incident edge described by direction, type, and the exact neighbour.
 */
async function readRadarIdentityDedupePlan() {
  const rows = await runReadTransaction<RadarIdentityRow>(
    `MATCH (r:Radar)
     WITH r.id AS radarId, collect(r) AS copies
     WHERE radarId IS NOT NULL AND size(copies) > 1
     UNWIND copies AS r
     RETURN elementId(r) AS elementId,
            r.id AS id,
            properties(r) AS properties,
            [(r)-[e]->(other) | {type: type(e), direction: 'outgoing', otherElementId: elementId(other), otherId: other.id}]
              + [(r)<-[e]-(other) | {type: type(e), direction: 'incoming', otherElementId: elementId(other), otherId: other.id}]
              AS edges
     ORDER BY id, elementId`,
    {}
  );
  return { rows: rows.records, plan: planRadarIdentityDedupe(rows.records) };
}

const MIGRATION_2026_07_31_RADAR_IDENTITY_DEDUPE: SchemaMigration = {
  name: RADAR_IDENTITY_DEDUPE_MIGRATION_NAME,
  description:
    'Collapse duplicate :Radar nodes sharing one id onto a deterministic survivor (aborts on any duplicate that is not provably redundant), unblocking the radar_id constraint and the ON_RADAR cardinality invariant.',
  async plan(): Promise<MigrationPlan> {
    const { plan } = await readRadarIdentityDedupePlan();
    return {
      name: RADAR_IDENTITY_DEDUPE_MIGRATION_NAME,
      description: MIGRATION_2026_07_31_RADAR_IDENTITY_DEDUPE.description,
      mutating: plan.nodesToDelete > 0,
      steps: [
        {
          step: 'delete-redundant-duplicate-radar-nodes',
          affected: plan.nodesToDelete,
          ids: plan.groups.flatMap((group) =>
            group.redundantElementIds.map((elementId) => `${group.radarId}@${elementId}`)
          ),
        },
        { step: 'remove-their-incident-edges', affected: plan.edgesToDelete },
        {
          step: 'surviving-radar-nodes',
          affected: plan.groups.length,
          ids: plan.groups.map((group) => `${group.radarId}@${group.survivorElementId}`),
        },
      ],
      violations: plan.violations,
      recovery: RADAR_IDENTITY_DEDUPE_RECOVERY,
    };
  },
  async apply() {
    const passes: MigrationPassResult[] = [];

    // (1)+(2) Read and preflight through the same helper `plan()` uses. Ambiguous
    //         drift aborts here, BEFORE the first write.
    const { plan } = await readRadarIdentityDedupePlan();
    if (plan.violations.length > 0) {
      throw new Error(
        `radar identity dedupe preflight failed (zero mutation applied): ${plan.violations.slice(0, 5).join('; ')}`
      );
    }
    passes.push({ pass: 'preflight-redundant-duplicates-only', updatedOrDeleted: 0 });

    // (3) Delete only the element ids the plan authorized. Addressing nodes by
    //     elementId — not by `id`, which is exactly what is ambiguous here — is
    //     what keeps the survivor safe. Re-running after a partial failure simply
    //     re-plans against the current graph, so an interrupted run resumes.
    const elementIds = plan.groups.flatMap((group) => group.redundantElementIds);
    if (elementIds.length > 0) {
      await runWriteTransaction(
        `UNWIND $elementIds AS target
         MATCH (r:Radar) WHERE elementId(r) = target
         DETACH DELETE r`,
        { elementIds }
      );
    }
    passes.push({ pass: 'delete-redundant-duplicate-radar-nodes', updatedOrDeleted: elementIds.length });

    // (4) Verify the postcondition the migration exists to establish: no
    //     duplicated Radar.id survives, and no RadarPlacement holds more than one
    //     ON_RADAR edge (the symptom the duplicates produced).
    const verify = await runReadTransaction<{ duplicateRadarIds: number; multiOnRadarPlacements: number }>(
      `CALL {
         MATCH (r:Radar) WHERE r.id IS NOT NULL
         WITH r.id AS id, count(*) AS c WHERE c > 1
         RETURN count(*) AS duplicateRadarIds
       }
       CALL {
         MATCH (p:RadarPlacement)
         WITH p, size([(p)-[e:ON_RADAR]->() | e]) AS onRadar WHERE onRadar > 1
         RETURN count(p) AS multiOnRadarPlacements
       }
       RETURN duplicateRadarIds, multiOnRadarPlacements`,
      {}
    );
    const remaining = verify.records[0] ?? { duplicateRadarIds: 0, multiOnRadarPlacements: 0 };
    if (remaining.duplicateRadarIds !== 0 || remaining.multiOnRadarPlacements !== 0) {
      throw new Error(
        `radar identity dedupe verification failed: duplicateRadarIds=${remaining.duplicateRadarIds}, ` +
          `multiOnRadarPlacements=${remaining.multiOnRadarPlacements}`
      );
    }
    passes.push({ pass: 'verify-radar-identity-dedupe', updatedOrDeleted: 0 });

    return passes;
  },
};

// ============================================================================
// 2026-07-28-mention-trust-derivation (GRAPH-064)
// ============================================================================
//
// Every text-match mention edge minted before GRAPH-064 was stamped
// `claimStatus:'curated'`, `confidence:100` regardless of what it matched in,
// so a weak deep-research draft produced edges indistinguishable from
// human-curated relations in confidence-ordered and curated-path reads.
//
// The correct trust is a function of the SOURCE document's provenance and
// review state, and the graph does not carry either fact until the document
// re-syncs. Rather than guess a classification from the sparse Document node,
// this migration converges in the honest direction:
//
//   1. Demote every never-derived text-match mention edge to the unverified
//      tier. An unclassified legacy edge may not claim curated.
//   2. Clear `sourceFingerprint` on Document nodes that lack `contentProvenance`
//      so the existing projection reconciler classifies them as
//      'pre-contract-projection' and replays exactly those documents. Each
//      replay projects the provenance and re-derives the mention trust —
//      promoting externally-sourced mentions back to curated.
//
// Exact-source guarded: only edges carrying BOTH known minter signatures
// (`assertedBy='system:chunk-mentions'` AND `linkedBy='text-match'`) with no
// `trustDerivedAt` are touched, and their prior values are preserved in
// `claimStatusPreTrust`/`confidencePreTrust` for the manual rollback below.

const MENTION_TRUST_MIGRATION_NAME = '2026-07-28-mention-trust-derivation';
const MENTION_TRUST_ROLLBACK_NAME = '2026-07-28-mention-trust-derivation-rollback';

const DEMOTE_LEGACY_MENTIONS_CYPHER = `
  MATCH ()-[r:MENTIONS]->()
  WHERE r.assertedBy = 'system:chunk-mentions'
    AND r.linkedBy = 'text-match'
    AND r.trustDerivedAt IS NULL
    AND r.claimStatusPreTrust IS NULL
  SET r.claimStatusPreTrust = r.claimStatus,
      r.confidencePreTrust = r.confidence,
      r.assertedConfidencePreTrust = r.assertedConfidence,
      r.effectiveConfidencePreTrust = r.effectiveConfidence,
      r.claimStatus = 'unverified',
      r.confidence = $unreviewedConfidence,
      r.assertedConfidence = $unreviewedConfidence,
      r.effectiveConfidence = $unreviewedConfidence,
      r.sourceProvenance = 'unknown',
      r.sourceReviewState = 'unreviewed',
      r.mentionTrustMigratedAt = $now
  RETURN count(r) AS n
`;

const RESET_DOCUMENT_FINGERPRINTS_CYPHER = `
  MATCH (d:Document)
  WHERE d.contentProvenance IS NULL AND d.sourceFingerprint IS NOT NULL
  REMOVE d.sourceFingerprint
  RETURN count(d) AS n
`;

const RESIDUAL_OVERSTATED_MENTIONS_CYPHER = `
  MATCH ()-[r:MENTIONS]->()
  WHERE r.claimStatus = 'curated'
    AND r.assertedBy = 'system:chunk-mentions'
    AND r.trustDerivedAt IS NULL
  RETURN count(r) AS n
`;

const MIGRATION_2026_07_28_MENTION_TRUST_DERIVATION: SchemaMigration = {
  name: MENTION_TRUST_MIGRATION_NAME,
  description:
    'GRAPH-064: demote never-derived text-match MENTIONS edges from curated/100 to the unverified tier, and drop the sourceFingerprint of Documents with no projected contentProvenance so the reconciler replays them and re-derives the real trust. Reversible via claimStatusPreTrust/confidencePreTrust.',
  async apply() {
    const passes: MigrationPassResult[] = [];
    const now = Date.now();

    const demoted = await runWriteTransaction<{ n: number }>(DEMOTE_LEGACY_MENTIONS_CYPHER, {
      now,
      unreviewedConfidence: UNREVIEWED_MENTION_CONFIDENCE,
    });
    passes.push({ pass: 'demote-underived-text-match-mentions', updatedOrDeleted: demoted.records[0]?.n ?? 0 });

    const replayed = await runWriteTransaction<{ n: number }>(RESET_DOCUMENT_FINGERPRINTS_CYPHER, {});
    passes.push({
      pass: 'queue-documents-for-provenance-replay',
      updatedOrDeleted: replayed.records[0]?.n ?? 0,
    });

    // Invariant: after the demotion pass no mention edge may still claim
    // curated without having been through the derivation. A nonzero residual
    // means the guarded predicate missed a minter signature — fail closed
    // rather than record a migration that left overstated edges behind.
    const residual = await runReadTransaction<{ n: number }>(RESIDUAL_OVERSTATED_MENTIONS_CYPHER, {});
    const residualCount = residual.records[0]?.n ?? 0;
    if (residualCount !== 0) {
      throw new Error(
        `mention-trust migration invariant violated: ${residualCount} MENTIONS edge(s) still claim curated without a derivation`
      );
    }
    passes.push({ pass: 'verify-no-residual-overstated-mentions', updatedOrDeleted: 0 });

    return passes;
  },
};

const ROLLBACK_MENTION_TRUST_CYPHER = `
  MATCH ()-[r:MENTIONS]->()
  WHERE r.claimStatusPreTrust IS NOT NULL
  SET r.claimStatus = r.claimStatusPreTrust,
      r.confidence = r.confidencePreTrust,
      r.assertedConfidence = r.assertedConfidencePreTrust,
      r.effectiveConfidence = r.effectiveConfidencePreTrust
  REMOVE r.claimStatusPreTrust, r.confidencePreTrust, r.assertedConfidencePreTrust,
         r.effectiveConfidencePreTrust, r.mentionTrustMigratedAt,
         r.sourceProvenance, r.sourceReviewState, r.trustDerivedAt
  RETURN count(r) AS n
`;

const MIGRATION_2026_07_28_MENTION_TRUST_DERIVATION_ROLLBACK: SchemaMigration = {
  name: MENTION_TRUST_ROLLBACK_NAME,
  description:
    'Rollback for 2026-07-28-mention-trust-derivation: restores claimStatus/confidence from the *PreTrust properties, removes the derivation markers, and DETACH DELETEs the forward migration record so it can be cleanly re-applied. MANUAL-only. Document sourceFingerprints are NOT restored — a replay is idempotent and re-stamps them.',
  async apply() {
    const passes: MigrationPassResult[] = [];

    const restored = await runWriteTransaction<{ n: number }>(ROLLBACK_MENTION_TRUST_CYPHER, {});
    passes.push({ pass: 'restore-mentions-from-preTrust', updatedOrDeleted: restored.records[0]?.n ?? 0 });

    const unrecord = await runWriteTransaction<{ n: number }>(ROLLBACK_UNRECORD_FORWARD_MIGRATION_CYPHER, {
      migrationName: MENTION_TRUST_MIGRATION_NAME,
    });
    passes.push({ pass: 'unrecord-forward-migration', updatedOrDeleted: unrecord.records[0]?.n ?? 0 });

    return passes;
  },
};

// Migrations run in declaration order. Add new entries at the end.
export const MIGRATIONS: SchemaMigration[] = [
  MIGRATION_2026_04_18_SCHEMA_SIMPLIFICATION,
  MIGRATION_2026_06_23_INTEREST_PROFILE,
  MIGRATION_2026_07_05_CONFIDENCE_SCALE_0_100,
  MIGRATION_2026_07_05_CONFIDENCE_TWO_FIELD_BACKFILL,
  MIGRATION_2026_07_28_MENTION_TRUST_DERIVATION,
];

/**
 * Migrations that are runnable ONLY by explicit name (applyMigrationByName),
 * never auto-applied by applyPendingMigrations. This is the lane for
 * rollbacks and other one-way-door operations where "just apply everything
 * pending" would be actively dangerous — e.g. the confidence-scale-0-100
 * rollback restores pre-migration values and DETACH DELETEs the forward
 * migration's own record, which must never fire as a side effect of a
 * routine `applyPendingMigrations()` sweep.
 */
export const MANUAL_MIGRATIONS: SchemaMigration[] = [
  MIGRATION_2026_07_05_CONFIDENCE_SCALE_0_100_ROLLBACK,
  // This migration consolidates and deletes legacy preference rows. Its
  // backup and operator-approval contract requires exact-name execution.
  MIGRATION_2026_07_12_USER_PREFERENCE_IDENTITY,
  // GRAPH-071: deletes redundant duplicate :Radar nodes, which is what unblocks
  // the migration below. Run this one FIRST, and only against a backed-up graph.
  MIGRATION_2026_07_31_RADAR_IDENTITY_DEDUPE,
  // GRAPH-066: adds uniqueness constraints and aborts on duplicate drift; run by
  // name against a backed-up graph so an operator can resolve any conflict first.
  MIGRATION_2026_07_22_RADAR_PLACEMENT_PAIR_IDENTITY,
  // GRAPH-064 rollback: restores pre-derivation mention trust and deletes the
  // forward migration's own record — never a side effect of a pending sweep.
  MIGRATION_2026_07_28_MENTION_TRUST_DERIVATION_ROLLBACK,
];

// ============================================================================
// Runner
// ============================================================================

async function hasBeenApplied(name: string): Promise<boolean> {
  const res = await runReadTransaction<{ appliedAt: number }>(
    `MATCH (m:SchemaMigration {name: $name}) RETURN m.appliedAt AS appliedAt`,
    { name }
  );
  return res.records.length > 0;
}

async function recordApplied(name: string, description: string, passes: MigrationPassResult[]): Promise<void> {
  await runWriteTransaction(
    `MERGE (m:SchemaMigration {name: $name})
     ON CREATE SET
       m.description = $description,
       m.appliedAt = $now,
       m.passesJson = $passesJson
     ON MATCH SET
       m.lastReappliedAt = $now`,
    {
      name,
      description,
      now: Date.now(),
      passesJson: JSON.stringify(passes),
    }
  );
}

/**
 * Apply one migration by name, or skip if already applied.
 *
 * Returns the run result plus a flag indicating whether it actually ran.
 * Pass `force: true` to re-apply even if recorded (useful during dev when
 * the migration itself has changed but you still want to mark it applied).
 */
export function findMigrationByName(name: string): SchemaMigration | undefined {
  return [...MIGRATIONS, ...MANUAL_MIGRATIONS].find((m) => m.name === name);
}

/**
 * Zero-mutation preview of one migration against the CURRENT graph.
 *
 * Throws for a migration that declares no `plan()` rather than returning an
 * empty preview — silently reporting "nothing to do" for a migration that has
 * simply never implemented a dry-run would be the most dangerous possible
 * answer to "what will this write?".
 */
export async function planMigrationByName(name: string): Promise<MigrationPlan> {
  const migration = findMigrationByName(name);
  if (!migration) throw new Error(`Unknown migration: ${name}`);
  if (!migration.plan) {
    throw new Error(`Migration ${name} does not support --dry-run (no plan() implementation)`);
  }
  return migration.plan();
}

export async function applyMigrationByName(
  name: string,
  options: { force?: boolean } = {}
): Promise<MigrationRunResult> {
  const migration = findMigrationByName(name);
  if (!migration) throw new Error(`Unknown migration: ${name}`);

  const t0 = Date.now();
  const alreadyApplied = await hasBeenApplied(name);

  if (alreadyApplied && !options.force) {
    log.info('Migration already applied, skipping', { name });
    return {
      name,
      description: migration.description,
      alreadyApplied: true,
      passes: [],
      durationMs: Date.now() - t0,
      appliedAt: 0,
    };
  }

  log.info('Applying migration', { name, description: migration.description });
  const passes = await migration.apply();
  await recordApplied(migration.name, migration.description, passes);
  const durationMs = Date.now() - t0;
  log.info('Migration applied', { name, passes, durationMs });

  return {
    name,
    description: migration.description,
    alreadyApplied,
    passes,
    durationMs,
    appliedAt: Date.now(),
  };
}

/** Apply all migrations that haven't been applied yet, in declaration order. */
export async function applyPendingMigrations(): Promise<MigrationRunResult[]> {
  const results: MigrationRunResult[] = [];
  for (const migration of MIGRATIONS) {
    const r = await applyMigrationByName(migration.name);
    results.push(r);
    if (!r.alreadyApplied) {
      log.info('Migration complete', { name: migration.name, durationMs: r.durationMs });
    }
  }
  return results;
}

/** Summary of which migrations have been applied (for /health + UI). */
export async function listAppliedMigrations(): Promise<Array<{ name: string; appliedAt: number }>> {
  const res = await runReadTransaction<{ name: string; appliedAt: number }>(
    `MATCH (m:SchemaMigration) RETURN m.name AS name, m.appliedAt AS appliedAt ORDER BY m.appliedAt ASC`,
    {}
  );
  return res.records.map((r) => ({ name: r.name, appliedAt: r.appliedAt }));
}
