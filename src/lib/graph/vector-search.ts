/**
 * @file lib/graph/vector-search.ts
 * @description Vector search functions for semantic document retrieval.
 *
 * Uses Neo4j's vector index to find chunks similar to a query embedding.
 * Supports filtering by document ID, entity links, and more.
 *
 * **Prerequisites:**
 * - Neo4j vector index created (see src/lib/graph/schema-manifest.ts)
 * - Chunks synced to Neo4j with embeddings (via sync-document-to-neo4j)
 *
 * @phase Knowledge Tab Sprint - Phase 1.5
 * @author Radarist Team
 * @created 2026-01-14
 */

import { runReadTransaction } from './neo4j-client';
import { GraphUnavailableError } from './errors';
import {
  businessEntityIdentityCypher,
  businessEntityIdentityParams,
  businessEntityLabelScopeCypher,
  graphLabelsForEntityTypes,
} from './business-entity-identity';
import { generateEmbedding } from '@/lib/ai/client';
import { TaskType } from '@/lib/ai/constants';
import { createLogger } from '@/lib/logger';
import neo4j from 'neo4j-driver';

const log = createLogger('graph/vector-search');

const MAX_VECTOR_RESULTS = 50;
const MAX_ENTITY_SEMANTIC_RESULTS = 25;
const MAX_RETRIEVAL_QUERY_CHARS = 1_000;

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function boundedScore(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

function boundedRetrievalQuery(query: string): string {
  return query.trim().slice(0, MAX_RETRIEVAL_QUERY_CHARS);
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result from vector similarity search
 */
export interface VectorSearchResult {
  /** Chunk ID */
  chunkId: string;
  /** Parent document ID */
  documentId: string;
  /** Chunk content text */
  content: string;
  /** Chunk index within document */
  chunkIndex: number;
  /** Cosine similarity score (0-1, higher is more similar) */
  score: number;
  /** Parent document title */
  documentTitle?: string;
  /** Parent document type */
  documentType?: string;
  /** Whether chunk is archived */
  archived?: boolean;
}

/**
 * Options for vector search
 */
export interface VectorSearchOptions {
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Minimum similarity score threshold (0-1, default: 0.5) */
  minScore?: number;
  /** Filter to specific document IDs */
  documentIds?: string[];
  /** Filter to documents linked to specific entity IDs */
  entityIds?: string[];
  /** Whether to include archived chunks (default: false) */
  includeArchived?: boolean;
  /** Workspace ID filter (default: 'default') */
  workspaceId?: string;
  /** Precomputed RETRIEVAL_QUERY embedding for request-scoped reuse. */
  queryEmbedding?: number[] | Promise<number[]>;
}

/**
 * Options for hybrid search (vector + keyword)
 */
export interface HybridSearchOptions extends VectorSearchOptions {
  /** Weight for vector search (0-1, default: 0.7) */
  vectorWeight?: number;
  /** Keywords to boost in results */
  keywords?: string[];
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/**
 * Vector similarity search using Neo4j's vector index
 * Returns chunks ordered by cosine similarity
 */
const VECTOR_SEARCH_QUERY = `
  CALL db.index.vector.queryNodes('chunk_embedding', $topK, $embedding)
  YIELD node AS chunk, score
  WHERE score >= $minScore
    AND ($includeArchived OR chunk.archived = false OR chunk.archived IS NULL)
    AND ($documentIds IS NULL OR chunk.documentId IN $documentIds)
    AND ($workspaceId IS NULL OR EXISTS {
      MATCH (d:Document {id: chunk.documentId})
      WHERE d.workspaceId = $workspaceId
    })
  WITH chunk, score
  OPTIONAL MATCH (d:Document {id: chunk.documentId})
  RETURN
    chunk.id AS chunkId,
    chunk.documentId AS documentId,
    chunk.content AS content,
    chunk.chunkIndex AS chunkIndex,
    score,
    d.title AS documentTitle,
    d.type AS documentType,
    chunk.archived AS archived
  ORDER BY score DESC
  LIMIT $limit
`;

/**
 * Vector search with entity filter
 * Only returns chunks from documents linked to specified entities
 *
 * Matches multiple relationship types for entity-document links:
 * - MENTIONS: Legacy/general entity mentions
 * - DOCUMENTED_BY: Document serves as documentation for entity
 * - HAS_EVIDENCE: Document provides evidence for entity
 */
const VECTOR_SEARCH_WITH_ENTITY_FILTER = `
  CALL db.index.vector.queryNodes('chunk_embedding', $topK, $embedding)
  YIELD node AS chunk, score
  WHERE score >= $minScore
    AND ($includeArchived OR chunk.archived = false OR chunk.archived IS NULL)
  WITH chunk, score
  MATCH (d:Document {id: chunk.documentId})
  WHERE EXISTS {
    MATCH (e:Entity)-[:MENTIONS|DOCUMENTED_BY|HAS_EVIDENCE]->(d)
    WHERE e.id IN $entityIds
  }
  AND ($workspaceId IS NULL OR d.workspaceId = $workspaceId)
  RETURN
    chunk.id AS chunkId,
    chunk.documentId AS documentId,
    chunk.content AS content,
    chunk.chunkIndex AS chunkIndex,
    score,
    d.title AS documentTitle,
    d.type AS documentType,
    chunk.archived AS archived
  ORDER BY score DESC
  LIMIT $limit
`;

/**
 * Find documents that contain chunks similar to query
 * Aggregates chunks by document with average score
 */
const FIND_SIMILAR_DOCUMENTS = `
  CALL db.index.vector.queryNodes('chunk_embedding', $topK, $embedding)
  YIELD node AS chunk, score
  WHERE score >= $minScore
    AND ($includeArchived OR chunk.archived = false OR chunk.archived IS NULL)
  WITH chunk.documentId AS docId,
       avg(score) AS avgScore,
       count(*) AS matchingChunks,
       max(score) AS maxScore,
       collect({content: chunk.content, score: score, chunkIndex: chunk.chunkIndex})[0..3] AS topChunks
  MATCH (d:Document {id: docId})
  WHERE $workspaceId IS NULL OR d.workspaceId = $workspaceId
  RETURN
    d.id AS documentId,
    d.title AS title,
    d.type AS type,
    d.domain AS domain,
    avgScore,
    maxScore,
    matchingChunks,
    topChunks
  ORDER BY maxScore DESC
  LIMIT $limit
`;

// ============================================================================
// SEARCH FUNCTIONS
// ============================================================================

/**
 * Perform semantic vector search for chunks similar to query text.
 *
 * @param query - The text query to search for
 * @param options - Search options (limit, filters, etc.)
 * @returns Array of matching chunks with similarity scores
 *
 * @example
 * ```typescript
 * const results = await searchChunksByText('machine learning optimization', {
 *   limit: 5,
 *   minScore: 0.7,
 * });
 * ```
 */
export async function searchChunksByText(
  query: string,
  options: VectorSearchOptions = {}
): Promise<VectorSearchResult[]> {
  const {
    limit: rawLimit = 10,
    minScore = 0.5,
    documentIds,
    entityIds,
    includeArchived = false,
    workspaceId,
    queryEmbedding,
  } = options;

  // Ensure limit is an integer - Neo4j LIMIT requires integers
  const limit = boundedLimit(rawLimit, 10, MAX_VECTOR_RESULTS);
  const boundedMinScore = boundedScore(minScore, 0.5);
  const boundedQuery = boundedRetrievalQuery(query);
  if (!boundedQuery) return [];

  // Generate embedding for query
  // Use RETRIEVAL_QUERY task type for queries (vs RETRIEVAL_DOCUMENT for documents)
  const embedding =
    (queryEmbedding ? await queryEmbedding : undefined) ??
    (await generateEmbedding(boundedQuery, {
      taskType: TaskType.RETRIEVAL_QUERY,
    }));

  // Choose query based on entity filter
  const cypherQuery = entityIds?.length ? VECTOR_SEARCH_WITH_ENTITY_FILTER : VECTOR_SEARCH_QUERY;

  const result = await runReadTransaction<VectorSearchResult>(cypherQuery, {
    embedding,
    topK: neo4j.int(Math.floor(limit * 2)), // Query more than needed since we filter
    limit: neo4j.int(limit),
    minScore: boundedMinScore,
    documentIds: documentIds?.length ? documentIds : null,
    entityIds: entityIds?.length ? entityIds : null,
    includeArchived,
    workspaceId: workspaceId || null,
  });

  return result.records;
}

/**
 * Perform semantic search using a pre-computed embedding.
 * Useful when you already have the query embedding.
 *
 * @param embedding - The 768-dimensional embedding vector
 * @param options - Search options (limit, filters, etc.)
 * @returns Array of matching chunks with similarity scores
 */
export async function searchChunksByEmbedding(
  embedding: number[],
  options: VectorSearchOptions = {}
): Promise<VectorSearchResult[]> {
  const {
    limit: rawLimit = 10,
    minScore = 0.5,
    documentIds,
    entityIds,
    includeArchived = false,
    workspaceId,
  } = options;

  // Ensure limit is an integer - Neo4j LIMIT requires integers
  const limit = boundedLimit(rawLimit, 10, MAX_VECTOR_RESULTS);
  const boundedMinScore = boundedScore(minScore, 0.5);

  // Choose query based on entity filter
  const cypherQuery = entityIds?.length ? VECTOR_SEARCH_WITH_ENTITY_FILTER : VECTOR_SEARCH_QUERY;

  const result = await runReadTransaction<VectorSearchResult>(cypherQuery, {
    embedding,
    topK: neo4j.int(Math.floor(limit * 2)),
    limit: neo4j.int(limit),
    minScore: boundedMinScore,
    documentIds: documentIds?.length ? documentIds : null,
    entityIds: entityIds?.length ? entityIds : null,
    includeArchived,
    workspaceId: workspaceId || null,
  });

  return result.records;
}

/**
 * Result from document similarity search
 */
export interface DocumentSimilarityResult {
  /** Document ID */
  documentId: string;
  /** Document title */
  title: string;
  /** Document type */
  type: string;
  /** Extracted domain */
  domain?: string;
  /** Average similarity score across matching chunks */
  avgScore: number;
  /** Maximum similarity score among chunks */
  maxScore: number;
  /** Number of chunks that matched */
  matchingChunks: number;
  /** Top matching chunks with scores */
  topChunks: Array<{
    content: string;
    score: number;
    chunkIndex: number;
  }>;
}

/**
 * Find documents similar to a query text.
 * Aggregates chunk-level similarities to document level.
 *
 * @param query - The text query to search for
 * @param options - Search options (limit, filters, etc.)
 * @returns Array of documents with similarity scores
 *
 * @example
 * ```typescript
 * const docs = await findSimilarDocuments('AI ethics guidelines', {
 *   limit: 5,
 *   minScore: 0.6,
 * });
 * ```
 */
export async function findSimilarDocuments(
  query: string,
  options: VectorSearchOptions = {}
): Promise<DocumentSimilarityResult[]> {
  const { limit: rawLimit = 10, minScore = 0.5, includeArchived = false, workspaceId } = options;

  // Ensure limit is an integer - Neo4j LIMIT requires integers
  const limit = boundedLimit(rawLimit, 10, MAX_VECTOR_RESULTS);
  const boundedMinScore = boundedScore(minScore, 0.5);
  const boundedQuery = boundedRetrievalQuery(query);
  if (!boundedQuery) return [];

  // Generate embedding for query
  const embedding = await generateEmbedding(boundedQuery, {
    taskType: TaskType.RETRIEVAL_QUERY,
  });

  const result = await runReadTransaction<DocumentSimilarityResult>(FIND_SIMILAR_DOCUMENTS, {
    embedding,
    topK: neo4j.int(Math.floor(limit * 10)), // Query more chunks for better document aggregation
    limit: neo4j.int(limit),
    minScore: boundedMinScore,
    includeArchived,
    workspaceId: workspaceId || null,
  });

  return result.records;
}

/**
 * Get chunks from a specific document.
 * Useful for browsing/exploring document content.
 *
 * @param documentId - Document to get chunks for
 * @param options - Options for filtering
 * @returns Array of chunks ordered by chunk index
 */
export async function getDocumentChunks(
  documentId: string,
  options: { includeArchived?: boolean } = {}
): Promise<
  Array<{
    chunkId: string;
    content: string;
    chunkIndex: number;
    archived: boolean;
    documentVersion: number;
  }>
> {
  const { includeArchived = false } = options;

  const query = `
    MATCH (c:Chunk {documentId: $documentId})
    WHERE $includeArchived OR c.archived = false OR c.archived IS NULL
    RETURN
      c.id AS chunkId,
      c.content AS content,
      c.chunkIndex AS chunkIndex,
      coalesce(c.archived, false) AS archived,
      coalesce(c.documentVersion, 1) AS documentVersion
    ORDER BY c.chunkIndex ASC
  `;

  const result = await runReadTransaction<{
    chunkId: string;
    content: string;
    chunkIndex: number;
    archived: boolean;
    documentVersion: number;
  }>(query, { documentId, includeArchived });

  return result.records;
}

/**
 * Check if vector search index exists and is ready
 */
export async function checkVectorIndexStatus(): Promise<{
  exists: boolean;
  ready: boolean;
  populationPercent?: number;
  error?: string;
}> {
  try {
    const result = await runReadTransaction<{
      name: string;
      state: string;
      populationPercent: number;
    }>(
      `
      SHOW INDEXES
      WHERE name = 'chunk_embedding'
      RETURN name, state, populationPercent
      `
    );

    if (result.records.length === 0) {
      return { exists: false, ready: false };
    }

    const indexInfo = result.records[0];
    const ready = indexInfo.state === 'ONLINE';

    return {
      exists: true,
      ready,
      populationPercent: indexInfo.populationPercent,
    };
  } catch (error) {
    return {
      exists: false,
      ready: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// ENTITY SEMANTIC SEARCH (Phase 2)
// ============================================================================

export type EntitySearchLabel = 'Technology' | 'Company' | 'Signal' | 'all';

export interface SemanticEntityResult {
  id: string;
  label: 'Technology' | 'Company' | 'Signal';
  name: string;
  description: string | null;
  score: number;
}

export interface SemanticEntitySearchOptions {
  limit?: number;
  minScore?: number;
  /** Precomputed RETRIEVAL_QUERY embedding for request-scoped reuse. */
  queryEmbedding?: number[] | Promise<number[]>;
}

/**
 * Envelope for semantic entity search. `degraded: true` means at least one
 * vector index (or the graph backend itself) was unavailable — the (partial
 * or empty) `results` are NOT evidence that nothing matched, and callers at
 * tool boundaries should surface `degradedReason` instead of presenting an
 * empty list as a real answer.
 */
export interface SemanticEntitySearchResult {
  results: SemanticEntityResult[];
  degraded: boolean;
  degradedReason?: string;
  /**
   * True when the degradation is the graph backend being *unreachable*, as
   * opposed to a vector index that simply hasn't been built yet.
   *
   * The two are not interchangeable and callers must not treat them alike. A
   * missing index on a fresh graph is a real, quiet degradation — there are
   * genuinely no results to return, and `{ results: [], degraded: true }` says
   * so honestly. A dead backend is *unknown*, not empty; a caller that reports
   * it as "no matches" has fabricated an answer. Consumers fail loud on this
   * flag (see subgraph-rag + findEntitiesByMeaning).
   */
  unavailable: boolean;
}

const ENTITY_INDEX_BY_LABEL: Record<'Technology' | 'Company' | 'Signal', string> = {
  Technology: 'technology_embedding',
  Company: 'company_embedding',
  Signal: 'signal_embedding',
};

/**
 * True for Neo4j's "the vector index you queried does not exist" failures
 * (e.g. `There is no such vector schema index: technology_embedding` /
 * `Neo.ClientError.Schema.IndexNotFound`). These mean the P2 schema init has
 * not run against this graph — a controlled degradation, not a bug.
 */
export function isVectorIndexMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such (vector |fulltext )?(schema )?index|IndexNotFound|index .* (does not exist|not found)/i.test(message);
}

/**
 * Semantic search across Technology / Company / Signal nodes.
 *
 * Embeds the query text once (RETRIEVAL_QUERY task type — asymmetric to the
 * RETRIEVAL_DOCUMENT vectors written by embedEntity), then calls
 * db.index.vector.queryNodes against technology_embedding /
 * company_embedding / signal_embedding. Results are merged and re-sorted by
 * score so callers get a single ranked list.
 *
 * Graceful degradation (honest, not silent): a missing vector index does not
 * throw — that per-index query contributes no results and the envelope comes
 * back with `degraded: true` + `degradedReason`. An un-backfilled graph with a
 * healthy index genuinely returns `{ results: [], degraded: false }` until
 * an operator populates embeddings. Unexpected infrastructure errors still
 * throw.
 *
 * An unreachable backend ({@link GraphUnavailableError}) also comes back in the
 * envelope, but flagged `unavailable: true` — it is NOT the same thing as an
 * empty result and callers must not render it as one. See the field docs on
 * {@link SemanticEntitySearchResult.unavailable}.
 */
export async function searchEntitiesBySemantic(
  query: string,
  label: EntitySearchLabel = 'all',
  options: SemanticEntitySearchOptions = {}
): Promise<SemanticEntitySearchResult> {
  const limit = boundedLimit(options.limit, 10, MAX_ENTITY_SEMANTIC_RESULTS);
  const minScore = boundedScore(options.minScore, 0.5);
  const boundedQuery = boundedRetrievalQuery(query);
  if (!boundedQuery) {
    return { results: [], degraded: false, unavailable: false };
  }

  const embedding =
    (options.queryEmbedding ? await options.queryEmbedding : undefined) ??
    (await generateEmbedding(boundedQuery, { taskType: TaskType.RETRIEVAL_QUERY }));

  const labels: Array<'Technology' | 'Company' | 'Signal'> =
    label === 'all' ? ['Technology', 'Company', 'Signal'] : [label];

  const perLabel = await Promise.all(labels.map((lbl) => queryOneEntityIndex(lbl, embedding, limit, minScore)));

  const degradedReasons = perLabel.map((r) => r.degradedReason).filter((r): r is string => Boolean(r));

  const byId = new Map<string, SemanticEntityResult>();
  for (const candidate of perLabel.flatMap((result) => result.results)) {
    const existing = byId.get(candidate.id);
    if (!existing || compareSemanticCandidates(candidate, existing) < 0) {
      byId.set(candidate.id, candidate);
    }
  }

  return {
    results: [...byId.values()].sort(compareSemanticCandidates).slice(0, limit),
    degraded: degradedReasons.length > 0,
    ...(degradedReasons.length > 0 ? { degradedReason: degradedReasons.join('; ') } : {}),
    unavailable: perLabel.some((r) => r.unavailable),
  };
}

function compareSemanticCandidates(a: SemanticEntityResult, b: SemanticEntityResult): number {
  return (
    b.score - a.score ||
    a.label.localeCompare(b.label) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  );
}

async function queryOneEntityIndex(
  label: 'Technology' | 'Company' | 'Signal',
  embedding: number[],
  limit: number,
  minScore: number
): Promise<{ results: SemanticEntityResult[]; degradedReason?: string; unavailable: boolean }> {
  const indexName = ENTITY_INDEX_BY_LABEL[label];
  // AI-026: the vector index is declared FOR (n:<label>), but the identity
  // predicate is applied anyway and pinned to that exact canonical label
  // (`$targetLabels`) rather than the broad allow-list. A node that acquired the
  // index's label while also carrying a bookkeeping label is then refused here
  // instead of being trusted because the index returned it.
  const cypher = `
    CALL db.index.vector.queryNodes($indexName, toInteger($topK), $embedding)
    YIELD node AS n, score
    WHERE score >= $minScore
      AND ${businessEntityIdentityCypher('n')}
      AND ${businessEntityLabelScopeCypher('n', '$targetLabels')}
    RETURN n.id AS id, n.name AS name, n.description AS description, score
    ORDER BY score DESC, toLower(coalesce(n.name, '')), n.id
    LIMIT toInteger($limit)
  `;

  try {
    const result = await runReadTransaction<{
      id: string;
      name: string;
      description: string | null;
      score: number;
    }>(cypher, {
      indexName,
      topK: Math.max(limit * 2, 20),
      embedding,
      minScore,
      limit,
      targetLabels: graphLabelsForEntityTypes([label]),
      ...businessEntityIdentityParams(),
    });

    return {
      results: result.records.map((r) => ({
        id: r.id,
        label,
        name: r.name,
        description: r.description,
        score: r.score,
      })),
      unavailable: false,
    };
  } catch (err) {
    if (
      err instanceof TypeError ||
      err instanceof ReferenceError ||
      err instanceof SyntaxError ||
      err instanceof RangeError
    ) {
      throw err;
    }
    if (err && typeof err === 'object') {
      const code = String((err as { code?: unknown }).code ?? '')
        .toLowerCase()
        .replace(/_/g, '-');
      if (code === '3' || code === 'invalid-argument' || code.endsWith('/invalid-argument')) throw err;
    }
    if (err instanceof GraphUnavailableError || isVectorIndexMissingError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Semantic entity index unavailable — degrading honestly', { label, indexName, error: message });
      return {
        results: [],
        degradedReason: `${indexName} unavailable: ${message}`,
        unavailable: err instanceof GraphUnavailableError,
      };
    }
    throw err;
  }
}
