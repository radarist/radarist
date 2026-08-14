/**
 * @file lib/concept-service.ts
 * @description Service for managing normalized concepts in the Knowledge Graph.
 * Provides CRUD operations for concepts that unify tag variations.
 *
 * Concepts normalize tag variations (e.g., "AI", "ai", "A.I.") to canonical
 * slugs ("artificial-intelligence") with display names ("Artificial Intelligence").
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 * @author Radarist Team
 * @created 2026-01-14
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as limitQuery,
  Timestamp,
  increment,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  Concept,
  ConceptType,
  CreateConceptInput,
  UpdateConceptInput,
  GraphSyncStatus,
} from '@/lib/types';
import {
  normalizeConcept,
  getCanonicalName,
  normalizeConceptArray,
} from '@/lib/utils/concept-normalize';

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'concepts';

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filter options for querying concepts.
 */
export interface ConceptFilters {
  /** Filter by concept type */
  type?: ConceptType;
  /** Filter by parent concept ID */
  parentId?: string;
  /** Filter by sync status */
  graphSyncStatus?: GraphSyncStatus;
  /** Search query for name/aliases */
  search?: string;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert Firestore document to Concept type.
 */
function firestoreToConcept(
  docSnap: import('firebase/firestore').DocumentSnapshot
): Concept | null {
  if (!docSnap.exists()) return null;

  const data = docSnap.data();
  return {
    id: docSnap.id,
    canonicalName: data.canonicalName,
    slug: data.slug,
    type: data.type,
    aliases: data.aliases || [],
    description: data.description,
    parentId: data.parentId,
    entityCount: data.entityCount || 0,
    graphSyncStatus: data.graphSyncStatus,
    lastSyncedAt: data.lastSyncedAt?.toMillis?.() ?? data.lastSyncedAt,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
  };
}

/**
 * Convert Concept to Firestore format for writing.
 */
function conceptToFirestore(
  concept: Partial<Concept>
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (concept.canonicalName !== undefined) data.canonicalName = concept.canonicalName;
  if (concept.slug !== undefined) data.slug = concept.slug;
  if (concept.type !== undefined) data.type = concept.type;
  if (concept.aliases !== undefined) data.aliases = concept.aliases;
  if (concept.description !== undefined) data.description = concept.description;
  if (concept.parentId !== undefined) data.parentId = concept.parentId;
  if (concept.entityCount !== undefined) data.entityCount = concept.entityCount;
  if (concept.graphSyncStatus !== undefined) data.graphSyncStatus = concept.graphSyncStatus;
  if (concept.lastSyncedAt !== undefined) {
    data.lastSyncedAt = Timestamp.fromMillis(concept.lastSyncedAt);
  }

  return data;
}

/**
 * Generate concept ID from slug.
 */
function generateConceptId(slug: string): string {
  return `concept-${slug}`;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get a concept by its ID.
 *
 * @param id - The concept ID
 * @returns The concept or null if not found
 *
 * @example
 * ```typescript
 * const concept = await getConceptById('concept-artificial-intelligence');
 * ```
 */
export async function getConceptById(id: string): Promise<Concept | null> {
  const docRef = doc(db, COLLECTION_NAME, id);
  const docSnap = await getDoc(docRef);
  return firestoreToConcept(docSnap);
}

/**
 * Get a concept by its slug.
 *
 * @param slug - The concept slug
 * @returns The concept or null if not found
 *
 * @example
 * ```typescript
 * const concept = await getConceptBySlug('artificial-intelligence');
 * ```
 */
export async function getConceptBySlug(slug: string): Promise<Concept | null> {
  const id = generateConceptId(slug);
  return getConceptById(id);
}

/**
 * Get all concepts with optional filters.
 *
 * @param filters - Optional filters to apply
 * @returns Array of concepts matching filters
 *
 * @example
 * ```typescript
 * // Get all tag concepts
 * const tags = await getConcepts({ type: 'tag' });
 *
 * // Get concepts pending sync
 * const pending = await getConcepts({ graphSyncStatus: 'pending' });
 * ```
 */
export async function getConcepts(filters: ConceptFilters = {}): Promise<Concept[]> {
  const conceptsRef = collection(db, COLLECTION_NAME);
  const constraints: import('firebase/firestore').QueryConstraint[] = [];

  // Apply filters
  if (filters.type) {
    constraints.push(where('type', '==', filters.type));
  }
  if (filters.parentId) {
    constraints.push(where('parentId', '==', filters.parentId));
  }
  if (filters.graphSyncStatus) {
    constraints.push(where('graphSyncStatus', '==', filters.graphSyncStatus));
  }

  // Order by canonical name
  constraints.push(orderBy('canonicalName', 'asc'));

  // Apply limit
  if (filters.limit) {
    constraints.push(limitQuery(filters.limit));
  }

  const q = query(conceptsRef, ...constraints);
  const snapshot = await getDocs(q);

  let concepts = snapshot.docs
    .map(firestoreToConcept)
    .filter((c): c is Concept => c !== null);

  // Client-side search (Firestore doesn't support full-text search)
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    concepts = concepts.filter((concept) => {
      return (
        concept.canonicalName.toLowerCase().includes(searchLower) ||
        concept.slug.includes(searchLower) ||
        concept.aliases.some((alias) => alias.toLowerCase().includes(searchLower))
      );
    });
  }

  // Apply offset (client-side, not ideal for large datasets)
  if (filters.offset) {
    concepts = concepts.slice(filters.offset);
  }

  return concepts;
}

/**
 * Search concepts by name, slug, or alias.
 *
 * @param searchQuery - The search query
 * @param limit - Maximum results to return
 * @returns Array of matching concepts
 *
 * @example
 * ```typescript
 * const results = await searchConcepts('machine', 10);
 * // Might return: Machine Learning, Machine Vision, etc.
 * ```
 */
export async function searchConcepts(
  searchQuery: string,
  limit: number = 20
): Promise<Concept[]> {
  return getConcepts({ search: searchQuery, limit });
}

/**
 * Get concepts pending Neo4j sync.
 *
 * @param limit - Maximum results to return
 * @returns Array of concepts with pending sync status
 */
export async function getConceptsPendingSync(limit: number = 100): Promise<Concept[]> {
  return getConcepts({ graphSyncStatus: 'pending', limit });
}

/**
 * Get child concepts of a parent concept.
 *
 * @param parentId - The parent concept ID
 * @returns Array of child concepts
 *
 * @example
 * ```typescript
 * // Get children of "artificial-intelligence"
 * const children = await getChildConcepts('concept-artificial-intelligence');
 * // Might return: Machine Learning, Deep Learning, etc.
 * ```
 */
export async function getChildConcepts(parentId: string): Promise<Concept[]> {
  return getConcepts({ parentId });
}

// ============================================================================
// CREATE OPERATIONS
// ============================================================================

/**
 * Create a new concept.
 *
 * @param input - The concept data
 * @returns The created concept
 *
 * @example
 * ```typescript
 * const concept = await createConcept({
 *   canonicalName: 'Artificial Intelligence',
 *   slug: 'artificial-intelligence',
 *   type: 'tag',
 *   aliases: ['AI', 'ai', 'A.I.'],
 * });
 * ```
 */
export async function createConcept(input: CreateConceptInput): Promise<Concept> {
  const now = Date.now();
  const id = generateConceptId(input.slug);

  const concept: Concept = {
    id,
    canonicalName: input.canonicalName,
    slug: input.slug,
    type: input.type,
    aliases: input.aliases || [],
    description: input.description,
    parentId: input.parentId,
    entityCount: 0,
    graphSyncStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  const docRef = doc(db, COLLECTION_NAME, id);
  await setDoc(docRef, {
    ...conceptToFirestore(concept),
    createdAt: Timestamp.fromMillis(now),
    updatedAt: Timestamp.fromMillis(now),
  });

  return concept;
}

/**
 * Get or create a concept from a raw tag input.
 * Normalizes the input, checks for existing concept, creates if needed.
 *
 * @param input - The raw tag/concept input (e.g., "AI", "artificial intelligence")
 * @param type - The concept type (default: 'tag')
 * @returns The existing or newly created concept
 *
 * @example
 * ```typescript
 * // These all return the same concept:
 * const concept1 = await getOrCreateConcept('AI');
 * const concept2 = await getOrCreateConcept('ai');
 * const concept3 = await getOrCreateConcept('Artificial Intelligence');
 * ```
 */
export async function getOrCreateConcept(
  input: string,
  type: ConceptType = 'tag'
): Promise<Concept> {
  const slug = normalizeConcept(input);
  if (!slug) {
    throw new Error('Invalid concept input: cannot normalize to a valid slug');
  }

  // Check if concept exists
  let concept = await getConceptBySlug(slug);

  if (concept) {
    // Add alias if it's a new variation
    const trimmedInput = input.trim();
    if (!concept.aliases.includes(trimmedInput)) {
      concept = await addConceptAlias(concept.id, trimmedInput);
    }
    return concept;
  }

  // Create new concept
  const canonicalName = getCanonicalName(slug);
  return createConcept({
    canonicalName,
    slug,
    type,
    aliases: [input.trim()],
  });
}

/**
 * Bulk create or update concepts from an array of tags.
 *
 * @param inputs - Array of raw tag inputs
 * @param type - The concept type (default: 'tag')
 * @returns Array of concepts (existing or newly created)
 *
 * @example
 * ```typescript
 * const concepts = await bulkGetOrCreateConcepts(['AI', 'ML', 'IoT']);
 * ```
 */
export async function bulkGetOrCreateConcepts(
  inputs: string[],
  type: ConceptType = 'tag'
): Promise<Concept[]> {
  const normalized = normalizeConceptArray(inputs);
  const concepts: Concept[] = [];

  for (const { slug, canonicalName, originalInputs } of normalized) {
    let concept = await getConceptBySlug(slug);

    if (concept) {
      // Add any new aliases
      const newAliases = originalInputs.filter((a) => !concept!.aliases.includes(a));
      if (newAliases.length > 0) {
        for (const alias of newAliases) {
          concept = await addConceptAlias(concept.id, alias);
        }
      }
    } else {
      // Create new concept
      concept = await createConcept({
        canonicalName,
        slug,
        type,
        aliases: originalInputs,
      });
    }

    concepts.push(concept);
  }

  return concepts;
}

// ============================================================================
// UPDATE OPERATIONS
// ============================================================================

/**
 * Update a concept.
 *
 * @param id - The concept ID
 * @param updates - The updates to apply
 * @returns The updated concept
 */
export async function updateConcept(
  id: string,
  updates: UpdateConceptInput
): Promise<Concept> {
  const docRef = doc(db, COLLECTION_NAME, id);
  const now = Date.now();

  await updateDoc(docRef, {
    ...conceptToFirestore(updates),
    updatedAt: Timestamp.fromMillis(now),
    graphSyncStatus: 'pending', // Mark for re-sync
  });

  const updated = await getConceptById(id);
  if (!updated) {
    throw new Error(`Concept ${id} not found after update`);
  }

  return updated;
}

/**
 * Add an alias to a concept.
 *
 * @param id - The concept ID
 * @param alias - The alias to add
 * @returns The updated concept
 *
 * @example
 * ```typescript
 * // Add "artificial intel" as an alias for the AI concept
 * const concept = await addConceptAlias('concept-artificial-intelligence', 'artificial intel');
 * ```
 */
export async function addConceptAlias(id: string, alias: string): Promise<Concept> {
  const concept = await getConceptById(id);
  if (!concept) {
    throw new Error(`Concept ${id} not found`);
  }

  const trimmedAlias = alias.trim();
  if (concept.aliases.includes(trimmedAlias)) {
    return concept; // Already exists
  }

  const updatedAliases = [...concept.aliases, trimmedAlias];
  return updateConcept(id, { aliases: updatedAliases });
}

/**
 * Remove an alias from a concept.
 *
 * @param id - The concept ID
 * @param alias - The alias to remove
 * @returns The updated concept
 */
export async function removeConceptAlias(id: string, alias: string): Promise<Concept> {
  const concept = await getConceptById(id);
  if (!concept) {
    throw new Error(`Concept ${id} not found`);
  }

  const updatedAliases = concept.aliases.filter((a) => a !== alias);
  return updateConcept(id, { aliases: updatedAliases });
}

/**
 * Set the parent concept for hierarchy.
 *
 * @param id - The concept ID
 * @param parentId - The parent concept ID (or null to remove)
 * @returns The updated concept
 *
 * @example
 * ```typescript
 * // Make "machine-learning" a child of "artificial-intelligence"
 * await setConceptParent(
 *   'concept-machine-learning',
 *   'concept-artificial-intelligence'
 * );
 * ```
 */
export async function setConceptParent(
  id: string,
  parentId: string | null
): Promise<Concept> {
  return updateConcept(id, { parentId: parentId ?? undefined });
}

/**
 * Increment the entity count for a concept.
 *
 * @param id - The concept ID
 * @param delta - The amount to increment (default: 1, negative for decrement)
 */
export async function incrementEntityCount(id: string, delta: number = 1): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  await updateDoc(docRef, {
    entityCount: increment(delta),
    updatedAt: Timestamp.fromMillis(Date.now()),
  });
}

/**
 * Mark concept as synced to Neo4j.
 *
 * @param id - The concept ID
 */
export async function markConceptSynced(id: string): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  const now = Date.now();
  await updateDoc(docRef, {
    graphSyncStatus: 'synced',
    lastSyncedAt: Timestamp.fromMillis(now),
    updatedAt: Timestamp.fromMillis(now),
  });
}

/**
 * Mark concept sync as failed.
 *
 * @param id - The concept ID
 */
export async function markConceptSyncFailed(id: string): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  await updateDoc(docRef, {
    graphSyncStatus: 'failed',
    updatedAt: Timestamp.fromMillis(Date.now()),
  });
}

// ============================================================================
// DELETE OPERATIONS
// ============================================================================

/**
 * Delete a concept.
 *
 * @param id - The concept ID to delete
 *
 * @example
 * ```typescript
 * await deleteConcept('concept-obsolete-tag');
 * ```
 */
export async function deleteConcept(id: string): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  await deleteDoc(docRef);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Find a concept that matches an input string.
 * Useful for looking up concepts by any of their aliases.
 *
 * @param input - The input string to match
 * @returns The matching concept or null
 *
 * @example
 * ```typescript
 * const concept = await findConceptByInput('AI');
 * // Returns the "artificial-intelligence" concept
 * ```
 */
export async function findConceptByInput(input: string): Promise<Concept | null> {
  const slug = normalizeConcept(input);
  if (!slug) return null;

  return getConceptBySlug(slug);
}

/**
 * Check if a concept exists for a given input.
 *
 * @param input - The input string to check
 * @returns True if a concept exists
 */
export async function conceptExists(input: string): Promise<boolean> {
  const concept = await findConceptByInput(input);
  return concept !== null;
}

/**
 * Get concept statistics.
 *
 * @returns Object with concept counts by type
 */
export async function getConceptStats(): Promise<{
  total: number;
  byType: Record<ConceptType, number>;
  pendingSync: number;
}> {
  const allConcepts = await getConcepts({});

  const byType: Record<ConceptType, number> = {
    tag: 0,
    category: 0,
    industry: 0,
    capability: 0,
    domain: 0,
  };

  let pendingSync = 0;

  for (const concept of allConcepts) {
    byType[concept.type] = (byType[concept.type] || 0) + 1;
    if (concept.graphSyncStatus === 'pending') {
      pendingSync++;
    }
  }

  return {
    total: allConcepts.length,
    byType,
    pendingSync,
  };
}

/**
 * Extract and create concepts from an entity's tags.
 *
 * @param tags - Array of tags from an entity
 * @param type - The concept type (default: 'tag')
 * @returns Array of concept slugs for linking
 *
 * @example
 * ```typescript
 * const entity = { tags: ['AI', 'Machine Learning', 'IoT'] };
 * const conceptSlugs = await extractConceptsFromTags(entity.tags);
 * // Returns: ['artificial-intelligence', 'machine-learning', 'internet-of-things']
 * ```
 */
export async function extractConceptsFromTags(
  tags: string[],
  type: ConceptType = 'tag'
): Promise<string[]> {
  if (!tags || tags.length === 0) {
    return [];
  }

  const concepts = await bulkGetOrCreateConcepts(tags, type);
  return concepts.map((c) => c.slug);
}
