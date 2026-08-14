/**
 * @file subgraph-rag.ts
 * @description Subgraph context extractor for LLM-facing RAG.
 *
 * Given a focus entity (or a query resolved to one), returns a structured
 * snapshot of the neighborhood:
 *   - center: the focus entity itself
 *   - neighbors: 1-hop typed relations with direction + confidence + claimId
 *   - chunks:   top-K semantically-similar document chunks (cosine)
 *   - claims:   Claim nodes where the entity is subject or object
 *   - temporal: edges changed within the last N days
 *
 * Agent consumers pass this structure as context to the model instead of
 * raw chunks, so the LLM has provenance (claimId → Evidence) and structural
 * context (who connects to whom, how, with what confidence) along with
 * semantic passages.
 *
 * @phase Phase 3: GraphRAG for agents
 */

import { runReadTransaction } from './neo4j-client';
import { currentEdgePredicate } from './current-edge-filter';
import { generateEmbedding } from '@/lib/ai/client';
import { TaskType } from '@/lib/ai/constants';
import { isVectorIndexMissingError, searchEntitiesBySemantic } from './vector-search';
import { GraphUnavailableError } from './errors';
import { sanitizeNeo4jErrorMessage } from './neo4j-sanitize';
import { BUSINESS_ENTITY_GRAPH_LABELS, expandEntityTypes } from './entity-type-vocab';
import {
  businessEntityIdentityCypher,
  businessEntityIdentityParams,
  businessEntityLabelProjection,
  businessEntityTypeScopeCypher,
  graphLabelsForEntityTypes,
} from './business-entity-identity';
import { isRetryableError } from '@/lib/ai/reliability';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/subgraph-rag');

// ============================================================================
// TYPES
// ============================================================================

export interface SubgraphCenter {
  id: string;
  label: string;
  name: string;
  description: string | null;
}

export interface SubgraphNeighbor {
  entity: SubgraphCenter;
  relation: string;
  relationPath?: string[];
  direction: 'out' | 'in';
  distance?: number;
  confidence: number | null;
  claimId: string | null;
  segments?: Array<{
    fromId: string;
    toId: string;
    relationType: string;
    confidence: number | null;
    claimId: string | null;
  }>;
}

export interface SubgraphChunk {
  id: string;
  content: string;
  documentId: string;
  documentTitle: string | null;
  chunkIndex: number | null;
  score: number;
  provenance: 'entity-mention' | 'linked-document-semantic';
}

export interface SubgraphClaim {
  id: string;
  predicate: string;
  subjectName: string;
  objectName: string;
  statement: string;
  confidence: number;
  status: string;
}

export interface SubgraphTemporalEdge {
  relation: string;
  connectedId: string;
  connectedName: string;
  direction: 'out' | 'in';
  t_observed: string;
}

export interface SubgraphContext {
  center: SubgraphCenter;
  neighbors: SubgraphNeighbor[];
  chunks: SubgraphChunk[];
  claims: SubgraphClaim[];
  temporal: SubgraphTemporalEdge[];
  partial?: boolean;
  diagnostics?: SubgraphDiagnostic[];
}

export type SubgraphStage = 'neighbors' | 'chunks.mentions' | 'chunks.semantic' | 'claims' | 'temporal';

export interface SubgraphDiagnostic {
  stage: SubgraphStage;
  code: 'unavailable';
  message: string;
}

export interface ExactGraphEntityCandidate extends SubgraphCenter {
  entityType: string;
}

export type ExactGraphEntityResolution =
  | {
      status: 'resolved';
      matchedBy: 'stable-id' | 'normalized-name';
      entity: ExactGraphEntityCandidate;
      candidates: [];
      candidatesTruncated: false;
    }
  | {
      status: 'ambiguous';
      matchedBy: 'normalized-name';
      entity: null;
      candidates: ExactGraphEntityCandidate[];
      candidatesTruncated: boolean;
    }
  | {
      status: 'not-found';
      matchedBy: null;
      entity: null;
      candidates: [];
      candidatesTruncated: false;
    };

/**
 * A document grounded to a focus entity via graph enumeration (chunk-level
 * MENTIONS aggregated to document, plus doc-level MENTIONS/DOCUMENTED_BY/
 * HAS_EVIDENCE edges) — distinct from `SubgraphChunk`, which is chunk-level.
 */
export interface EntityGroundedDocument {
  documentId: string;
  title: string | null;
  type: string | null;
  mentionCount: number;
  snippets: string[];
  /**
   * GRAPH-064 — how much this grounding is worth. `'machine-generated'` +
   * `'unreviewed'` means the snippets are model output nobody has vouched for;
   * a reader that presents them as established fact is overclaiming.
   */
  sourceProvenance: string | null;
  sourceReviewState: string | null;
}

export interface ExtractSubgraphOptions {
  neighbors?: number;
  chunks?: number;
  claims?: number;
  temporalDays?: number;
  chunkMinScore?: number;
  chunkQuery?: string;
  /** Precomputed RETRIEVAL_QUERY embedding for request-scoped reuse. */
  queryEmbedding?: number[] | Promise<number[]>;
}

interface NormalizedExtractSubgraphOptions {
  neighbors: number;
  chunks: number;
  claims: number;
  temporalDays: number;
  chunkMinScore: number;
  chunkQuery?: string;
  queryEmbedding?: number[] | Promise<number[]>;
}

const DEFAULTS: NormalizedExtractSubgraphOptions = {
  neighbors: 15,
  chunks: 5,
  claims: 10,
  temporalDays: 30,
  chunkMinScore: 0.55,
};

const MAX_EXACT_CANDIDATES = 10;
const DEFAULT_EXACT_CANDIDATES = 5;
const MAX_NEIGHBORS = 25;
const MAX_CHUNKS = 10;
const MAX_CLAIMS = 20;
const MAX_TEMPORAL_DAYS = 365;
const MAX_CHUNK_QUERY_CHARS = 1_000;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function boundedScore(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

/** NFKC + whitespace/case normalization used by the exact-name resolution contract. */
export function normalizeGraphRetrievalName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeOptions(options: ExtractSubgraphOptions): NormalizedExtractSubgraphOptions {
  const chunkQuery = options.chunkQuery?.trim().slice(0, MAX_CHUNK_QUERY_CHARS);
  return {
    neighbors: boundedInteger(options.neighbors, DEFAULTS.neighbors, 0, MAX_NEIGHBORS),
    chunks: boundedInteger(options.chunks, DEFAULTS.chunks, 0, MAX_CHUNKS),
    claims: boundedInteger(options.claims, DEFAULTS.claims, 0, MAX_CLAIMS),
    temporalDays: boundedInteger(options.temporalDays, DEFAULTS.temporalDays, 1, MAX_TEMPORAL_DAYS),
    chunkMinScore: boundedScore(options.chunkMinScore, DEFAULTS.chunkMinScore),
    ...(chunkQuery ? { chunkQuery } : {}),
    ...(options.queryEmbedding ? { queryEmbedding: options.queryEmbedding } : {}),
  };
}

/**
 * AI-026 — the identity envelope every read in this module binds. Sourced from
 * `business-entity-identity` so the exact, semantic and neighborhood lanes can
 * never drift onto different vocabularies.
 */
const graphEntityParams = businessEntityIdentityParams;

function toDiagnostic(stage: SubgraphStage, error: unknown): SubgraphDiagnostic {
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  ) {
    throw error;
  }
  if (error && typeof error === 'object') {
    const code = String((error as { code?: unknown }).code ?? '')
      .toLowerCase()
      .replace(/_/g, '-');
    if (code === '3' || code === 'invalid-argument' || code.endsWith('/invalid-argument')) throw error;
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeNeo4jErrorMessage(error instanceof Error ? error.message : String(error));
  const graphUnavailable = error instanceof GraphUnavailableError;
  const indexUnavailable = isVectorIndexMissingError(error);
  const providerUnavailable = isRetryableError(error) || /Google AI API key not found/.test(rawMessage);
  if (!graphUnavailable && !indexUnavailable && !providerUnavailable) throw error;
  log.warn('Subgraph retrieval lane unavailable', { stage, error: sanitized });
  return {
    stage,
    code: 'unavailable',
    message: graphUnavailable
      ? sanitized
      : indexUnavailable
        ? 'A required graph index is unavailable.'
        : 'The embedding provider is temporarily unavailable.',
  };
}

function quotedFulltextPhrase(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ============================================================================
// CORE
// ============================================================================

/**
 * Extract a subgraph around a focus entity.
 *
 * Returns null if the focus entity is not found in Neo4j.
 */
export async function extractSubgraph(
  focusEntityId: string,
  options: ExtractSubgraphOptions = {}
): Promise<SubgraphContext | null> {
  const opts = normalizeOptions(options);

  const center = await fetchCenter(focusEntityId);
  if (!center) {
    log.debug('extractSubgraph: focus entity not found', { focusEntityId });
    return null;
  }

  const [neighborsResult, chunksResult, claimsResult, temporalResult] = await Promise.allSettled([
    fetchNeighbors(focusEntityId, opts.neighbors),
    fetchTopChunks(center, opts.chunks, opts.chunkMinScore, opts.chunkQuery, opts.queryEmbedding),
    fetchClaims(focusEntityId, opts.claims),
    fetchTemporal(focusEntityId, opts.temporalDays),
  ]);

  const diagnostics: SubgraphDiagnostic[] = [];
  const neighbors = settledValue(neighborsResult, [], 'neighbors', diagnostics);
  const chunkOutcome = settledValue(chunksResult, { chunks: [], diagnostics: [] }, 'chunks.semantic', diagnostics);
  diagnostics.push(...chunkOutcome.diagnostics);
  const claims = settledValue(claimsResult, [], 'claims', diagnostics);
  const temporal = settledValue(temporalResult, [], 'temporal', diagnostics);

  return {
    center,
    neighbors,
    chunks: chunkOutcome.chunks,
    claims,
    temporal,
    ...(diagnostics.length > 0 ? { partial: true, diagnostics } : {}),
  };
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  stage: SubgraphStage,
  diagnostics: SubgraphDiagnostic[]
): T {
  if (result.status === 'fulfilled') return result.value;
  diagnostics.push(toDiagnostic(stage, result.reason));
  return fallback;
}

/**
 * Resolve only deterministic graph identities: stable id first, then one
 * unique normalized exact display name. Partial/fuzzy names are deliberately
 * excluded; semantic fallback belongs to the caller and ambiguity never picks
 * the first row.
 */
export async function resolveExactGraphEntity(
  reference: string,
  options: { candidateLimit?: number; entityTypes?: string[] } = {}
): Promise<ExactGraphEntityResolution> {
  const input = reference?.trim() ?? '';
  if (!input) {
    return {
      status: 'not-found',
      matchedBy: null,
      entity: null,
      candidates: [],
      candidatesTruncated: false,
    };
  }

  const candidateLimit = boundedInteger(options.candidateLimit, DEFAULT_EXACT_CANDIDATES, 1, MAX_EXACT_CANDIDATES);
  const entityTypes = options.entityTypes?.length ? expandEntityTypes(options.entityTypes) : null;
  // Unscoped resolution admits ANY canonical entity label; a requested type
  // narrows to that type's label(s). Passing an empty list when unscoped would
  // make the label branch unsatisfiable and refuse every labelled entity.
  const entityLabels = entityTypes ? graphLabelsForEntityTypes(entityTypes) : [...BUSINESS_ENTITY_GRAPH_LABELS];
  const commonParams = { ...graphEntityParams(), entityTypes, entityLabels };
  // AI-026: identity comes from the node's label set, never from `entityType`
  // alone. A requested type is proven by that type's canonical label, and the
  // property may only stand in for an endpoint placeholder that carries no
  // canonical label at all — which is how an `:AgentObservation` carrying
  // `entityType:'technology'` used to resolve as a Technology. An unmappable
  // requested type leaves `$entityLabels` empty, so the scope fails closed.
  const rowProjection = `
    n.id AS id,
    coalesce(n.name, n.title, n.id) AS name,
    coalesce(n.entityType, ${businessEntityLabelProjection('n')}) AS entityType,
    ${businessEntityLabelProjection('n')} AS label,
    n.description AS description
  `;
  const businessPredicate = `
    ${businessEntityIdentityCypher('n')}
      AND ${businessEntityTypeScopeCypher('n', '$entityLabels', '$entityTypes')}
  `;

  const byId = await runReadTransaction<ExactGraphEntityCandidate>(
    `MATCH (n:Entity {id: $input})
     WHERE ${businessPredicate}
     RETURN ${rowProjection}
     LIMIT 1`,
    { input, ...commonParams }
  );
  if (byId.records[0]) {
    return {
      status: 'resolved',
      matchedBy: 'stable-id',
      entity: byId.records[0],
      candidates: [],
      candidatesTruncated: false,
    };
  }

  // Use the schema-owned fulltext index so normalized lookup is an indexed,
  // bounded candidate read rather than a computed label scan. A quoted phrase
  // narrows the index result; TypeScript then applies the exact NFKC contract.
  const normalizedName = normalizeGraphRetrievalName(input);
  const scanLimit = Math.min(candidateLimit * 4 + 1, MAX_EXACT_CANDIDATES * 4 + 1);
  const byName = await runReadTransaction<ExactGraphEntityCandidate>(
    `CALL db.index.fulltext.queryNodes('entity_name_idx', $fulltextQuery, {limit: $scanLimit})
     YIELD node AS n, score
     WHERE n:Entity
       AND ${businessPredicate}
     RETURN ${rowProjection}, score
     ORDER BY score DESC, toLower(coalesce(n.entityType, '')),
              toLower(coalesce(n.name, n.title, '')), n.id
     LIMIT toInteger($scanLimit)`,
    {
      fulltextQuery: quotedFulltextPhrase(input),
      scanLimit,
      ...commonParams,
    }
  );

  const exactRows = byName.records
    .filter((candidate) => normalizeGraphRetrievalName(candidate.name) === normalizedName)
    .sort(compareExactCandidates);
  const candidateScanTruncated = byName.records.length >= scanLimit;
  if (exactRows.length === 1 && !candidateScanTruncated) {
    return {
      status: 'resolved',
      matchedBy: 'normalized-name',
      entity: exactRows[0],
      candidates: [],
      candidatesTruncated: false,
    };
  }
  if (exactRows.length > 1 || candidateScanTruncated) {
    const candidates = (exactRows.length > 0 ? exactRows : [...byName.records].sort(compareExactCandidates)).slice(
      0,
      candidateLimit
    );
    return {
      status: 'ambiguous',
      matchedBy: 'normalized-name',
      entity: null,
      candidates,
      candidatesTruncated: candidateScanTruncated || exactRows.length > candidateLimit,
    };
  }
  return {
    status: 'not-found',
    matchedBy: null,
    entity: null,
    candidates: [],
    candidatesTruncated: false,
  };
}

/*
 * Kept separate from the fulltext score: ambiguity order is a domain contract,
 * not an implementation detail of a particular Neo4j analyzer version.
 */
function compareExactCandidates(a: ExactGraphEntityCandidate, b: ExactGraphEntityCandidate): number {
  return (
    a.entityType.localeCompare(b.entityType) ||
    normalizeGraphRetrievalName(a.name).localeCompare(normalizeGraphRetrievalName(b.name)) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Resolve a natural-language query to the best-matching entity, then
 * extract a subgraph around it. Returns null if no entity matches above
 * the semantic-search threshold.
 */
export async function extractSubgraphForQuery(
  query: string,
  options: ExtractSubgraphOptions & { resolveMinScore?: number } = {}
): Promise<SubgraphContext | null> {
  const minScore = options.resolveMinScore ?? 0.6;
  const {
    results: hits,
    degraded,
    degradedReason,
    unavailable,
  } = await searchEntitiesBySemantic(query, 'all', { limit: 1, minScore });

  // `null` from this function means one specific thing: no entity matched. A
  // dead graph is not a non-match — it is an unknown — and collapsing the two
  // would make an outage indistinguishable from an empty result for every
  // caller downstream. Fail loud instead.
  if (unavailable) {
    throw new GraphUnavailableError('extractSubgraphForQuery', 'neo4j', degradedReason);
  }

  if (degraded) {
    log.warn('extractSubgraphForQuery: semantic entity search degraded', { query, degradedReason });
  }
  const top = hits[0];
  if (!top) return null;
  return extractSubgraph(top.id, options);
}

// ============================================================================
// SUBQUERIES
// ============================================================================

async function fetchCenter(entityId: string): Promise<SubgraphCenter | null> {
  const cypher = `
    MATCH (n:Entity {id: $entityId})
    WHERE ${businessEntityIdentityCypher('n')}
    WITH n, head([label IN $businessEntityLabels WHERE label IN labels(n)]) AS label
    RETURN n.id AS id, label, n.name AS name, n.description AS description
    LIMIT 1
  `;
  const result = await runReadTransaction<SubgraphCenter>(cypher, { entityId, ...graphEntityParams() });
  return result.records[0] ?? null;
}

async function fetchNeighbors(entityId: string, limit: number): Promise<SubgraphNeighbor[]> {
  if (limit === 0) return [];

  // Use undirected pattern + startNode() check so we get outgoing and
  // incoming edges in a single aggregation-free query. Filter out
  // self-loops and non-Entity nodes.
  const cypher = `
    MATCH (center:Entity {id: $entityId})-[r]-(other)
    WHERE other:Entity
      AND other.id <> $entityId
      AND ${businessEntityIdentityCypher('other')}
      AND ${currentEdgePredicate('r')}
    RETURN other.id AS id,
           head([label IN $businessEntityLabels WHERE label IN labels(other)]) AS label,
           other.name AS name,
           other.description AS description,
           type(r) AS relation,
           [type(r)] AS relationPath,
           CASE WHEN startNode(r) = center THEN 'out' ELSE 'in' END AS direction,
           1 AS distance,
           COALESCE(r.effectiveConfidence, r.confidence) AS confidence,
           r.claimId AS claimId,
           [{
             fromId: startNode(r).id,
             toId: endNode(r).id,
             relationType: type(r),
             confidence: COALESCE(r.effectiveConfidence, r.confidence),
             claimId: r.claimId
           }] AS segments
    ORDER BY coalesce(r.effectiveConfidence, r.confidence, 0) DESC,
             toLower(coalesce(other.name, '')), other.id
    LIMIT toInteger($limit)
  `;
  type Raw = {
    id: string;
    label: string;
    name: string;
    description: string | null;
    relation: string;
    relationPath: string[];
    direction: 'out' | 'in';
    distance: number;
    confidence: number | null;
    claimId: string | null;
    segments: NonNullable<SubgraphNeighbor['segments']>;
  };
  const result = await runReadTransaction<Raw>(cypher, { entityId, limit, ...graphEntityParams() });
  return result.records.map((r) => ({
    entity: { id: r.id, label: r.label, name: r.name, description: r.description },
    relation: r.relation,
    relationPath: r.relationPath,
    direction: r.direction,
    distance: r.distance,
    confidence: r.confidence,
    claimId: r.claimId,
    segments: r.segments,
  }));
}

interface ChunkFetchOutcome {
  chunks: SubgraphChunk[];
  diagnostics: SubgraphDiagnostic[];
}

async function fetchTopChunks(
  center: SubgraphCenter,
  limit: number,
  minScore: number,
  chunkQuery?: string,
  queryEmbedding?: number[] | Promise<number[]>
): Promise<ChunkFetchOutcome> {
  if (limit === 0) return { chunks: [], diagnostics: [] };

  // Hybrid retrieval: union chunks that MENTIONS the center (literal
  // name match — strongest signal, virtual score 1.0) with chunks
  // whose embedding is similar to the user's query (or the center when no
  // query was supplied). The vector lane is restricted to documents with a
  // graph-grounded link to the center. Each lane can degrade independently;
  // direct MENTIONS evidence survives a vector-index/provider outage.
  const [mentionsResult, vectorResult] = await Promise.allSettled([
    fetchChunksByMentions(center.id, limit * 2),
    fetchChunksByVectorSimilarity(center, limit * 2, minScore, chunkQuery, queryEmbedding),
  ]);

  const diagnostics: SubgraphDiagnostic[] = [];
  const mentionsChunks = settledValue(mentionsResult, [], 'chunks.mentions', diagnostics);
  const vectorChunks = settledValue(vectorResult, [], 'chunks.semantic', diagnostics);

  const byId = new Map<string, SubgraphChunk>();
  for (const chunk of [...mentionsChunks, ...vectorChunks]) {
    const existing = byId.get(chunk.id);
    if (!existing || chunk.score > existing.score) byId.set(chunk.id, chunk);
  }

  return {
    chunks: Array.from(byId.values())
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.documentId.localeCompare(b.documentId) ||
          (a.chunkIndex ?? Number.MAX_SAFE_INTEGER) - (b.chunkIndex ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limit),
    diagnostics,
  };
}

async function fetchChunksByMentions(entityId: string, limit: number): Promise<SubgraphChunk[]> {
  const cypher = `
    MATCH (e:Entity {id: $entityId})<-[:MENTIONS]-(c:Chunk)
    WHERE (c.archived = false OR c.archived IS NULL)
    OPTIONAL MATCH (d:Document {id: c.documentId})
    RETURN c.id AS id, c.content AS content,
           c.documentId AS documentId, d.title AS documentTitle,
           c.chunkIndex AS chunkIndex, 1.0 AS score,
           'entity-mention' AS provenance
    ORDER BY coalesce(c.chunkIndex, 0), c.id
    LIMIT toInteger($limit)
  `;
  const result = await runReadTransaction<SubgraphChunk>(cypher, {
    entityId,
    limit,
  });
  return result.records;
}

async function fetchChunksByVectorSimilarity(
  center: SubgraphCenter,
  limit: number,
  minScore: number,
  chunkQuery?: string,
  queryEmbedding?: number[] | Promise<number[]>
): Promise<SubgraphChunk[]> {
  const text = (chunkQuery || [center.name, center.description].filter(Boolean).join('\n\n')).trim();
  if (!text) return [];
  const embedding =
    (queryEmbedding ? await queryEmbedding : undefined) ??
    (await generateEmbedding(text, { taskType: TaskType.RETRIEVAL_QUERY }));

  const cypher = `
    MATCH (center:Entity {id: $entityId})
    CALL db.index.vector.queryNodes('chunk_embedding', toInteger($topK), $embedding)
    YIELD node AS chunk, score
    WHERE score >= $minScore
      AND (chunk.archived = false OR chunk.archived IS NULL)
      AND (
        EXISTS { MATCH (chunk)-[:MENTIONS]->(center) }
        OR EXISTS {
          MATCH (center)-[:MENTIONS|DOCUMENTED_BY|HAS_EVIDENCE]->(linkedDocument:Document)
          WHERE linkedDocument.id = chunk.documentId
        }
      )
    OPTIONAL MATCH (d:Document {id: chunk.documentId})
    RETURN chunk.id AS id, chunk.content AS content,
           chunk.documentId AS documentId, d.title AS documentTitle,
           chunk.chunkIndex AS chunkIndex, score,
           CASE
             WHEN EXISTS { MATCH (chunk)-[:MENTIONS]->(center) } THEN 'entity-mention'
             ELSE 'linked-document-semantic'
           END AS provenance
    ORDER BY score DESC, chunk.documentId, coalesce(chunk.chunkIndex, 0), chunk.id
    LIMIT toInteger($limit)
  `;
  const result = await runReadTransaction<SubgraphChunk>(cypher, {
    entityId: center.id,
    embedding,
    topK: Math.max(limit * 2, 10),
    limit,
    minScore,
  });
  return result.records;
}

async function fetchClaims(entityId: string, limit: number): Promise<SubgraphClaim[]> {
  const cypher = `
    MATCH (c:Assertion)
    WHERE c.subjectId = $entityId OR c.objectId = $entityId
    WITH c
    WHERE coalesce(c.status, 'proposed') <> 'rejected'
    RETURN c.id AS id, c.predicate AS predicate, c.subjectName AS subjectName,
           c.objectName AS objectName, c.statement AS statement,
           COALESCE(c.effectiveConfidence, c.confidence) AS confidence, c.status AS status
    ORDER BY c.createdAt DESC
    LIMIT toInteger($limit)
  `;
  const result = await runReadTransaction<SubgraphClaim>(cypher, { entityId, limit });
  return result.records;
}

async function fetchTemporal(entityId: string, days: number): Promise<SubgraphTemporalEdge[]> {
  // M9: t_observed is written as toString(datetime()) — an ISO STRING.
  // Comparing it to a Cypher datetime() (string > datetime → NULL) matched 0
  // edges, ever. Compare string-vs-string against a JS-computed ISO cutoff,
  // mirroring temporal-queries.ts getChangedSince (`r.t_observed > $since`).
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cypher = `
    MATCH (center:Entity {id: $entityId})
    MATCH (center)-[r]-(other:Entity)
    WHERE r.t_observed IS NOT NULL
      AND r.t_observed > $since
      AND other.id <> $entityId
      AND ${businessEntityIdentityCypher('other')}
      AND ${currentEdgePredicate('r')}
    WITH center, r, other,
         CASE WHEN startNode(r) = center THEN 'out' ELSE 'in' END AS direction
    RETURN type(r) AS relation, other.id AS connectedId,
           other.name AS connectedName, direction,
           toString(r.t_observed) AS t_observed
    ORDER BY r.t_observed DESC
    LIMIT 25
  `;
  const result = await runReadTransaction<SubgraphTemporalEdge>(cypher, {
    entityId,
    since,
    ...graphEntityParams(),
  });
  return result.records;
}

// ============================================================================
// DOCUMENT GROUNDING (Task 13 / A3 — getEntityContext graph enumeration)
// ============================================================================

const DOCUMENT_SNIPPET_MAX_CHARS = 280;

/**
 * Enumerate the distinct documents grounded to an entity via the graph:
 * chunk-level `(Chunk)-[:MENTIONS]->(Entity)` aggregated up to the parent
 * `Document`, unioned with doc-level `(Entity)-[:MENTIONS|DOCUMENTED_BY|
 * HAS_EVIDENCE]->(Document)` edges. This is the document-level sibling of
 * `fetchChunksByMentions` (chunk-level) — it answers "which documents talk
 * about this entity", not "which passages".
 *
 * Ordered by total mention count desc, then document recency desc. Snippets
 * (max 3 per document, sourced from chunk content) are truncated to 280
 * chars TS-side since Cypher's `[0..3]` only bounds the array length.
 *
 * Logs and rethrows on a read failure — callers decide the fallback.
 */
export async function fetchDocumentsForEntity(
  entityId: string,
  options: { limit?: number } = {}
): Promise<EntityGroundedDocument[]> {
  const limit = options.limit ?? 5;
  const cypher = `
    CALL {
      MATCH (ch:Chunk)-[:MENTIONS]->(:Entity { id: $entityId })
      WHERE ch.archived = false OR ch.archived IS NULL
      MATCH (d:Document { id: ch.documentId })
      WITH d, count(ch) AS mentionCount, collect(ch.content)[0..3] AS snippets
      RETURN d, mentionCount, snippets
      UNION ALL
      MATCH (:Entity { id: $entityId })-[r:MENTIONS|DOCUMENTED_BY|HAS_EVIDENCE]->(d:Document)
      RETURN d, 1 AS mentionCount, [] AS snippets
    }
    WITH d, sum(mentionCount) AS mentions,
         reduce(acc = [], s IN collect(snippets) | acc + s)[0..3] AS snippets
    RETURN d.id AS documentId, d.title AS title, d.type AS type, mentions AS mentionCount, snippets,
           d.contentProvenance AS sourceProvenance,
           CASE WHEN coalesce(d.contentReviewedAt, 0) > 0 THEN 'reviewed' ELSE 'unreviewed' END AS sourceReviewState
    ORDER BY mentions DESC, coalesce(d.updatedAt, 0) DESC
    LIMIT toInteger($limit)
  `;
  try {
    const result = await runReadTransaction<EntityGroundedDocument>(cypher, { entityId, limit });
    return result.records.map((record) => ({
      ...record,
      snippets: (record.snippets ?? []).map((snippet) => snippet.slice(0, DOCUMENT_SNIPPET_MAX_CHARS)),
    }));
  } catch (error) {
    log.error('fetchDocumentsForEntity failed', error instanceof Error ? error : new Error(String(error)), {
      entityId,
      limit,
    });
    throw error;
  }
}
