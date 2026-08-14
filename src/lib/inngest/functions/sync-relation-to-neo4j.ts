/**
 * @file lib/inngest/functions/sync-relation-to-neo4j.ts
 * @description Inngest job for syncing Relations to Neo4j graph database
 *
 * This module handles synchronization of entity-to-entity relations to Neo4j:
 * - Creates relationships between Entity nodes based on relation type
 * - Supports all entity types (Technology, Company, UseCase, etc.)
 * - Maps Firestore relation types to Neo4j relationship types
 * - Syncs confidence, evidence, and claim metadata
 *
 * **Relationship Mapping:**
 * - uses → USES
 * - enables → ENABLES
 * - competes_with → COMPETES_WITH
 * - vendor → VENDOR
 * - partner → PARTNER
 * - addresses → ADDRESSES
 * - supports → SUPPORTS
 * - etc.
 *
 * **Trigger:** Event-driven (`app/relation.sync.requested`)
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts with exponential backoff
 *
 * @author Radarist Team
 * @created 2026-01-14
 */

import { inngest, safeSendEvent } from '../client';
import { extractFailureEventData } from '../utils';
import { checkHealth, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import {
  syncRelationAsAssertion,
  syncRelationAsEdge,
  deleteAssertionByRelationId,
} from '@/lib/graph/relation-assertion-sync';
import { deleteVerificationResultsForRelation } from '@/lib/graph/verification';
import { invalidateCachesForEntity } from '@/lib/graph/query-cache';
import { resolveNeo4jPredicate } from '@/lib/graph/relation-registry';
import { parseRelationProjectionSource, relationProjectionFingerprint } from '@/lib/graph/projection-reconciliation';
import { normalizeConfidence100 } from '@/lib/graph/relation-defaults';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId, resolveCorrelationId } from '@/lib/observability/correlation';
import { resolveRelationSourceFingerprint } from '@/lib/relation-source-version';

const log = createLogger('inngest/sync-relation-to-neo4j');
import type { EvidenceInput } from '@/lib/graph/types';
import type { EntityType, EvidenceRef, Relation, RelationType } from '@/lib/types';
import { parseRelationDeleteOutboxRecord, RELATION_SYNC_OUTBOX_COLLECTION } from '@/lib/relation-sync-outbox';

// ============================================================================
// HELPER: Send correct sync event based on entity type
// ============================================================================

/**
 * Send the appropriate sync event for an entity type.
 * Technologies and documents have dedicated sync functions that listen to
 * different events than the unified entity sync.
 */
async function sendEntitySyncEvent(entityType: EntityType | undefined, entityId: string | undefined): Promise<void> {
  if (!entityType || !entityId) return;

  if (entityType === 'technology') {
    await inngest.send({
      name: 'app/technology.sync.requested',
      data: {
        operation: 'update' as const,
        technologyId: entityId,
      },
    });
  } else if (entityType === 'document') {
    await inngest.send({
      name: 'app/document.sync.requested',
      data: {
        operation: 'update' as const,
        documentId: entityId,
      },
    });
  } else {
    await inngest.send({
      name: 'app/unified-entity.sync.requested',
      data: {
        operation: 'update' as const,
        entityType,
        entityId,
      },
    });
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface RelationSyncEventData {
  /** Stable relation-mutation token; absent only on legacy replay events. */
  correlationId?: string;
  /** Fingerprint of the graph-driving Firestore generation; absent on legacy events. */
  sourceFingerprint?: string;
  operation: 'create' | 'update' | 'delete';
  relationId: string;
  deleteToken?: string;
  sourceId?: string;
  sourceType?: EntityType;
  sourceName?: string;
  targetId?: string;
  targetType?: EntityType;
  targetName?: string;
  relationType?: RelationType;
  confidence?: number;
  notes?: string;
  aiSuggested?: boolean;
  claimStatus?: Relation['claimStatus'];
  /** B1 — distinct asserter identity. Observability parity only: the real
   * value used to build `assertedBy` travels via the Firestore doc re-read
   * (see load step below), not this event payload. */
  agentName?: string;
}

interface SyncResult {
  relationId: string;
  operation: 'created' | 'updated' | 'deleted' | 'skipped';
  neo4jRelType: string;
  reason?: string; // Added for skipped relations
  sourceId?: string;
  targetId?: string;
  correlationId?: string;
}

interface LoadedRelationData {
  relationId: string;
  sourceId?: string;
  sourceType?: EntityType;
  sourceName?: string;
  targetId?: string;
  targetType?: EntityType;
  targetName?: string;
  relationType: RelationType;
  confidence?: number;
  notes?: string;
  reasoningSummary?: string;
  aiSuggested?: boolean;
  claimStatus?: Relation['claimStatus'];
  agentName?: string;
  claimId?: string;
  evidenceRefs: EvidenceRef[];
  sourceCorrelationId?: string;
  sourceFingerprint?: string;
  projectionFingerprint?: string;
  deleteOutboxToken?: string;
  skipDelete: boolean;
}

function sourceVersionMismatchReason(
  correlationId: string | undefined,
  sourceFingerprint: string | undefined,
  current: LoadedRelationData
): string | undefined {
  if (correlationId && current.sourceCorrelationId && correlationId !== current.sourceCorrelationId) {
    return 'Relation event correlation is older than the authoritative Firestore mutation';
  }
  if (sourceFingerprint && current.sourceFingerprint && sourceFingerprint !== current.sourceFingerprint) {
    return 'Relation event fingerprint is older than the authoritative Firestore mutation';
  }
  return undefined;
}

async function readAuthoritativeRelation(relationId: string): Promise<LoadedRelationData | null> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snap = await adminDb.collection('relations').doc(relationId).get();
  if (!snap.exists) return null;
  const relation = parseRelationProjectionSource(relationId, snap.data());
  const hasSourceCorrelationId = relation.sourceCorrelationId !== undefined;
  const hasSourceFingerprint = relation.sourceFingerprint !== undefined;
  if (hasSourceCorrelationId !== hasSourceFingerprint) {
    throw new Error(`Malformed relation ${relationId}: incomplete source version metadata`);
  }
  const sourceCorrelationId =
    relation.sourceCorrelationId === undefined ? undefined : parseCorrelationId(relation.sourceCorrelationId);
  if (relation.sourceCorrelationId !== undefined && !sourceCorrelationId) {
    throw new Error(`Malformed relation ${relationId}: invalid source correlation metadata`);
  }
  const sourceFingerprint = resolveRelationSourceFingerprint(relation.sourceFingerprint);
  const projectionFingerprint = relationProjectionFingerprint(relation);
  if (sourceFingerprint && sourceFingerprint !== projectionFingerprint) {
    throw new Error(`Malformed relation ${relationId}: source fingerprint does not match authoritative content`);
  }
  return {
    relationId,
    sourceId: relation.sourceSnapshot.id,
    sourceType: relation.sourceSnapshot.type,
    sourceName: relation.sourceSnapshot.name,
    targetId: relation.targetSnapshot.id,
    targetType: relation.targetSnapshot.type,
    targetName: relation.targetSnapshot.name,
    relationType: relation.relationType,
    confidence: relation.confidence,
    notes: relation.notes,
    reasoningSummary: relation.reasoningSummary,
    aiSuggested: relation.aiSuggested,
    claimStatus: relation.claimStatus,
    agentName: relation.agentName,
    claimId: relation.claimId,
    evidenceRefs: relation.evidenceRefs ?? [],
    sourceCorrelationId: sourceCorrelationId ?? undefined,
    sourceFingerprint,
    projectionFingerprint,
    deleteOutboxToken: undefined,
    skipDelete: false,
  };
}

async function removeRelationProjection(relationId: string): Promise<void> {
  await deleteAssertionByRelationId(relationId);
  await runWriteTransaction(DELETE_RELATIONSHIP, { relationId });
  // GRAPH-061: an EdgeVerificationResult is a standalone node keyed by
  // relationId — nothing about deleting the Assertion or the typed edge reaches
  // it. Remove it here, after the edge is gone, so a retry of this idempotent
  // teardown still converges on zero dangling verdicts.
  await deleteVerificationResultsForRelation(relationId);
}

async function readRelationDeleteGuard(
  relationId: string,
  deleteToken: string | undefined
): Promise<{ skipDelete: boolean; deleteOutboxToken?: string }> {
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const [relationSnapshot, outboxSnapshot] = await Promise.all([
    adminDb.collection('relations').doc(relationId).get(),
    adminDb.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(relationId).get(),
  ]);
  const outbox = outboxSnapshot.exists ? parseRelationDeleteOutboxRecord(relationId, outboxSnapshot.data()) : null;
  if (outboxSnapshot.exists && !outbox) {
    throw new Error(`Malformed relation delete outbox marker for ${relationId}`);
  }
  const tokenMatches = deleteToken !== undefined && outbox?.deleteToken === deleteToken;
  return {
    // Tokenless legacy events may clean up an old projection only when no
    // durable generation owns this relation ID.
    skipDelete: relationSnapshot.exists || (outbox !== null && !tokenMatches),
    deleteOutboxToken: tokenMatches ? outbox.deleteToken : undefined,
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Map entity types to Neo4j node labels
 */
const ENTITY_TYPE_TO_LABEL: Record<EntityType, string> = {
  technology: 'Technology',
  company: 'Company',
  useCase: 'UseCase',
  strategy: 'Strategy',
  prototype: 'Prototype',
  signal: 'Signal',
  document: 'Document',
  orgUnit: 'OrgUnit',
  initiative: 'Initiative',
  painPoint: 'PainPoint',
  radarPlacement: 'RadarPlacement',
};

// ============================================================================
// CYPHER QUERIES
// ============================================================================

// buildCreateRelationshipQuery removed 2026-04-17: the raw MERGE-on-edge
// path bypassed the Relation Write Contract (no :Assertion, no :Evidence, no
// temporal fields). Replaced by syncRelationAsAssertion in
// relation-assertion-sync.ts.

/**
 * Delete relationship by relation ID
 */
const DELETE_RELATIONSHIP = `
  MATCH ()-[r {relationId: $relationId}]->()
  DELETE r
  RETURN count(r) as deleted
`;

/**
 * Check if entity exists in Neo4j
 */
function buildCheckEntityExistsQuery(label: string): string {
  return `
    MATCH (e:${label} {id: $entityId})
    RETURN e.id as id
  `;
}

/**
 * Map Firestore EvidenceRef records to the graph layer's EvidenceInput shape
 * (M2: Class C relations — curated + citation — must not lose their evidence
 * on sync).
 */
function evidenceRefsToInputs(refs: EvidenceRef[] | undefined): EvidenceInput[] {
  return (refs ?? []).map((ref) => ({
    sourceKey: ref.sourceKey ?? ref.id,
    sourceType: ref.type,
    snippet: ref.snippet ?? '',
    sourceUrl: ref.url,
    documentId: ref.documentId,
    chunkId: ref.chunkId,
    pageNumber: ref.pageNumber,
    signalId: ref.signalId,
    entityId: ref.entityId,
    entityType: ref.entityType,
    entityField: ref.entityField,
  }));
}

// ============================================================================
// SYNC RELATION JOB
// ============================================================================

/**
 * Sync a single Relation to Neo4j
 *
 * **Trigger:** app/relation.sync.requested event
 * **Timeout:** 30 seconds
 * **Retries:** 3 attempts
 */
export const syncRelationToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-relation-to-neo4j',
    name: 'Sync Relation to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },
    // Serialize syncs for the same relation: two rapid re-syncs of one relationId
    // must not race on the MERGE (Assertion / typed edge) and produce drift.
    // Different relations still run concurrently, up to the throttle limit.
    concurrency: {
      key: 'event.data.relationId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event — reading
      // event.data.<field> directly always yields undefined here.
      const data = extractFailureEventData<RelationSyncEventData>(event.data);
      const relationId = data.relationId || 'unknown';
      const correlationId = parseCorrelationId(data.correlationId) ?? undefined;
      log.error('Sync relation final failure', new Error(error.message), { relationId, correlationId });

      await inngest.send({
        name: 'app/relation.sync.failed',
        data: {
          ...(correlationId ? { correlationId } : {}),
          relationId,
          operation: data.operation || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/relation.sync.requested' },

  async ({ event, step }) => {
    const eventData = event.data as RelationSyncEventData;
    const { operation, relationId } = eventData;
    const parsedCorrelationId =
      eventData.correlationId === undefined ? undefined : parseCorrelationId(eventData.correlationId);
    if (eventData.correlationId !== undefined && !parsedCorrelationId) {
      throw new Error('Invalid relation sync correlation ID');
    }
    const correlationId = parsedCorrelationId ?? undefined;
    const eventSourceFingerprint = resolveRelationSourceFingerprint(eventData.sourceFingerprint);

    try {
      // Step 1: Load the authoritative source before touching Neo4j. This lets
      // a delayed event exit without even a health read against the graph.
      const relationData = await step.run('load-relation-data', async () => {
        if (operation === 'delete') {
          const guard = await readRelationDeleteGuard(relationId, eventData.deleteToken);
          return {
            relationId,
            sourceId: eventData.sourceId,
            sourceType: eventData.sourceType,
            sourceName: eventData.sourceName as string | undefined,
            targetId: eventData.targetId,
            targetType: eventData.targetType,
            targetName: eventData.targetName as string | undefined,
            relationType: eventData.relationType || 'custom',
            confidence: eventData.confidence,
            notes: eventData.notes,
            reasoningSummary: undefined as string | undefined,
            aiSuggested: eventData.aiSuggested,
            claimStatus: eventData.claimStatus,
            agentName: eventData.agentName,
            claimId: undefined as string | undefined,
            evidenceRefs: [] as EvidenceRef[],
            deleteOutboxToken: guard.deleteOutboxToken,
            skipDelete: guard.skipDelete,
          };
        }

        // For create/update, load from Firestore. Read via the admin SDK
        // directly instead of going through `@/lib/relations` → relations-core.ts
        // → @/lib/firebase (client SDK). The client SDK has no auth context
        // server-side; its gRPC Listen/Write streams hang for 50+ seconds
        // before failing with "Failed to get document because the client is
        // offline". This is the same client-versus-admin boundary one layer
        // deeper through the shared service module; the wider
        // relations-core.ts split remains future work.
        const relation = await readAuthoritativeRelation(relationId);
        // A create/update event can outlive its Firestore source. Return a
        // typed placeholder; the retrying graph mutation step re-reads and
        // performs compensating cleanup rather than resurrecting stale data.
        return (
          relation ?? {
            relationId,
            relationType: eventData.relationType ?? 'custom',
            evidenceRefs: [],
            deleteOutboxToken: undefined,
            skipDelete: false,
          }
        );
      });

      const preflightMismatchReason =
        operation === 'delete'
          ? undefined
          : sourceVersionMismatchReason(correlationId, eventSourceFingerprint, relationData);
      const preflightResult: SyncResult | undefined = preflightMismatchReason
        ? {
            relationId,
            operation: 'skipped',
            neo4jRelType: resolveNeo4jPredicate(relationData.relationType),
            reason: preflightMismatchReason,
            correlationId,
          }
        : undefined;

      // Step 2: Check Neo4j only after the source generation is eligible.
      if (!preflightResult) {
        await step.run('check-neo4j-health', async () => {
          const health = await checkHealth();
          if (!health.healthy) {
            throw new Error(`Neo4j not healthy: ${health.error}`);
          }
          return health;
        });
      }

      // Step 3: Perform operation
      let confirmedDeleteOutboxToken = relationData.deleteOutboxToken;
      const result =
        preflightResult ??
        (await step.run('sync-relation', async (): Promise<SyncResult> => {
          switch (operation) {
            case 'create':
            case 'update': {
              // Inngest memoizes successful steps. The earlier load may therefore
              // describe an older Firestore generation after this graph step is
              // retried. Only the read inside this retrying mutation boundary is
              // allowed to drive a write.
              const current = await readAuthoritativeRelation(relationId);
              if (!current) {
                await removeRelationProjection(relationId);
                if (await readAuthoritativeRelation(relationId)) {
                  throw new Error(`Relation ${relationId} was recreated during stale projection cleanup`);
                }
                return {
                  relationId,
                  operation: 'skipped',
                  neo4jRelType: resolveNeo4jPredicate(eventData.relationType),
                  reason: 'Firestore source disappeared before graph mutation; stale projection removed',
                };
              }
              const mismatchReason = sourceVersionMismatchReason(correlationId, eventSourceFingerprint, current);
              if (mismatchReason) {
                return {
                  relationId,
                  operation: 'skipped',
                  neo4jRelType: resolveNeo4jPredicate(current.relationType),
                  reason: mismatchReason,
                  correlationId: correlationId ?? current.sourceCorrelationId,
                };
              }
              const projectionCorrelationId = current.sourceCorrelationId ?? correlationId;
              const sourceLabel = ENTITY_TYPE_TO_LABEL[current.sourceType as EntityType] || 'Entity';
              const targetLabel = ENTITY_TYPE_TO_LABEL[current.targetType as EntityType] || 'Entity';
              const neo4jRelType = resolveNeo4jPredicate(current.relationType);
              // Verify source entity exists in Neo4j
              const sourceExistsQuery = buildCheckEntityExistsQuery(sourceLabel);
              const sourceResult = await runReadTransaction<{ id: string }>(sourceExistsQuery, {
                entityId: current.sourceId,
              });

              if (sourceResult.records.length === 0) {
                log.warn('Source entity not found in Neo4j - triggering sync and will retry', {
                  sourceLabel,
                  sourceId: current.sourceId,
                });
                // Queue entity sync using the correct event for this entity type
                await sendEntitySyncEvent(current.sourceType, current.sourceId);
                // Throw to trigger retry - entity should be synced by then
                throw new Error(`Source entity ${sourceLabel}:${current.sourceId} not in Neo4j yet - queued for sync`);
              }

              // Verify target entity exists in Neo4j
              const targetExistsQuery = buildCheckEntityExistsQuery(targetLabel);
              const targetResult = await runReadTransaction<{ id: string }>(targetExistsQuery, {
                entityId: current.targetId,
              });

              if (targetResult.records.length === 0) {
                log.warn('Target entity not found in Neo4j - triggering sync and will retry', {
                  targetLabel,
                  targetId: current.targetId,
                });
                // Queue entity sync using the correct event for this entity type
                await sendEntitySyncEvent(current.targetType, current.targetId);
                // Throw to trigger retry - entity should be synced by then
                throw new Error(`Target entity ${targetLabel}:${current.targetId} not in Neo4j yet - queued for sync`);
              }

              // Split write path (2026-04-18 schema audit): curated edges
              // without structured evidence bypass the :Assertion layer
              // entirely — edge properties carry confidence, temporal,
              // asserter, notes. Agent-proposed edges or edges with real
              // snippet evidence (M2: including curated + citation, Class C)
              // keep the :Assertion path for independent lifecycle + Evidence
              // attachment.
              // B1 — distinct asserter identity: stamp the real proposing agent
              // (linker / auto-linker / assistant) instead of a hardcoded
              // 'agent:linker' for every AI-suggested relation.
              const assertedBy = current.aiSuggested ? `agent:${current.agentName ?? 'linker'}` : 'user:system';
              const evidence = evidenceRefsToInputs(current.evidenceRefs);
              const needsAssertionNode =
                current.aiSuggested === true ||
                (current.claimStatus && current.claimStatus !== 'curated') ||
                evidence.length > 0;
              // Task 16 (A1) ingress normalization: Firestore relation docs
              // written before the 0-100 contract (or by anything that still
              // mints 0-1, flag off) carry legacy 0.5/1.0-style confidence.
              // Healing here — not just at mint time — is mandatory: without
              // it, every re-sync of an old doc re-poisons an edge the
              // confidence-scale migration already healed. Flag-gated so it can
              // be rolled back to the raw passthrough alongside the minters.
              const confidence = config.flags.confidenceScale100Enabled
                ? current.confidence !== undefined
                  ? normalizeConfidence100(current.confidence)
                  : current.aiSuggested
                    ? 50
                    : 100
                : (current.confidence ?? (current.aiSuggested ? 50 : 100));
              const commonInput = {
                ...(projectionCorrelationId ? { correlationId: projectionCorrelationId } : {}),
                ...(current.sourceCorrelationId ? { sourceCorrelationId: current.sourceCorrelationId } : {}),
                ...(current.sourceFingerprint ? { sourceFingerprint: current.sourceFingerprint } : {}),
                relationId: current.relationId,
                subject: {
                  id: current.sourceId!,
                  type: current.sourceType ?? 'unknown',
                  name: current.sourceName,
                },
                object: {
                  id: current.targetId!,
                  type: current.targetType ?? 'unknown',
                  name: current.targetName,
                },
                predicate: neo4jRelType,
                confidence,
                assertedBy,
                notes: current.notes ?? null,
                reasoningSummary: current.reasoningSummary ?? null,
                // F134: the original lowercase relationType. `neo4jRelType` above
                // is the collapsed predicate (32/50 types → RELATED_TO); carrying
                // the source type lets the edge stamp + scope invalidation so
                // distinct relations between the same pair don't supersede each other.
                sourceRelationType: current.relationType,
              };
              if (needsAssertionNode) {
                const assertionResult = await syncRelationAsAssertion({
                  ...commonInput,
                  // F105: carry the human-triage decision so a below-threshold
                  // machine assertion still materializes once a human approves.
                  claimStatus: current.claimStatus,
                  ...(evidence.length > 0 ? { evidence } : {}),
                });
                // M3: persist the :Assertion id back onto the Firestore Relation
                // doc so provenance reads (getRelationEvidence, KnowledgeTab)
                // can follow the claimId pointer. Idempotent: skip when the doc
                // already carries the same id. Admin SDK — this runs in a worker.
                if (assertionResult.claimId && current.claimId !== assertionResult.claimId) {
                  const { db: adminDb } = await import('@/lib/firebase-admin');
                  await adminDb
                    .collection('relations')
                    .doc(current.relationId)
                    .update({ claimId: assertionResult.claimId });
                }
              } else {
                // A Class B/C -> A transition removes the no-longer-backed
                // Assertion/Evidence projection before writing the direct edge.
                // The Firestore source explicitly removed the evidence/AI status,
                // so retaining the old claim would be stale rather than history.
                // Always delete by the stable relationId. Legacy Class B/C rows
                // can have a graph Assertion even when the Firestore claimId
                // write-back never completed.
                await deleteAssertionByRelationId(current.relationId);
                await syncRelationAsEdge(commonInput);
                if (current.claimId) {
                  const [{ db: adminDb }, { FieldValue }] = await Promise.all([
                    import('@/lib/firebase-admin'),
                    import('firebase-admin/firestore'),
                  ]);
                  await adminDb
                    .collection('relations')
                    .doc(current.relationId)
                    .update({ claimId: FieldValue.delete() });
                }
              }

              const verified = await readAuthoritativeRelation(relationId);
              if (!verified) {
                await removeRelationProjection(relationId);
                if (await readAuthoritativeRelation(relationId)) {
                  throw new Error(`Relation ${relationId} was recreated during post-write cleanup`);
                }
                return {
                  relationId,
                  operation: 'skipped',
                  neo4jRelType,
                  reason: 'Firestore source was deleted during graph mutation; projection removed',
                };
              }
              if (verified.projectionFingerprint !== current.projectionFingerprint) {
                throw new Error(
                  `Relation ${relationId} changed during graph mutation (${String(current.projectionFingerprint)} -> ${String(verified.projectionFingerprint)})`
                );
              }
              if (
                verified.sourceCorrelationId !== current.sourceCorrelationId ||
                verified.sourceFingerprint !== current.sourceFingerprint
              ) {
                throw new Error(`Relation ${relationId} source generation changed during graph mutation`);
              }

              return {
                relationId: current.relationId,
                operation: operation === 'create' ? 'created' : 'updated',
                neo4jRelType,
                sourceId: current.sourceId,
                targetId: current.targetId,
                correlationId: projectionCorrelationId,
              };
            }

            case 'delete': {
              const neo4jRelType = resolveNeo4jPredicate(relationData.relationType);
              // Successful Inngest steps are memoized across retries. Re-read
              // immediately before the destructive graph call so a relation
              // recreation or marker replacement after the load step cannot be
              // deleted by stale retry state.
              const currentGuard = await readRelationDeleteGuard(relationId, eventData.deleteToken);
              confirmedDeleteOutboxToken = currentGuard.deleteOutboxToken;
              if (currentGuard.skipDelete) {
                return {
                  relationId: relationData.relationId,
                  operation: 'skipped',
                  neo4jRelType,
                  reason: 'Delete marker is stale or the Firestore relation exists',
                };
              }
              // H5: NO find-edge gate here. Class B edges written pre-CRIT-1
              // carry a random relationId and sub-75 proposals never
              // materialize an edge at all — gating cleanup on "an edge with
              // this relationId exists" leaked the :Assertion + :Evidence (and
              // any mis-stamped live edge) forever. Both cleanups are
              // idempotent, so they run unconditionally.
              await removeRelationProjection(relationData.relationId);

              return {
                relationId: relationData.relationId,
                operation: 'deleted',
                neo4jRelType,
              };
            }

            default:
              throw new Error(`Unknown operation: ${operation}`);
          }
        }));

      if (confirmedDeleteOutboxToken) {
        await step.run('clear-relation-delete-outbox', async () => {
          const { db: adminDb } = await import('@/lib/firebase-admin');
          const markerRef = adminDb.collection(RELATION_SYNC_OUTBOX_COLLECTION).doc(relationId);
          await adminDb.runTransaction(async (transaction) => {
            const marker = await transaction.get(markerRef);
            if (!marker.exists) return;
            const record = parseRelationDeleteOutboxRecord(relationId, marker.data());
            if (record?.deleteToken === confirmedDeleteOutboxToken) transaction.delete(markerRef);
          });
        });
      }

      // M6: the edge changed — drop stale neighbor/path/business cache
      // entries for old and current endpoints. An endpoint rewrite removes
      // topology from the memoized pair and adds it to the fresh pair.
      try {
        const endpointIds = new Set([relationData.sourceId, relationData.targetId, result.sourceId, result.targetId]);
        for (const endpointId of endpointIds) {
          if (endpointId) invalidateCachesForEntity(endpointId);
        }
      } catch (cacheError) {
        log.warn('Cache invalidation failed (non-fatal)', {
          relationId,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }

      // Step 4: Send completion event (only if not skipped)
      const resultCorrelationId = result.correlationId ?? correlationId;
      await step.run('send-completion', async () => {
        // Don't send completion event for skipped relations
        // They will be retried by reconciliation job
        if (result.operation !== 'skipped') {
          await inngest.send({
            name: 'app/relation.sync.completed',
            data: {
              ...(resultCorrelationId ? { correlationId: resultCorrelationId } : {}),
              relationId: result.relationId,
              operation: result.operation,
              neo4jRelType: result.neo4jRelType,
              syncedAt: Date.now(),
            },
          });
        }

        // Fire edge verification after typed-edge writes (create/update only).
        // Gated by DEFENSE_MINISTER_ENABLED env (default: disabled when missing).
        if (
          (result.operation === 'created' || result.operation === 'updated') &&
          process.env.DEFENSE_MINISTER_ENABLED === 'true'
        ) {
          try {
            await inngest.send({
              name: 'app/edge.verification.requested',
              data: {
                relationId: relationData.relationId,
                sourceEntityId: relationData.sourceId ?? '',
                targetEntityId: relationData.targetId ?? '',
              },
            });
          } catch {
            // Best-effort — don't fail the sync job if verification can't be queued
          }
        }
      });

      if (result.operation === 'skipped') {
        log.info('Sync relation skipped', { relationId, correlationId: resultCorrelationId, reason: result.reason });
      } else {
        log.info('Sync relation completed', {
          relationId,
          correlationId: resultCorrelationId,
          operation: result.operation,
          neo4jRelType: result.neo4jRelType,
        });
      }

      return {
        success: true,
        ...(resultCorrelationId ? { correlationId: resultCorrelationId } : {}),
        ...result,
      };
    } catch (error) {
      log.error('Sync relation failed', error instanceof Error ? error : undefined, { relationId, correlationId });
      throw error;
    }
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trigger a relation sync from application code.
 * Rejects malformed supplied correlation IDs. After validation, safeSendEvent
 * converts Inngest transport unavailability into a false result.
 *
 * @returns true if event was sent, false if Inngest unavailable
 */
export async function triggerRelationSync(
  relationId: string,
  operation: 'create' | 'update' | 'delete',
  additionalData?: Partial<Omit<RelationSyncEventData, 'relationId' | 'operation'>>
): Promise<boolean> {
  const eventData = { ...(additionalData ?? {}) } as Partial<RelationSyncEventData>;
  delete eventData.correlationId;
  delete eventData.sourceFingerprint;
  let sourceCorrelationId =
    additionalData?.correlationId === undefined ? undefined : resolveCorrelationId(additionalData.correlationId);
  let sourceFingerprint = resolveRelationSourceFingerprint(additionalData?.sourceFingerprint);
  if (operation !== 'delete') {
    const current = await readAuthoritativeRelation(relationId);
    sourceCorrelationId = current?.sourceCorrelationId ?? sourceCorrelationId;
    sourceFingerprint = current?.sourceFingerprint ?? sourceFingerprint;
  }
  const correlationId = resolveCorrelationId(sourceCorrelationId);
  return safeSendEvent(
    {
      name: 'app/relation.sync.requested',
      data: {
        ...eventData,
        operation,
        relationId,
        correlationId,
        ...(sourceFingerprint ? { sourceFingerprint } : {}),
      },
    },
    { logPrefix: '[relations]', silent: true }
  );
}

/**
 * Trigger batch sync of multiple relations.
 * Uses safeSendEvent to avoid throwing errors when Inngest is unavailable.
 *
 * @returns number of events successfully sent
 */
export async function triggerBatchRelationSync(relationIds: string[]): Promise<number> {
  // Load each authoritative source pair so a repair event is not mistaken for
  // an older mutation by the version gate.
  const results = await Promise.all(relationIds.map((relationId) => triggerRelationSync(relationId, 'update')));
  return results.filter(Boolean).length;
}
