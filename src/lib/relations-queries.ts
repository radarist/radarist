/**
 * @file relations-queries.ts
 * @description Query operations for relations — by entity, by type, AI suggestions,
 * staleness detection, and client-side filtering.
 *
 * Split from relations.ts — contains getRelationsBySource, getRelationsByTarget,
 * getRelationsForEntity, getRelationsByType, getAISuggestedRelations, getStaleRelations,
 * filterRelations, and the RelationFilters interface.
 */

import { db } from '@/lib/firebase';
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore';
import type { Relation, RelationType, EntityType } from '@/lib/types';
import { getRelations } from './relations-core';

/**
 * Search and filter options for relations.
 */
export interface RelationFilters {
  /** Text search query (searches notes and entity names). */
  searchQuery?: string;
  /** Filter by relation type. */
  relationType?: RelationType[];
  /** Filter by source entity type. */
  sourceType?: EntityType[];
  /** Filter by target entity type. */
  targetType?: EntityType[];
  /** Filter by specific source entity ID. */
  sourceId?: string;
  /** Filter by specific target entity ID. */
  targetId?: string;
  /** Filter by AI-suggested relations only (true keeps only AI-suggested). */
  aiSuggestedOnly?: boolean;
  /** Exact-match the aiSuggested flag: `true` keeps only AI-suggested, `false` keeps only human-curated. */
  aiSuggested?: boolean;
  /** Filter by minimum confidence threshold (0-100). */
  minConfidence?: number;
  /** Filter by maximum confidence threshold (0-100). */
  maxConfidence?: number;
}

/**
 * Fetches relations filtered by source entity ID.
 * Used for contextual graphs and entity detail pages.
 *
 * @param sourceId - The source entity ID (e.g., "radar-1:42", "company-123")
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getRelationsBySource(sourceId: string): Promise<Relation[]> {
  const q = query(collection(db, 'relations'), where('sourceSnapshot.id', '==', sourceId));
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as Relation);
}

/**
 * Fetches relations filtered by target entity ID.
 * Used for reverse lookups and entity detail pages.
 *
 * @param targetId - The target entity ID
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getRelationsByTarget(targetId: string): Promise<Relation[]> {
  const q = query(collection(db, 'relations'), where('targetSnapshot.id', '==', targetId));
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as Relation);
}

/**
 * Fetches all relations for a given entity (both source and target).
 * This is the primary method for contextual graphs.
 *
 * @param entityId - The entity ID to fetch relations for
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getRelationsForEntity(entityId: string): Promise<Relation[]> {
  const [sourceRelations, targetRelations] = await Promise.all([
    getRelationsBySource(entityId),
    getRelationsByTarget(entityId),
  ]);

  // Deduplicate by ID (shouldn't happen but just in case)
  const allRelations = [...sourceRelations, ...targetRelations];
  const uniqueRelations = Array.from(new Map(allRelations.map((rel) => [rel.id, rel])).values());

  return uniqueRelations;
}

/**
 * Bulk-fetch relations for MANY entities at once, grouped by entity ID.
 *
 * Replaces the N+1 fan-out (`Promise.all(ids.map(getRelationsForEntity))`) that the
 * library list-page hooks used to do — for N entities that fired 2N concurrent
 * Firestore reads and tripped the client SDK's `resource-exhausted: Too many
 * outstanding requests`. Small sets use Firestore `in` queries (≤30 values each —
 * no new index needed). Large library sets use one collection scan and group the
 * requested endpoints locally; this trades a bounded amount of extra document data
 * for one network round trip instead of dozens of sequential query waves.
 *
 * Semantics match `getRelationsForEntity` per id: each entity's list contains every
 * relation where it is the source OR the target, de-duplicated by relation id. Every
 * requested id is present in the result (→ `[]` when it has no relations).
 *
 * @param entityIds - entity IDs to fetch relations for
 * @returns Promise resolving to `{ [entityId]: Relation[] }`
 * @throws Error if a Firestore query fails
 */
export async function getRelationsForEntities(entityIds: string[]): Promise<Record<string, Relation[]>> {
  const uniqueEntityIds = [...new Set(entityIds)];
  const map: Record<string, Relation[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const id of uniqueEntityIds) {
    map[id] = [];
    seen[id] = new Set();
  }
  if (uniqueEntityIds.length === 0) return map;

  const wanted = new Set(uniqueEntityIds);
  const add = (entityId: string | undefined, rel: Relation) => {
    if (!entityId || !wanted.has(entityId)) return;
    if (seen[entityId].has(rel.id)) return;
    seen[entityId].add(rel.id);
    map[entityId].push(rel);
  };

  // A full relation scan is cheaper in latency once a list would require more
  // than three sequential source/target batches. This is intentionally a
  // high threshold: focused entity/sheet reads keep their selective indexes,
  // while large local-first library pages avoid 50–75 network queries.
  const BATCH_SIZE = 30;
  const MAX_SELECTIVE_BATCHES = 3;
  if (uniqueEntityIds.length > BATCH_SIZE * MAX_SELECTIVE_BATCHES) {
    const allRelations = await getRelations();
    for (const rel of allRelations) {
      add(rel.sourceSnapshot?.id, rel);
      add(rel.targetSnapshot?.id, rel);
    }
    return map;
  }

  // Firestore `in` accepts up to 30 values. One source + one target query per
  // batch; batches run in sequence so at most 2 queries are ever in flight.
  for (let i = 0; i < uniqueEntityIds.length; i += BATCH_SIZE) {
    const batch = uniqueEntityIds.slice(i, i + BATCH_SIZE);
    const [bySource, byTarget] = await Promise.all([
      getDocs(query(collection(db, 'relations'), where('sourceSnapshot.id', 'in', batch))),
      getDocs(query(collection(db, 'relations'), where('targetSnapshot.id', 'in', batch))),
    ]);
    bySource.docs.forEach((d) => {
      const rel = d.data() as Relation;
      add(rel.sourceSnapshot?.id, rel);
    });
    byTarget.docs.forEach((d) => {
      const rel = d.data() as Relation;
      add(rel.targetSnapshot?.id, rel);
    });
  }

  return map;
}

/**
 * Fetches relations filtered by relation type.
 *
 * @param relationType - The type of relation to filter by
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getRelationsByType(relationType: RelationType): Promise<Relation[]> {
  const q = query(collection(db, 'relations'), where('relationType', '==', relationType));
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as Relation);
}

/**
 * Fetches AI-suggested relations pending approval.
 * Used for Auto-Linker Agent review UI.
 *
 * @param minConfidence - Minimum confidence score threshold (0-100)
 * @returns Promise resolving to an array of Relation objects
 * @throws Error if Firestore query fails
 */
export async function getAISuggestedRelations(minConfidence: number = 0): Promise<Relation[]> {
  const q = query(
    collection(db, 'relations'),
    where('aiSuggested', '==', true),
    where('confidence', '>=', minConfidence),
    orderBy('confidence', 'desc')
  );
  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as Relation);
}

/**
 * Finds stale relation snapshots that need refreshing.
 * Used by background job to keep snapshots up-to-date.
 *
 * @param staleDays - Number of days after which a snapshot is considered stale (default: 30)
 * @returns Promise resolving to an array of Relation objects with stale snapshots
 * @throws Error if Firestore query fails
 */
export async function getStaleRelations(staleDays: number = 30): Promise<Relation[]> {
  const staleTimestamp = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const allRelations = await getRelations();

  return allRelations.filter(
    (rel) => rel.sourceSnapshot.snapshotAt < staleTimestamp || rel.targetSnapshot.snapshotAt < staleTimestamp
  );
}

/**
 * Client-side filtering for relations.
 * Used when Firestore queries are not sufficient (e.g., text search).
 *
 * @param relations - Array of relations to filter
 * @param filters - Filter criteria
 * @returns Filtered array of Relation objects
 */
export function filterRelations(relations: Relation[], filters: RelationFilters): Relation[] {
  let filtered = [...relations];

  // Text search
  if (filters.searchQuery) {
    const query = filters.searchQuery.toLowerCase();
    filtered = filtered.filter(
      (rel) =>
        rel.sourceSnapshot.name.toLowerCase().includes(query) ||
        rel.targetSnapshot.name.toLowerCase().includes(query) ||
        rel.notes?.toLowerCase().includes(query)
    );
  }

  // Relation type filter
  if (filters.relationType && filters.relationType.length > 0) {
    filtered = filtered.filter((rel) => filters.relationType!.includes(rel.relationType));
  }

  // Source type filter
  if (filters.sourceType && filters.sourceType.length > 0) {
    filtered = filtered.filter((rel) => filters.sourceType!.includes(rel.sourceSnapshot.type));
  }

  // Target type filter
  if (filters.targetType && filters.targetType.length > 0) {
    filtered = filtered.filter((rel) => filters.targetType!.includes(rel.targetSnapshot.type));
  }

  // Source ID filter
  if (filters.sourceId) {
    filtered = filtered.filter((rel) => rel.sourceSnapshot.id === filters.sourceId);
  }

  // Target ID filter
  if (filters.targetId) {
    filtered = filtered.filter((rel) => rel.targetSnapshot.id === filters.targetId);
  }

  // AI-suggested only
  if (filters.aiSuggestedOnly) {
    filtered = filtered.filter((rel) => rel.aiSuggested === true);
  }

  // AI-suggested exact match (true = AI-only, false = human-curated only)
  if (filters.aiSuggested !== undefined) {
    filtered = filtered.filter((rel) => (rel.aiSuggested ?? false) === filters.aiSuggested);
  }

  // Minimum confidence threshold
  if (filters.minConfidence !== undefined) {
    filtered = filtered.filter((rel) => (rel.confidence ?? 0) >= filters.minConfidence!);
  }

  // Maximum confidence threshold
  if (filters.maxConfidence !== undefined) {
    filtered = filtered.filter((rel) => (rel.confidence ?? 0) <= filters.maxConfidence!);
  }

  return filtered;
}
