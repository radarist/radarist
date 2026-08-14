/**
 * @file entity-tag-concept-projection.ts
 * @description Canonical server-owned projection from entity tags to Concepts.
 *
 * Entity writers intentionally remain unaware of the graph. The authoritative
 * sync workers call this module after re-reading Firestore, so UI, Assistant,
 * admin, and import writes all converge through the same path.
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminBulkGetOrCreateConcepts } from '@/lib/concept-admin';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { db } from '@/lib/firebase-admin';
import type { Concept, EntityType } from '@/lib/types';
import { runReadTransaction, runWriteTransaction } from './neo4j-client';

export const ENTITY_TAG_CONCEPT_MAX_TAGS = 20;
export const ENTITY_TAG_CONCEPT_MAX_LENGTH = 50;

const TAG_CONCEPT_ENTITY_TYPES = new Set<EntityType>([
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
]);

const MAX_SOURCE_CHURN_ATTEMPTS = 3;

export interface EntityTagConceptProjection {
  tags: string[];
  concepts: Concept[];
  conceptIds: string[];
  addedConceptIds: string[];
  removedConceptIds: string[];
  conceptIdsChanged: boolean;
}

export interface EntityTagConceptGraphReceipt {
  relationshipsCreated: number;
  countReceipts: ConceptEntityCountReceipt[];
}

export interface ConceptEntityCountReceipt {
  conceptId: string;
  entityCount: number;
  projectionRevision: number;
  reconciledAt: number;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Apply the same bounds as the strict Technology schema at this shared legacy
 * boundary. Invalid/oversized values are ignored rather than allowed to create
 * unbounded Concept fan-out from older or loosely validated writers.
 */
export function normalizeBoundedEntityTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!tag || tag.length > ENTITY_TAG_CONCEPT_MAX_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length === ENTITY_TAG_CONCEPT_MAX_TAGS) break;
  }
  return tags;
}

export function buildEntityTagConceptProjection(
  tags: string[],
  concepts: Concept[],
  currentConceptIds: unknown
): EntityTagConceptProjection {
  const conceptIds = [...new Set(concepts.map((concept) => concept.id))];
  const currentIds = uniqueStrings(currentConceptIds);
  const desired = new Set(conceptIds);
  const current = new Set(currentIds);

  return {
    tags,
    concepts,
    conceptIds,
    addedConceptIds: conceptIds.filter((id) => !current.has(id)),
    removedConceptIds: currentIds.filter((id) => !desired.has(id)),
    conceptIdsChanged: !arraysEqual(currentIds, conceptIds),
  };
}

/**
 * Converge the Firestore-side tag projection. Concept counts are deliberately
 * not maintained here: Neo4j's distinct HAS_CONCEPT topology is the one count
 * authority, and {@link reconcileConceptEntityCounts} projects a monotonic
 * receipt back to Firestore after the graph edges converge.
 *
 * A source tag edit racing the projection is detected and retried from a fresh
 * read; no stale conceptIds are committed. `conceptIds` is derived metadata, so
 * writing it must not make the business entity look user-edited by changing its
 * `updatedAt` timestamp.
 */
export async function reconcileEntityTagConcepts(
  entityId: string,
  entityType: EntityType
): Promise<EntityTagConceptProjection | null> {
  if (!TAG_CONCEPT_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Entity type ${entityType} does not support tag Concept projection`);
  }

  const entityRef = db.collection(ENTITY_COLLECTIONS[entityType]).doc(entityId);

  for (let attempt = 0; attempt < MAX_SOURCE_CHURN_ATTEMPTS; attempt++) {
    const source = await entityRef.get();
    if (!source.exists) return null;

    const sourceTags = normalizeBoundedEntityTags(source.data()?.tags);
    const concepts = await adminBulkGetOrCreateConcepts(sourceTags, 'tag');
    const desiredConceptIds = [...new Set(concepts.map((concept) => concept.id))];

    const transactionResult = await db.runTransaction(async (transaction) => {
      const currentSource = await transaction.get(entityRef);
      if (!currentSource.exists) return { state: 'missing' as const };

      const currentData = currentSource.data() ?? {};
      const currentTags = normalizeBoundedEntityTags(currentData.tags);
      if (!arraysEqual(sourceTags, currentTags)) return { state: 'stale' as const };

      const projection = buildEntityTagConceptProjection(currentTags, concepts, currentData.conceptIds);
      if (projection.conceptIdsChanged) {
        transaction.update(entityRef, {
          conceptIds: desiredConceptIds,
        });
      }

      return {
        state: 'committed' as const,
        projection,
      };
    });

    if (transactionResult.state === 'missing') return null;
    if (transactionResult.state === 'committed') return transactionResult.projection;
  }

  throw new Error(`Entity ${entityType}:${entityId} tags changed during every projection attempt`);
}

const UPSERT_TAG_CONCEPTS = `
  UNWIND $concepts AS concept
  MERGE (c:Concept {id: concept.id})
  ON CREATE SET c.createdAt = concept.createdAt
  SET c.slug = concept.slug,
      c.canonicalName = concept.canonicalName,
      c.type = concept.type,
      c.aliases = concept.aliases,
      c.description = concept.description,
      c.updatedAt = concept.updatedAt
  RETURN count(c) AS conceptsProjected
`;

const DELETE_STALE_OWNED_TAG_EDGES = `
  MATCH (:Entity {id: $entityId})-[r:HAS_CONCEPT]->(c:Concept)
  WHERE r.relationId IS NULL
    AND r.claimId IS NULL
    AND (r.projectionOwner IS NULL OR r.projectionOwner = $projectionOwner)
    AND NOT c.id IN $conceptIds
  WITH collect(r) AS staleEdges, collect(DISTINCT c.id) AS staleConceptIds
  FOREACH (edge IN staleEdges | DELETE edge)
  RETURN size(staleEdges) AS relationshipsDeleted, staleConceptIds
`;

const ADOPT_LEGACY_TAG_CONCEPT_EDGES = `
  MATCH (:Entity {id: $entityId})-[r:HAS_CONCEPT]->(c:Concept)
  WHERE c.id IN $conceptIds
    AND r.relationId IS NULL
    AND r.claimId IS NULL
    AND r.projectionOwner IS NULL
  SET r.projectionOwner = $projectionOwner
  RETURN count(r) AS relationshipsAdopted
`;

const MERGE_TAG_CONCEPT_EDGES = `
  UNWIND $conceptIds AS conceptId
  MATCH (entity:Entity {id: $entityId})
  MATCH (concept:Concept {id: conceptId})
  MERGE (entity)-[r:HAS_CONCEPT {projectionOwner: $projectionOwner}]->(concept)
  ON CREATE SET r.createdAt = $createdAt
  RETURN count(r) AS relationshipsProjected
`;

const ENTITY_TAG_CONCEPT_PROJECTION_OWNER = 'entity-tags-v1';

const CAPTURE_ENTITY_TAG_CONCEPT_IDS = `
  MATCH (:Entity {id: $entityId})-[:HAS_CONCEPT]->(concept:Concept)
  RETURN collect(DISTINCT concept.id) AS conceptIds
`;

/**
 * Serialize count derivation per Concept in Neo4j before reading topology.
 * The revision uses a wall-clock floor so a rebuilt graph always supersedes
 * receipts retained in Firestore from an older graph instance. Within one
 * graph, the Concept property lock makes concurrent entity projections line up
 * and each later receipt observes all previously committed topology.
 */
const RECONCILE_CONCEPT_ENTITY_COUNTS = `
  UNWIND $conceptIds AS conceptId
  MATCH (concept:Concept {id: conceptId})
  WITH concept ORDER BY concept.id
  WITH concept, timestamp() AS reconciledAt
  SET concept.entityCountProjectionRevision =
        CASE
          WHEN coalesce(concept.entityCountProjectionRevision, 0) >= reconciledAt * 1000
            THEN concept.entityCountProjectionRevision + 1
          ELSE reconciledAt * 1000
        END
  WITH concept, reconciledAt, concept.entityCountProjectionRevision AS projectionRevision
  OPTIONAL MATCH (entity:Entity)-[:HAS_CONCEPT]->(concept)
  WITH concept, reconciledAt, projectionRevision, count(DISTINCT entity) AS entityCount
  SET concept.entityCount = entityCount,
      concept.entityCountReconciledAt = reconciledAt
  RETURN concept.id AS conceptId, entityCount, projectionRevision, reconciledAt
  ORDER BY conceptId
`;

function uniqueConceptIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

/** Capture before an entity DETACH DELETE so count repair survives retries. */
export async function captureEntityTagConceptIdsFromNeo4j(entityId: string): Promise<string[]> {
  const result = await runReadTransaction<{ conceptIds: string[] }>(CAPTURE_ENTITY_TAG_CONCEPT_IDS, { entityId });
  return uniqueConceptIds(result.records[0]?.conceptIds ?? []);
}

/**
 * Project topology-derived counts to both stores without stale-write races.
 * Neo4j returns a monotonically versioned receipt; each Firestore Concept
 * accepts only a newer revision, so out-of-order concurrent workers converge.
 */
export async function reconcileConceptEntityCounts(
  affectedConceptIds: readonly string[]
): Promise<ConceptEntityCountReceipt[]> {
  const conceptIds = uniqueConceptIds(affectedConceptIds);
  if (conceptIds.length === 0) return [];

  const graphResult = await runWriteTransaction<ConceptEntityCountReceipt>(RECONCILE_CONCEPT_ENTITY_COUNTS, {
    conceptIds,
  });
  const receipts = graphResult.records;

  await Promise.all(
    receipts.map(async (receipt) => {
      const conceptRef = db.collection('concepts').doc(receipt.conceptId);
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(conceptRef);
        if (!snapshot.exists) return;

        const storedRevision = snapshot.data()?.entityCountProjectionRevision;
        const currentRevision =
          typeof storedRevision === 'number' && Number.isFinite(storedRevision) ? storedRevision : 0;
        if (currentRevision > receipt.projectionRevision) return;
        if (currentRevision === receipt.projectionRevision) {
          const storedCount = snapshot.data()?.entityCount;
          if (storedCount !== receipt.entityCount) {
            throw new Error(
              `Concept ${receipt.conceptId} has conflicting entity-count receipts at revision ${receipt.projectionRevision}`
            );
          }
          return;
        }

        transaction.update(conceptRef, {
          entityCount: receipt.entityCount,
          entityCountProjectionRevision: receipt.projectionRevision,
          entityCountReconciledAt: Timestamp.fromMillis(receipt.reconciledAt),
        });
      });
    })
  );

  return receipts;
}

/**
 * Project canonical Concept nodes before their edges, then remove only
 * field-owned implicit links. Relation/Assertion-owned edges carry relationId
 * or claimId and are deliberately preserved.
 */
export async function projectEntityTagConceptsToNeo4j(
  entityId: string,
  projection: EntityTagConceptProjection
): Promise<EntityTagConceptGraphReceipt> {
  if (projection.concepts.length > 0) {
    await runWriteTransaction(UPSERT_TAG_CONCEPTS, {
      concepts: projection.concepts.map((concept) => ({
        id: concept.id,
        slug: concept.slug,
        canonicalName: concept.canonicalName,
        type: concept.type,
        aliases: concept.aliases,
        description: concept.description ?? null,
        createdAt: concept.createdAt,
        updatedAt: concept.updatedAt,
      })),
    });
  }

  const staleResult = await runWriteTransaction<{ staleConceptIds: string[] }>(DELETE_STALE_OWNED_TAG_EDGES, {
    entityId,
    conceptIds: projection.conceptIds,
    projectionOwner: ENTITY_TAG_CONCEPT_PROJECTION_OWNER,
  });

  let relationshipsCreated = 0;
  if (projection.conceptIds.length > 0) {
    // Existing concept workers created unmarked implicit edges. Adopt only
    // those legacy edges before the owner-keyed MERGE; explicit Relation and
    // Assertion edges are excluded so they can never be relabeled or pruned.
    await runWriteTransaction(ADOPT_LEGACY_TAG_CONCEPT_EDGES, {
      entityId,
      conceptIds: projection.conceptIds,
      projectionOwner: ENTITY_TAG_CONCEPT_PROJECTION_OWNER,
    });
    const result = await runWriteTransaction(MERGE_TAG_CONCEPT_EDGES, {
      entityId,
      conceptIds: projection.conceptIds,
      createdAt: Date.now(),
      projectionOwner: ENTITY_TAG_CONCEPT_PROJECTION_OWNER,
    });
    relationshipsCreated = result.summary.counters.relationshipsCreated;
  }

  const countReceipts = await reconcileConceptEntityCounts([
    ...projection.conceptIds,
    ...projection.removedConceptIds,
    ...(staleResult.records[0]?.staleConceptIds ?? []),
  ]);

  return { relationshipsCreated, countReceipts };
}
