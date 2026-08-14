/**
 * @file relations-validation.ts
 * @description Entity snapshot building, relation creation from IDs, and orphan cleanup.
 *
 * Split from relations.ts — contains buildEntitySnapshot, createRelationFromIds,
 * ENTITY_COLLECTIONS mapping, and cleanupOrphanedRelations.
 */

import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import type { Relation, RelationType, EntityType, EntitySnapshot, EvidenceRef } from '@/lib/types';
import { agentNameForDiscoverySource } from '@/lib/types/relations';
import { safeResolve, needsResolution } from '@/lib/migration';
import { createLogger } from '@/lib/logger';
import { createRelation, getRelations, SelfReferenceError, triggerRelationSyncSafely } from './relations-core';
import { deleteRelationsWithOwnedLocks, type RelationDeleteTarget } from './relations-delete-client';
import { requireRelationSyncAcknowledgement } from './relation-sync-dispatch';
// Canonical EntityType → collection map. cleanupOrphanedRelations resolves
// entity existence through this shared leaf module (the same one entity-factory
// derives ENTITY_CONFIGS from), so the client and admin cleanup twins can never
// drift on collection spellings again. Previously a local copy used the wrong
// `useCases`/`orgUnits` names and orphan-deleted valid use-case/org-unit relations.
import { ENTITY_COLLECTIONS } from './entity-collections';
import { assertCanonicalRelationType } from './relation-type-contract';
import { resolveCorrelationId } from './observability/correlation';

// Re-export for backward compatibility
export { agentNameForDiscoverySource };

const log = createLogger('relations');

/**
 * Result of an orphaned relations cleanup operation.
 */
export interface CleanupOrphanedRelationsResult {
  /** Total relations checked */
  checked: number;
  /** Number of orphaned relations found */
  orphaned: number;
  /** Number of orphaned relations deleted */
  deleted: number;
}

/**
 * Finds and deletes orphaned relations where the source or target entity
 * no longer exists in Firestore.
 *
 * This is a defense-in-depth mechanism to catch orphans from race conditions,
 * partial failures, or past bugs where cascade deletes were missing.
 *
 * @returns Promise resolving to cleanup results
 */
export async function cleanupOrphanedRelations(): Promise<CleanupOrphanedRelationsResult> {
  const allRelations = await getRelations();

  if (allRelations.length === 0) {
    return { checked: 0, orphaned: 0, deleted: 0 };
  }

  // Collect unique entity IDs to check, grouped by collection
  const entitiesToCheck = new Map<string, Set<string>>(); // collectionName -> Set<entityId>

  for (const rel of allRelations) {
    const sourceCollection = ENTITY_COLLECTIONS[rel.sourceSnapshot.type];
    const targetCollection = ENTITY_COLLECTIONS[rel.targetSnapshot.type];

    if (sourceCollection) {
      if (!entitiesToCheck.has(sourceCollection)) {
        entitiesToCheck.set(sourceCollection, new Set());
      }
      entitiesToCheck.get(sourceCollection)!.add(rel.sourceSnapshot.id);
    }

    if (targetCollection) {
      if (!entitiesToCheck.has(targetCollection)) {
        entitiesToCheck.set(targetCollection, new Set());
      }
      entitiesToCheck.get(targetCollection)!.add(rel.targetSnapshot.id);
    }
  }

  // Check entity existence in parallel batches of 50
  const existingEntities = new Set<string>(); // "collection:id" keys
  const checkPromises: Promise<void>[] = [];

  for (const [collectionName, entityIds] of entitiesToCheck) {
    const ids = Array.from(entityIds);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      checkPromises.push(
        Promise.all(
          batch.map(async (id) => {
            try {
              const docSnap = await getDoc(doc(db, collectionName, id));
              if (docSnap.exists()) {
                existingEntities.add(`${collectionName}:${id}`);
              }
            } catch {
              // If check fails, assume entity exists (conservative)
              existingEntities.add(`${collectionName}:${id}`);
            }
          })
        ).then(() => undefined)
      );
    }
  }

  await Promise.all(checkPromises);

  // Find orphaned relations
  const orphanedRelations: Relation[] = [];

  for (const rel of allRelations) {
    const sourceCollection = ENTITY_COLLECTIONS[rel.sourceSnapshot.type];
    const targetCollection = ENTITY_COLLECTIONS[rel.targetSnapshot.type];

    const sourceExists = sourceCollection ? existingEntities.has(`${sourceCollection}:${rel.sourceSnapshot.id}`) : true; // Unknown type -> conservative, assume exists
    const targetExists = targetCollection ? existingEntities.has(`${targetCollection}:${rel.targetSnapshot.id}`) : true;

    if (!sourceExists || !targetExists) {
      orphanedRelations.push(rel);
    }
  }

  if (orphanedRelations.length === 0) {
    return { checked: allRelations.length, orphaned: 0, deleted: 0 };
  }

  const targets: RelationDeleteTarget[] = orphanedRelations.map((relation) => ({ id: relation.id }));
  const correlationId = resolveCorrelationId();
  const deleted = (
    await deleteRelationsWithOwnedLocks(db, targets, {
      correlationId,
      onChunkDeleted: async (ids, dispatches) => {
        const acknowledgements = await Promise.all(
          dispatches.map(({ relationId, deleteToken }) =>
            triggerRelationSyncSafely(relationId, 'delete', { deleteToken }, { correlationId })
          )
        );
        acknowledgements.forEach((acknowledged, index) =>
          requireRelationSyncAcknowledgement(acknowledged, ids[index], 'delete')
        );
      },
    })
  ).length;

  log.info('Cleaned up orphaned relations', { deleted, total: allRelations.length });

  return {
    checked: allRelations.length,
    orphaned: orphanedRelations.length,
    deleted,
  };
}

// ============================================================================
// RELATION CREATION HELPERS
// ============================================================================

/**
 * Input for creating a relation using entity IDs.
 * The helper will fetch the entities and build snapshots automatically.
 */
export interface CreateRelationInput {
  /** ID of the source entity */
  sourceId: string;
  /** Type of the source entity */
  sourceType: EntityType;
  /** ID of the target entity */
  targetId: string;
  /** Type of the target entity */
  targetType: EntityType;
  /** Type of relationship */
  relationType: RelationType;
  /** Optional notes */
  notes?: string;
  /** Confidence score (0-100) */
  confidence?: number;
  /** Whether this was AI-suggested */
  aiSuggested?: boolean;
  /** Bare agent name ('linker'|'auto-linker'|'assistant'); only meaningful when aiSuggested. */
  agentName?: string;
  // ========== Phase 4: Relations-as-Claims ==========
  /** Evidence references supporting this relation */
  evidenceRefs?: EvidenceRef[];
  /** Summary of reasoning behind this relation */
  reasoningSummary?: string;
  /** Status of the claim */
  claimStatus?: 'proposed' | 'curated' | 'rejected' | 'derived';
}

/**
 * Fetches entity data and builds an EntitySnapshot.
 * This helper fetches the entity from the appropriate collection
 * based on its type and creates a snapshot.
 *
 * @param entityId - The entity ID
 * @param entityType - The entity type
 * @returns Promise resolving to an EntitySnapshot
 * @throws Error if entity not found
 */
async function buildEntitySnapshot(entityId: string, entityType: EntityType): Promise<EntitySnapshot> {
  const now = Date.now();

  // Import entity fetchers dynamically to avoid circular dependencies
  switch (entityType) {
    case 'company': {
      const { getCompanyById } = await import('@/lib/companies');
      const company = await getCompanyById(entityId);
      if (!company) throw new Error(`Company not found: ${entityId}`);
      return {
        type: 'company',
        id: company.id,
        name: company.name,
        description: company.description,
        status: company.status,
        snapshotAt: now,
      };
    }
    case 'prototype': {
      const { getPrototypeById } = await import('@/lib/prototypes');
      const prototype = await getPrototypeById(entityId);
      if (!prototype) throw new Error(`Prototype not found: ${entityId}`);
      return {
        type: 'prototype',
        id: prototype.id,
        name: prototype.name,
        description: prototype.description,
        status: prototype.status,
        snapshotAt: now,
      };
    }
    case 'useCase': {
      const { getUseCaseById } = await import('@/lib/use-cases');
      const useCase = await getUseCaseById(entityId);
      if (!useCase) throw new Error(`UseCase not found: ${entityId}`);
      return {
        type: 'useCase',
        id: useCase.id,
        name: useCase.title,
        description: useCase.description,
        status: useCase.status,
        snapshotAt: now,
      };
    }
    case 'strategy': {
      const { getStrategyById } = await import('@/lib/strategies');
      const strategy = await getStrategyById(entityId);
      if (!strategy) throw new Error(`Strategy not found: ${entityId}`);
      return {
        type: 'strategy',
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        // Strategy doesn't have a status field
        snapshotAt: now,
      };
    }
    case 'technology': {
      const { getTechnologyById: getNewTechById } = await import('@/lib/technology-service');
      const resolvedId = needsResolution(entityId) ? safeResolve(entityId) : entityId;
      if (!resolvedId.startsWith('tech-')) {
        throw new Error(`Technology ID must be in format "tech-xxx": ${entityId}`);
      }

      const tech = await getNewTechById(resolvedId);
      if (!tech) {
        throw new Error(`Technology not found: ${resolvedId}`);
      }

      return {
        type: 'technology',
        id: resolvedId,
        name: tech.name || 'Unknown Technology',
        description: tech.description,
        status: tech.approvalStatus || 'approved',
        snapshotAt: now,
      };
    }
    case 'signal': {
      const docRef = doc(db, 'signals', entityId);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) throw new Error(`Signal not found: ${entityId}`);
      const signal = docSnap.data();
      return {
        type: 'signal',
        id: entityId,
        name: signal.title || 'Unknown Signal',
        description: signal.description,
        status: signal.status,
        snapshotAt: now,
      };
    }
    case 'orgUnit': {
      const { getOrgUnitById } = await import('@/lib/org-units');
      const orgUnit = await getOrgUnitById(entityId);
      if (!orgUnit) throw new Error(`OrgUnit not found: ${entityId}`);
      return {
        type: 'orgUnit',
        id: orgUnit.id,
        name: orgUnit.name,
        description: orgUnit.description,
        snapshotAt: now,
      };
    }
    case 'initiative': {
      const { getInitiativeById } = await import('@/lib/initiatives');
      const initiative = await getInitiativeById(entityId);
      if (!initiative) throw new Error(`Initiative not found: ${entityId}`);
      return {
        type: 'initiative',
        id: initiative.id,
        name: initiative.name,
        description: initiative.description,
        status: initiative.status,
        snapshotAt: now,
      };
    }
    case 'painPoint': {
      const { getPainPointById } = await import('@/lib/pain-points');
      const painPoint = await getPainPointById(entityId);
      if (!painPoint) throw new Error(`PainPoint not found: ${entityId}`);
      return {
        type: 'painPoint',
        id: painPoint.id,
        name: painPoint.title,
        description: painPoint.description,
        status: painPoint.status,
        snapshotAt: now,
      };
    }
    case 'document': {
      const { getDocumentById } = await import('@/lib/document-service');
      const document = await getDocumentById(entityId);
      if (!document) throw new Error(`Document not found: ${entityId}`);
      return {
        type: 'document',
        id: document.id,
        name: document.title, // Document uses 'title', not 'name'
        description: document.description,
        status: document.status,
        snapshotAt: now,
      };
    }
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Creates a relation between two entities using their IDs.
 * This helper fetches the entities and builds the required snapshots automatically.
 *
 * @param input - The relation creation input with entity IDs and types
 * @returns Promise resolving to the created Relation
 * @throws Error if either entity is not found
 */
export async function createRelationFromIds(input: CreateRelationInput): Promise<Relation> {
  assertCanonicalRelationType(input.relationType);
  const {
    sourceId,
    sourceType,
    targetId,
    targetType,
    relationType,
    notes,
    confidence,
    aiSuggested = false,
    agentName,
    // Phase 4: Relations-as-Claims fields
    evidenceRefs,
    reasoningSummary,
    claimStatus,
  } = input;

  // Early self-reference check by ID (fail fast before fetching)
  if (sourceId === targetId) {
    throw new SelfReferenceError(sourceId, `Entity ${sourceId}`);
  }

  // Build snapshots for both entities
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    buildEntitySnapshot(sourceId, sourceType),
    buildEntitySnapshot(targetId, targetType),
  ]);

  // Create the relation with full snapshots
  // Firebase rejects undefined values, so provide defaults for optional fields
  return createRelation({
    relationType,
    sourceSnapshot,
    targetSnapshot,
    notes: notes || '', // Default to empty string
    confidence: confidence ?? 100, // Default to 100% confidence if not specified
    aiSuggested,
    // Phase 4: Relations-as-Claims fields (only include if defined)
    ...(evidenceRefs && { evidenceRefs }),
    ...(reasoningSummary && { reasoningSummary }),
    ...(claimStatus && { claimStatus }),
    ...(agentName && { agentName }),
  });
}
