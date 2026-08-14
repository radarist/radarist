/**
 * @file lib/inngest/functions/sync-entity-to-neo4j.ts
 * @description Unified Inngest job for syncing ALL entity types to Neo4j
 *
 * This module handles synchronization of all entities to the Neo4j graph:
 * - Company, Strategy, Prototype, Signal, OrgUnit, Initiative, PainPoint, UseCase, RadarPlacement
 * - Creates Entity nodes with appropriate labels
 * - Preserves all entity properties for AI/agent use
 *
 * **Entity Types Handled:**
 * - company: Company entities
 * - strategy: Strategic plans
 * - prototype: Prototype projects
 * - signal: Market signals
 * - orgUnit: Organizational units
 * - initiative: Strategic initiatives
 * - painPoint: Business pain points
 * - useCase: Use case definitions
 * - radarPlacement: Radar placement positions
 *
 * **Trigger:** Event-driven (`app/unified-entity.sync.requested`)
 * **Timeout:** 30 seconds per entity
 * **Retries:** 3 attempts with exponential backoff
 *
 * @author Radarist Team
 * @created 2026-01-14
 */

import { createHash } from 'node:crypto';
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { SKIP_REASONS } from '../skip-reasons';
import { toMillis, extractFailureEventData } from '../utils';
import { checkHealth, deleteEntityFromGraph, runWriteTransaction } from '@/lib/graph';
import { invalidateCachesForEntity } from '@/lib/graph/query-cache';
import { scheduleEntityEmbed, type EmbeddableLabel } from '@/lib/graph/embedding-sync';
import { loadSignalProjectionDecision } from '@/lib/graph/signal-projection-policy-admin';
import type { SignalProjectionReference } from '@/lib/graph/signal-projection-policy';
import { buildInitiativeDependencyReplayEvent, loadDependentInitiativeIds } from '../initiative-dependent-replay';
import {
  buildInitiativeLinkProjection,
  type InitiativeLinkProjectionReceipt,
} from '@/lib/graph/initiative-link-projection';
import {
  captureEntityTagConceptIdsFromNeo4j,
  projectEntityTagConceptsToNeo4j,
  reconcileConceptEntityCounts,
  reconcileEntityTagConcepts,
} from '@/lib/graph/entity-tag-concept-projection';
import { maybeBuildEntityCreateVerificationEvent } from '../entity-verification-dispatch';
import { createLogger } from '@/lib/logger';
import { createEntitySourceFingerprint, normalizeEntityGraphSet } from '@/lib/entity-source-version';
import { isLibraryEntitySyncType } from '@/lib/entity-sync';
import { clearConvergedEntityGraphSyncAnchor, readEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';

const log = createLogger('inngest/sync-entity-to-neo4j');
import type { EntityType } from '@/lib/types';

function invalidateEntityQueryCaches(entityId: string): void {
  try {
    invalidateCachesForEntity(entityId);
  } catch (cacheError) {
    log.warn('Cache invalidation failed (non-fatal)', {
      entityId,
      error: cacheError instanceof Error ? cacheError.message : String(cacheError),
    });
  }
}

function signalReferenceReplayEvent(parentEventId: string, signalId: string, reference: SignalProjectionReference) {
  const digest = createHash('sha256')
    .update(`${parentEventId}\u0000${signalId}\u0000${reference.kind}\u0000${reference.id}`)
    .digest('hex');
  return reference.kind === 'relation-endpoint'
    ? {
        id: `signal-reference-replay:${digest}`,
        name: 'app/relation.sync.requested' as const,
        data: { operation: 'update' as const, relationId: reference.id },
      }
    : {
        id: `signal-reference-replay:${digest}`,
        name: 'app/entity-document-link.sync.requested' as const,
        data: { operation: 'update' as const, linkId: reference.id },
      };
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

// M1 / decision D2: identifier-only event shape — the handler always loads
// the full document from Firestore admin (no inline data side-channel).
interface EntitySyncEventData {
  operation: 'create' | 'update' | 'delete';
  entityType: EntityType;
  entityId: string;
}

interface SyncResult {
  entityId: string;
  entityType: EntityType;
  operation: 'created' | 'updated' | 'deleted';
  /**
   * P3-B (H7 model): implicit relationship writes (CHILD_OF, OWNED_BY, …)
   * that failed this run. Non-zero ⇒ the run must not report success:true —
   * previously these were warn-and-continue masked.
   */
  implicitRelationshipFailures?: number;
  /** Referenced Firestore IDs that had no graph target during this run. */
  implicitRelationshipMissingTargets?: {
    strategyIds: string[];
    painPointIds: string[];
  };
  skipped?: 'source-missing' | 'projection-ineligible';
  /** GRAPH-056: fingerprint stamped on the node, used to settle the recovery anchor. */
  sourceFingerprint?: string;
  projectionReason?: 'approved-or-imported' | 'reference-required' | 'inbox-only';
  referenceReplays?: SignalProjectionReference[];
  /** Initiative projections to replay after this Strategy/PainPoint arrives. */
  dependentInitiativeIds?: string[];
}

const DELETE_SOURCE_WAIT_SECONDS = [1, 2, 4, 8] as const;

// ============================================================================
// ENTITY TYPE TO LABEL MAPPING
// ============================================================================

const ENTITY_TYPE_TO_LABEL: Record<string, string> = {
  company: 'Company',
  strategy: 'Strategy',
  prototype: 'Prototype',
  signal: 'Signal',
  orgUnit: 'OrgUnit',
  initiative: 'Initiative',
  painPoint: 'PainPoint',
  useCase: 'UseCase',
  radarPlacement: 'RadarPlacement',
};

// ============================================================================
// FIRESTORE LOADERS
// ============================================================================

/**
 * EntityType → Firestore collection name. Kept here (not derived from the
 * label mapping) because Firestore collections use mixed naming conventions
 * (kebab-case for `org-units` and `use-cases`, camelCase elsewhere).
 */
const ENTITY_TYPE_TO_COLLECTION: Record<EntityType, string> = {
  company: 'companies',
  strategy: 'strategies',
  prototype: 'prototypes',
  signal: 'signals',
  orgUnit: 'org-units',
  initiative: 'initiatives',
  painPoint: 'painPoints',
  useCase: 'use-cases',
  radarPlacement: 'radarPlacements',
  technology: 'technologies',
  document: 'documents',
};

/**
 * Load an entity directly via the admin SDK. Going through the per-entity
 * service modules (`@/lib/companies`, `@/lib/prototypes`, etc.) pulls in
 * `@/lib/firebase` (client SDK), which hangs gRPC Listen streams ~5–50s
 * server-side and eventually fails with "client is offline". Same bug class
 * as the 2026-05-12 relation sync fix, applied here to the generic loader
 * so all nine handled entity types get the fix in one place.
 */
async function loadEntityFromFirestore(
  entityType: EntityType,
  entityId: string
): Promise<Record<string, unknown> | null> {
  const collectionName = ENTITY_TYPE_TO_COLLECTION[entityType];
  if (!collectionName) return null;
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snap = await adminDb.collection(collectionName).doc(entityId).get();
  if (!snap.exists) return null;
  return snap.data() as Record<string, unknown>;
}

// ============================================================================
// CYPHER QUERY BUILDERS
// ============================================================================

function buildUpsertQuery(label: string): string {
  return `
    MERGE (e:Entity:${label} {id: $entityId})
    ON CREATE SET
      e.name = $name,
      e.title = $title,
      e.description = $description,
      e.status = $status,
      e.tags = $tags,
      e.entityType = $entityType,
      e.category = $category,
      e.priority = $priority,
      e.severity = $severity,
      e.type = $type,
      e.level = $level,
      e.budget = $budget,
      e.impact = $impact,
      e.confidence = $confidence,
      e.createdAt = $createdAt,
      e.updatedAt = $updatedAt,
      e.properties = $properties,
      e.companyType = $companyType,
      e.industry = $industry,
      e.companySize = $companySize,
      e.headquarters = $headquarters,
      e.locationCity = $locationCity,
      e.locationCountry = $locationCountry,
      e.website = $website,
      e.sourceType = $sourceType,
      e.sourceUrl = $sourceUrl,
      e.sentiment = $sentiment,
      e.publishedDate = $publishedDate,
      e.horizon = $horizon,
      e.alignmentScore = $alignmentScore,
      e.problemDomain = $problemDomain,
      e.solutionCategory = $solutionCategory,
      e.phase = $phase,
      e.successCriteria = $successCriteria,
      e.startDate = $startDate,
      e.endDate = $endDate
    ON MATCH SET
      e.name = $name,
      e.title = $title,
      e.description = $description,
      e.status = $status,
      e.tags = $tags,
      e.category = $category,
      e.priority = $priority,
      e.severity = $severity,
      e.type = $type,
      e.level = $level,
      e.budget = $budget,
      e.impact = $impact,
      e.confidence = $confidence,
      e.updatedAt = $updatedAt,
      e.properties = $properties,
      e.companyType = $companyType,
      e.industry = $industry,
      e.companySize = $companySize,
      e.headquarters = $headquarters,
      e.locationCity = $locationCity,
      e.locationCountry = $locationCountry,
      e.website = $website,
      e.sourceType = $sourceType,
      e.sourceUrl = $sourceUrl,
      e.sentiment = $sentiment,
      e.publishedDate = $publishedDate,
      e.horizon = $horizon,
      e.alignmentScore = $alignmentScore,
      e.problemDomain = $problemDomain,
      e.solutionCategory = $solutionCategory,
      e.phase = $phase,
      e.successCriteria = $successCriteria,
      e.startDate = $startDate,
      e.endDate = $endDate
    RETURN e
  `;
}

const STAMP_ENTITY_SOURCE_FINGERPRINT = `
  MATCH (e:Entity {id: $entityId})
  SET e.sourceFingerprint = $sourceFingerprint
  RETURN e.id AS entityId
`;

/**
 * GRAPH-063 — a named, bounded description of an implicit edge that could not
 * be written because its target was absent from the graph.
 */
export interface UnresolvedImplicitTarget {
  /** The Neo4j predicate the MERGE would have written. */
  predicate: string;
  /** Target IDs the query needed, excluding the entity being synced. */
  targetIds: string[];
}

/** Keep a pathological entity from writing an unbounded run summary. */
const MAX_REPORTED_UNRESOLVED_TARGETS = 10;

/**
 * Derive the predicate and target IDs of a failed implicit-relationship write
 * from the query itself, so every builder entry is described without each one
 * having to carry duplicate metadata.
 */
export function describeImplicitTarget(
  query: string,
  params: Record<string, unknown>,
  entityId: string
): UnresolvedImplicitTarget {
  const predicate = query.match(/MERGE\s*\([^)]*\)-\[\s*\w*\s*:\s*(\w+)/)?.[1] ?? 'UNKNOWN';
  const targetIds = Object.values(params).filter(
    (value): value is string => typeof value === 'string' && value.length > 0 && value !== entityId
  );
  return { predicate, targetIds };
}

/**
 * Create implicit relationship edges from entity arrays
 * e.g., OrgUnit parentId → CHILD_OF, Initiative ownerOrgUnitId → OWNED_BY
 */
function buildImplicitRelationshipQueries(
  entityId: string,
  entityType: string,
  props: ExtractedProperties
): Array<{ query: string; params: Record<string, unknown> }> {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];

  // OrgUnit hierarchy: CHILD_OF parent
  if (entityType === 'orgUnit' && props.parentId) {
    queries.push({
      query: `
        MATCH (child:OrgUnit {id: $childId})
        MATCH (parent:OrgUnit {id: $parentId})
        MERGE (child)-[r:CHILD_OF]->(parent)
        RETURN r
      `,
      params: { childId: entityId, parentId: props.parentId },
    });
  }

  // Initiative ownership: OWNED_BY orgUnit
  if (entityType === 'initiative' && props.ownerOrgUnitId) {
    queries.push({
      query: `
        MATCH (initiative:Initiative {id: $initiativeId})
        MATCH (orgUnit:OrgUnit {id: $orgUnitId})
        MERGE (initiative)-[r:OWNED_BY]->(orgUnit)
        RETURN r
      `,
      params: { initiativeId: entityId, orgUnitId: props.ownerOrgUnitId },
    });
  }

  // PainPoint affects OrgUnits: AFFECTS
  if (entityType === 'painPoint' && props.relatedEntityIds.length > 0) {
    for (const orgUnitId of props.relatedEntityIds) {
      queries.push({
        query: `
          MATCH (painPoint:PainPoint {id: $painPointId})
          MATCH (orgUnit:OrgUnit {id: $orgUnitId})
          MERGE (painPoint)-[r:AFFECTS]->(orgUnit)
          RETURN r
        `,
        params: { painPointId: entityId, orgUnitId },
      });
    }
  }

  // UseCase links to Technologies: IMPLEMENTED_WITH
  if (entityType === 'useCase' && props.relatedEntityIds.length > 0) {
    for (const relatedId of props.relatedEntityIds) {
      queries.push({
        query: `
          MATCH (useCase:UseCase {id: $useCaseId})
          MATCH (target:Entity {id: $targetId})
          MERGE (useCase)-[r:LINKED_TO]->(target)
          RETURN r
        `,
        params: { useCaseId: entityId, targetId: relatedId },
      });
    }
  }

  // Signal relationships (complex - relates to many entity types)
  if (entityType === 'signal') {
    // Need to extract the full signal data for relationship building
    // This is passed through props.properties as JSON
    const signalData = JSON.parse(props.properties || '{}');

    // linkedEntities.technologies → RELATES_TO Technology
    const linkedTechs = signalData.linkedEntities?.technologies || [];
    for (const techId of linkedTechs) {
      queries.push({
        query: `
          MATCH (signal:Signal {id: $signalId})
          MATCH (tech:Technology {id: $techId})
          MERGE (signal)-[r:RELATES_TO]->(tech)
          SET r.linkType = 'linkedEntity'
          RETURN r
        `,
        params: { signalId: entityId, techId },
      });
    }

    // linkedEntities.companies → RELATES_TO Company
    const linkedCompanies = signalData.linkedEntities?.companies || [];
    for (const companyId of linkedCompanies) {
      queries.push({
        query: `
          MATCH (signal:Signal {id: $signalId})
          MATCH (company:Company {id: $companyId})
          MERGE (signal)-[r:RELATES_TO]->(company)
          SET r.linkType = 'linkedEntity'
          RETURN r
        `,
        params: { signalId: entityId, companyId },
      });
    }

    // linkedEntities.useCases → RELATES_TO UseCase
    const linkedUseCases = signalData.linkedEntities?.useCases || [];
    for (const useCaseId of linkedUseCases) {
      queries.push({
        query: `
          MATCH (signal:Signal {id: $signalId})
          MATCH (useCase:UseCase {id: $useCaseId})
          MERGE (signal)-[r:RELATES_TO]->(useCase)
          SET r.linkType = 'linkedEntity'
          RETURN r
        `,
        params: { signalId: entityId, useCaseId },
      });
    }

    // alignedStrategies → ALIGNS_WITH Strategy
    const alignedStrategies = signalData.alignedStrategies || [];
    for (const strategyId of alignedStrategies) {
      queries.push({
        query: `
          MATCH (signal:Signal {id: $signalId})
          MATCH (strategy:Strategy {id: $strategyId})
          MERGE (signal)-[r:ALIGNS_WITH]->(strategy)
          SET r.alignmentScore = $alignmentScore
          RETURN r
        `,
        params: {
          signalId: entityId,
          strategyId,
          alignmentScore: props.alignmentScore ?? 0,
        },
      });
    }

    // importedAs → BECAME (when signal converted to entity)
    if (signalData.importedAs?.id && signalData.importedAs?.type) {
      const importedType = signalData.importedAs.type;
      const labelMap: Record<string, string> = {
        technology: 'Technology',
        company: 'Company',
        useCase: 'UseCase',
      };
      const targetLabel = labelMap[importedType] || 'Entity';

      queries.push({
        query: `
          MATCH (signal:Signal {id: $signalId})
          MATCH (target:${targetLabel} {id: $targetId})
          MERGE (signal)-[r:BECAME]->(target)
          SET r.importedAt = timestamp()
          RETURN r
        `,
        params: { signalId: entityId, targetId: signalData.importedAs.id },
      });
    }

    // expandedContent.relatedItems.signals → RELATED_SIGNAL (signal-to-signal)
    const relatedSignals = signalData.expandedContent?.relatedItems?.signals || [];
    for (const relatedSignal of relatedSignals) {
      if (relatedSignal.id && relatedSignal.id !== entityId) {
        queries.push({
          query: `
            MATCH (signal1:Signal {id: $signalId})
            MATCH (signal2:Signal {id: $relatedSignalId})
            MERGE (signal1)-[r:RELATED_SIGNAL]->(signal2)
            SET r.relevance = $relevance
            RETURN r
          `,
          params: {
            signalId: entityId,
            relatedSignalId: relatedSignal.id,
            relevance: relatedSignal.relevance || 'related',
          },
        });
      }
    }

    // expandedContent.relatedItems.technologies → DISCOVERED (AI-found relations)
    const discoveredTechs = signalData.expandedContent?.relatedItems?.technologies || [];
    for (const tech of discoveredTechs) {
      if (tech.id && !linkedTechs.includes(tech.id)) {
        queries.push({
          query: `
            MATCH (signal:Signal {id: $signalId})
            MATCH (tech:Technology {id: $techId})
            MERGE (signal)-[r:DISCOVERED]->(tech)
            SET r.relevance = $relevance, r.aiGenerated = true
            RETURN r
          `,
          params: {
            signalId: entityId,
            techId: tech.id,
            relevance: tech.relevance || 'related',
          },
        });
      }
    }

    // expandedContent.relatedItems.companies → DISCOVERED (AI-found relations)
    const discoveredCompanies = signalData.expandedContent?.relatedItems?.companies || [];
    for (const company of discoveredCompanies) {
      if (company.id && !linkedCompanies.includes(company.id)) {
        queries.push({
          query: `
            MATCH (signal:Signal {id: $signalId})
            MATCH (company:Company {id: $companyId})
            MERGE (signal)-[r:DISCOVERED]->(company)
            SET r.relevance = $relevance, r.aiGenerated = true
            RETURN r
          `,
          params: {
            signalId: entityId,
            companyId: company.id,
            relevance: company.relevance || 'related',
          },
        });
      }
    }
  }

  return queries;
}

// ============================================================================
// PROPERTY EXTRACTORS
// ============================================================================

/**
 * Entity-specific property extractors for optimal AI queryability
 * These flatten key properties directly onto nodes for Cypher access
 *
 * @updated 2026-01-15 - Added AI-valuable direct properties for better querying
 */
interface ExtractedProperties {
  // Common properties (all entities)
  name: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  // Entity-specific properties (flattened for direct access)
  category: string | string[] | null;
  priority: string | null;
  severity: string | null;
  type: string | string[] | null;
  level: number | null;
  budget: number | null;
  impact: number | null;
  confidence: number | null;
  // Relationship arrays (for creating implicit edges)
  relatedEntityIds: string[];
  parentId: string | null;
  ownerOrgUnitId: string | null;
  // Concept IDs (for creating HAS_CONCEPT edges)
  conceptIds: string[];

  // =========================================================================
  // NEW: AI-Valuable Direct Properties (added 2026-01-15)
  // These are exposed directly on Neo4j nodes for efficient AI queries
  // =========================================================================

  // Company-specific
  companyType: string | string[] | null; // vendor, partner, competitor, startup, customer
  industry: string | string[] | null; // Industry sector
  companySize: string | null; // small, medium, large, enterprise
  headquarters: string | null; // Location string (e.g., "New York, United States")
  locationCity: string | null; // City from location object
  locationCountry: string | null; // Country from location object
  website: string | null; // Company website URL

  // Signal-specific
  sourceType: string | null; // patent, news, academic, github, funding, social
  sourceUrl: string | null; // Source URL for reference
  sentiment: string | null; // positive, negative, neutral
  publishedDate: number | null; // When the signal was published

  // Strategy/Signal-specific
  horizon: string | null; // short, medium, long
  alignmentScore: number | null; // How well aligned (0-100)

  // UseCase-specific
  problemDomain: string | null; // What problem domain
  solutionCategory: string | null; // Category of solution

  // Prototype-specific
  phase: string | null; // ideation, poc, pilot, production
  successCriteria: string | null; // Success criteria summary

  // Initiative-specific
  startDate: number | null; // Initiative start
  endDate: number | null; // Initiative end

  // Full properties JSON for AI deep analysis
  properties: string;
}

function alignmentScoreOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function normalizedStringOrSet(value: unknown): string | string[] | null {
  if (Array.isArray(value)) return normalizeEntityGraphSet(value);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractCommonProperties(entity: Record<string, unknown>, entityType: string): ExtractedProperties {
  // Common properties — use title as name for entity types that use 'title' as their nameField
  // (Signal, PainPoint, UseCase use 'title'; Company, Technology, etc. use 'name')
  const TITLE_BASED_TYPES = ['signal', 'painPoint', 'useCase', 'initiative'];
  const rawName = (entity.name as string) || null;
  const rawTitle = (entity.title as string) || null;
  const name = TITLE_BASED_TYPES.includes(entityType) ? (rawTitle ?? rawName) : (rawName ?? rawTitle);
  const title = rawTitle;
  const description = (entity.description as string) || null;
  const status = (entity.status as string) || null;
  const tags = normalizeEntityGraphSet(entity.tags);
  // Convert timestamps using utility (handles serialized Firestore timestamps from Inngest events)
  // Missing source timestamps are legacy-valid. Keep them deterministic so a
  // replay cannot manufacture a new graph projection from ambient wall time.
  const createdAt = toMillis(entity.createdAt, 0);
  const updatedAt = toMillis(entity.updatedAt, 0);

  // Entity-specific properties (flattened for direct Cypher queries)
  let category: string | string[] | null = null;
  let priority: string | null = null;
  let severity: string | null = null;
  let type: string | string[] | null = null;
  let level: number | null = null;
  let budget: number | null = null;
  let impact: number | null = null;
  let confidence: number | null = null;
  let relatedEntityIds: string[] = [];
  let parentId: string | null = null;
  let ownerOrgUnitId: string | null = null;

  // Concept IDs (common across all entity types)
  const conceptIds = normalizeEntityGraphSet(entity.conceptIds);

  // NEW: AI-Valuable Direct Properties (initialized to null)
  let companyType: string | string[] | null = null;
  let industry: string | string[] | null = null;
  let companySize: string | null = null;
  let headquarters: string | null = null;
  let locationCity: string | null = null;
  let locationCountry: string | null = null;
  let website: string | null = null;
  let sourceType: string | null = null;
  let sourceUrl: string | null = null;
  let sentiment: string | null = null;
  let publishedDate: number | null = null;
  let horizon: string | null = null;
  let alignmentScore: number | null = null;
  let problemDomain: string | null = null;
  let solutionCategory: string | null = null;
  let phase: string | null = null;
  let successCriteria: string | null = null;
  let startDate: number | null = null;
  let endDate: number | null = null;

  // Extract entity-specific properties based on type
  switch (entityType) {
    case 'company': {
      type = normalizedStringOrSet(entity.type);
      category = normalizedStringOrSet(entity.industry);
      // Collect related entities for implicit edges
      relatedEntityIds = [...((entity.competitorIds as string[]) || []), ...((entity.technologyIds as string[]) || [])];
      // NEW: Company-specific AI properties
      companyType = type;
      industry = category;
      companySize = (entity.size as string) || (entity.companySize as string) || null;

      // Handle location object - flatten to primitives for Neo4j
      const location = entity.location as { city?: string; country?: string } | string | undefined;
      if (location && typeof location === 'object' && 'city' in location) {
        // Location is an object {city, country}
        locationCity = location.city || null;
        locationCountry = location.country || null;
        headquarters =
          location.city && location.country
            ? `${location.city}, ${location.country}`
            : location.city || location.country || null;
      } else if (typeof location === 'string') {
        // Location is already a string
        headquarters = location;
      } else if (entity.headquarters && typeof entity.headquarters === 'string') {
        // Fallback to headquarters field
        headquarters = entity.headquarters as string;
      }

      website = (entity.website as string) || (entity.url as string) || null;
      break;
    }

    case 'strategy':
      category = (entity.category as string) || null;
      priority = (entity.priority as string) || null;
      // NEW: Strategy-specific AI properties
      horizon = (entity.horizon as string) || (entity.timeHorizon as string) || null;
      alignmentScore = alignmentScoreOrNull(entity.alignmentScore);
      break;

    case 'useCase':
      category = (entity.category as string) || null;
      relatedEntityIds = [
        ...((entity.radarTechnologyIds as string[]) || []),
        ...((entity.companyIds as string[]) || []),
      ];
      // NEW: UseCase-specific AI properties
      problemDomain = (entity.problemDomain as string) || (entity.domain as string) || null;
      solutionCategory = (entity.solutionCategory as string) || (entity.solutionType as string) || null;
      break;

    case 'prototype':
      type = (entity.type as string) || null;
      category = (entity.category as string) || null;
      relatedEntityIds = (entity.technologyIds as string[]) || [];
      // NEW: Prototype-specific AI properties
      phase = (entity.phase as string) || (entity.stage as string) || null;
      successCriteria = (entity.successCriteria as string) || null;
      break;

    case 'signal': {
      type = (entity.type as string) || null; // SignalType: patent, news, academic, etc.
      category = (entity.source as string) || null; // Source name for categorization
      severity = (entity.sentiment as string) || null;
      confidence = (entity.trustScore as { overall?: number })?.overall || (entity.relevanceScore as number) || null;

      // Collect all linked entities from signal
      const linkedEntities =
        (entity.linkedEntities as {
          technologies?: string[];
          companies?: string[];
          useCases?: string[];
        }) || {};

      relatedEntityIds = [
        ...(linkedEntities.technologies || []),
        ...(linkedEntities.companies || []),
        ...(linkedEntities.useCases || []),
        ...((entity.alignedStrategies as string[]) || []),
      ];

      // NEW: Signal-specific AI properties
      sourceType = (entity.type as string) || null; // patent, news, academic, github, funding, social
      sourceUrl = (entity.sourceUrl as string) || (entity.url as string) || null;
      sentiment = (entity.sentiment as string) || null;
      alignmentScore = alignmentScoreOrNull(entity.alignmentScore);
      publishedDate = entity.publishedDate
        ? toMillis(entity.publishedDate)
        : entity.discoveredAt
          ? toMillis(entity.discoveredAt)
          : entity.createdAt
            ? toMillis(entity.createdAt)
            : null;
      break;
    }

    case 'orgUnit':
      type = (entity.type as string) || null;
      level = (entity.level as number) || null;
      budget = (entity.annualBudget as number) || null;
      parentId = (entity.parentId as string) || null;
      break;

    case 'initiative':
      priority = (entity.priority as string) || null;
      budget = (entity.budget as number) || null;
      ownerOrgUnitId = (entity.ownerOrgUnitId as string) || null;
      relatedEntityIds = [...((entity.technologyIds as string[]) || []), ...((entity.painPointIds as string[]) || [])];
      // NEW: Initiative-specific AI properties
      startDate = entity.startDate ? toMillis(entity.startDate) : null;
      endDate = entity.endDate ? toMillis(entity.endDate) : entity.targetDate ? toMillis(entity.targetDate) : null;
      break;

    case 'painPoint':
      severity = (entity.severity as string) || null;
      category = (entity.category as string) || null;
      impact = (entity.estimatedImpact as number) || null;
      relatedEntityIds = (entity.affectedOrgUnitIds as string[]) || [];
      break;
  }

  // Store ALL properties as JSON for AI deep analysis
  const additionalProps: Record<string, unknown> = {};
  // Signal readers also consume the serialized contract. Store the validated
  // number as a live value so the single JSON.stringify below keeps zero and
  // does not double-encode it.
  if (entityType === 'signal' && alignmentScore !== null) {
    additionalProps.alignmentScore = alignmentScore;
  }
  const excludeKeys = [
    'id',
    'name',
    'title',
    'description',
    'status',
    'tags',
    'createdAt',
    'updatedAt',
    'category',
    'priority',
    'severity',
    'type',
    'level',
    'budget',
    'impact',
    'confidence',
    // NEW: Also exclude the new properties since they're stored directly
    'companyType',
    'industry',
    'companySize',
    'headquarters',
    'location',
    'locationCity',
    'locationCountry',
    'website',
    'sourceType',
    'sourceUrl',
    'sentiment',
    'publishedDate',
    'horizon',
    'alignmentScore',
    'problemDomain',
    'solutionCategory',
    'phase',
    'successCriteria',
    'startDate',
    'endDate',
  ];

  for (const [key, value] of Object.entries(entity)) {
    if (!excludeKeys.includes(key) && value !== undefined && value !== null) {
      // Store the live value. The single `JSON.stringify(additionalProps)` below
      // serializes nested objects/arrays exactly once. Previously each object
      // value was ALSO stringified here, so the outer stringify double-encoded
      // it — `JSON.parse(props.properties).expandedContent` then came back as a
      // string, and buildImplicitRelationshipQueries' reads of
      // expandedContent.relatedItems / linkedEntities / alignedStrategies all
      // resolved to [], silently dropping every implicit signal edge. The node
      // only ever stores the one `properties` blob (never spread as node props),
      // so single-encoding is safe for Neo4j's primitive-only constraint.
      additionalProps[key] = value;
    }
  }

  return {
    name,
    title,
    description,
    status,
    tags,
    createdAt,
    updatedAt,
    category,
    priority,
    severity,
    type,
    level,
    budget,
    impact,
    confidence,
    relatedEntityIds: normalizeEntityGraphSet(relatedEntityIds),
    parentId,
    ownerOrgUnitId,
    conceptIds,
    // NEW: AI-Valuable Direct Properties
    companyType,
    industry,
    companySize,
    headquarters,
    locationCity,
    locationCountry,
    website,
    sourceType,
    sourceUrl,
    sentiment,
    publishedDate,
    horizon,
    alignmentScore,
    problemDomain,
    solutionCategory,
    phase,
    successCriteria,
    startDate,
    endDate,
    properties: JSON.stringify(additionalProps),
  };
}

// ============================================================================
// SYNC ENTITY JOB
// ============================================================================

/**
 * Sync any entity to Neo4j (Unified handler for all entity types)
 *
 * **Trigger:** app/unified-entity.sync.requested event
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts
 */
export const syncUnifiedEntityToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-unified-entity-to-neo4j',
    name: 'Sync Unified Entity to Neo4j',
    retries: 3,
    throttle: {
      limit: 100,
      period: '1m',
    },
    // Concurrency is step-level. The write step also re-reads Firestore, so a
    // queued delete and an older upsert cannot write the same graph node at once.
    concurrency: {
      key: 'event.data.entityType + ":" + event.data.entityId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<EntitySyncEventData>(event?.data);
      log.error('Sync entity final failure', new Error(error.message), {
        entityType: data.entityType || 'unknown',
        entityId: data.entityId || 'unknown',
      });

      await inngest.send({
        name: 'app/unified-entity.sync.failed',
        data: {
          entityType: data.entityType || 'unknown',
          entityId: data.entityId || 'unknown',
          operation: data.operation || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/unified-entity.sync.requested' },

  async ({ event, step }) => {
    const eventData = event.data as EntitySyncEventData;
    const { operation, entityType, entityId } = eventData;

    // Skip entity types that have their own sync functions
    if (entityType === 'technology' || entityType === 'document' || entityType === 'radarPlacement') {
      log.info('Skipping entity - has dedicated sync function', { entityType });
      return { skipped: true, reason: SKIP_REASONS.DEDICATED_SYNC_FUNCTION };
    }

    const label = ENTITY_TYPE_TO_LABEL[entityType];
    if (!label) {
      log.error('Unknown entity type', undefined, { entityType });
      return { error: `Unknown entity type: ${entityType}` };
    }

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      if (operation === 'delete') {
        let sourceExists = true;
        for (const [index, seconds] of DELETE_SOURCE_WAIT_SECONDS.entries()) {
          sourceExists = await step.run(`check-source-deleted-${index}`, async () => {
            return (await loadEntityFromFirestore(entityType, entityId)) !== null;
          });
          if (!sourceExists) break;
          await step.sleep(`wait-for-source-delete-${index}`, `${seconds}s`);
        }
        if (sourceExists) {
          // This step throws while the source remains, so it is not memoized and
          // every function retry re-reads Firestore. Earlier bounded poll steps
          // cover normal bulk-cascade latency without consuming retries.
          await step.run('require-source-deleted', async () => {
            if ((await loadEntityFromFirestore(entityType, entityId)) !== null) {
              throw new Error(`Cannot delete graph ${entityType} ${entityId} while its Firestore source still exists`);
            }
            return true;
          });
        }
      }

      // Step 2: Load entity data — ALWAYS from Firestore (M1 / decision D2).
      // The old `eventData.data` shortcut was dead (producers send `payload`,
      // never `data`), and consuming an inline partial patch would shadow the
      // authoritative doc. One load path.
      const entityData = await step.run('load-entity-data', async () => {
        if (operation === 'delete') {
          return { id: entityId };
        }

        const entity = await loadEntityFromFirestore(entityType, entityId);
        if (!entity) {
          // Entity might have been deleted - log warning and return null to skip sync
          log.warn('Entity not found in Firestore - will skip sync', { entityType, entityId });
          return null;
        }
        return entity;
      });

      // If entity not found and not a delete operation, skip sync
      if (!entityData) {
        log.info('Skipped entity - not found in Firestore', { entityType, entityId });
        // GRAPH-056: the source is gone, so there is no projection to converge
        // on and the recovery anchor is moot. This early return sits AHEAD of
        // the settle step below — found by the disposable-stack acceptance run,
        // where a create/update replay for a deleted entity correctly refused to
        // resurrect the node but left the anchor reporting a pending sync for an
        // entity that no longer exists.
        if (isLibraryEntitySyncType(entityType)) {
          await step.run('settle-anchor-for-missing-source', async () => {
            try {
              // Ordering is load-bearing: capture the generation first, then
              // re-read the authoritative source in this same durable step.
              // If the entity was recreated, its debt stands. If recreation
              // happens after the re-read, generation-CAS prevents this old
              // event from clearing the newer anchor.
              const anchor = await readEntityGraphSyncAnchor(entityType, entityId);
              if (!anchor) return { settled: false, outcome: 'absent' };
              if ((await loadEntityFromFirestore(entityType, entityId)) !== null) {
                return { settled: false, outcome: 'source-reappeared' };
              }
              const outcome = await clearConvergedEntityGraphSyncAnchor(entityType, entityId, anchor.generation);
              return { settled: outcome === 'cleared', outcome };
            } catch (error) {
              // Bookkeeping must not fail a skip; reconciliation still retires
              // the anchor from the reverse pass.
              log.warn('Could not settle graph sync anchor for a missing source', {
                entityType,
                entityId,
                error: error instanceof Error ? error.message : String(error),
              });
              return { settled: false };
            }
          });
        }
        return {
          success: true,
          skipped: true,
          reason: SKIP_REASONS.ENTITY_NOT_FOUND,
        };
      }

      // DETACH DELETE removes the only topology from which exact Concept
      // counts can be derived. Keep the affected IDs in their own durable step
      // so a crash after deletion still retries the count repair with the same
      // pre-delete snapshot.
      const deletionConceptIds =
        operation === 'delete'
          ? await step.run('capture-tag-concepts-before-delete', async () => {
              return captureEntityTagConceptIdsFromNeo4j(entityId);
            })
          : [];

      // Step 3: Perform operation
      const result = await step.run('sync-entity', async (): Promise<SyncResult> => {
        switch (operation) {
          case 'create':
          case 'update': {
            // Re-read in the same durable step as the graph write. The earlier
            // load step may be memoized across retries; using it here could
            // resurrect a node after a delayed delete removed the source.
            let currentEntityData = await loadEntityFromFirestore(entityType, entityId);
            if (!currentEntityData) {
              return {
                entityId,
                entityType,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }

            let referenceReplays: SignalProjectionReference[] = [];
            if (entityType === 'signal') {
              const decision = await loadSignalProjectionDecision(entityId, currentEntityData);
              if (!decision.eligible) {
                const sourceConceptIds = Array.isArray(currentEntityData.conceptIds)
                  ? currentEntityData.conceptIds.filter(
                      (conceptId): conceptId is string => typeof conceptId === 'string' && conceptId.length > 0
                    )
                  : [];
                // DETACH DELETE removes both derived and explicitly curated
                // HAS_CONCEPT edges. Count repair must therefore use the graph
                // topology as well as Firestore's derived conceptIds; otherwise
                // an explicit edge absent from conceptIds leaves an inflated
                // Concept.entityCount after a Signal is downgraded.
                const graphConceptIds = await captureEntityTagConceptIdsFromNeo4j(entityId);
                await deleteEntityFromGraph(entityId, entityType);
                await reconcileConceptEntityCounts([...new Set([...sourceConceptIds, ...graphConceptIds])]);

                // A status/reference write can race this deletion. Confirm the
                // policy after the graph call.
                const confirmed = await loadSignalProjectionDecision(entityId);
                if (confirmed.eligible) {
                  // A Relation/link worker may have completed immediately
                  // before DETACH DELETE removed its topology. Continue through
                  // the normal full upsert before returning references for
                  // individually durable replay steps.
                  currentEntityData = await loadEntityFromFirestore(entityType, entityId);
                  if (!currentEntityData) {
                    throw new Error(`Signal ${entityId} source disappeared during projection-race recovery`);
                  }
                  referenceReplays = confirmed.references;
                } else {
                  return {
                    entityId,
                    entityType,
                    operation: operation === 'create' ? 'created' : 'updated',
                    skipped: 'projection-ineligible',
                    projectionReason: decision.reason,
                  };
                }
              }
            }

            const tagConceptProjection = await reconcileEntityTagConcepts(entityId, entityType);
            if (!tagConceptProjection) {
              return {
                entityId,
                entityType,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }
            // The tag/concept reconciler may transactionally rewrite
            // Firestore conceptIds. Re-read after it completes; merging its
            // return into the earlier snapshot can miss concurrent source
            // fields and stamps a version that was never authoritative.
            const reconciledEntityData = await loadEntityFromFirestore(entityType, entityId);
            if (!reconciledEntityData) {
              return {
                entityId,
                entityType,
                operation: operation === 'create' ? 'created' : 'updated',
                skipped: 'source-missing',
              };
            }
            currentEntityData = reconciledEntityData;
            const sourceFingerprint = await createEntitySourceFingerprint(entityType, entityId, currentEntityData);
            const props = extractCommonProperties(currentEntityData, entityType);
            const query = buildUpsertQuery(label);

            await runWriteTransaction(query, {
              entityId,
              entityType,
              ...props,
              sourceFingerprint,
            });

            // P5-C: keep the entity's semantic embedding fresh. Fire-and-forget:
            // scheduleEntityEmbed is key-guarded (no-op when keyless) and never
            // rejects; the extra try/catch means even a synchronous scheduling
            // failure can't fail the sync (same contract as cache invalidation).
            const EMBEDDABLE_LABELS: EmbeddableLabel[] = ['Company', 'Signal'];
            if (EMBEDDABLE_LABELS.includes(label as EmbeddableLabel)) {
              try {
                void scheduleEntityEmbed({
                  entityId,
                  label: label as EmbeddableLabel,
                  name: props.name ?? '',
                  description: props.description ?? undefined,
                });
              } catch (embedError) {
                log.warn('Embedding scheduling failed (non-fatal)', {
                  entityType,
                  entityId,
                  error: embedError instanceof Error ? embedError.message : String(embedError),
                });
              }
            }

            // GRAPH-054: tags are a first-class graph path for every writer,
            // not only UI paths that happened to pre-fill conceptIds. The
            // mapper has already transactionally converged Firestore; project
            // its Concept nodes before reconciling only implicit HAS_CONCEPT
            // links. Any failure throws so Inngest retries the whole idempotent
            // boundary instead of reporting a partially useful graph.
            await projectEntityTagConceptsToNeo4j(entityId, tagConceptProjection);

            // Drift fix: implicit/structural edges are re-derived from entity
            // fields on every sync via MERGE. Without a prune, changing an
            // owner/parent or removing an item from a linked array leaves the
            // OLD edge forever (MERGE-only never removes). Delete the entity's
            // implicit edges before rebuilding — scoped to relationId IS NULL so
            // contract-managed (curated/asserted) edges of the same type are
            // preserved. Mirrors the delete-before-merge the technology/document
            // syncs already use. A prune failure must retry the boundary: the
            // source fingerprint certifies the complete topology, not merely
            // the node properties.
            // NB: HAS_CONCEPT is deliberately excluded because the canonical
            // tag projection above owns its exact, claim-safe reconciliation.
            await runWriteTransaction(
              `MATCH (n {id: $entityId})-[r:CHILD_OF|OWNED_BY|AFFECTS|LINKED_TO|RELATES_TO|ALIGNS_WITH|BECAME|RELATED_SIGNAL|DISCOVERED]->()
               WHERE r.relationId IS NULL
                 AND r.claimId IS NULL
                 AND r.projectionOwner IS NULL
               DELETE r`,
              { entityId }
            );

            // Create implicit relationship edges
            let implicitRelationshipFailures = 0;
            const unresolvedImplicitTargets: UnresolvedImplicitTarget[] = [];
            let implicitRelationshipMissingTargets: { strategyIds: string[]; painPointIds: string[] } | undefined;
            const implicitQueries = buildImplicitRelationshipQueries(entityId, entityType, props);
            for (const { query: implicitQuery, params } of implicitQueries) {
              try {
                const relationshipResult = await runWriteTransaction(implicitQuery, params);
                // Every builder query returns `r`. MATCH on a missing target
                // is a successful Cypher execution with zero records, not an
                // exception; it is still an incomplete projection and must
                // prevent the final source-fingerprint stamp.
                if (relationshipResult.records.length === 0) {
                  throw new Error('Implicit relationship target was not found');
                }
              } catch (_e) {
                // Don't throw (target entity might not exist yet), but count
                // it (P3-B) so the run summary stays honest.
                //
                // GRAPH-063: name the endpoint that failed. A bare count made a
                // permanently-blocked signal indistinguishable from one waiting
                // on a lagging projection, with no way to see which target was
                // missing. Phantom endpoints are now rejected upstream, so
                // whatever appears here is a real convergence gap worth reading.
                implicitRelationshipFailures++;
                if (unresolvedImplicitTargets.length < MAX_REPORTED_UNRESOLVED_TARGETS) {
                  unresolvedImplicitTargets.push(describeImplicitTarget(implicitQuery, params, entityId));
                }
                log.warn('Implicit relationship failed', {
                  entityType,
                  entityId,
                  target: describeImplicitTarget(implicitQuery, params, entityId),
                });
              }
            }

            if (entityType === 'initiative') {
              const projection = buildInitiativeLinkProjection(entityId, currentEntityData);
              const projectionResult = await runWriteTransaction<InitiativeLinkProjectionReceipt>(
                projection.query,
                projection.params
              );
              const receipt = projectionResult.records[0];
              if (!receipt) {
                throw new Error(`Initiative ${entityId} link projection returned no acknowledgement`);
              }

              const strategyIds = receipt.missingStrategyIds ?? [];
              const painPointIds = receipt.missingPainPointIds ?? [];
              const missingTargetCount = strategyIds.length + painPointIds.length;
              implicitRelationshipFailures += missingTargetCount;
              if (missingTargetCount > 0) {
                implicitRelationshipMissingTargets = { strategyIds, painPointIds };
                log.warn('Initiative link projection has missing graph targets', {
                  entityId,
                  missingStrategyIds: strategyIds,
                  missingPainPointIds: painPointIds,
                });
              }
            }

            if (entityType === 'signal') {
              const confirmed = await loadSignalProjectionDecision(entityId);
              if (!confirmed.eligible) {
                throw new Error(`Signal ${entityId} became graph-ineligible while its projection was being written`);
              }
              // Return current references after every eligible upsert. If the
              // callback crashed after a compensating write but before this
              // return, rerunning it still schedules the incident topology.
              referenceReplays = confirmed.references;
            }

            const dependentInitiativeIds =
              entityType === 'strategy' || entityType === 'painPoint'
                ? await loadDependentInitiativeIds(entityType, entityId)
                : [];

            // Stamp only after every topology owner has converged. Leaving the
            // previous fingerprint in place on any partial write makes the
            // reconciler replay it instead of certifying stale relationships.
            const completeProjection = implicitRelationshipFailures === 0;
            if (completeProjection) {
              await runWriteTransaction(STAMP_ENTITY_SOURCE_FINGERPRINT, {
                entityId,
                sourceFingerprint,
              });
            }

            return {
              entityId,
              entityType,
              operation: operation === 'create' ? 'created' : 'updated',
              ...(completeProjection ? { sourceFingerprint } : {}),
              implicitRelationshipFailures,
              ...(unresolvedImplicitTargets.length > 0 ? { unresolvedImplicitTargets } : {}),
              ...(implicitRelationshipMissingTargets ? { implicitRelationshipMissingTargets } : {}),
              ...(referenceReplays.length > 0 ? { referenceReplays } : {}),
              ...(dependentInitiativeIds.length > 0 ? { dependentInitiativeIds } : {}),
            };
          }

          case 'delete': {
            // The deletion and this authoritative check share one retryable
            // step. Never remove the graph projection while Firestore still
            // holds the source (for example after a failed final batch commit).
            if ((await loadEntityFromFirestore(entityType, entityId)) !== null) {
              throw new Error(`Cannot delete graph ${entityType} ${entityId} while its Firestore source still exists`);
            }
            await deleteEntityFromGraph(entityId, entityType);
            await reconcileConceptEntityCounts(deletionConceptIds);

            return {
              entityId,
              entityType,
              operation: 'deleted',
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      // GRAPH-056: settle the durable recovery anchor for this entity.
      //
      // This is the entity equivalent of the relation worker's post-write
      // verification: the anchor is retired only when the projection provably
      // matches the authoritative document. If the document moved during the
      // graph write the fingerprints differ, the anchor survives, and the next
      // replay settles it. Anchor bookkeeping can never fail the sync — the
      // graph write has already committed, and reconciliation retires stragglers
      // from fingerprint drift regardless of what happens here.
      if (isLibraryEntitySyncType(entityType)) {
        await step.run('settle-entity-graph-sync-anchor', async () => {
          try {
            const anchor = await readEntityGraphSyncAnchor(entityType, entityId);
            if (!anchor) return { outcome: 'absent' };

            const current = await loadEntityFromFirestore(entityType, entityId);
            if (!current) {
              // No projection to converge on. Leaving the anchor would report a
              // pending sync for a deleted entity forever.
              return {
                outcome: await clearConvergedEntityGraphSyncAnchor(entityType, entityId, anchor.generation),
                reason: 'entity-deleted',
              };
            }

            // A delete or a skipped upsert wrote no fingerprint, so there is
            // nothing this run can prove about the projection.
            if (!result.sourceFingerprint) return { outcome: 'no-projection-written' };

            if ((await createEntitySourceFingerprint(entityType, entityId, current)) !== result.sourceFingerprint) {
              return { outcome: 'source-moved' };
            }

            return {
              outcome: await clearConvergedEntityGraphSyncAnchor(entityType, entityId, anchor.generation),
            };
          } catch (error) {
            log.warn('Could not settle graph sync recovery anchor', {
              entityType,
              entityId,
              error: error instanceof Error ? error.message : String(error),
            });
            return { outcome: 'settle-failed' };
          }
        });
      }

      if (result.skipped === 'source-missing') {
        log.info('Skipped graph upsert because source disappeared before the write', {
          entityType,
          entityId,
        });
        return { success: true, ...result };
      }

      // Every remaining result changed or removed the graph projection,
      // including an inbox-only Signal downgrade.
      invalidateEntityQueryCaches(entityId);

      if (result.skipped === 'projection-ineligible') {
        log.info('Removed inbox-only Signal from graph projection', {
          entityId,
          projectionReason: result.projectionReason,
        });
        return { success: true, ...result };
      }

      const parentEventId = typeof event.id === 'string' ? event.id : `${entityType}:${entityId}:${operation}`;
      for (const [index, reference] of (result.referenceReplays ?? []).entries()) {
        await step.run(`replay-signal-reference-${index}`, async () => {
          const accepted = await inngest.send(signalReferenceReplayEvent(parentEventId, entityId, reference));
          if (!accepted.ids?.length) {
            throw new Error(
              `Inngest accepted no ${reference.kind} replay for Signal ${entityId} reference ${reference.id}`
            );
          }
        });
      }

      if (result.implicitRelationshipMissingTargets) {
        const { strategyIds, painPointIds } = result.implicitRelationshipMissingTargets;
        throw new Error(
          `Initiative ${result.entityId} graph targets are not ready (strategies: ${strategyIds.join(', ') || 'none'}; pain points: ${painPointIds.join(', ') || 'none'})`
        );
      }

      for (const [index, initiativeId] of (result.dependentInitiativeIds ?? []).entries()) {
        await step.run(`replay-dependent-initiative-${index}`, async () => {
          const targetType = result.entityType as 'strategy' | 'painPoint';
          const accepted = await inngest.send(
            buildInitiativeDependencyReplayEvent(parentEventId, targetType, result.entityId, initiativeId)
          );
          if (!accepted.ids?.length) {
            throw new Error(
              `Inngest accepted no Initiative replay for ${targetType} ${result.entityId} dependency ${initiativeId}`
            );
          }
          return accepted.ids;
        });
      }

      // GRAPH-048: keep verification dispatch in its own durable step. A
      // rejected or empty acknowledgement must fail this attempt so Inngest
      // retries it; the deterministic event id makes accepted replays converge
      // at ingestion. This precedes the terminal completion event so one run
      // can never emit both completed and failed outcomes.
      const verificationEvent = maybeBuildEntityCreateVerificationEvent({
        entityType: result.entityType,
        entityId: result.entityId,
        operation: result.operation,
      });
      if (verificationEvent) {
        await step.run('dispatch-entity-verification', async () => {
          const accepted = await inngest.send(verificationEvent);
          if (!accepted.ids?.length) {
            throw new Error(`Inngest accepted no entity verification event for ${result.entityId}`);
          }
          return accepted.ids;
        });
      }

      // Step 4: Send completion only after every required post-commit dispatch
      // has been acknowledged.
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/entity.sync.completed',
          data: {
            entityId: result.entityId,
            entityType: result.entityType,
            operation: result.operation,
            syncedAt: Date.now(),
          },
        });
      });

      log.info('Sync entity completed', { entityType, entityId, operation: result.operation });

      return {
        // P3-B (H7 model): a run that failed implicit-edge writes must not
        // report blanket success — downstream traversals silently miss them.
        success: (result.implicitRelationshipFailures ?? 0) === 0,
        ...result,
      };
    } catch (error) {
      log.error('Sync entity failed', error instanceof Error ? error : undefined, { entityType, entityId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

interface BatchSyncEventData {
  entityType: EntityType;
  entityIds: string[];
}

/**
 * Batch sync multiple entities of the same type (Unified handler)
 */
export const batchSyncUnifiedEntitiesToNeo4jJob = inngest.createFunction(
  {
    id: 'batch-sync-unified-entities-to-neo4j',
    name: 'Batch Sync Unified Entities to Neo4j',
    retries: 2,
  },

  { event: 'app/unified-entities.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-unified-entities-to-neo4j');
    const { entityType, entityIds } = event.data as BatchSyncEventData;

    log.info('Starting batch sync', { count: entityIds.length, entityType });

    // Send individual sync events for each entity
    await step.run('send-sync-events', async () => {
      const events = entityIds.map((entityId) => ({
        name: 'app/unified-entity.sync.requested' as const,
        data: {
          operation: 'update' as const,
          entityType,
          entityId,
        },
      }));

      // Send in batches of 25 to avoid overwhelming the queue
      const batchSize = 25;
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        await inngest.send(batch);
        log.info('Sent batch', {
          batch: Math.floor(i / batchSize) + 1,
          totalBatches: Math.ceil(events.length / batchSize),
        });
      }

      return { eventsSent: events.length };
    });

    return {
      success: true,
      entityType,
      entitiesQueued: entityIds.length,
    };
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trigger unified entity sync from application code.
 *
 * M1 / decision D2: identifiers only — the handler always loads the full doc
 * from Firestore admin, so there is no inline data side-channel.
 */
export async function triggerUnifiedEntitySync(
  entityType: EntityType,
  entityId: string,
  operation: 'create' | 'update' | 'delete'
): Promise<void> {
  await inngest.send({
    name: 'app/unified-entity.sync.requested',
    data: {
      operation,
      entityType,
      entityId,
    },
  });
}

/**
 * Trigger batch sync for multiple entities (unified)
 */
export async function triggerBatchUnifiedEntitySync(entityType: EntityType, entityIds: string[]): Promise<void> {
  await inngest.send({
    name: 'app/unified-entities.batch-sync.requested',
    data: {
      entityType,
      entityIds,
    },
  });
}
