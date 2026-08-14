/**
 * @file ai/tools/knowledge-tools.ts
 * @description AI tools for Knowledge Graph search and entity context retrieval
 *
 * - Hybrid search combining vector (semantic) + graph (structural) results
 * - Entity context retrieval with configurable depth
 * - Citation formatting for LLM responses
 *
 * @author Radarist Team
 * @created 2026-01-14
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { generateEmbedding } from '@/lib/ai/client';
import { TaskType } from '@/lib/ai/constants';
import { isRetryableError } from '@/lib/ai/reliability';
import {
  // Vector search
  searchChunksByText,
  findSimilarDocuments,
  type VectorSearchResult,
  // Graph traversal
  fetchDocumentsForEntity,
  getNeighbors,
  getEntity,
  GraphUnavailableError,
  // Business-entity identity (AI-026)
  businessEntityGraphType,
  // Entity semantic search (P5-C / H8)
  searchEntitiesBySemantic,
  type EntitySearchLabel,
  type SemanticEntityResult,
} from '@/lib/graph';
import { isVectorIndexMissingError } from '@/lib/graph/vector-search';
import { retrieveGraphFirst, type GraphFirstRetrievalResult } from '@/lib/ai/retrieval/graph-first-retrieval';
import { sanitizeNeo4jErrorMessage } from '@/lib/graph/neo4j-sanitize';
import { adminGetConcepts, adminGetConceptById } from '@/lib/concept-admin';
import type { Concept, TransformationEntityType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { getEntityUrl } from '@/lib/entity-links';

const log = createLogger('ai/knowledge-tools');

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Parameters for knowledge graph search
 */
export interface KnowledgeSearchParams {
  /** The search query text */
  query: string;
  /** Entity types to include (default: all) */
  entityTypes?: TransformationEntityType[];
  /** Maximum results to return (default: 20) */
  maxResults?: number;
  /** Minimum similarity score for vector results (default: 0.5) */
  minScore?: number;
  /** Include document chunks in results */
  includeChunks?: boolean;
  /** Include concepts in results */
  includeConcepts?: boolean;
  /** Include direct business relationships in results (default: true) */
  includeGraphPaths?: boolean;
}

/**
 * A matched entity from the knowledge graph
 */
export interface KnowledgeEntity {
  id: string;
  name: string;
  type: string;
  description?: string;
  score: number;
  source: 'graph' | 'vector' | 'concept';
}

/**
 * A matched document chunk
 */
export interface KnowledgeChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  chunkIndex: number;
  /** Why this chunk is in context; keeps the passage traceable to its retrieval lane. */
  provenance?: 'entity-mention' | 'linked-document-semantic' | 'query-semantic';
  /** Focus entity that grounded the chunk, when applicable. */
  focusEntityId?: string;
  /** True when content was clipped to the tool's per-passage context bound. */
  truncated?: boolean;
}

/**
 * A matched concept
 */
export interface KnowledgeConcept {
  id: string;
  name: string;
  slug: string;
  type: string;
  entityCount: number;
  score: number;
}

/** A direct relationship in the resolved entity's bounded business neighborhood. */
export interface KnowledgeGraphPath {
  from: { id: string; name: string; type: string };
  to: { id: string; name: string; type: string };
  /** Direction of the edge relative to the resolved focus entity. */
  direction: 'outgoing' | 'incoming';
  /** Real relationship type from Neo4j (e.g., 'USES', 'VENDOR', 'SOLVES') — no longer hardcoded 'RELATED_TO' */
  relation: string;
  /** Always 1 for searchKnowledgeGraph's bounded neighborhood. */
  distance: number;
  /** Per-edge evidence for the direct relationship. */
  segments?: Array<{
    fromId: string;
    toId: string;
    relationType: string;
    confidence?: number;
    claimId?: string;
    curated?: boolean;
  }>;
  /** Assertion/evidence identifier carried by the relationship, when present. */
  claimId?: string;
  /** Minimum confidence across all edges in the path */
  pathConfidence?: number;
  /** Legacy discriminator retained for response compatibility. */
  source: 'pathfinding' | 'neighbors';
}

export interface KnowledgeClaim {
  id: string;
  predicate: string;
  subjectName: string;
  objectName: string;
  statement: string;
  confidence: number;
  status: string;
}

export interface KnowledgeSearchDiagnostic {
  stage: string;
  code: string;
  message: string;
}

/**
 * Result from knowledge graph search
 */
export interface KnowledgeSearchResult {
  /** Matched entities */
  entities: KnowledgeEntity[];
  /** Matched document chunks (if includeChunks) */
  chunks: KnowledgeChunk[];
  /** Matched concepts (if includeConcepts) */
  /** Task 0.14: Graph provenance — which backend answered this query */
  graphMode?: 'neo4j' | 'firestore-fallback' | 'mock' | 'unavailable';
  /** Task 0.14: Why graph is degraded (only set when not neo4j) */
  graphModeReason?: string;
  /** Task 0.14: Max hops available (6 for neo4j, 2 for firestore-fallback) */
  maxHopsAvailable?: number;
  concepts: KnowledgeConcept[];
  /** Bounded direct relationships for the uniquely resolved focus entity. */
  graphPaths: KnowledgeGraphPath[];
  /** Assertion context attached to the uniquely resolved entity. */
  claims: KnowledgeClaim[];
  /** Deterministic entity resolution result; ambiguous candidates never imply selection. */
  resolution: GraphFirstRetrievalResult['resolution'];
  /** Overall graph-first plan state. */
  retrievalStatus: GraphFirstRetrievalResult['status'];
  /** True when any requested retrieval lane could not complete. */
  partial: boolean;
  /** Ordered plan receipt suitable for explaining which fallback ran. */
  retrievalPlan: GraphFirstRetrievalResult['plan'];
  /** Honest bounded-outage/coverage diagnostics. */
  diagnostics: KnowledgeSearchDiagnostic[];
  /** Effective hard limits used for the graph-first portion. */
  retrievalBounds: GraphFirstRetrievalResult['bounds'];
  /** Total primary response items: entities + chunks + concepts, each counted once. */
  totalResults: number;
  /** Search execution time in ms */
  executionTimeMs: number;
}

/**
 * Parameters for entity context retrieval
 */
export interface EntityContextParams {
  /** Entity ID to get context for */
  entityId: string;
  /** Traversal depth (1-3 hops, default: 2) */
  depth?: number;
  /** Include related document chunks */
  includeDocuments?: boolean;
  /** Include linked concepts */
  includeConcepts?: boolean;
  /** Maximum relationships to return */
  maxRelationships?: number;
}

/**
 * A relationship in entity context
 */
export interface EntityRelationship {
  targetId: string;
  targetName: string;
  targetType: string;
  relationType: string;
  direction: 'outgoing' | 'incoming';
  distance: number;
}

/**
 * A document reference in entity context
 */
export interface EntityDocument {
  documentId: string;
  title: string;
  type: string;
  relevantChunks: Array<{
    content: string;
    chunkIndex: number;
  }>;
  /**
   * Which lane produced this document: `'graph'` for real
   * MENTIONS/DOCUMENTED_BY/HAS_EVIDENCE graph edges (fetchDocumentsForEntity),
   * `'vector'` for the name-similarity fallback. Optional for backward
   * compatibility with any pre-existing consumers.
   */
  source?: 'graph' | 'vector';
  /** Total mention count across chunk + doc-level edges (graph lane only). */
  mentionCount?: number;
  /**
   * GRAPH-064 — whether this grounding is human-vouched. `'unreviewed'` on a
   * `'machine-generated'` source means the snippets are this system's own model
   * output; the answer must not present them as established fact.
   */
  sourceProvenance?: string;
  sourceReviewState?: string;
}

/**
 * Result from entity context retrieval
 */
export interface EntityContextResult {
  /** The entity details */
  entity: {
    id: string;
    name: string;
    type: string;
    description?: string;
    properties: Record<string, unknown>;
  } | null;
  /** Related entities by relationship */
  relationships: EntityRelationship[];
  /** Linked concepts */
  concepts: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  /** Related documents */
  documents: EntityDocument[];
  /** Summary statistics */
  stats: {
    totalRelationships: number;
    totalConcepts: number;
    totalDocuments: number;
  };
}

/**
 * Result from semantic entity search (findEntitiesByMeaning)
 */
export interface FindEntitiesByMeaningResult {
  /** Ranked entity matches (cosine similarity, highest first) */
  matches: SemanticEntityResult[];
  /** Number of matches returned */
  totalResults: number;
  /**
   * True when at least one entity vector index (or the graph backend) was
   * unavailable — an empty `matches` is then NOT evidence that nothing
   * matched. Surface this to the user instead of answering "no results".
   */
  degraded: boolean;
  /** Why the search is degraded (only set when degraded=true) */
  degradedReason?: string;
}

/**
 * A formatted citation for LLM responses
 */
export interface Citation {
  id: string;
  type: 'document' | 'entity' | 'chunk';
  title: string;
  excerpt?: string;
  url?: string;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const KNOWLEDGE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'searchKnowledgeGraph',
    description: `Search the knowledge base with deterministic graph-first entity resolution plus independent document and concept search. Use this as the primary read tool for facts, entity relationships, supporting passages, and open-topic research.

WHEN TO USE THIS TOOL:
- "What do we know about [topic]?" - comprehensive knowledge lookup
- "Find everything related to [subject]"
- "Search for [term] across all our data"
- Open-ended research questions about any topic
- When user needs information from multiple sources (documents, entities, concepts)

SEARCH MODES COMBINED:
1. Entity resolution: stable ID, unique normalized exact name, then bounded semantic fallback
2. Business context: one-hop relationships, assertions, and graph-grounded passages only after unique resolution
3. Topic search: independent semantic document passages and taxonomic concepts, including when no entity resolves

Semantic entity indexes cover Technology, Company, and Signal. Broader or unfiltered semantic fallback returns partial candidates and never auto-selects one as globally unique.

EXAMPLE - Basic search:
{
  "query": "artificial intelligence in healthcare"
}

EXAMPLE - Focused search:
{
  "query": "container orchestration",
  "entityTypes": ["technology", "company"],
  "maxResults": 30,
  "includeChunks": true,
  "includeConcepts": true
}

EXAMPLE - Direct business relationships:
{
  "query": "digital transformation strategy",
  "includeGraphPaths": true
}

RETURNS:
- entities: Matched companies, technologies, use cases, etc.
- chunks: Relevant document passages with source info
- concepts: Taxonomic concepts (categories, topics)
- graphPaths: Bounded direct relationships for the uniquely resolved focus entity
- claims: Assertion/evidence context for the uniquely resolved focus entity
- resolution/retrievalPlan/diagnostics: Explicit fallback and ambiguity receipt

WHEN TO USE OTHER TOOLS INSTEAD:
- Full details for a known stable entity ID → getEntityDetails or getEntityContext
- Document content search → searchDocuments
- Graph queries → generateCypher
- Company/technology details → specific entity tools`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query - natural language question or keywords. Be specific for better results.',
        },
        entityTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Filter exact resolution by: 'technology', 'company', 'useCase', 'prototype', 'strategy', 'signal', 'org_unit', 'initiative', 'pain_point'. Semantic auto-selection is complete only when every requested type is indexed: technology, company, or signal.",
        },
        maxResults: {
          type: SchemaType.NUMBER,
          description: 'Max results per category (default: 20, max: 50). Increase for comprehensive research.',
        },
        includeChunks: {
          type: SchemaType.BOOLEAN,
          description: 'Include document chunks in results (default: true). Set false if only entities needed.',
        },
        includeConcepts: {
          type: SchemaType.BOOLEAN,
          description: 'Include taxonomic concepts (default: true). Useful for categorical understanding.',
        },
        includeGraphPaths: {
          type: SchemaType.BOOLEAN,
          description: "Include the resolved entity's bounded one-hop business relationships (default: true).",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'getEntityContext',
    description: `Get comprehensive context for a specific entity including all its relationships, linked concepts, and supporting documents. Use this for deep dives into a single entity.

WHEN TO USE THIS TOOL:
- "Tell me everything about [entity]"
- "What's connected to [entity]?"
- "Give me the full context on [entity]"
- "What documents mention [entity]?"
- After finding an entity via search, to get its full network
- Building detailed reports about specific entities

CONTEXT INCLUDES:
1. Entity Details: Name, type, description, all properties
2. Relationships: Connected entities at configurable depth (1-3 hops)
3. Concepts: Taxonomic categories and topics linked to the entity
4. Documents: Source documents that mention/cite the entity

EXAMPLE - Get full context:
{
  "entityId": "tech_abc123",
  "depth": 2,
  "includeDocuments": true,
  "includeConcepts": true
}

EXAMPLE - Just relationships:
{
  "entityId": "comp_xyz456",
  "depth": 3,
  "includeDocuments": false,
  "includeConcepts": false,
  "maxRelationships": 100
}

DEPTH LEVELS:
- 1 hop: Direct connections only (partners, uses, provides)
- 2 hops: Includes connections of connections (default)
- 3 hops: Extended network (slower but comprehensive)

RETURNS:
- entity: Full entity details and properties
- relationships: Array of connected entities with relation types
- concepts: Linked taxonomic concepts
- documents: Supporting documents with relevant chunks
- stats: Counts of relationships, concepts, documents

USE INSTEAD OF getEntityDetails when you need the FULL network context, not just entity properties.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity. Get from searchEntities, searchKnowledgeGraph, or listEntities results.',
        },
        depth: {
          type: SchemaType.NUMBER,
          description: 'Relationship traversal depth: 1 (direct only), 2 (default), or 3 (extended network).',
        },
        includeDocuments: {
          type: SchemaType.BOOLEAN,
          description: 'Include supporting documents (default: true). Disable for faster response if not needed.',
        },
        includeConcepts: {
          type: SchemaType.BOOLEAN,
          description: 'Include linked concepts/categories (default: true).',
        },
        maxRelationships: {
          type: SchemaType.NUMBER,
          description: 'Max relationships to return (default: 50, max: 100). Increase for heavily connected entities.',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'formatCitations',
    description: `Format search results as citations for including in responses. Generates structured source attribution for documents, entities, and chunks.

WHEN TO USE THIS TOOL:
- After searchKnowledgeGraph to cite sources in your response
- When building responses that need source attribution
- "Cite your sources" or "Where did you get this information?"
- Creating audit trails for AI-generated insights

PURPOSE:
Converts raw IDs into formatted citations with titles, types, and links. Ensures responses can be traced back to their sources.

EXAMPLE - Cite multiple sources:
{
  "documentIds": ["doc_abc123", "doc_def456"],
  "entityIds": ["tech_xyz789"],
  "chunkIds": ["chunk_001"]
}

RETURNS: Array of citations, each with:
- id: Original ID
- type: 'document', 'entity', or 'chunk'
- title: Human-readable title
- excerpt: Relevant text snippet (for chunks)
- url: Link to the source (if applicable)

TYPICAL WORKFLOW:
1. searchKnowledgeGraph → find relevant info
2. Use the info to answer the question
3. formatCitations → generate source references
4. Include citations in response

TIP: Always cite sources when answering factual questions based on knowledge graph data. This builds trust and enables verification.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Document IDs to cite. Get from search results.',
        },
        entityIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Entity IDs to cite. Get from search results.',
        },
        chunkIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Specific chunk IDs for precise citations. Get from searchDocuments or searchKnowledgeGraph.',
        },
      },
      required: [],
    },
  },
  {
    name: 'findEntitiesByMeaning',
    description: `Find Technology, Company, and Signal entities whose MEANING matches a natural-language description — pure semantic (embedding) search over entity name+description vectors. Works when keyword search fails because the user describes what an entity does rather than what it is called.

WHEN TO USE THIS TOOL:
- "Which technologies deal with [concept]?" when the concept is not a literal name/tag
- "Find companies similar to [description]" / "who else does X?"
- "Any signals about [theme]?" phrased in the user's own words
- Fuzzy recall: user remembers what an entity does but not its name
- Deduplication checks before creating a new entity ("do we already track something like this?")

HOW IT DIFFERS FROM SIBLING TOOLS:
- searchEntities: exact/substring name+tag matching — use for known names
- searchKnowledgeGraph: hybrid search returning documents/chunks/concepts too — use for broad research
- findEntitiesByMeaning: entities ONLY, ranked purely by embedding similarity — use for "means like this" lookups

EXAMPLE - Concept lookup across all entity types:
{
  "query": "orchestrating containers across a fleet of machines"
}

EXAMPLE - Companies only, more results:
{
  "query": "startups building autonomous coding agents",
  "entityType": "company",
  "limit": 15
}

RETURNS:
- matches: [{id, label (Technology|Company|Signal), name, description, score}] ranked by similarity (0-1)
- degraded: true when a vector index or the graph is unavailable — empty matches then mean "search could not run", NOT "nothing exists". Tell the user the search was degraded instead of claiming no results.

NOTE: only entities with embeddings are searchable (embeddings are written on entity sync and by the backfill script). A score >= 0.7 is a strong match; 0.5-0.7 is loosely related.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Natural-language description of the entity meaning to search for. Full sentences work better than single keywords.',
        },
        entityType: {
          type: SchemaType.STRING,
          description:
            "Restrict to one entity type: 'technology', 'company', or 'signal'. Omit (or 'all') for all three.",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max matches to return (default: 10, max: 25).',
        },
        minScore: {
          type: SchemaType.NUMBER,
          description: 'Minimum similarity score 0-1 (default: 0.5). Raise to 0.7 for near-duplicates only.',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Search concepts by query text (simple text matching)
 */
async function searchConceptsByQuery(query: string, limit: number = 10): Promise<KnowledgeConcept[]> {
  const allConcepts = await adminGetConcepts();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  // Score concepts by how well they match the query
  const scoredConcepts = allConcepts
    .map((concept) => {
      const nameLower = concept.canonicalName.toLowerCase();
      const aliasesLower = (concept.aliases || []).map((a) => a.toLowerCase());

      let score = 0;

      // Exact name match
      if (nameLower === queryLower) {
        score += 1.0;
      }
      // Partial name match
      else if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
        score += 0.7;
      }
      // Word match
      else {
        for (const word of queryWords) {
          if (word.length > 2 && nameLower.includes(word)) {
            score += 0.3;
          }
        }
      }

      // Alias match bonus
      for (const alias of aliasesLower) {
        if (alias === queryLower) {
          score += 0.5;
        } else if (alias.includes(queryLower)) {
          score += 0.2;
        }
      }

      // Boost by entity count (more connected = more relevant)
      score *= 1 + Math.log10(Math.max(concept.entityCount || 1, 1)) * 0.1;

      return { concept, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scoredConcepts.map(({ concept, score }) => ({
    id: concept.id,
    name: concept.canonicalName,
    slug: concept.slug,
    type: concept.type,
    entityCount: concept.entityCount || 0,
    score,
  }));
}

const MAX_KNOWLEDGE_RESULTS = 50;
const MAX_CHUNK_CONTENT_CHARS = 1_200;
const MAX_RESULT_NAME_CHARS = 200;
const MAX_RESULT_DESCRIPTION_CHARS = 600;
const MAX_RESULT_STATEMENT_CHARS = 1_000;

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function boundedScore(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

type GraphFirstCandidate = GraphFirstRetrievalResult['resolution']['candidates'][number];

function boundedCandidate(candidate: GraphFirstCandidate): GraphFirstCandidate {
  return {
    ...candidate,
    name: boundedText(candidate.name, MAX_RESULT_NAME_CHARS),
    type: boundedText(candidate.type, MAX_RESULT_NAME_CHARS),
    ...(candidate.description ? { description: boundedText(candidate.description, MAX_RESULT_DESCRIPTION_CHARS) } : {}),
  };
}

function candidateToKnowledgeEntity(
  candidate: GraphFirstCandidate,
  method: GraphFirstRetrievalResult['resolution']['method']
): KnowledgeEntity {
  const bounded = boundedCandidate(candidate);
  return {
    id: bounded.id,
    name: bounded.name,
    type: bounded.type,
    ...(bounded.description ? { description: bounded.description } : {}),
    score: bounded.score ?? 1,
    source: method === 'semantic' ? 'vector' : 'graph',
  };
}

function publicSearchError(error: unknown, fallback: string): string {
  if (error instanceof GraphUnavailableError) return sanitizeNeo4jErrorMessage(error.message);
  if (isVectorIndexMissingError(error)) return 'A required graph index is unavailable.';
  return fallback;
}

function isProgrammerOrInvalidArgumentError(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  ) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '')
    .toLowerCase()
    .replace(/_/g, '-');
  return code === '3' || code === 'invalid-argument' || code.endsWith('/invalid-argument');
}

function isExpectedKnowledgeLaneError(error: unknown): boolean {
  if (isProgrammerOrInvalidArgumentError(error)) return false;
  if (error instanceof GraphUnavailableError || isVectorIndexMissingError(error) || isRetryableError(error))
    return true;
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '').toLowerCase();
  if (/^(?:firestore\/)?(?:unavailable|deadline-exceeded|resource-exhausted)$/.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /Google AI API key not found/.test(message);
}

function confidenceScore(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value > 1 ? value / 100 : value, 0), 1);
}

function boundedChunkContent(content: string): { content: string; truncated?: boolean } {
  if (content.length <= MAX_CHUNK_CONTENT_CHARS) return { content };
  return { content: content.slice(0, MAX_CHUNK_CONTENT_CHARS), truncated: true };
}

function dedupeChunks(chunks: KnowledgeChunk[], limit: number): KnowledgeChunk[] {
  const byId = new Map<string, KnowledgeChunk>();
  for (const chunk of chunks) {
    const existing = byId.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) byId.set(chunk.chunkId, chunk);
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.documentId.localeCompare(b.documentId) ||
        a.chunkIndex - b.chunkIndex ||
        a.chunkId.localeCompare(b.chunkId)
    )
    .slice(0, limit);
}

interface KnowledgeSearchDependencies {
  retrieve: typeof retrieveGraphFirst;
  searchChunks: typeof searchChunksByText;
  searchConcepts: typeof searchConceptsByQuery;
  embedQuery(query: string): Promise<number[]>;
  graphMode(): Promise<{ mode: string; reason?: string; maxHopsAvailable: number }>;
  now(): number;
}

const DEFAULT_KNOWLEDGE_SEARCH_DEPENDENCIES: KnowledgeSearchDependencies = {
  retrieve: retrieveGraphFirst,
  searchChunks: searchChunksByText,
  searchConcepts: searchConceptsByQuery,
  embedQuery: (query) => generateEmbedding(query, { taskType: TaskType.RETRIEVAL_QUERY }),
  graphMode: async () => {
    const { getGraphMode } = await import('@/lib/graph/service-factory');
    return getGraphMode();
  },
  now: Date.now,
};

// ============================================================================
// EXECUTION FUNCTIONS
// ============================================================================

/**
 * Execute hybrid knowledge graph search
 */
export async function executeSearchKnowledgeGraph(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: KnowledgeSearchResult;
  error?: string;
}>;
export async function executeSearchKnowledgeGraph(
  args: Record<string, unknown>,
  dependencies?: KnowledgeSearchDependencies
): Promise<{ success: boolean; data?: KnowledgeSearchResult; error?: string }>;
export async function executeSearchKnowledgeGraph(
  args: Record<string, unknown>,
  dependencies: KnowledgeSearchDependencies = DEFAULT_KNOWLEDGE_SEARCH_DEPENDENCIES
): Promise<{ success: boolean; data?: KnowledgeSearchResult; error?: string }> {
  const startTime = dependencies.now();

  try {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const entityTypes = Array.isArray(args.entityTypes)
      ? args.entityTypes.filter((type): type is TransformationEntityType => typeof type === 'string').slice(0, 10)
      : undefined;
    const maxResults = boundedInteger(args.maxResults, 20, 1, MAX_KNOWLEDGE_RESULTS);
    const includeChunks = args.includeChunks !== false;
    const includeConcepts = args.includeConcepts !== false;
    const includeGraphPaths = args.includeGraphPaths !== false;
    const minScore = boundedScore(args.minScore, 0.5);

    if (!query) {
      return { success: false, error: 'query is required' };
    }

    // One request-scoped RETRIEVAL_QUERY embedding is shared by entity,
    // graph-grounded chunk, and broad chunk vector queries.
    let queryEmbedding: Promise<number[]> | undefined;
    const getQueryEmbedding = () => (queryEmbedding ??= dependencies.embedQuery(query.slice(0, 1_000)));

    // 1. Deterministic graph-first resolution and one-hop context. This runs
    // before the broad document/concept lanes and refuses to traverse an
    // ambiguous entity candidate.
    const graphFirst = await dependencies.retrieve(query, {
      ...(entityTypes?.length ? { entityTypes } : {}),
      maxResults,
      minScore,
      includeChunks,
      getQueryEmbedding,
    });
    const diagnostics: KnowledgeSearchDiagnostic[] = graphFirst.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: boundedText(diagnostic.message, MAX_RESULT_DESCRIPTION_CHARS),
    }));
    const resolution: GraphFirstRetrievalResult['resolution'] = {
      ...graphFirst.resolution,
      entity: graphFirst.resolution.entity ? boundedCandidate(graphFirst.resolution.entity) : null,
      candidates: graphFirst.resolution.candidates.map(boundedCandidate),
    };

    const graphEntities: KnowledgeEntity[] = [];
    if (resolution.entity) {
      graphEntities.push(candidateToKnowledgeEntity(resolution.entity, resolution.method));
    } else {
      graphEntities.push(...resolution.candidates.map((item) => candidateToKnowledgeEntity(item, resolution.method)));
    }
    for (const neighbor of graphFirst.context?.neighbors ?? []) {
      graphEntities.push({
        id: neighbor.entity.id,
        name: boundedText(neighbor.entity.name, MAX_RESULT_NAME_CHARS),
        type: boundedText(neighbor.entity.label, MAX_RESULT_NAME_CHARS),
        ...(neighbor.entity.description
          ? { description: boundedText(neighbor.entity.description, MAX_RESULT_DESCRIPTION_CHARS) }
          : {}),
        score: confidenceScore(neighbor.confidence),
        source: 'graph',
      });
    }

    const focusEntityId = resolution.entity?.id;
    const contextChunks: KnowledgeChunk[] = (graphFirst.context?.chunks ?? []).map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle: boundedText(chunk.documentTitle || 'Untitled', MAX_RESULT_NAME_CHARS),
      ...boundedChunkContent(chunk.content),
      score: chunk.score,
      chunkIndex: chunk.chunkIndex ?? 0,
      provenance: chunk.provenance,
      ...(focusEntityId ? { focusEntityId } : {}),
    }));

    const neighborhood: KnowledgeGraphPath[] = (graphFirst.context?.neighbors ?? []).map((neighbor) => {
      const center = {
        id: graphFirst.context!.center.id,
        name: boundedText(graphFirst.context!.center.name, MAX_RESULT_NAME_CHARS),
        type: boundedText(graphFirst.context!.center.label, MAX_RESULT_NAME_CHARS),
      };
      const connected = {
        id: neighbor.entity.id,
        name: boundedText(neighbor.entity.name, MAX_RESULT_NAME_CHARS),
        type: boundedText(neighbor.entity.label, MAX_RESULT_NAME_CHARS),
      };
      const outgoing = neighbor.direction === 'out';
      return {
        from: outgoing ? center : connected,
        to: outgoing ? connected : center,
        direction: outgoing ? 'outgoing' : 'incoming',
        relation: boundedText(neighbor.relation, MAX_RESULT_NAME_CHARS),
        distance: neighbor.distance ?? 1,
        ...(neighbor.segments?.length
          ? {
              segments: neighbor.segments.map((segment) => ({
                fromId: segment.fromId,
                toId: segment.toId,
                relationType: boundedText(segment.relationType, MAX_RESULT_NAME_CHARS),
                ...(segment.confidence === null ? {} : { confidence: segment.confidence }),
                ...(segment.claimId === null ? {} : { claimId: segment.claimId }),
              })),
            }
          : {}),
        ...(neighbor.claimId === null ? {} : { claimId: neighbor.claimId }),
        ...(neighbor.confidence === null ? {} : { pathConfidence: neighbor.confidence }),
        source: 'neighbors',
      };
    });

    // 2. Broad passages remain independent topic evidence. They run even when
    // entity resolution is ambiguous or unavailable and never select a focus.
    let queryChunks: KnowledgeChunk[] = [];
    if (includeChunks && contextChunks.length < maxResults) {
      try {
        const vectorResults = await dependencies.searchChunks(query, {
          limit: maxResults - contextChunks.length,
          minScore,
          queryEmbedding: getQueryEmbedding(),
        });
        queryChunks = vectorResults.map((chunk: VectorSearchResult) => ({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          documentTitle: boundedText(chunk.documentTitle || 'Untitled', MAX_RESULT_NAME_CHARS),
          ...boundedChunkContent(chunk.content),
          score: chunk.score,
          chunkIndex: chunk.chunkIndex,
          provenance: 'query-semantic',
        }));
      } catch (error) {
        if (!isExpectedKnowledgeLaneError(error)) throw error;
        diagnostics.push({
          stage: 'document-chunks',
          code:
            error instanceof GraphUnavailableError
              ? 'graph-unavailable'
              : isVectorIndexMissingError(error)
                ? 'index-unavailable'
                : 'vector-unavailable',
          message: publicSearchError(error, 'Document semantic search is temporarily unavailable.'),
        });
        log.warn('searchKnowledgeGraph: document chunk search unavailable', {
          error: sanitizeNeo4jErrorMessage(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    const chunks = includeChunks ? dedupeChunks([...contextChunks, ...queryChunks], maxResults) : [];

    // 3. Preserve bounded concept results as an independent Firestore lane. A
    // graph outage can still return concepts, but the result remains explicitly
    // partial/unavailable through retrievalStatus + diagnostics.
    let concepts: KnowledgeConcept[] = [];
    if (includeConcepts) {
      try {
        concepts = (await dependencies.searchConcepts(query, Math.min(15, maxResults))).map((concept) => ({
          ...concept,
          name: boundedText(concept.name, MAX_RESULT_NAME_CHARS),
          slug: boundedText(concept.slug, MAX_RESULT_NAME_CHARS),
          type: boundedText(concept.type, MAX_RESULT_NAME_CHARS),
        }));
      } catch (error) {
        if (!isExpectedKnowledgeLaneError(error)) throw error;
        diagnostics.push({
          stage: 'concept-search',
          code: 'concept-search-unavailable',
          message: 'Concept search is temporarily unavailable.',
        });
        log.warn('searchKnowledgeGraph: concept search unavailable', {
          error: sanitizeNeo4jErrorMessage(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    // Passages and concepts already have dedicated arrays; duplicating aliases
    // in entities makes totalResults count the same evidence twice.
    const entities = [...new Map(graphEntities.map((entity) => [entity.id, entity] as const)).values()].slice(
      0,
      maxResults
    );
    const graphPaths = includeGraphPaths ? neighborhood : [];

    // Task 0.14: Get graph provenance for transparency
    let graphModeInfo: { mode: string; reason?: string; maxHopsAvailable: number } | undefined;
    try {
      graphModeInfo = await dependencies.graphMode();
    } catch {
      // Graph mode unavailable — skip provenance
    }
    const executionTimeMs = dependencies.now() - startTime;

    const result: KnowledgeSearchResult = {
      entities,
      chunks: includeChunks ? chunks : [],
      concepts: includeConcepts ? concepts : [],
      graphPaths,
      claims: (graphFirst.context?.claims ?? []).map((claim) => ({
        ...claim,
        predicate: boundedText(claim.predicate, MAX_RESULT_NAME_CHARS),
        subjectName: boundedText(claim.subjectName, MAX_RESULT_NAME_CHARS),
        objectName: boundedText(claim.objectName, MAX_RESULT_NAME_CHARS),
        statement: boundedText(claim.statement, MAX_RESULT_STATEMENT_CHARS),
        status: boundedText(claim.status, MAX_RESULT_NAME_CHARS),
      })),
      resolution,
      retrievalStatus:
        diagnostics.length > graphFirst.diagnostics.length && graphFirst.status === 'complete'
          ? 'partial'
          : graphFirst.status,
      partial: graphFirst.partial || diagnostics.length > graphFirst.diagnostics.length,
      retrievalPlan: graphFirst.plan,
      diagnostics,
      retrievalBounds: graphFirst.bounds,
      totalResults: entities.length + chunks.length + concepts.length,
      executionTimeMs,
      graphMode:
        (graphModeInfo?.mode as KnowledgeSearchResult['graphMode']) ??
        (graphFirst.status === 'unavailable' ? 'unavailable' : undefined),
      graphModeReason: graphModeInfo?.reason,
      maxHopsAvailable: graphModeInfo?.maxHopsAvailable,
    };

    return { success: true, data: result };
  } catch (error) {
    log.error('searchKnowledgeGraph error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: 'Knowledge search failed',
    };
  }
}

/**
 * Execute entity context retrieval
 */
export async function executeGetEntityContext(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: EntityContextResult;
  error?: string;
}> {
  try {
    const entityId = args.entityId as string;
    // Ensure numeric params are integers - Neo4j LIMIT requires integers
    const depth = Math.floor(Math.min(Math.max((args.depth as number) || 2, 1), 3));
    const includeDocuments = args.includeDocuments !== false;
    const includeConcepts = args.includeConcepts !== false;
    const maxRelationships = Math.floor(Math.min((args.maxRelationships as number) || 50, 100));

    if (!entityId) {
      return { success: false, error: 'entityId is required' };
    }

    // 1. Get the entity itself
    let entity: EntityContextResult['entity'] = null;
    try {
      const graphEntity = await getEntity(entityId);
      if (graphEntity) {
        entity = {
          id: graphEntity.id,
          name: String(graphEntity.properties?.name || graphEntity.id),
          // AI-026: canonical label first; `getEntity` has already refused any
          // node whose identity is not label-proven.
          type: businessEntityGraphType(graphEntity) ?? 'unknown',
          description: graphEntity.properties?.description ? String(graphEntity.properties.description) : undefined,
          properties: graphEntity.properties || {},
        };
      }
    } catch {
      // Entity not in graph, try to identify type from ID pattern
      entity = {
        id: entityId,
        name: entityId,
        type: 'unknown',
        properties: {},
      };
    }

    // 2. Get relationships
    const relationships: EntityRelationship[] = [];

    try {
      // Get immediate neighbors first
      const neighbors = await getNeighbors(entityId, { limit: maxRelationships });

      for (const neighbor of neighbors) {
        relationships.push({
          targetId: neighbor.id,
          targetName: String(neighbor.properties?.name || neighbor.id),
          targetType: businessEntityGraphType(neighbor) ?? 'unknown',
          relationType: 'RELATED_TO', // Would need relation info from query
          direction: 'outgoing',
          distance: 1,
        });
      }

      // If depth > 1, get extended network.
      // M8: this used to call findConnected with an UNDEFINED targetType —
      // the generated Cypher referenced $targetType but the driver never
      // received it, so every depth>1 call (the default is depth 2) threw
      // ParameterMissing and silently degraded to 1-hop. findConnected
      // requires a target type by contract; an untyped multi-hop expansion
      // is exactly what getNeighbors' depth option provides.
      if (depth > 1) {
        const extendedNeighbors = await getNeighbors(entityId, {
          depth,
          limit: maxRelationships,
        });

        for (const node of extendedNeighbors.slice(0, maxRelationships - relationships.length)) {
          // Skip if already in relationships
          if (relationships.some((r) => r.targetId === node.id)) continue;

          relationships.push({
            targetId: node.id,
            targetName: String(node.properties?.name || node.id),
            targetType: businessEntityGraphType(node) ?? 'unknown',
            relationType: 'CONNECTED',
            direction: 'outgoing',
            distance: 2, // Approximate
          });
        }
      }
    } catch (relationshipError) {
      // Entity might not be in graph — but never swallow silently (M8).
      log.warn('getEntityContext: relationship traversal failed', {
        entityId,
        depth,
        error: relationshipError instanceof Error ? relationshipError.message : String(relationshipError),
      });
    }

    // 3. Get linked concepts
    let concepts: Array<{ id: string; name: string; type: string }> = [];

    if (includeConcepts) {
      try {
        // Try to get conceptIds from entity properties
        const conceptIds = entity?.properties?.conceptIds as string[] | undefined;
        if (conceptIds && conceptIds.length > 0) {
          // Fetch each concept by ID
          const conceptResults = await Promise.all(conceptIds.map((id) => adminGetConceptById(id)));
          const linkedConcepts = conceptResults.filter((c): c is Concept => c !== null);
          concepts = linkedConcepts.map((c: Concept) => ({
            id: c.id,
            name: c.canonicalName,
            type: c.type,
          }));
        }
      } catch {
        // No concepts linked
      }
    }

    // 4. Get related documents — graph enumeration FIRST (real MENTIONS /
    // DOCUMENTED_BY / HAS_EVIDENCE edges via fetchDocumentsForEntity), vector
    // name-similarity only fills remaining slots up to the cap, deduped by
    // documentId. The tool declaration promises "documents that mention/cite
    // the entity"; previously only the vector lane ran, so the graph's
    // 1700+ MENTIONS edges were never read for this.
    const documents: EntityDocument[] = [];
    const MAX_DOCUMENTS = 5;

    if (includeDocuments && entity?.name) {
      const seenDocumentIds = new Set<string>();

      try {
        const graphDocs = await fetchDocumentsForEntity(entityId, { limit: MAX_DOCUMENTS });
        for (const doc of graphDocs) {
          if (documents.length >= MAX_DOCUMENTS) break;
          seenDocumentIds.add(doc.documentId);
          documents.push({
            documentId: doc.documentId,
            title: doc.title ?? doc.documentId,
            type: doc.type ?? 'unknown',
            relevantChunks: doc.snippets.map((content, chunkIndex) => ({ content, chunkIndex })),
            source: 'graph',
            mentionCount: doc.mentionCount,
            // GRAPH-064: carry the source's trust through to the model. An
            // unreviewed machine-generated draft grounds an answer far more
            // weakly than an uploaded document, and only the graph knows which.
            ...(doc.sourceProvenance ? { sourceProvenance: doc.sourceProvenance } : {}),
            ...(doc.sourceReviewState ? { sourceReviewState: doc.sourceReviewState } : {}),
          });
        }
      } catch (graphError) {
        log.warn('getEntityContext: graph document enumeration failed', {
          entityId,
          error: graphError instanceof Error ? graphError.message : String(graphError),
        });
      }

      if (documents.length < MAX_DOCUMENTS) {
        try {
          // Search for documents mentioning this entity by name similarity
          const docResults = await findSimilarDocuments(entity.name, {
            limit: 5,
            minScore: 0.6,
          });

          for (const doc of docResults) {
            if (documents.length >= MAX_DOCUMENTS) break;
            if (seenDocumentIds.has(doc.documentId)) continue;
            seenDocumentIds.add(doc.documentId);
            documents.push({
              documentId: doc.documentId,
              title: doc.title,
              type: doc.type,
              relevantChunks: doc.topChunks.map((c) => ({
                content: c.content,
                chunkIndex: c.chunkIndex,
              })),
              source: 'vector',
            });
          }
        } catch (vectorError) {
          log.warn('getEntityContext: vector document fallback failed', {
            entityId,
            error: vectorError instanceof Error ? vectorError.message : String(vectorError),
          });
        }
      }
    }

    const result: EntityContextResult = {
      entity,
      relationships,
      concepts,
      documents,
      stats: {
        totalRelationships: relationships.length,
        totalConcepts: concepts.length,
        totalDocuments: documents.length,
      },
    };

    return { success: true, data: result };
  } catch (error) {
    log.error('getEntityContext error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get entity context',
    };
  }
}

/**
 * Format search results as citations
 */
export async function executeFormatCitations(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { citations: Citation[] };
  error?: string;
}> {
  try {
    const documentIds = (args.documentIds as string[]) || [];
    const entityIds = (args.entityIds as string[]) || [];
    const chunkIds = (args.chunkIds as string[]) || [];

    const citations: Citation[] = [];

    // Format document citations
    for (const docId of documentIds) {
      citations.push({
        id: docId,
        type: 'document',
        title: docId, // Would need to fetch actual title
        url: getEntityUrl('document', docId) ?? '/library/documents',
      });
    }

    // Format entity citations
    for (const entityId of entityIds) {
      try {
        const entity = await getEntity(entityId);
        citations.push({
          id: entityId,
          type: 'entity',
          title: entity ? String(entity.properties?.name || entityId) : entityId,
        });
      } catch {
        citations.push({
          id: entityId,
          type: 'entity',
          title: entityId,
        });
      }
    }

    // Format chunk citations
    for (const chunkId of chunkIds) {
      citations.push({
        id: chunkId,
        type: 'chunk',
        title: `Chunk ${chunkId}`,
      });
    }

    return { success: true, data: { citations } };
  } catch (error) {
    log.error('formatCitations error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to format citations',
    };
  }
}

/** entityType tool param → Neo4j label filter for searchEntitiesBySemantic. */
const MEANING_SEARCH_LABEL_BY_TYPE: Record<string, EntitySearchLabel> = {
  all: 'all',
  technology: 'Technology',
  company: 'Company',
  signal: 'Signal',
};

/**
 * Execute semantic entity search (findEntitiesByMeaning).
 *
 * Honest boundary contract (P5-C): a missing vector index / unavailable graph
 * comes back as `success: true` with `degraded: true` (the search ran but
 * could not consult all indexes); a missing Gemini API key or an unexpected
 * infrastructure error comes back as `success: false` with the real message —
 * never as a fabricated empty result.
 */
export async function executeFindEntitiesByMeaning(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: FindEntitiesByMeaningResult;
  error?: string;
}> {
  try {
    const query = args.query as string | undefined;
    if (!query || !query.trim()) {
      return { success: false, error: 'query is required' };
    }

    const rawEntityType = ((args.entityType as string) || 'all').toLowerCase();
    const label = MEANING_SEARCH_LABEL_BY_TYPE[rawEntityType];
    if (!label) {
      return {
        success: false,
        error: `Unknown entityType '${rawEntityType}' — use 'technology', 'company', 'signal', or omit for all.`,
      };
    }

    // Ensure numeric params are integers - Neo4j LIMIT requires integers
    const limit = Math.floor(Math.min(Math.max((args.limit as number) || 10, 1), 25));
    const minScore = Math.min(Math.max((args.minScore as number) || 0.5, 0), 1);

    const { results, degraded, degradedReason, unavailable } = await searchEntitiesBySemantic(query, label, {
      limit,
      minScore,
    });

    // A dead graph is not "zero matches". Reporting it as a successful empty
    // result would let the model tell the user "I found no matching entities"
    // when the truth is that nothing was searched at all.
    if (unavailable) {
      return {
        success: false,
        error: degradedReason ?? 'Semantic entity search unavailable: the graph backend could not be reached.',
      };
    }

    return {
      success: true,
      data: {
        matches: results,
        totalResults: results.length,
        degraded,
        ...(degradedReason ? { degradedReason } : {}),
      },
    };
  } catch (error) {
    log.error('findEntitiesByMeaning error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Semantic entity search failed',
    };
  }
}
