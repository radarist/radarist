/**
 * @file ai/tools/analytics-tools.ts
 * @description AI tools for graph and data analytics.
 *
 * Three read-only analytics tools:
 * - getGraphAnalytics: Entity and relation counts across the knowledge graph
 * - getClaimHealth: Evidence coverage statistics for claims
 * - findDataGaps: Entities with missing data or zero relations
 *
 * Each executor tries Neo4j first and falls back to Firestore if unavailable.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { FunctionDeclaration } from '@google/generative-ai';
import { SchemaType } from '@google/generative-ai';
import neo4j from 'neo4j-driver';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/analytics-tools');

// ============================================================================
// Tool Declarations
// ============================================================================

export const ANALYTICS_TOOLS: FunctionDeclaration[] = [
  {
    name: 'getGraphAnalytics',
    description:
      'Get exact analytics about the knowledge graph: entity counts by type, relation counts by type, total nodes and edges, AND companyStatusDistribution (exact company counts by engagement status: Watching/Contacted/Partner/Rejected). Use this for any "how many", "what percentage", "what % are in <status>", "distribution", or "total" question — compute percentages from these exact counts, never from a capped list.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: 'getClaimHealth',
    description:
      'Get evidence coverage statistics for relations (claims) in the knowledge graph. Shows how many claims have evidence, are verified, or need review.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: 'findDataGaps',
    description:
      'Find entities with missing or incomplete data: entities with 0 relations, entities without descriptions, stale entities not updated recently.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of gaps to return (default: 20)',
        },
      },
    },
  },
];

// ============================================================================
// Result Types
// ============================================================================

export interface GraphAnalyticsResult {
  entityCounts: Record<string, number>;
  relationCounts: Record<string, number>;
  totalEntities: number;
  totalRelations: number;
  /**
   * 2.3 — exact company counts grouped by engagement status (Watching / Contacted
   * / Partner / Rejected), so "what % of companies are in <status>" / distribution
   * questions get a real breakdown instead of a capped-list guess.
   */
  companyStatusDistribution?: Record<string, number>;
}

export interface ClaimHealthResult {
  totalClaims: number;
  byStatus: Record<string, number>;
  avgConfidence: number;
  claimsWithEvidence: number;
  totalEvidence: number;
  byAsserterType: { agent: number; user: number };
  topRelationTypes: Array<{ name: string; count: number }>;
  /**
   * Whether the stats reflect a real graph read. `false` means Neo4j was
   * unavailable and the zeroed numbers are placeholders — NOT a genuinely
   * empty claim graph. Absent/true on a successful read.
   */
  available?: boolean;
  /** Present with `available:false` — the reason the read failed. */
  error?: string;
}

export interface DataGap {
  entityId: string;
  entityName: string;
  entityType: string;
  issues: string[];
}

export interface FindDataGapsResult {
  gaps: DataGap[];
  totalGaps: number;
}

// ============================================================================
// Tool Executors
// ============================================================================

/**
 * Get analytics about the knowledge graph: entity and relation counts.
 *
 * ENTITY counts come from Firestore — the canonical "what we are tracking"
 * source the library pages show. Neo4j node counts drift higher (it holds
 * orphans from the approve-then-link lifecycle), so using Neo4j for "how many
 * companies do we have" over-counts vs what the user sees in /library.
 * RELATION counts come from Neo4j (graph-native), since relations live there.
 * Each source is independently fault-tolerant.
 */
export async function executeGetGraphAnalytics(): Promise<GraphAnalyticsResult> {
  // Entity counts: Firestore (canonical) — the number users see in the library.
  const firestore = await getGraphAnalyticsFromFirestore();

  // Relation counts: Neo4j (graph-native), best-effort. Firestore already
  // produced a relations total as a baseline; overlay the Neo4j per-type
  // breakdown when the graph is reachable.
  let relationCounts = firestore.relationCounts;
  let totalRelations = firestore.totalRelations;
  try {
    const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
    const { GET_RELATIONSHIP_STATS } = await import('@/lib/graph/cypher-templates');
    const relResult = await runReadTransaction<{ relationType: string; count: number }>(GET_RELATIONSHIP_STATS);
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of relResult.records) {
      byType[row.relationType] = row.count;
      total += row.count;
    }
    if (total > 0) {
      relationCounts = byType;
      totalRelations = total;
    }
  } catch (neo4jError) {
    log.warn('Neo4j unavailable for relation breakdown; using Firestore relations total', {
      error: neo4jError instanceof Error ? neo4jError.message : String(neo4jError),
    });
  }

  log.info('Graph analytics retrieved (Firestore entities + Neo4j relations)', {
    totalEntities: firestore.totalEntities,
    totalRelations,
  });
  return {
    entityCounts: firestore.entityCounts,
    relationCounts,
    totalEntities: firestore.totalEntities,
    totalRelations,
    companyStatusDistribution: firestore.companyStatusDistribution,
  };
}

/**
 * Firestore fallback for graph analytics.
 * Reads Firestore collection sizes (limited fields via select).
 */
async function getGraphAnalyticsFromFirestore(): Promise<GraphAnalyticsResult> {
  const { db } = await import('@/lib/firebase-admin');

  // H3: use-cases and org-units are kebab-case in Firestore (see
  // entity-factory ENTITY_CONFIGS). The camelCase names 'useCases'/'orgUnits'
  // do not exist and silently counted 0.
  const entityTypes = [
    'companies',
    'technologies',
    'signals',
    'use-cases',
    'strategies',
    'prototypes',
    'org-units',
    'initiatives',
    'painPoints',
  ];

  const entityCounts: Record<string, number> = {};

  // Parallel count queries using countDocuments (or .get() + .size fallback)
  await Promise.all(
    entityTypes.map(async (collectionName) => {
      try {
        const snapshot = await db.collection(collectionName).count().get();
        entityCounts[collectionName] = snapshot.data().count;
      } catch {
        // .count() may not be available in older SDK versions; fall back
        const snapshot = await db.collection(collectionName).select().get();
        entityCounts[collectionName] = snapshot.size;
      }
    })
  );

  let relationsCount = 0;
  try {
    const relSnapshot = await db.collection('relations').count().get();
    relationsCount = relSnapshot.data().count;
  } catch {
    const relSnapshot = await db.collection('relations').select().get();
    relationsCount = relSnapshot.size;
  }

  // 2.3 — exact company counts by engagement status (group-by aggregate). Counted
  // per known status via Firestore COUNT so "% in Watching" is answerable exactly.
  const COMPANY_STATUSES = ['Watching', 'Contacted', 'Partner', 'Rejected'];
  const companyStatusDistribution: Record<string, number> = {};
  await Promise.all(
    COMPANY_STATUSES.map(async (status) => {
      try {
        const snap = await db.collection('companies').where('status', '==', status).count().get();
        companyStatusDistribution[status] = snap.data().count;
      } catch {
        companyStatusDistribution[status] = 0;
      }
    })
  );

  const totalEntities = Object.values(entityCounts).reduce((sum, c) => sum + c, 0);

  log.info('Graph analytics retrieved via Firestore fallback', { totalEntities, totalRelations: relationsCount });

  return {
    entityCounts,
    relationCounts: {},
    totalEntities,
    totalRelations: relationsCount,
    companyStatusDistribution,
  };
}

/**
 * Get claim health statistics: evidence coverage, verification status, etc.
 *
 * Delegates to the existing getAssertionStats() from the graph claims module.
 * Falls back to a minimal Firestore-only response if Neo4j is unavailable.
 */
export async function executeGetClaimHealth(): Promise<ClaimHealthResult> {
  try {
    const { getAssertionStats } = await import('@/lib/graph/assertions');
    const stats = await getAssertionStats();

    log.info('Claim health retrieved', { totalClaims: stats.totalClaims });

    return {
      available: true,
      totalClaims: stats.totalClaims,
      byStatus: stats.byStatus,
      avgConfidence: stats.avgConfidence,
      claimsWithEvidence: stats.claimsWithEvidence,
      totalEvidence: stats.totalEvidence,
      byAsserterType: stats.byAsserterType,
      topRelationTypes: stats.topRelationTypes,
    };
  } catch (error) {
    log.warn('Could not retrieve claim health (Neo4j likely unavailable)', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Zeroed numbers for shape compatibility, but flag the outage so the
    // caller/LLM does not read "0 claims" as a genuinely empty claim graph.
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Claim graph unavailable',
      totalClaims: 0,
      byStatus: { proposed: 0, curated: 0, rejected: 0, derived: 0 },
      avgConfidence: 0,
      claimsWithEvidence: 0,
      totalEvidence: 0,
      byAsserterType: { agent: 0, user: 0 },
      topRelationTypes: [],
    };
  }
}

/**
 * Find entities with data quality issues: missing descriptions, zero
 * relations, or stale data (not updated in 90+ days).
 *
 * Tries Neo4j first; falls back to Firestore for basic gap detection.
 *
 * @param args.limit - Maximum gaps to return (default 20)
 */
export async function executeFindDataGaps(args: Record<string, unknown>): Promise<FindDataGapsResult> {
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 20)), 100);

  try {
    return await findDataGapsFromNeo4j(limit);
  } catch (error) {
    log.warn('Neo4j unavailable for gap analysis, falling back to Firestore', {
      error: error instanceof Error ? error.message : String(error),
    });
    return findDataGapsFromFirestore(limit);
  }
}

/**
 * Neo4j-based gap analysis: find entities with no relationships.
 */
async function findDataGapsFromNeo4j(limit: number): Promise<FindDataGapsResult> {
  const { runReadTransaction } = await import('@/lib/graph/neo4j-client');

  // Find entities with zero relationships
  const cypher = `
    MATCH (n:Entity)
    WHERE NOT (n)--()
    RETURN n.id AS entityId, n.name AS entityName, n.entityType AS entityType
    ORDER BY n.name
    LIMIT $limit
  `;

  // H3: the driver transmits raw JS numbers as FLOATs (20 → 20.0) and Neo4j
  // rejects floats for LIMIT — wrap as a proper Neo4j Integer.
  const result = await runReadTransaction<{
    entityId: string;
    entityName: string;
    entityType: string;
  }>(cypher, { limit: neo4j.int(limit) });

  const gaps: DataGap[] = result.records.map((r) => ({
    entityId: r.entityId,
    entityName: r.entityName ?? 'Unknown',
    entityType: r.entityType ?? 'unknown',
    issues: ['No relations in knowledge graph'],
  }));

  log.info('Data gaps found via Neo4j', { gapCount: gaps.length });

  return { gaps, totalGaps: gaps.length };
}

/**
 * Firestore-based gap analysis: find entities missing descriptions.
 *
 * Each gap carries the canonical singular `entityType` (e.g. `'company'`,
 * not `'companies'`). Phase 0 step 0.5 fixed this — prior versions wrote
 * the collection name (plural) directly, which then failed to match the
 * singular keys in `getInsightAction` and produced insights with a
 * useless `/library` action URL. Pair this with the plural→singular
 * safety net in `normaliseEntityType` (step 0.4) — both ends now agree.
 */
async function findDataGapsFromFirestore(limit: number): Promise<FindDataGapsResult> {
  const { db } = await import('@/lib/firebase-admin');

  const collections: Array<{ name: string; entityType: string; nameField: string; descField: string }> = [
    { name: 'companies', entityType: 'company', nameField: 'name', descField: 'description' },
    { name: 'technologies', entityType: 'technology', nameField: 'name', descField: 'description' },
    // H3: the Firestore collection is kebab-case 'use-cases' ('useCases' does not exist)
    { name: 'use-cases', entityType: 'useCase', nameField: 'title', descField: 'description' },
    { name: 'prototypes', entityType: 'prototype', nameField: 'name', descField: 'description' },
    { name: 'strategies', entityType: 'strategy', nameField: 'name', descField: 'description' },
  ];

  const gaps: DataGap[] = [];

  for (const col of collections) {
    if (gaps.length >= limit) break;

    const snapshot = await db.collection(col.name).select(col.nameField, col.descField, 'updatedAt').limit(limit).get();

    for (const docSnap of snapshot.docs) {
      if (gaps.length >= limit) break;

      const data = docSnap.data();
      const issues: string[] = [];

      if (!data[col.descField] || (data[col.descField] as string).trim().length === 0) {
        issues.push('Missing description');
      }

      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const updatedAt = data.updatedAt as number | undefined;
      if (updatedAt && Date.now() - updatedAt > ninetyDaysMs) {
        issues.push('Stale (not updated in 90+ days)');
      }

      if (issues.length > 0) {
        gaps.push({
          entityId: docSnap.id,
          entityName: (data[col.nameField] as string) ?? 'Unknown',
          entityType: col.entityType,
          issues,
        });
      }
    }
  }

  log.info('Data gaps found via Firestore fallback', { gapCount: gaps.length });

  return { gaps, totalGaps: gaps.length };
}

/**
 * Find entities whose Defense Minister verification is stale or missing.
 *
 * Returns DataGap-shaped objects so the sweep cycle can route them through
 * the existing SENSE/DECIDE pipeline. Each returned gap carries the
 * `'needs reverification'` issue marker which the sweep's `classifyGap`
 * recognizes and routes to a verification-event dispatch (not a new agent
 * mission).
 *
 * Scope: only `companies` and `technologies` — these are the externally-
 * named entities the Defense Minister verifies. Internal artifacts
 * (prototypes / strategies / use cases) don't have web presence to verify.
 */
export async function findEntitiesNeedingReverification(ageDays: number, limit: number): Promise<FindDataGapsResult> {
  const { db } = await import('@/lib/firebase-admin');
  const cutoffMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // entityType uses the singular ENTITY_CONFIGS key (e.g. 'company', not
  // 'companies') so verify-entity can resolve it via
  // ENTITY_CONFIGS[entityType].collection. The plural fallback would
  // produce 'companiess' and 404 in the load-entity step.
  const collections: Array<{ name: string; entityType: string; nameField: string }> = [
    { name: 'companies', entityType: 'company', nameField: 'name' },
    { name: 'technologies', entityType: 'technology', nameField: 'name' },
  ];

  const gaps: DataGap[] = [];

  for (const col of collections) {
    if (gaps.length >= limit) break;

    // Pull a small batch of entities; client-side filter on verifiedAt.
    // Avoids requiring a Firestore composite index for this lookup.
    const snapshot = await db
      .collection(col.name)
      .select(col.nameField, 'verifiedAt')
      .limit(limit * 4)
      .get();

    for (const docSnap of snapshot.docs) {
      if (gaps.length >= limit) break;

      const data = docSnap.data();
      const verifiedAt = data.verifiedAt as string | number | undefined;
      let isStale = false;
      if (verifiedAt === undefined || verifiedAt === null) {
        isStale = true;
      } else if (typeof verifiedAt === 'string') {
        isStale = verifiedAt < cutoffIso;
      } else if (typeof verifiedAt === 'number') {
        isStale = verifiedAt < cutoffMs;
      }

      if (isStale) {
        gaps.push({
          entityId: docSnap.id,
          entityName: (data[col.nameField] as string) ?? 'Unknown',
          entityType: col.entityType,
          issues: [`needs reverification (verifiedAt > ${ageDays} days ago or missing)`],
        });
      }
    }
  }

  log.info('Reverification gaps found', { gapCount: gaps.length, ageDays });
  return { gaps, totalGaps: gaps.length };
}
