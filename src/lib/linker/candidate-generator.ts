/**
 * @file linker/candidate-generator.ts
 * @description Multi-stage Candidate Generation Pipeline for Linker Agent
 *
 * Generates relation candidates using a multi-stage narrowing pipeline
 * that scales as O(batch × k) instead of O(N²).
 *
 * **Pipeline Stages:**
 * 1. Batch Selection: Fetch entities by type from Firestore
 * 2. Heuristic Pre-filter: Tags, categories, industry overlap
 * 3. Embedding Similarity: Vector search for semantic matches (optional)
 *
 * **Features:**
 * - Incremental processing via lastProcessedAt tracking
 * - Entity resolution using entity-aliases
 * - Existing relation filtering to avoid duplicates
 * - Configurable batch size and candidate limits
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { createLogger } from '@/lib/logger';
// Server-only (Inngest worker) module: use the firebase-admin SDK. The Firestore
// client SDK throws `code: 'unavailable'` (a540) when used without a persistent
// connection, so all reads here go through the admin Firestore query builder.
import { db } from '@/lib/firebase-admin';

const log = createLogger('linker/candidate-generator');
import { getValidRelationTypes } from './relation-ontology';
import { getTrackedEntityIds } from './linker-metrics';
import { adminCheckDuplicateRelation } from '@/lib/relations-admin';
import { adminGetPendingProposalsBetween } from '@/lib/proposed-relations-admin';
import { generateEmbedding } from '@/lib/ai/client';
import { normalizeAlias } from '@/lib/text-normalize';
import type { LinkerCandidate, EntityContext } from './types';
import type { EntityType, RelationType } from '@/lib/types';
import { getNeighborsByRelation } from '@/lib/graph/traversal';
import { getTwoHopJoin } from '@/lib/discovery/two-hop-whitelist';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Default configuration values
 */
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_CANDIDATES_PER_ENTITY = 10;
const HEURISTIC_SCORE_THRESHOLD = 30; // Minimum heuristic score to consider
const EMBEDDING_SIMILARITY_THRESHOLD = 0.65; // Minimum cosine similarity

/**
 * Entity type to Firestore collection mapping.
 * Exported for test-time cross-check against entity-factory's ENTITY_CONFIGS.
 */
export const ENTITY_COLLECTIONS: Record<EntityType, string> = {
  company: 'companies',
  technology: 'technologies',
  useCase: 'use-cases',
  strategy: 'strategies',
  prototype: 'prototypes',
  signal: 'signals',
  document: 'documents',
  orgUnit: 'org-units',
  initiative: 'initiatives',
  painPoint: 'painPoints',
  radarPlacement: 'radarPlacements',
};

/**
 * Name field for each entity type (varies by collection)
 */
const ENTITY_NAME_FIELDS: Record<EntityType, string> = {
  company: 'name',
  technology: 'name',
  useCase: 'title',
  strategy: 'name',
  prototype: 'name',
  signal: 'title',
  document: 'title',
  orgUnit: 'name',
  initiative: 'name',
  painPoint: 'title',
  radarPlacement: 'id', // No name field, use ID
};

/**
 * Entity types that support heuristic matching
 */
export const HEURISTIC_ENTITY_TYPES: EntityType[] = [
  'company',
  'technology',
  'useCase',
  'signal',
  'painPoint',
  // Added 2026-04-17: these types have rich ontology entries but were never
  // iterated as sources, so Prototype (83%), Strategy (38%), OrgUnit (35%),
  // Initiative (13%) accumulated high orphan rates.
  'prototype',
  'strategy',
  'orgUnit',
  'initiative',
];

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for candidate generation
 */
export interface CandidateGeneratorOptions {
  /** Number of source entities to process per run */
  batchSize?: number;
  /** Entity types to use as sources */
  sourceTypes?: EntityType[];
  /** Entity types to use as targets */
  targetTypes?: EntityType[];
  /** Whether to use embedding similarity in narrowing */
  useEmbeddings?: boolean;
  /** Maximum candidates per source entity */
  maxCandidatesPerEntity?: number;
  /** Only process entities updated after this timestamp */
  processAfter?: number;
  /** Whether to prioritize untracked entities (never processed before) */
  prioritizeUntracked?: boolean;
}

/**
 * Internal entity representation for processing
 */
interface EntityRecord {
  id: string;
  type: EntityType;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  industry?: string;
  updatedAt?: number;
  createdAt?: number;
}

/**
 * Heuristic match result
 */
interface HeuristicMatch {
  target: EntityRecord;
  score: number;
  matchedOn: string[];
}

// ============================================================================
// CONTEXT BUILDING
// ============================================================================

/**
 * Builds an EntityContext object from an EntityRecord.
 * This rich context helps the AI verifier make better decisions.
 *
 * @param entity - Entity record to convert
 * @returns EntityContext for AI verification
 */
function buildEntityContext(entity: EntityRecord): EntityContext {
  const context: EntityContext = {
    name: entity.name,
  };

  // Add description if available
  if (entity.description) {
    // Truncate long descriptions for prompt efficiency
    context.description = entity.description.slice(0, 500);
  }

  // Add industry for companies
  if (entity.industry) {
    context.industry = entity.industry;
  }

  // Add category (quadrant for technologies)
  if (entity.category) {
    context.category = entity.category;
  }

  // Add tags (up to 10 for efficiency)
  if (entity.tags && entity.tags.length > 0) {
    context.tags = entity.tags.slice(0, 10);
  }

  return context;
}

// ============================================================================
// ENTITY FETCHING
// ============================================================================

/**
 * Fetches entities of a given type from Firestore.
 *
 * @param entityType - The type of entities to fetch
 * @param options - Fetch options (limit, processAfter, prioritizeUntracked)
 * @returns Array of entity records
 */
async function fetchEntities(
  entityType: EntityType,
  options: { limit?: number; processAfter?: number; prioritizeUntracked?: boolean } = {}
): Promise<EntityRecord[]> {
  const collectionName = ENTITY_COLLECTIONS[entityType];
  const nameField = ENTITY_NAME_FIELDS[entityType];

  if (!collectionName) {
    log.warn('Unknown collection for entity type', { entityType });
    return [];
  }

  try {
    // Build query with the admin Firestore query builder.
    // Only use orderBy when processAfter is specified — this avoids requiring
    // all documents to have an updatedAt field.
    let q: FirebaseFirestore.Query = db.collection(collectionName);

    if (options.processAfter) {
      // When filtering by time, we need the index
      q = q.where('updatedAt', '>', options.processAfter).orderBy('updatedAt', 'desc');
    }

    // Filter signals to only include APPROVED status
    // This prevents polluting the graph with unvalidated signals
    if (entityType === 'signal') {
      q = q.where('status', '==', 'Approved');
    }

    // Fetch more than needed if we're prioritizing untracked
    const fetchLimit = options.prioritizeUntracked
      ? (options.limit || 50) * 3 // Fetch 3x to have room to filter
      : options.limit;

    if (fetchLimit) {
      q = q.limit(fetchLimit);
    }

    const snapshot = await q.get();

    let entities = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: entityType,
        name: String(data[nameField] || doc.id),
        description: data.description || data.summary || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        category: data.category || data.quadrant || '',
        industry: data.industry || data.sector || '',
        updatedAt: data.updatedAt?.toMillis?.() || data.updatedAt || Date.now(),
        createdAt: data.createdAt?.toMillis?.() || data.createdAt || Date.now(),
      };
    });

    // Sort by updatedAt (most recent first) - do in memory since we removed orderBy
    entities.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Prioritize untracked entities if requested
    if (options.prioritizeUntracked && entities.length > 0) {
      try {
        const trackedIds = await getTrackedEntityIds(entityType);
        const untracked = entities.filter((e) => !trackedIds.has(e.id));
        const tracked = entities.filter((e) => trackedIds.has(e.id));

        // Put untracked first, then tracked
        entities = [...untracked, ...tracked];

        if (untracked.length > 0) {
          log.info(`Prioritized ${untracked.length} untracked ${entityType} entities`);
        }
      } catch (error) {
        log.warn('Failed to check tracked entities', { error: error instanceof Error ? error.message : String(error) });
        // Continue with original order
      }
    }

    // Apply final limit
    if (options.limit && entities.length > options.limit) {
      entities = entities.slice(0, options.limit);
    }

    return entities;
  } catch (error) {
    log.error(`Error fetching ${entityType}`, error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Fetches all target entities for candidate matching.
 *
 * @param targetTypes - Entity types to fetch as targets
 * @returns Map of entity type to entity records
 */
async function fetchTargetEntities(targetTypes: EntityType[]): Promise<Map<EntityType, EntityRecord[]>> {
  const targetMap = new Map<EntityType, EntityRecord[]>();

  // Fetch all target types in parallel
  const results = await Promise.all(
    targetTypes.map(async (type) => ({
      type,
      entities: await fetchEntities(type, { limit: 500 }), // Cap targets per type
    }))
  );

  for (const { type, entities } of results) {
    targetMap.set(type, entities);
  }

  return targetMap;
}

// ============================================================================
// HEURISTIC MATCHING
// ============================================================================

/**
 * Calculates a heuristic similarity score between two entities.
 * Uses multiple signals: tags, categories, industry, name overlap.
 *
 * @param source - Source entity
 * @param target - Target entity
 * @returns Score (0-100) and list of matched features
 */
function calculateHeuristicScore(source: EntityRecord, target: EntityRecord): { score: number; matchedOn: string[] } {
  let score = 0;
  const matchedOn: string[] = [];

  // Skip self-matches
  if (source.id === target.id && source.type === target.type) {
    return { score: 0, matchedOn: [] };
  }

  // 1. Tag overlap (30 points max)
  if (source.tags?.length && target.tags?.length) {
    const sourceTags = new Set(source.tags.map((t) => normalizeAlias(t)));
    const targetTags = new Set(target.tags.map((t) => normalizeAlias(t)));
    const overlap = [...sourceTags].filter((t) => targetTags.has(t));

    if (overlap.length > 0) {
      const tagScore = Math.min(30, overlap.length * 10);
      score += tagScore;
      matchedOn.push(`tags:${overlap.join(',')}`);
    }
  }

  // 2. Category/quadrant match (20 points)
  if (source.category && target.category) {
    const sourceCategory = normalizeAlias(source.category);
    const targetCategory = normalizeAlias(target.category);

    if (sourceCategory === targetCategory) {
      score += 20;
      matchedOn.push(`category:${source.category}`);
    }
  }

  // 3. Industry match (20 points)
  if (source.industry && target.industry) {
    const sourceIndustry = normalizeAlias(source.industry);
    const targetIndustry = normalizeAlias(target.industry);

    if (sourceIndustry === targetIndustry) {
      score += 20;
      matchedOn.push(`industry:${source.industry}`);
    }
  }

  // 4. Name similarity (30 points max)
  const sourceName = normalizeAlias(source.name);
  const targetName = normalizeAlias(target.name);

  // Check for word overlap
  const sourceWords = new Set(sourceName.split(/\s+/).filter((w) => w.length >= 3));
  const targetWords = new Set(targetName.split(/\s+/).filter((w) => w.length >= 3));
  const wordOverlap = [...sourceWords].filter((w) => targetWords.has(w));

  if (wordOverlap.length > 0) {
    const nameScore = Math.min(30, wordOverlap.length * 15);
    score += nameScore;
    matchedOn.push(`name_words:${wordOverlap.join(',')}`);
  }

  // 5. Description keyword overlap (bonus 10 points)
  if (source.description && target.description) {
    const sourceDesc = normalizeAlias(source.description.slice(0, 500));
    const targetDesc = normalizeAlias(target.description.slice(0, 500));
    const descWords = new Set(sourceDesc.split(/\s+/).filter((w) => w.length >= 5));
    const targetDescWords = targetDesc.split(/\s+/).filter((w) => w.length >= 5);
    const descOverlap = targetDescWords.filter((w) => descWords.has(w));

    if (descOverlap.length >= 3) {
      score += 10;
      matchedOn.push('description_overlap');
    }
  }

  return { score: Math.min(100, score), matchedOn };
}

/**
 * Filters target entities using heuristic matching.
 *
 * @param source - Source entity
 * @param targets - Candidate target entities
 * @param threshold - Minimum score threshold
 * @param maxResults - Maximum results to return
 * @returns Filtered and scored matches
 */
function filterByHeuristics(
  source: EntityRecord,
  targets: EntityRecord[],
  threshold: number = HEURISTIC_SCORE_THRESHOLD,
  maxResults: number = DEFAULT_MAX_CANDIDATES_PER_ENTITY
): HeuristicMatch[] {
  const matches: HeuristicMatch[] = [];

  for (const target of targets) {
    // Skip same entity
    if (source.id === target.id && source.type === target.type) {
      continue;
    }

    const { score, matchedOn } = calculateHeuristicScore(source, target);

    if (score >= threshold) {
      matches.push({ target, score, matchedOn });
    }
  }

  // Sort by score descending and limit
  return matches.sort((a, b) => b.score - a.score).slice(0, maxResults * 2); // Keep extra for embedding stage
}

// ============================================================================
// EMBEDDING SIMILARITY
// ============================================================================

/**
 * Generates a text representation of an entity for embedding.
 *
 * @param entity - Entity to embed
 * @returns Text string for embedding
 */
function entityToText(entity: EntityRecord): string {
  const parts = [entity.name];

  if (entity.description) {
    parts.push(entity.description.slice(0, 300));
  }

  if (entity.tags?.length) {
    parts.push(`Tags: ${entity.tags.join(', ')}`);
  }

  if (entity.category) {
    parts.push(`Category: ${entity.category}`);
  }

  return parts.join('. ');
}

/**
 * Calculates cosine similarity between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity (0-1)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Filters and ranks candidates using embedding similarity.
 *
 * @param sourceEmbedding - Source entity embedding
 * @param candidates - Pre-filtered candidates with heuristic matches
 * @param threshold - Minimum similarity threshold
 * @param maxResults - Maximum results to return
 * @returns Ranked candidates with similarity scores
 */
async function filterByEmbeddings(
  sourceEntity: EntityRecord,
  candidates: HeuristicMatch[],
  threshold: number = EMBEDDING_SIMILARITY_THRESHOLD,
  maxResults: number = DEFAULT_MAX_CANDIDATES_PER_ENTITY
): Promise<Array<HeuristicMatch & { similarityScore: number }>> {
  if (candidates.length === 0) {
    return [];
  }

  try {
    // Generate source embedding
    const sourceText = entityToText(sourceEntity);
    const sourceEmbedding = await generateEmbedding(sourceText);

    // Generate candidate embeddings in parallel (batched)
    const candidateTexts = candidates.map((c) => entityToText(c.target));
    const candidateEmbeddings = await Promise.all(candidateTexts.map((text) => generateEmbedding(text)));

    // Calculate similarities
    const results = candidates.map((candidate, index) => ({
      ...candidate,
      similarityScore: cosineSimilarity(sourceEmbedding, candidateEmbeddings[index]),
    }));

    // Filter by threshold and sort
    return results
      .filter((r) => r.similarityScore >= threshold)
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, maxResults);
  } catch (error) {
    log.warn('Embedding generation failed, falling back to heuristics', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fallback: return heuristic results without embeddings
    return candidates.slice(0, maxResults).map((c) => ({
      ...c,
      similarityScore: c.score / 100, // Normalize heuristic score
    }));
  }
}

// ============================================================================
// RELATION INFERENCE
// ============================================================================

/**
 * Infers the most likely relation type between two entities.
 *
 * NOTE: This function uses CONSERVATIVE defaults. The AI verifier will
 * refine the relation type during verification. We avoid making strong
 * assumptions (like "same industry = competitor") that lead to bad relations.
 *
 * @param source - Source entity
 * @param target - Target entity
 * @param matchedOn - Features that matched
 * @returns Suggested relation type
 */
function inferRelationType(source: EntityRecord, target: EntityRecord, matchedOn: string[]): RelationType {
  const validTypes = getValidRelationTypes(source.type, target.type);

  if (validTypes.length === 0 || validTypes[0] === 'custom') {
    return 'custom';
  }

  // Use conservative heuristics - let AI verifier make the final call
  const matchContext = matchedOn.join(' ').toLowerCase();

  // Technology relations - use conservative defaults
  if (source.type === 'technology' && target.type === 'technology') {
    // Only infer 'competes_with' if there's explicit competition signal
    if (matchContext.includes('compet') || matchContext.includes('alternative')) {
      return validTypes.includes('competes_with') ? 'competes_with' : validTypes[0];
    }
    // 'integrates_with' is a safe neutral choice for tech-to-tech
    // AI verifier will refine to uses/enables/competes_with if appropriate
    if (validTypes.includes('integrates_with')) {
      return 'integrates_with';
    }
    return validTypes[0];
  }

  // Company relations - DO NOT assume competitor/partner
  // These require AI verification with grounding
  // CRITICAL: Same industry does NOT mean competitor!
  if (source.type === 'company' && target.type === 'company') {
    // Use 'custom' as placeholder - AI verifier MUST determine actual type
    // Valid types: partner, competitor, acquired_by, invested_in, customer_of, supplier_of
    // We cannot infer these from heuristics alone - need web grounding
    return validTypes.includes('custom') ? 'custom' : validTypes[0];
  }

  // Company-Technology relations - DO NOT assume vendor
  // A company might be a user, investor, or vendor
  if (source.type === 'company' && target.type === 'technology') {
    // Use 'custom' - AI verifier will determine vendor vs user vs invested_in
    // based on context and grounding
    return validTypes.includes('custom') ? 'custom' : validTypes[0];
  }

  if (source.type === 'technology' && target.type === 'company') {
    // Use 'custom' - AI verifier will refine
    return validTypes.includes('custom') ? 'custom' : validTypes[0];
  }

  // Signal relations - mentions is almost always correct
  if (source.type === 'signal') {
    return validTypes.includes('mentions') ? 'mentions' : validTypes[0];
  }

  // Document relations - mentions is almost always correct
  if (source.type === 'document') {
    return validTypes.includes('mentions') ? 'mentions' : validTypes[0];
  }

  // Pain Point relations
  if (target.type === 'painPoint') {
    return validTypes.includes('solves') ? 'solves' : validTypes[0];
  }

  if (source.type === 'painPoint') {
    return validTypes.includes('related_to') ? 'related_to' : validTypes[0];
  }

  // UseCase relations
  if (source.type === 'useCase' && target.type === 'technology') {
    return validTypes.includes('requires') ? 'requires' : validTypes[0];
  }

  if (source.type === 'technology' && target.type === 'useCase') {
    return validTypes.includes('enables') ? 'enables' : validTypes[0];
  }

  // Default to first valid type - AI verifier will refine
  return validTypes[0];
}

// ============================================================================
// MAIN GENERATOR
// ============================================================================

/**
 * Generates relation candidates using the multi-stage pipeline.
 *
 * **Pipeline:**
 * 1. Batch Selection: Fetch source entities (optionally filtered by processAfter)
 * 2. Heuristic Pre-filter: Score candidates by tags, categories, etc.
 * 3. Embedding Similarity: Refine with semantic similarity (if enabled)
 * 4. Duplicate Filtering: Remove existing relations and pending proposals
 *
 * @param options - Configuration options
 * @returns Array of relation candidates
 *
 * @example
 * ```typescript
 * const candidates = await generateCandidates({
 *   batchSize: 50,
 *   sourceTypes: ['technology', 'company'],
 *   useEmbeddings: true,
 *   maxCandidatesPerEntity: 5,
 * });
 * ```
 */
export async function generateCandidates(options: CandidateGeneratorOptions = {}): Promise<LinkerCandidate[]> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    sourceTypes = HEURISTIC_ENTITY_TYPES,
    targetTypes = HEURISTIC_ENTITY_TYPES,
    useEmbeddings = true,
    maxCandidatesPerEntity = DEFAULT_MAX_CANDIDATES_PER_ENTITY,
    processAfter,
    prioritizeUntracked = true, // Default to prioritizing untracked entities
  } = options;

  log.info('Starting pipeline', { batchSize, embeddings: useEmbeddings, prioritizeUntracked });

  const candidates: LinkerCandidate[] = [];

  // Stage 1: Fetch target entities (once for all sources)
  log.info('Stage 1: Fetching target entities...');
  const targetEntities = await fetchTargetEntities(targetTypes);

  const totalTargets = Array.from(targetEntities.values()).reduce((sum, arr) => sum + arr.length, 0);
  log.info('Fetched target entities', { count: totalTargets });

  // Stage 2: Process each source type
  for (const sourceType of sourceTypes) {
    log.info(`Processing source type: ${sourceType}`);

    // Fetch source entities for this type
    const sourceEntities = await fetchEntities(sourceType, {
      limit: batchSize,
      processAfter,
      prioritizeUntracked,
    });

    log.info(`Fetched ${sourceEntities.length} ${sourceType} entities`);

    // Process each source entity (per-source core extracted → buildCandidatesForSource,
    // so a single entity can be linked on demand without scanning the whole collection).
    for (const source of sourceEntities) {
      const sortedCandidates = await buildCandidatesForSource(source, targetEntities, {
        targetTypes,
        useEmbeddings,
        maxCandidatesPerEntity,
      });
      candidates.push(...sortedCandidates);

      // Multi-entity breadth: 2-hop transitive discovery (e.g. painPoint —SOLVES—
      // technology —ADDRESSES→ useCase ⇒ propose painPoint-[addresses]->useCase).
      // No-ops for source types without a whitelisted join, so it is a cheap per-source
      // addition that flows through the SAME verify + materialize pipeline as direct
      // candidates — giving non-technology entities a path into the proposal queue.
      const transitiveCandidates = await generateTransitiveCandidates(source.id, sourceType);
      candidates.push(...transitiveCandidates);
    }
  }

  log.info('Pipeline complete', { candidates: candidates.length });

  return candidates;
}

/**
 * Build linker candidates for a SINGLE source entity against a pre-fetched target
 * map. This is the per-source core of {@link generateCandidates}, factored out so an
 * individual entity (e.g. a just-approved signal) can be linked on demand. Does the
 * heuristic → embedding → dedup → confidence pipeline for one source only.
 */
async function buildCandidatesForSource(
  source: EntityRecord,
  targetEntities: Map<EntityType, EntityRecord[]>,
  options: { targetTypes: EntityType[]; useEmbeddings: boolean; maxCandidatesPerEntity: number }
): Promise<LinkerCandidate[]> {
  const { targetTypes, useEmbeddings, maxCandidatesPerEntity } = options;
  const entityCandidates: LinkerCandidate[] = [];

  // Get targets for each target type
  for (const targetType of targetTypes) {
    const targets = targetEntities.get(targetType) || [];

    if (targets.length === 0) continue;

    // Stage 3: Heuristic pre-filter
    const heuristicMatches = filterByHeuristics(source, targets, HEURISTIC_SCORE_THRESHOLD, maxCandidatesPerEntity * 2);

    if (heuristicMatches.length === 0) continue;

    // Stage 4: Embedding similarity (optional)
    let finalMatches: Array<HeuristicMatch & { similarityScore?: number }>;

    if (useEmbeddings && heuristicMatches.length > 0) {
      finalMatches = await filterByEmbeddings(
        source,
        heuristicMatches,
        EMBEDDING_SIMILARITY_THRESHOLD,
        maxCandidatesPerEntity
      );
    } else {
      finalMatches = heuristicMatches
        .slice(0, maxCandidatesPerEntity)
        .map((m) => ({ ...m, similarityScore: m.score / 100 }));
    }

    // Stage 5: Build candidates
    for (const match of finalMatches) {
      const relationType = inferRelationType(source, match.target, match.matchedOn);

      // Check for existing relation
      const existingRelation = await adminCheckDuplicateRelation(source.id, match.target.id, relationType);

      if (existingRelation) {
        continue; // Skip if relation already exists
      }

      // Check for pending proposal
      const pendingProposals = await adminGetPendingProposalsBetween(source.id, match.target.id);

      if (pendingProposals.some((p) => p.relationType === relationType)) {
        continue; // Skip if proposal already pending
      }

      // Build confidence score
      const confidence = Math.round(
        match.score * 0.4 + // 40% from heuristics
          (match.similarityScore ?? 0.5) * 100 * 0.6 // 60% from embeddings
      );

      // Determine discovery method
      const discoveryMethod: LinkerCandidate['discoveryMethod'] =
        useEmbeddings && match.similarityScore !== undefined ? 'embedding' : 'heuristic';

      entityCandidates.push({
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        sourceContext: buildEntityContext(source),
        targetId: match.target.id,
        targetType: match.target.type,
        targetName: match.target.name,
        targetContext: buildEntityContext(match.target),
        relationType,
        confidence,
        discoveryMethod,
        similarityScore: match.similarityScore,
        evidenceSnippets: match.matchedOn.length > 0 ? [`Matched on: ${match.matchedOn.join(', ')}`] : undefined,
      });
    }
  }

  // Limit candidates per source entity
  return entityCandidates.sort((a, b) => b.confidence - a.confidence).slice(0, maxCandidatesPerEntity);
}

/**
 * Link ONE signal on demand. Fetches the signal, builds its source record, fetches
 * the target universe once, and runs {@link buildCandidatesForSource} — WITHOUT
 * scanning the whole signals collection (so it's cheap enough to run on a like).
 * Returns `[]` for missing / non-Approved signals (mirrors the cron's Approved-only
 * rule — unvalidated signals must not pollute the graph).
 */
export async function generateCandidatesForSignal(
  signalId: string,
  options: { useEmbeddings?: boolean; maxCandidatesPerEntity?: number; targetTypes?: EntityType[] } = {}
): Promise<LinkerCandidate[]> {
  const {
    useEmbeddings = false,
    maxCandidatesPerEntity = DEFAULT_MAX_CANDIDATES_PER_ENTITY,
    targetTypes = HEURISTIC_ENTITY_TYPES,
  } = options;

  const snap = await db.collection('signals').doc(signalId).get();
  if (!snap.exists) return [];
  const data = snap.data() as Record<string, unknown>;
  if (data.status !== 'Approved') return [];

  const ts = (v: unknown): number | undefined =>
    typeof v === 'object' && v !== null && 'toMillis' in v
      ? (v as { toMillis: () => number }).toMillis()
      : typeof v === 'number'
        ? v
        : undefined;

  const source: EntityRecord = {
    id: signalId,
    type: 'signal',
    name: String(data.title || signalId),
    description: String(data.description || data.summary || ''),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    category: String(data.category || data.quadrant || ''),
    industry: String(data.industry || data.sector || ''),
    updatedAt: ts(data.updatedAt) ?? Date.now(),
    createdAt: ts(data.createdAt) ?? Date.now(),
  };

  const targetEntities = await fetchTargetEntities(targetTypes);
  return buildCandidatesForSource(source, targetEntities, { targetTypes, useEmbeddings, maxCandidatesPerEntity });
}

/**
 * Generates candidates specifically for document mentions.
 * Scans documents for entity mentions and creates candidates.
 *
 * @param documentId - Document to scan
 * @returns Candidates from document mentions
 */
export async function generateDocumentMentionCandidates(documentId: string): Promise<LinkerCandidate[]> {
  const { scanDocumentForEntities } = await import('./document-scanner');

  log.info('Generating document mention candidates', { documentId });

  const candidates = await scanDocumentForEntities(documentId);

  // Filter out candidates that already have relations or pending proposals
  const filteredCandidates: LinkerCandidate[] = [];

  for (const candidate of candidates) {
    // Check for existing relation
    const existingRelation = await adminCheckDuplicateRelation(
      candidate.sourceId,
      candidate.targetId,
      candidate.relationType as RelationType
    );

    if (existingRelation) {
      continue; // Skip if relation already exists
    }

    // Check for pending proposal
    const pendingProposals = await adminGetPendingProposalsBetween(candidate.sourceId, candidate.targetId);

    if (pendingProposals.some((p) => p.relationType === candidate.relationType)) {
      continue; // Skip if proposal already pending
    }

    filteredCandidates.push(candidate);
  }

  log.info('Document mention candidates', {
    kept: filteredCandidates.length,
    filtered: candidates.length - filteredCandidates.length,
  });

  return filteredCandidates;
}

/**
 * Generates candidates through transitive relation discovery.
 * Finds entities connected through intermediate entities.
 *
 * @param entityId - Starting entity ID
 * @param entityType - Starting entity type
 * @param depth - Maximum traversal depth (default: 2)
 * @returns Transitive relation candidates
 */
/**
 * Default per-hop confidence when a node carries none (0–1). NB (v0.1.0 limitation):
 * the traversal returns neighbor NODES, not edge properties, so unless a node
 * carries a `confidence` prop both hops default to 0.8 → a path lands at 0.64,
 * above the default 0.6 floor. The floor is therefore largely dormant until edge
 * confidence is surfaced through the traversal (hardening track).
 */
const TWO_HOP_DEFAULT_HOP_CONFIDENCE = 0.8;

/** Per-hop confidence from a node's `confidence` property (0–100 coerced to 0–1), else the default. */
function hopConfidence(node: { properties?: Record<string, unknown> }): number {
  const c = node.properties?.confidence;
  if (typeof c === 'number') return c > 1 ? c / 100 : c;
  return TWO_HOP_DEFAULT_HOP_CONFIDENCE;
}

/**
 * Bias-controlled 2-hop transitive discovery. From a whitelisted source, traverse
 * exactly two hops along a per-source relation+direction whitelist and propose the
 * inferred source→terminal relation — but only when the path confidence
 * (hop1*hop2) clears the configured floor. Hard path-length cap of 2 (no recursion).
 *
 * Returns [] for any source type without a whitelisted join. Whole-body best-effort.
 */
export async function generateTransitiveCandidates(
  entityId: string,
  entityType: EntityType,
  _depth: number = 2
): Promise<LinkerCandidate[]> {
  try {
    const join = getTwoHopJoin(entityType);
    if (!join) return []; // unsupported/excluded source — no traversal at all

    const floor = getDiscoveryConfig().twoHopConfidenceFloor;
    const hop1Nodes = await getNeighborsByRelation(entityId, join.hop1.relationTypes, {
      direction: join.hop1.direction,
    });

    const candidates: LinkerCandidate[] = [];
    const seen = new Set<string>();
    for (const mid of hop1Nodes) {
      const hop1Conf = hopConfidence(mid);
      const hop2Nodes = await getNeighborsByRelation(mid.id, join.hop2.relationTypes, {
        direction: join.hop2.direction,
      });
      for (const terminal of hop2Nodes) {
        if (terminal.id === entityId || seen.has(terminal.id)) continue;
        const pathConfidence = hop1Conf * hopConfidence(terminal);
        if (pathConfidence < floor) continue; // suppress weak inferences
        seen.add(terminal.id);
        const props = (terminal.properties ?? {}) as Record<string, unknown>;
        candidates.push({
          sourceId: entityId,
          sourceType: entityType,
          sourceName: entityId, // denormalized name resolved by the triage UI from sourceId
          targetId: terminal.id,
          targetType: join.hop2.targetLabel,
          targetName: (props.name as string) ?? (props.title as string) ?? terminal.id,
          relationType: join.proposedRelationType,
          confidence: Math.round(pathConfidence * 100),
          discoveryMethod: 'transitive',
        });
      }
    }
    return candidates;
  } catch (error) {
    log.warn('transitive candidate generation failed', {
      entityId,
      entityType,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
