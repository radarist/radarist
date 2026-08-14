/**
 * @file index.ts
 * @description Main export file for the Neo4j graph module.
 *
 * This module provides the graph layer for the Innovation Brain,
 * implementing the Reified Claim Model and GraphService abstraction.
 *
 * @phase Phase 4: Relations-as-Claims + Phase 5: GraphRAG
 * @author Radarist Team
 * @created 2026-01-09
 */

// =============================================================================
// DOMAIN ERRORS
// =============================================================================

export { GraphUnavailableError } from './errors';

// =============================================================================
// BUSINESS-ENTITY IDENTITY (AI-026)
// =============================================================================

export {
  businessEntityGraphType,
  filterBusinessEntityNodes,
  graphLabelForEntityType,
  graphLabelsForEntityTypes,
  isBusinessEntityNode,
  ENTITY_PROJECTION_GRAPH_LABELS,
  INTERNAL_MEMORY_ENTITY_TYPES,
  INTERNAL_MEMORY_GRAPH_LABELS,
} from './business-entity-identity';

// =============================================================================
// GRAPH SERVICE ABSTRACTION (Phase 5)
// =============================================================================

// Interface types
export type {
  IGraphService,
  GraphNode,
  GraphRelation,
  GraphPath,
  GraphQueryResult,
  TraversalOptions,
  PathFindingOptions,
  NeighborOptions,
  GraphServiceConfig,
  GraphServiceHealth,
  GraphMode,
} from './interface';

// Service factory (main entry point)
export {
  getGraphService,
  setGraphService,
  resetGraphService,
  getGraphServiceHealth,
  getGraphServiceConfig,
  isGraphServiceInitialized,
  getCurrentBackend,
  reconnectGraphService,
} from './service-factory';

// Service implementations (for direct usage/testing)
export { Neo4jGraphService } from './neo4j-graph-service';
export { MockGraphService, SAMPLE_GRAPH_FIXTURE } from './mock-graph-service';
export type { GraphFixture } from './mock-graph-service';
export { FirestoreFallbackService } from './firestore-fallback-service';

// Graph traversal functions (high-level API)
export {
  // Neighbor operations
  getNeighbors,
  getNeighborsByType,
  getNeighborsByRelation,
  // Multi-hop traversal
  findConnected,
  findConnectedWithDistance,
  // Path finding
  findPath,
  findAllPaths,
  checkConnection,
  // Connection explanation (renamed to avoid conflict with claims.explainConnection)
  explainConnection as explainGraphConnection,
  // Batch operations
  getEntities,
  getEntity,
  checkMultipleConnections,
  // Utilities
  formatPath,
  getGraphStatus,
} from './traversal';
export type {
  ConnectionResult,
  EntityWithDistance,
  ConnectionExplanation as GraphConnectionExplanation,
} from './traversal';

// Business queries (multi-hop domain-specific queries)
export {
  // Solution discovery
  findSolutionsForPainPoint,
  findPainPointsForOrgUnit,
  // Strategic alignment
  findTechnologiesForStrategy,
  findInitiativesForPainPoint,
  // Impact analysis
  analyzeTechnologyImpact,
  // Vendor recommendations
  findVendorsForStrategy,
  // Gap analysis
  analyzeGaps,
  // Competitive analysis
  findCompetitorTechnologies,
  compareTechnologyPortfolio,
  // Executive Q&A
  recommendTechnologyInvestments,
  generateTechnologySummary,
} from './business-queries';
export type {
  AlignedTechnology,
  PainPointSolution,
  TechnologyImpact,
  VendorRecommendation,
  GapAnalysis,
} from './business-queries';

// Cypher query templates
export {
  // Node queries
  GET_NODE_BY_ID,
  GET_NODES_BY_IDS,
  SEARCH_NODES,
  GET_NODES_BY_TYPE,
  // Neighbor queries
  GET_NEIGHBORS,
  GET_NEIGHBORS_WITH_RELATIONS,
  GET_MULTIHOP_NEIGHBORS,
  // Path finding
  FIND_SHORTEST_PATH,
  FIND_SHORTEST_PATH_FILTERED,
  FIND_ALL_PATHS,
  FIND_WEIGHTED_PATH,
  FIND_PATH_DETAILED,
  // Traversal
  FIND_CONNECTED_BY_TYPE,
  FIND_CONNECTED_VIA_RELATIONS,
  ARE_CONNECTED,
  // Business queries
  FIND_SOLUTIONS_FOR_PAIN_POINT,
  FIND_PAIN_POINTS_FOR_ORG_UNIT,
  FIND_TECHNOLOGIES_FOR_STRATEGY,
  FIND_TECHNOLOGY_IMPACT,
  FIND_INITIATIVES_FOR_PAIN_POINT,
  FIND_VENDORS_FOR_STRATEGY,
  DISCOVER_USE_CASES,
  FIND_UNADDRESSED_PAIN_POINTS,
  FIND_TECHNOLOGIES_WITHOUT_PROTOTYPES,
  // Statistics
  GET_GRAPH_STATS,
  GET_RELATIONSHIP_STATS,
  GET_NODE_CONNECTIVITY,
  // Helpers
  buildQuery,
  substituteDepth,
} from './cypher-templates';

// =============================================================================
// NEO4J CLIENT (Low-level access)
// =============================================================================

// Neo4j Client
export {
  getDriver,
  closeDriver,
  getSession,
  runQuery,
  runWriteTransaction,
  runReadTransaction,
  runRawReadQuery,
  checkHealth,
  initializeSchema,
  getNeo4jConfig,
  type Neo4jConfig,
  type QueryExecutionResult,
} from './neo4j-client';

// Graph Types
export type {
  ClaimStatus,
  GraphAssertion,
  GraphClaim,
  GraphEvidence,
  GraphRelationType,
  GraphEntity,
  GraphAgent,
  GraphUser,
  CreateAssertionInput,
  CreateClaimInput,
  EvidenceInput,
  ConnectionExplanation,
  EntityAssertions,
  EntityClaims,
  DocumentCitations,
  SyncOperation,
  SyncQueueItem,
  AssertionGraphStats,
  ClaimGraphStats,
} from './types';

// Assertion Service
export {
  // CRUD (new)
  createAssertion,
  getAssertion,
  getAssertionWithEvidence,
  getAssertionWithEvidenceByRelationId,
  getAssertionsForEntity,
  getAssertionsBetweenEntities,
  updateAssertionStatus,
  updateAssertionConfidence,
  deleteAssertion,

  // Evidence
  addEvidenceToAssertion,
  getEvidenceForAssertion,
  removeEvidence,

  // Connection Explanation
  explainConnection,
  getAssertionsCitingDocument,

  // Queries
  getAssertionsByStatus,
  getAssertionsByAsserter,
  getHighConfidenceAssertions,
  getAssertionsByPredicate,

  // Statistics
  getAssertionStats,

  // Entity Sync
  syncEntity,
  deleteEntityFromGraph,

  // Bulk Operations
  bulkCreateAssertions,
  bulkApproveAssertions,
  bulkRejectAssertions,

  // Edge Materialization
  materializeAssertionAsEdge,
} from './assertions';

// =============================================================================
// ENTITY EMBEDDINGS (Phase 2)
// =============================================================================

export {
  embedEntity,
  scheduleEntityEmbed,
  type EmbeddableLabel,
  type EmbedEntityInput,
  type EmbedEntityResult,
  type ScheduleEntityEmbedResult,
} from './embedding-sync';

// =============================================================================
// SUBGRAPH RAG (Phase 3)
// =============================================================================

export {
  extractSubgraph,
  extractSubgraphForQuery,
  fetchDocumentsForEntity,
  type SubgraphContext,
  type SubgraphCenter,
  type SubgraphNeighbor,
  type SubgraphChunk,
  type SubgraphClaim,
  type SubgraphTemporalEdge,
  type ExtractSubgraphOptions,
  type EntityGroundedDocument,
} from './subgraph-rag';

export {
  linkChunkMentions,
  applyMentionTrustForDocument,
  countUnlinkedChunks,
  listChunksWithoutMentions,
  type LinkChunkMentionsResult,
  type ApplyMentionTrustResult,
} from './chunk-mentions';

export {
  deriveDocumentContentProvenance,
  deriveMentionSourceReviewState,
  deriveMentionTrust,
  deriveMentionTrustForDocument,
  REVIEWED_MENTION_CONFIDENCE,
  UNREVIEWED_MENTION_CONFIDENCE,
  type DocumentContentProvenance,
  type MentionSourceReviewState,
  type MentionTrust,
} from './mention-trust';

// =============================================================================
// DATA-QUALITY SCANNER (Phase 4 — emits CuriosityGaps for orphans / missing desc)
// =============================================================================

export { detectDataQualityGaps } from './curiosity-gaps';

// =============================================================================
// GDS ALGORITHMS (Phase 5)
// =============================================================================

export {
  projectKnowledgeGraph,
  dropProjection,
  withProjection,
  projectionExists,
  DEFAULT_GRAPH_NAME,
  DEFAULT_NODE_LABELS,
  DEFAULT_RELATIONSHIP_TYPES,
  type ProjectionStats,
} from './gds-projections';

export {
  runLouvainCommunity,
  detectDuplicateCandidates,
  runPersonalizedPageRankForUser,
  GdsUnavailableError,
  type LouvainResult,
  type DupeCandidate,
  type PageRankHit,
} from './gds-algorithms';

// =============================================================================
// NATURAL LANGUAGE TO CYPHER (Phase 5.13)
// =============================================================================

// NL-to-Cypher translation
export {
  parseNaturalLanguageQuery,
  generateCypherQuery,
  executeNaturalLanguageQuery,
  getExampleQueries,
  isSafeQuery,
} from './nl-to-cypher';
export type { QueryIntent, ParsedQuery, GeneratedQuery, NLQueryResult } from './nl-to-cypher';

// =============================================================================
// QUERY CACHING (Phase 5.16)
// =============================================================================

// Query cache utilities
export {
  QueryCache,
  neighborsCache,
  pathCache,
  businessQueryCache,
  buildNeighborsCacheKey,
  buildPathCacheKey,
  buildBusinessQueryCacheKey,
  invalidateCachesForEntity,
  invalidateAllGraphCaches,
  getAllCacheStats,
} from './query-cache';
export type { CacheStats } from './query-cache';

// =============================================================================
// VECTOR SEARCH (Knowledge Tab Sprint)
// =============================================================================

// Vector search functions
export {
  searchChunksByText,
  searchChunksByEmbedding,
  findSimilarDocuments,
  getDocumentChunks,
  checkVectorIndexStatus,
  searchEntitiesBySemantic,
} from './vector-search';
export type {
  VectorSearchResult,
  VectorSearchOptions,
  HybridSearchOptions,
  DocumentSimilarityResult,
  EntitySearchLabel,
  SemanticEntityResult,
  SemanticEntitySearchOptions,
  SemanticEntitySearchResult,
} from './vector-search';

// =============================================================================
// SESSION MEMORY
// =============================================================================

// Session memory functions
export {
  createSession,
  getOrCreateActiveSession,
  trackEntityView,
  getExploredEntities,
  getActiveUserIds,
} from './session-memory';
export type { SessionNode, ExploredEntity } from './session-memory';

// =============================================================================
// PROACTIVE INSIGHTS
// =============================================================================

// Proactive insight detection functions
export {
  recordAgentObservation,
  detectInsightsForUser,
  getInsightsForUser,
  markInsightConsumed,
  getInsightStats,
} from './proactive-insights';
export type { AgentObservation, ProactiveInsightNode, DetectionResult } from './proactive-insights';

// =============================================================================
// DOT CONNECTOR
// =============================================================================

// Dot Connector
export { findDotConnections, connectDots } from './dot-connector';
export type { DotConnection, DotConnectorResult } from './dot-connector';

// =============================================================================
// INTEREST PROFILE (discovery loop — P0 learning store)
// =============================================================================

export {
  MAX_INTEREST_PROFILE_TOPICS,
  addInterestTopic,
  getInterestProfile,
  mergeInterestProfileTopics,
  normalizeInterestProfileTopics,
  replaceSyntheticInterestProfileTopics,
  touchInterestProfile,
} from './interest-profile';
export type { InterestProfile, SyntheticInterestProfileUserId } from './interest-profile';

// =============================================================================
// EMERGENCE DETECTION (C5 — edge-velocity)
// =============================================================================

export { getEdgeVelocity, selectEmergent, detectEmergence } from './emergence';
export type { EdgeVelocityRow, EmergenceFinding } from './emergence';
