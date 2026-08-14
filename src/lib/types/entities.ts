// ============================================================================
// CORE ENTITY TYPES
// ============================================================================
// Entity interfaces for Technology, Company, Signal, Prototype, UseCase,
// Strategy, OrgUnit, Initiative, PainPoint, Document, and their sub-types.

import type { TransformationEntityType, GraphSyncStatus, DocumentVisibility } from './common';
import type { DeepResearchData, TechnologyResearch } from './research';
import type { DeepResearchProgress } from '@/lib/research/deep-research-progress';

// ============================================================================
// TECHNOLOGY TYPES
// ============================================================================

/**
 * Technology category classifications.
 * Describes what kind of technology this is.
 */
export type TechnologyCategory =
  | 'framework'
  | 'language'
  | 'platform'
  | 'tool'
  | 'library'
  | 'service'
  | 'methodology'
  | 'infrastructure'
  | 'hardware'
  | 'standard'
  | 'protocol'
  | 'api'
  | 'architecture'
  | 'other'; // For unknown/custom categories (normalization fallback)

/**
 * Market interest trend indicator.
 * Used to track whether interest in a technology is growing or declining.
 *
 * @phase Phase 0 Task 0.2.1
 */
export type MarketInterestTrend = 'rising' | 'stable' | 'declining';

/**
 * Market interest metrics for a technology.
 * Tracks market signals, trends, and sources of interest data.
 *
 * This data is typically populated by:
 * - ScoutAgent analyzing external signals
 * - AI research flows analyzing trends
 * - Manual user input for custom assessments
 *
 * @example
 * ```typescript
 * const marketInterest: MarketInterest = {
 *   score: 85,
 *   trend: 'rising',
 *   lastUpdated: Date.now(),
 *   sources: ['Google Trends', 'GitHub Stars', 'HackerNews'],
 * };
 * ```
 *
 * @phase Phase 0 Task 0.2.1
 */
export interface MarketInterest {
  /** Interest score from 0-100. Higher = more market interest. */
  score: number;

  /** Direction of market interest trend. */
  trend: MarketInterestTrend;

  /** Timestamp when this data was last updated (milliseconds since epoch). */
  lastUpdated: number;

  /** Data sources used to calculate the interest score. */
  sources?: string[];

  /**
   * Technology Readiness Level (1-9).
   * 1-3: Research phase (basic principles to proof of concept)
   * 4-6: Development phase (lab to relevant environment validation)
   * 7-9: Deployment phase (prototype to operational system)
   */
  trl?: number;
}

/**
 * Represents a technology entity - factual information only.
 * This is decoupled from radar placement (opinions).
 *
 * @example
 * ```typescript
 * const react: Technology = {
 *   id: 'tech-123',
 *   name: 'React',
 *   slug: 'react',
 *   description: 'A JavaScript library for building user interfaces',
 *   category: 'framework',
 *   tags: ['frontend', 'javascript', 'ui'],
 *   websiteUrl: 'https://react.dev',
 *   githubUrl: 'https://github.com/facebook/react',
 *   createdAt: 1704067200000,
 *   updatedAt: 1704067200000,
 *   createdBy: 'user-456',
 * };
 * ```
 */
/**
 * ARUN-028 — durable debt that a completed research attempt's post-research
 * placement-snapshot refresh (`app/technology.updated`) was not dispatched. Its
 * presence means "research is complete; the graph/radar snapshot refresh is
 * still pending" — never that research failed. A replay re-dispatches the
 * refresh and clears this; the token guards against clearing a newer attempt.
 */
export interface PendingSnapshotRefresh {
  /** The completed attempt's `researchStartedAt`, so a stale replay can't clear a newer debt. */
  attemptToken: number;
  /** When the debt was first recorded (ms since epoch). */
  recordedAt: number;
  /** How many times the refresh dispatch has been attempted. */
  attempts: number;
  /** Last dispatch error message, for operator visibility. */
  lastError?: string;
}

export interface Technology {
  /** Unique identifier for the technology. */
  id: string;
  /** Display name of the technology. */
  name: string;
  /** URL-friendly slug for routing. */
  slug: string;
  /** Detailed description of the technology. */
  description: string;
  /** Category classification. */
  category?: TechnologyCategory;
  /** Tags for filtering and search. */
  tags: string[];
  /** Official website URL. */
  websiteUrl?: string;
  /** GitHub repository URL. */
  githubUrl?: string;
  /** Documentation URL. */
  documentationUrl?: string;
  /** Linked company IDs (vendors/partners). */
  linkedCompanies?: string[];
  /** Linked use case IDs. */
  linkedUseCases?: string[];
  /** Timestamp when created. */
  createdAt: number;
  /** Timestamp when last updated. */
  updatedAt: number;
  /** User ID who created this technology. */
  createdBy: string;

  // ========== APPROVAL WORKFLOW (Phase 0 Task 0.1.2) ==========
  /** Approval status for AI-created or imported technologies. */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  /** User ID who approved/rejected the technology. */
  approvedBy?: string;
  /** Timestamp when approved/rejected. */
  approvedAt?: number;
  /** Notes provided during approval/rejection. */
  approvalNotes?: string;

  // ========== MARKET INTEREST (Phase 0 Task 0.2.1) ==========
  /**
   * Market interest metrics for this technology.
   * Populated by AI research and external signal analysis.
   */
  marketInterest?: MarketInterest;

  // ========== DEEP RESEARCH (Phase 0 Task 0.2.3) ==========
  /**
   * Persisted deep research results for this technology.
   * Contains AI-generated insights that were previously only in transient state.
   * Updated when deep research is performed via AI Assistant or agents.
   */
  deepResearch?: DeepResearchData;

  /**
   * Status of background research job.
   * Used to prevent duplicate research requests and show progress to users.
   */
  researchStatus?: 'idle' | 'pending' | 'completed' | 'failed';

  /**
   * Timestamp when research was last started.
   * Used to detect stale pending states and show elapsed time.
   */
  researchStartedAt?: number;

  /**
   * ARUN-028 — set when a completed research attempt's post-research snapshot
   * refresh could not be dispatched. Research stays `completed`; this marks the
   * graph/radar refresh as pending until a replay re-dispatches it.
   */
  pendingSnapshotRefresh?: PendingSnapshotRefresh;

  // ========== COMPREHENSIVE RESEARCH (Technology Research Feature) ==========
  /**
   * Comprehensive AI-generated research for this technology.
   * Contains 12 research sections covering all aspects of technology assessment.
   * Populated by the researchTechnologyComprehensive tool.
   */
  comprehensiveResearch?: TechnologyResearch;

  /**
   * Technology Readiness Level (1-9) at the technology level.
   * Can be synced to/from RadarPlacements for consistency.
   * 1 = Basic principles observed
   * 9 = Actual system proven in operational environment
   */
  trl?: number;

  /**
   * Time-to-Impact horizon at the technology level.
   * Can be synced to/from RadarPlacements for consistency.
   * H1 = Near-term (0-1 year), H2 = Medium-term (1-3 years), H3 = Long-term (3+ years)
   */
  timeToImpact?: 'H1' | 'H2' | 'H3';

  /**
   * Notes for the technology.
   * Array of timestamped notes with content.
   */
  notes?: TechnologyNote[];
}

/**
 * A note attached to a technology.
 * Used to track observations, meeting notes, and comments.
 */
export interface TechnologyNote {
  /** Unique identifier for the note. */
  id: string;
  /** Note content (supports markdown). */
  content: string;
  /** Timestamp when note was created (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp when note was last updated (milliseconds since epoch). */
  updatedAt: number;
  /** User ID who created the note (optional). */
  createdBy?: string;
}

/**
 * Combined view of Technology with its RadarPlacement.
 * Used for UI rendering where both facts and opinions are needed.
 */
export interface TechnologyWithPlacement extends Technology {
  /** The placement data for this technology on a specific radar. */
  placement: import('./radar').RadarPlacement;
}

/**
 * Input type for creating a new Technology.
 */
export type CreateTechnologyInput = Omit<Technology, 'id' | 'createdAt' | 'updatedAt'>;

// ============================================================================
// DOCUMENT TYPES (Evidence Layer)
// ============================================================================

/**
 * Document type classifications.
 * Determines how the document is processed and displayed.
 *
 * @phase Phase 2: Evidence Layer
 */
export type DocumentType = 'pdf' | 'docx' | 'pptx' | 'url' | 'transcript' | 'markdown' | 'text' | 'deep-research';

/**
 * Document processing status.
 * Tracks the state of document ingestion pipeline.
 * - blocked: URL cannot be fetched (paywall, robots.txt, etc.)
 *
 * @phase Phase 2: Evidence Layer
 */
export type DocumentStatus = 'uploaded' | 'processing' | 'processed' | 'failed' | 'blocked';

/**
 * Represents an uploaded document in the Evidence Layer.
 * Documents are the source of truth for evidence citations.
 *
 * The document content is stored in Firebase Storage, and chunks are extracted
 * for vector search and citation.
 *
 * @example
 * ```typescript
 * const doc: Document = {
 *   id: 'doc-123',
 *   title: 'React Performance Guide',
 *   type: 'pdf',
 *   storageUrl: '/documents/react-perf.pdf',
 *   status: 'processed',
 *   chunkCount: 45,
 *   processedAt: 1704153600000,
 *   createdAt: 1704067200000,
 *   updatedAt: 1704153600000,
 *   uploadedBy: 'user-456',
 * };
 * ```
 *
 * @phase Phase 2: Evidence Layer
 */
export interface Document {
  /** Unique identifier for the document. */
  id: string;

  /** Display title of the document. */
  title: string;

  /** Type of document (determines processing pipeline). */
  type: DocumentType;

  /** Firebase Storage path to the document file. */
  storageUrl: string;

  /** Original URL if scraped from web. */
  originalUrl?: string;

  /** Processing status. */
  status: DocumentStatus;

  /** Timestamp when processing completed. */
  processedAt?: number;

  /** Number of chunks extracted from document. */
  chunkCount?: number;

  /** Error message if processing failed. */
  errorMessage?: string;

  /** Document description or summary. */
  description?: string;

  /** Tags for categorization. */
  tags?: string[];

  /** File size in bytes. */
  fileSize?: number;

  /** MIME type of the original file. */
  mimeType?: string;

  /** Number of pages (for PDFs). */
  pageCount?: number;

  /** Timestamp when created. */
  createdAt: number;

  /** Timestamp when last updated. */
  updatedAt: number;

  /** User ID who uploaded this document. */
  uploadedBy: string;

  // ===== Knowledge Tab Sprint Fields =====

  /**
   * Workspace ID for multi-workspace support.
   * Default: 'default' - enforced later when workspaces are implemented.
   * @phase Knowledge Tab Sprint
   */
  workspaceId?: string;

  // ----- URL-specific fields -----

  /**
   * Extracted domain for grouping (e.g., 'techcrunch.com').
   * @phase Knowledge Tab Sprint
   */
  domain?: string;

  /**
   * Normalized URL for deduplication (lowercase, no trailing slash, no tracking params).
   * @phase Knowledge Tab Sprint
   */
  normalizedUrl?: string;

  /**
   * Timestamp of last successful URL fetch.
   * @phase Knowledge Tab Sprint
   */
  lastFetchedAt?: number;

  /**
   * Error message if URL refresh failed.
   * @phase Knowledge Tab Sprint
   */
  fetchError?: string;

  // ----- Versioning fields -----

  /**
   * Document version number. Increments on refresh when content changes.
   * Starts at 1.
   * @phase Knowledge Tab Sprint
   */
  version?: number;

  /**
   * SHA-256 hash of content for change detection.
   * @phase Knowledge Tab Sprint
   */
  contentHash?: string;

  /**
   * Flag to prevent concurrent refresh attempts.
   * @phase Knowledge Tab Sprint
   */
  refreshInProgress?: boolean;

  // ----- Deep research (PRODUCT-003) -----

  /**
   * The Gemini Interactions-API interaction backing a deep-research document.
   * Persisted as soon as the task starts: it is the only handle by which a run
   * that outlasts the job's poll budget can be checked again, so without it a
   * timeout is indistinguishable from a lost run.
   */
  deepResearchInteractionId?: string;

  /**
   * Provider-backed plan/progress for a deep-research run. Contains ONLY facts
   * the Interactions API reported (raw status, its own `steps[]`) plus the
   * app's own clearly-labelled poll budget — never an invented stage name,
   * completion percentage, or ETA. See `lib/research/deep-research-progress.ts`.
   */
  deepResearchProgress?: DeepResearchProgress;

  /**
   * Millis timestamp of the moment a (re)processing run was ACCEPTED by the
   * queue. Written by the retry/enqueue path, never by the worker, so the UI
   * can distinguish "accepted and running" from a `processing` status left
   * behind by a crashed worker.
   *
   * Read exclusively through `document-processing-policy.ts` — see
   * `isProcessingActive` / `isProcessingStalled`.
   */
  processingRequestedAt?: number;

  // ----- Metadata fields -----

  /**
   * Document visibility level for future permissions.
   * @phase Knowledge Tab Sprint
   */
  visibility?: DocumentVisibility;

  /**
   * AI-generated summary of the document.
   * @phase Knowledge Tab Sprint
   */
  aiSummary?: string;

  /**
   * AI-suggested tags for the document.
   * @phase Knowledge Tab Sprint
   */
  aiTags?: string[];

  // ----- Library hygiene -----

  /**
   * Materialized count of linked entities for "orphan" detection.
   * @phase Knowledge Tab Sprint
   */
  linkedEntityCount?: number;

  // ----- Neo4j sync status -----

  /**
   * Status of synchronization to Neo4j graph database.
   * @phase Knowledge Tab Sprint
   */
  graphSyncStatus?: GraphSyncStatus;

  /**
   * Timestamp of last successful Neo4j sync.
   * @phase Knowledge Tab Sprint
   */
  lastSyncedAt?: number;

  // ----- Content review (GRAPH-064) -----

  /**
   * When a human vouched for this document's CONTENT (not its metadata).
   * Machine-generated sources — deep-research drafts, build-mission reports —
   * yield explicitly unverified graph mentions until this is set; reviewing
   * promotes those mentions to curated on the next sync. Absent = unreviewed.
   */
  contentReviewedAt?: number;

  /** User ID who reviewed this document's content. */
  contentReviewedBy?: string;

  // ----- Build-mission provenance (artifact outputs) -----
  /** The build-mission/run that produced this Document (evaluation/architecture/report artifact). */
  sourceRunId?: string;
  /** Alias of sourceRunId kept for symmetry with mission records. */
  sourceMissionId?: string;
  /** Structured metrics captured by an evaluation artifact (mirrors the verdict.json metrics). */
  structuredMetrics?: Array<{ name: string; value: string; command?: string }>;

  // ----- Generated-research evidence gate (AI-038) -----
  /**
   * Evidence verdict for an automatically generated research document.
   *
   * Present only on generated research (deep research); absent on uploaded and
   * URL-sourced documents, whose provenance is the source itself. A non-
   * `sufficient` verdict is ALSO written into the stored markdown as an
   * "Evidence review" section, so the caveat reaches readers who never see this
   * field — the field exists for filtering and reporting, not as the only
   * carrier of the warning.
   */
  researchEvidence?: DocumentResearchEvidence;
}

/**
 * Bounded evidence summary persisted on a generated research document (AI-038).
 * Mirrors the fields of `ResearchEvidenceReport` that are worth keeping on the
 * record; the full derivation lives in `@/lib/research/primary-evidence`.
 */
export interface DocumentResearchEvidence {
  verdict: 'sufficient' | 'limited' | 'insufficient';
  totalCitations: number;
  primaryCitations: number;
  secondaryCitations: number;
  /** Opaque search/grounding redirects — counted, never treated as evidence. */
  searchRedirectCitations: number;
  unusableCitations: number;
  distinctPrimaryDomains: number;
  /** Bounded sample of the primary domains cited. */
  primaryDomains: string[];
  identifierClaims: number;
  /** Bounded list of identifiers asserted in the text but present in no citation. */
  unsupportedIdentifiers: string[];
  /** Machine-readable finding codes, in the order they were reported. */
  findingCodes: string[];
  /** When the gate ran (epoch ms). */
  evaluatedAt: number;
}

/**
 * Represents a chunk of a document for semantic search.
 * Chunks are paragraphs or sections extracted from documents.
 *
 * Embeddings are stored both in Firestore (for backup) and Neo4j (for vector search).
 * Chunks are versioned to preserve citation integrity when documents are refreshed.
 *
 * @example
 * ```typescript
 * const chunk: DocumentChunk = {
 *   id: 'chunk-456',
 *   documentId: 'doc-123',
 *   content: 'Virtual DOM reconciliation reduces re-renders by 60%...',
 *   metadata: {
 *     page: 12,
 *     section: 'Performance',
 *     startChar: 5230,
 *     endChar: 5890,
 *   },
 *   chunkIndex: 15,
 *   tokenCount: 128,
 *   documentVersion: 1,
 *   archived: false,
 *   createdAt: 1704153600000,
 * };
 * ```
 *
 * @phase Phase 2: Evidence Layer
 */
export interface DocumentChunk {
  /** Unique identifier for the chunk. */
  id: string;

  /** Parent document ID. */
  documentId: string;

  /** The text content of this chunk. */
  content: string;

  /** Location metadata within the source document. */
  metadata: {
    /** Page number (for PDFs). */
    page?: number;
    /** Section or heading name. */
    section?: string;
    /** Start character position in original. */
    startChar: number;
    /** End character position in original. */
    endChar: number;
  };

  /** Index of this chunk within the document (0-based). */
  chunkIndex: number;

  /** Approximate token count for embedding context. */
  tokenCount?: number;

  /** Timestamp when created. */
  createdAt: number;

  // ===== Knowledge Tab Sprint Fields =====

  // ----- Versioning fields -----

  /**
   * Version of the parent document when this chunk was created.
   * Used to track which document version a citation references.
   * @phase Knowledge Tab Sprint
   */
  documentVersion?: number;

  /**
   * True for chunks from older document versions.
   * Archived chunks are preserved for citation integrity but not used in new searches.
   * @phase Knowledge Tab Sprint
   */
  archived?: boolean;

  // ----- Embedding fields -----

  /**
   * 768-dimensional embedding vector from text-embedding-004.
   * Optional in Firestore (may be stored only in Neo4j to save space).
   * @phase Knowledge Tab Sprint
   */
  embedding?: number[];

  /**
   * Model used to generate the embedding (e.g., 'text-embedding-004').
   * @phase Knowledge Tab Sprint
   */
  embeddingModel?: string;

  /**
   * Timestamp when embedding was generated.
   * @phase Knowledge Tab Sprint
   */
  embeddedAt?: number;
}

/**
 * Chunk with search score for vector search results.
 *
 * @phase Phase 2: Evidence Layer
 */
export interface DocumentChunkWithScore extends DocumentChunk {
  /** Similarity score (0-1) from vector search. */
  score: number;

  /** Parent document metadata for display. */
  documentTitle?: string;
}

/**
 * Input type for creating a new Document.
 */
export type CreateDocumentInput = Omit<
  Document,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'chunkCount' | 'processedAt'
>;

/**
 * Input type for creating a new DocumentChunk.
 */
export type CreateDocumentChunkInput = Omit<DocumentChunk, 'id' | 'createdAt'>;

// ============================================================================
// ENTITY-DOCUMENT LINKS (Knowledge Tab Sprint - Phase 2)
// ============================================================================

/**
 * Type of relationship between an entity and a document.
 * Describes how the document relates to the entity.
 *
 * @phase Knowledge Tab Sprint - Phase 2
 */
export type DocumentRelationshipType =
  | 'documentation' // Official documentation, guides, manuals
  | 'pitch_deck' // Sales or investor pitch deck
  | 'technical_spec' // Technical specifications, architecture docs
  | 'case_study' // Customer success story, implementation example
  | 'research_paper' // Academic or industry research
  | 'competitive_intel' // Competitor analysis, market intelligence
  | 'contract' // Legal agreement, partnership terms
  | 'evidence' // Supporting evidence for claims
  | 'other'; // Miscellaneous

/**
 * Relevance level of a document link.
 */
export type DocumentRelevance = 'high' | 'medium' | 'low';

/**
 * Normalized link between an entity and a document.
 * Replaces embedded document arrays with explicit relationships.
 *
 * Stored in Firestore collection: `entityDocumentLinks`
 *
 * @phase Knowledge Tab Sprint - Phase 2
 */
export interface EntityDocumentLink {
  /** Unique identifier for the link */
  id: string;

  /** Workspace ID for multi-tenant support (default: 'default') */
  workspaceId: string;

  // ---- Link endpoints ----

  /** Type of the linked entity */
  entityType: TransformationEntityType;

  /** ID of the linked entity */
  entityId: string;

  /** ID of the linked document */
  documentId: string;

  // ---- Relationship metadata ----

  /** Type of relationship between entity and document */
  relationshipType: DocumentRelationshipType;

  /** Tags for categorization and filtering */
  tags: string[];

  /** Relevance level of this document for the entity */
  relevance: DocumentRelevance;

  /** Optional note explaining why this document matters for this entity */
  note?: string;

  // ---- AI metadata ----

  /** Whether this link was suggested by AI */
  aiSuggested?: boolean;

  /** AI confidence score for the suggestion (0-100) */
  aiConfidence?: number;

  // ---- Audit fields ----

  /** Timestamp when the link was created */
  createdAt: number;

  /** User ID who created the link */
  createdBy: string;

  /** Timestamp when the link was last updated */
  updatedAt: number;

  // ---- Graph sync status (v1.5) ----

  /** Neo4j synchronization status */
  graphSyncStatus?: GraphSyncStatus;

  /** Timestamp of last successful Neo4j sync */
  lastSyncedAt?: number;
}

/**
 * Input type for creating a new EntityDocumentLink.
 */
export type CreateEntityDocumentLinkInput = Omit<
  EntityDocumentLink,
  'id' | 'createdAt' | 'updatedAt' | 'graphSyncStatus' | 'lastSyncedAt'
>;

/**
 * Input type for updating an EntityDocumentLink.
 */
export type UpdateEntityDocumentLinkInput = Partial<
  Omit<EntityDocumentLink, 'id' | 'createdAt' | 'createdBy' | 'entityType' | 'entityId' | 'documentId' | 'workspaceId'>
>;

/**
 * EntityDocumentLink with denormalized document data for display.
 */
export interface EntityDocumentLinkWithDocument extends EntityDocumentLink {
  /** Denormalized document snapshot */
  document: {
    title: string;
    type: DocumentType;
    status: DocumentStatus;
    originalUrl?: string;
    domain?: string;
    fileSize?: number;
  };
}

// ============================================================================
// CONCEPTS (Knowledge Graph Intelligence Sprint - Phase 6)
// ============================================================================

/**
 * Type of concept for categorization and filtering.
 * Determines how the concept is used in the knowledge graph.
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 */
export type ConceptType =
  | 'tag' // General-purpose tag (AI, IoT, blockchain)
  | 'category' // Entity category (e.g., "Enterprise Software")
  | 'industry' // Industry vertical (e.g., "Healthcare", "Finance")
  | 'capability' // Business capability (e.g., "Supply Chain", "Customer Service")
  | 'domain'; // Knowledge domain (e.g., "Machine Learning", "Data Science")

/**
 * Normalized concept that unifies tag variations.
 * For example: "AI", "ai", "A.I." all map to concept "artificial-intelligence"
 * with canonicalName "Artificial Intelligence".
 *
 * Stored in Firestore collection: `concepts`
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 */
export interface Concept {
  /** Unique identifier (format: "concept-{slug}") */
  id: string;

  /** Canonical display name (e.g., "Artificial Intelligence") */
  canonicalName: string;

  /** URL-safe slug used for lookups (e.g., "artificial-intelligence") */
  slug: string;

  /** Type of concept for filtering */
  type: ConceptType;

  /** All known aliases that map to this concept (e.g., ["AI", "ai", "A.I."]) */
  aliases: string[];

  /** Optional description of the concept */
  description?: string;

  /** Parent concept ID for hierarchies (e.g., "machine-learning" is child of "artificial-intelligence") */
  parentId?: string;

  /** Number of entities tagged with this concept */
  entityCount?: number;

  /** Graph sync status for Neo4j */
  graphSyncStatus?: GraphSyncStatus;

  /** Timestamp when last synced to Neo4j */
  lastSyncedAt?: number;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Input type for creating a new Concept.
 */
export type CreateConceptInput = Omit<
  Concept,
  'id' | 'createdAt' | 'updatedAt' | 'entityCount' | 'graphSyncStatus' | 'lastSyncedAt'
>;

/**
 * Input type for updating a Concept.
 */
export type UpdateConceptInput = Partial<Omit<Concept, 'id' | 'createdAt' | 'updatedAt'>>;

// ============================================================================
// PHASE 3: NEW ENTITIES (OrgUnit, Initiative, PainPoint)
// ============================================================================

/**
 * OrgUnit level in the organizational hierarchy.
 * Level 1 is the top-level business unit.
 *
 * @phase Phase 3: New Entities
 */
export type OrgUnitLevel = 1 | 2 | 3 | 4 | 5;

/**
 * OrgUnit type for categorization.
 *
 * @phase Phase 3: New Entities
 */
export type OrgUnitType = 'business_unit' | 'department' | 'team' | 'division' | 'region' | 'subsidiary';

/**
 * Represents an organizational unit in the company hierarchy.
 * OrgUnits enable tracking of who owns initiatives and who is affected by pain points.
 *
 * **Hierarchy Example:**
 * ```
 * FrieslandCampina (Level 1)
 * +-- Dairy Division (Level 2)
 * |   +-- Cheese BU (Level 3)
 * |   +-- Milk BU (Level 3)
 * +-- Nutrition Division (Level 2)
 * |   +-- Infant Nutrition (Level 3)
 * |   +-- Adult Nutrition (Level 3)
 * +-- R&D (Level 2)
 *     +-- Innovation Lab (Level 3)
 * ```
 *
 * **Usage:**
 * - Initiative ownership: "Supply Chain Initiative owned by Logistics"
 * - PainPoint scope: "Inventory visibility affects Dairy and Nutrition"
 * - Technology adoption: "AI Lab evaluates ML technologies for all BUs"
 *
 * @example
 * ```typescript
 * const dairyDivision: OrgUnit = {
 *   id: 'org-123',
 *   name: 'Dairy Division',
 *   description: 'Responsible for cheese, milk, and butter products',
 *   type: 'division',
 *   parentId: 'org-001', // FrieslandCampina
 *   level: 2,
 *   headUserId: 'user-456',
 *   tags: ['dairy', 'core-business'],
 *   createdAt: 1704067200000,
 *   updatedAt: 1704067200000,
 * };
 * ```
 *
 * @phase Phase 3: New Entities
 */
export interface OrgUnit {
  /** Unique identifier for the org unit. */
  id: string;

  /** Display name of the org unit. */
  name: string;

  /** URL-safe slug for uniqueness enforcement (derived from name) */
  slug: string;

  /** Description of the org unit's purpose and scope. */
  description?: string;

  /** Type of organizational unit. */
  type: OrgUnitType;

  /** Parent org unit ID (null for top-level). */
  parentId?: string;

  /** Hierarchical level (1 = top-level, 2 = department, etc.). */
  level: OrgUnitLevel;

  /** User ID of the org unit head (optional). */
  headUserId?: string;

  /** Head name for display (denormalized). */
  headName?: string;

  /** Number of employees (approximate). */
  employeeCount?: number;

  /** Budget allocation (annual, in USD). */
  annualBudget?: number;

  /** Location or region. */
  location?: string;

  /** Custom tags for categorization and filtering. */
  tags: string[];

  /** Timestamp when created (milliseconds since epoch). */
  createdAt: number;

  /** Timestamp when last updated (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Input type for creating a new OrgUnit.
 */
export type CreateOrgUnitInput = Omit<OrgUnit, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

/**
 * Initiative status in the lifecycle.
 *
 * @phase Phase 3: New Entities
 */
export type InitiativeStatus =
  | 'proposed' // Initial proposal stage
  | 'approved' // Approved for execution
  | 'active' // Currently being worked on
  | 'on_hold' // Temporarily paused
  | 'completed' // Successfully completed
  | 'cancelled'; // Cancelled/abandoned

/**
 * Initiative priority level.
 *
 * @phase Phase 3: New Entities
 */
export type InitiativePriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Represents a strategic initiative.
 * Initiatives are the "missing middle" connecting Strategy -> Initiative -> Prototype.
 *
 * **Purpose:**
 * - Bridge between high-level strategy and concrete prototypes
 * - Track budget and timeline for innovation programs
 * - Assign ownership to org units and sponsors
 *
 * **Example Initiative:**
 * - Name: "Supply Chain Visibility Program"
 * - Owner: Logistics Division
 * - Sponsor: VP of Operations
 * - Budget: $500K
 * - Timeline: 12 months
 * - Linked Prototypes: IoT Tracking POC, Real-time Dashboard
 *
 * @example
 * ```typescript
 * const initiative: Initiative = {
 *   id: 'init-123',
 *   name: 'Supply Chain Visibility Program',
 *   description: 'Implement end-to-end supply chain visibility using IoT',
 *   ownerOrgUnitId: 'org-logistics',
 *   sponsorUserId: 'user-vp-ops',
 *   sponsorName: 'Jane Smith',
 *   status: 'active',
 *   priority: 'high',
 *   startDate: 1704067200000,
 *   targetEndDate: 1735603200000,
 *   budget: 500000,
 *   actualSpend: 125000,
 *   linkedStrategyIds: ['strategy-digital-transformation'],
 *   linkedPrototypeIds: ['proto-iot-tracking', 'proto-dashboard'],
 *   linkedPainPointIds: ['pain-visibility', 'pain-delays'],
 *   tags: ['supply-chain', 'iot', 'digital'],
 *   createdAt: 1704067200000,
 *   updatedAt: 1704067200000,
 * };
 * ```
 *
 * @phase Phase 3: New Entities
 */
export interface Initiative {
  /** Unique identifier for the initiative. */
  id: string;

  /** Display name of the initiative. */
  name: string;

  /** URL-safe slug for uniqueness enforcement (derived from name) */
  slug: string;

  /** Detailed description of the initiative. */
  description: string;

  /** Owning org unit ID (who pays?). */
  ownerOrgUnitId: string;

  /** Owning org unit name (denormalized for display). */
  ownerOrgUnitName?: string;

  /** Executive sponsor user ID. */
  sponsorUserId?: string;

  /** Sponsor name (denormalized for display). */
  sponsorName?: string;

  /** Current status in the initiative lifecycle. */
  status: InitiativeStatus;

  /** Priority level. */
  priority: InitiativePriority;

  /** Start date (milliseconds since epoch). */
  startDate?: number;

  /** Target end date (milliseconds since epoch). */
  targetEndDate?: number;

  /** Actual end date (milliseconds since epoch). */
  actualEndDate?: number;

  /** Budget allocation in USD. */
  budget?: number;

  /** Actual spend to date in USD. */
  actualSpend?: number;

  /** Linked strategy IDs this initiative aligns with. */
  linkedStrategyIds: string[];

  /** Linked prototype IDs (outputs of this initiative). */
  linkedPrototypeIds: string[];

  /** Linked pain point IDs this initiative addresses. */
  linkedPainPointIds: string[];

  /** Custom tags for categorization. */
  tags: string[];

  /** Key milestones and deliverables. */
  milestones?: Array<{
    id: string;
    title: string;
    targetDate?: number;
    completedDate?: number;
    status: 'pending' | 'completed' | 'missed';
  }>;

  /** External tracking links (Jira, Confluence, etc.). */
  externalLinks?: Array<{
    title: string;
    url: string;
    type: 'jira' | 'confluence' | 'sharepoint' | 'other';
  }>;

  /** Timestamp when created (milliseconds since epoch). */
  createdAt: number;

  /** Timestamp when last updated (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Input type for creating a new Initiative.
 */
export type CreateInitiativeInput = Omit<Initiative, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

/**
 * PainPoint severity level.
 *
 * @phase Phase 3: New Entities
 */
export type PainPointSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * PainPoint status in the lifecycle.
 *
 * @phase Phase 3: New Entities
 */
export type PainPointStatus =
  | 'identified' // Just discovered/documented
  | 'validated' // Confirmed as real problem
  | 'being_addressed' // Active solutions in progress
  | 'resolved'; // No longer a problem

/**
 * PainPoint category for grouping.
 *
 * @phase Phase 3: New Entities
 */
export type PainPointCategory =
  | 'operational' // Internal process/efficiency issues
  | 'customer' // Customer-facing problems
  | 'regulatory' // Compliance/regulatory challenges
  | 'technical' // Technology/infrastructure issues
  | 'market' // Market/competitive pressures
  | 'financial' // Cost/revenue issues
  | 'talent' // HR/skills gaps
  | 'other';

/**
 * Provenance for a Pain Point.
 *
 * Imported legacy rows may not carry a source-local timestamp; their parent
 * PainPoint timestamps remain authoritative and readers must not fabricate a
 * discovery time. Interactive and automated discovery sources retain the
 * existing required `discoveredAt` contract.
 */
export type PainPointSource =
  | {
      type: 'manual' | 'interview' | 'survey' | 'agent' | 'signal';
      agentId?: string;
      signalId?: string;
      intervieweeRole?: string;
      discoveredAt: number;
    }
  | {
      type: 'import';
      importSource?: string;
      createdAt?: number;
      discoveredAt?: number;
    };

/**
 * Represents a business pain point.
 * PainPoints are standalone problem statements for "Problem-Pull" innovation.
 *
 * **Purpose:**
 * - Document business problems that need solutions
 * - Track which org units are affected
 * - Link to technologies/prototypes that address the problem
 * - Enable "problem-first" innovation discovery
 *
 * **Example Pain Point:**
 * - Title: "Lack of Real-time Supply Chain Visibility"
 * - Severity: High
 * - Category: Operational
 * - Affected: Logistics, Sales, Customer Service
 * - Estimated Impact: $2M/year in delays and inefficiencies
 *
 * @example
 * ```typescript
 * const painPoint: PainPoint = {
 *   id: 'pain-123',
 *   title: 'Lack of Real-time Supply Chain Visibility',
 *   description: 'Cannot track shipments in real-time, leading to delays',
 *   severity: 'high',
 *   category: 'operational',
 *   affectedOrgUnitIds: ['org-logistics', 'org-sales'],
 *   status: 'being_addressed',
 *   estimatedImpact: 2000000,
 *   impactDescription: '$2M/year in delays, customer complaints, expediting costs',
 *   linkedPrototypeIds: ['proto-iot-tracking'],
 *   linkedTechnologyIds: ['tech-iot-sensors', 'tech-real-time-dashboard'],
 *   tags: ['supply-chain', 'visibility', 'iot'],
 *   createdAt: 1704067200000,
 *   updatedAt: 1704067200000,
 * };
 * ```
 *
 * @phase Phase 3: New Entities
 */
export interface PainPoint {
  /** Unique identifier for the pain point. */
  id: string;

  /** Short title of the pain point. */
  title: string;

  /** URL-safe slug for uniqueness enforcement (derived from title) */
  slug: string;

  /** Detailed description of the problem. */
  description: string;

  /** Severity level. */
  severity: PainPointSeverity;

  /** Category for grouping. */
  category: PainPointCategory;

  /** Org unit IDs affected by this pain point. */
  affectedOrgUnitIds: string[];

  /** Current status. */
  status: PainPointStatus;

  /** Estimated annual impact in USD. */
  estimatedImpact?: number;

  /** Actual measured impact in USD (after resolution). */
  actualImpact?: number;

  /** Human-readable impact description. */
  impactDescription?: string;

  /** Linked prototype IDs (solutions addressing this pain point). */
  linkedPrototypeIds: string[];

  /** Linked technology IDs (technologies that can solve this). */
  linkedTechnologyIds: string[];

  /** Linked initiative IDs (initiatives addressing this pain point). */
  linkedInitiativeIds: string[];

  /** Root causes (optional analysis). */
  rootCauses?: string[];

  /** Discovery source. */
  source?: PainPointSource;

  /** Custom tags for categorization. */
  tags: string[];

  /** Date when pain point was first identified. */
  identifiedAt?: number;

  /** Date when pain point was validated. */
  validatedAt?: number;

  /** Date when pain point was resolved. */
  resolvedAt?: number;

  /** Timestamp when created (milliseconds since epoch). */
  createdAt: number;

  /** Timestamp when last updated (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Input type for creating a new PainPoint.
 */
export type CreatePainPointInput = Omit<PainPoint, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

// ============================================================================
// SCOUTING FEATURE TYPES (Company, Contact, UseCase)
// ============================================================================

/**
 * Company type classifications for categorization.
 * Represents the company's lifecycle stage and organizational type.
 * A company can have multiple types.
 *
 * @migration Legacy values (Vendor, Partner, Competitor) are migrated to company.tags[]
 */
export type CompanyType =
  | 'startup' // Early-stage, pre-product-market fit
  | 'scaleup' // Growth stage, scaling operations
  | 'sme' // Small/medium enterprise, stable
  | 'corporate' // Large established company
  | 'spinoff' // Corporate spin-off
  | 'joint_venture' // Joint venture between companies
  | 'research' // Research institution / university
  | 'accelerator' // Accelerator or incubator
  | 'venture_studio' // Venture studio / company builder
  | 'consultancy' // Consulting / service provider
  | 'government' // Government agency or body
  | 'ngo' // Non-governmental organization
  | 'consortium' // Industry consortium
  | 'academic'; // Academic institution (distinct from research)

/**
 * Company size categories based on employee count.
 */
export type CompanySize =
  | 'micro' // 1-9 employees
  | 'small' // 10-49 employees
  | 'medium' // 50-249 employees
  | 'large' // 250-999 employees
  | 'enterprise'; // 1000+ employees

/**
 * Funding/business stage for companies.
 */
export type CompanyStage =
  | 'pre_seed' // Pre-seed funding
  | 'seed' // Seed round
  | 'series_a' // Series A
  | 'series_b' // Series B
  | 'series_c_plus' // Series C+
  | 'bootstrapped' // Self-funded
  | 'private' // Private, late stage
  | 'public' // Publicly traded
  | 'ipo' // Recently IPO'd
  | 'nonprofit'; // Non-profit organization

/**
 * Industry classification for companies.
 * Uses a strict enum with 'other' option for flexibility.
 */
export type CompanyIndustry =
  | 'healthcare' // Healthcare & Life Sciences
  | 'food_agriculture' // Food & Agriculture
  | 'technology' // Technology & Software
  | 'manufacturing' // Manufacturing & Industrial
  | 'energy' // Energy & Environment
  | 'consumer' // Consumer & Retail
  | 'financial' // Financial Services
  | 'logistics' // Logistics & Infrastructure
  | 'media' // Media & Entertainment
  | 'professional' // Professional Services
  | 'defense' // Defense & Aerospace
  | 'education' // Education & EdTech
  | 'real_estate' // Real Estate & PropTech
  | 'telecommunications' // Telecommunications
  | 'automotive' // Automotive & Mobility
  | 'chemicals' // Chemicals & Materials
  | 'other'; // Other (requires industryCustom)

/**
 * Display labels for CompanyIndustry enum values.
 */
export const COMPANY_INDUSTRY_LABELS: Record<CompanyIndustry, string> = {
  healthcare: 'Healthcare & Life Sciences',
  food_agriculture: 'Food & Agriculture',
  technology: 'Technology & Software',
  manufacturing: 'Manufacturing & Industrial',
  energy: 'Energy & Environment',
  consumer: 'Consumer & Retail',
  financial: 'Financial Services',
  logistics: 'Logistics & Infrastructure',
  media: 'Media & Entertainment',
  professional: 'Professional Services',
  defense: 'Defense & Aerospace',
  education: 'Education & EdTech',
  real_estate: 'Real Estate & PropTech',
  telecommunications: 'Telecommunications',
  automotive: 'Automotive & Mobility',
  chemicals: 'Chemicals & Materials',
  other: 'Other',
};

/**
 * Display labels for CompanyType enum values.
 */
export const COMPANY_TYPE_LABELS: Record<CompanyType, string> = {
  startup: 'Startup',
  scaleup: 'Scaleup',
  sme: 'SME',
  corporate: 'Corporate',
  spinoff: 'Spin-off',
  joint_venture: 'Joint Venture',
  research: 'Research Institution',
  accelerator: 'Accelerator/Incubator',
  venture_studio: 'Venture Studio',
  consultancy: 'Consultancy',
  government: 'Government',
  ngo: 'NGO',
  consortium: 'Consortium',
  academic: 'Academic Institution',
};

/**
 * Display labels for CompanySize enum values.
 */
export const COMPANY_SIZE_LABELS: Record<CompanySize, string> = {
  micro: 'Micro (1-9)',
  small: 'Small (10-49)',
  medium: 'Medium (50-249)',
  large: 'Large (250-999)',
  enterprise: 'Enterprise (1000+)',
};

/**
 * Display labels for CompanyStage enum values.
 */
export const COMPANY_STAGE_LABELS: Record<CompanyStage, string> = {
  pre_seed: 'Pre-seed',
  seed: 'Seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c_plus: 'Series C+',
  bootstrapped: 'Bootstrapped',
  private: 'Private',
  public: 'Public',
  ipo: 'IPO',
  nonprofit: 'Non-profit',
};

/**
 * Current status of the relationship with a company.
 * Represents the engagement workflow state.
 */
export type CompanyStatus =
  | 'Watching' // On radar but no contact
  | 'Contacted' // Initial contact made
  | 'Partner' // Active partnership
  | 'Rejected'; // Evaluated but not pursuing

/**
 * Type of relationship between a company and a radar blip.
 */
export type RelationshipType =
  | 'Vendor' // Company provides this technology
  | 'User' // Company uses this technology
  | 'Partner' // Collaborative relationship on this tech
  | 'Competitor'; // Company is a competitor in this space

/**
 * Type of company note/comment for categorization.
 */
export type NoteType = 'Meeting' | 'Email' | 'Demo' | 'Evaluation' | 'General';

/**
 * Represents a Use Case - a specific problem or opportunity that technologies can address.
 * Use cases can be linked to radar entries and companies.
 */
export interface UseCase {
  /** Unique identifier for the use case. */
  id: string;
  /** Name/title of the use case. */
  title: string;
  /** URL-safe slug for uniqueness enforcement (derived from title) */
  slug: string;
  /** Detailed description of the use case. */
  description: string;
  /** The problem this use case aims to solve. */
  problem?: string;
  /** The proposed solution or approach for this use case. */
  solution?: string;
  /** Expected outcomes or benefits if this use case is addressed. */
  outcomes?: string[];
  /** Current status of the use case. */
  status: 'Proposed' | 'In Progress' | 'Implemented' | 'Archived';
  /** Optional category for organizational purposes. */
  category?: string;
  /** Array of radar entry IDs (blips) linked to this use case. */
  radarTechnologyIds: string[];
  /** Array of company IDs that can address this use case. */
  companyIds: string[];
  /** Custom tags for categorization. */
  tags: string[];
  /** Optional: Radar ID if use case is radar-specific. */
  radarId?: string;
  /** Source lineage for agent-created use cases (optional). */
  source?: {
    type: 'agent' | 'signal';
    agentId?: string;
    agentName?: string;
    signalId?: string;
    taskTemplate?: string;
    createdAt: number;
  };
  /** AI metadata for agent-discovered use cases (optional). */
  aiMetadata?: {
    relevanceScore?: number;
    discoveredAt?: number;
  };
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last update (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Funding information for a company.
 */
export interface CompanyFunding {
  /** Total funding raised (e.g., "$10M"). */
  totalRaised?: string;
  /** Most recent funding round (e.g., "Series B"). */
  lastRound?: string;
  /** List of investor names. */
  investors: string[];
}

/**
 * Social media and web presence links for a company.
 */
export interface CompanySocialLinks {
  /** LinkedIn company page URL. */
  linkedin?: string;
  /** Twitter/X company account URL. */
  twitter?: string;
  /** GitHub organization URL. */
  github?: string;
  /** Additional custom links. */
  [key: string]: string | undefined;
}

/**
 * Company location information.
 */
export interface CompanyLocation {
  /** City name. */
  city: string;
  /** Country name. */
  country: string;
}

/**
 * Document or file reference attached to a company.
 */
export interface CompanyDocument {
  /** Unique identifier for the document. */
  id: string;
  /** Display name of the document. */
  name: string;
  /** Type of document reference. */
  type: 'upload' | 'link';
  /** URL to the document (Firebase Storage URL or external link). */
  url: string;
  /** Timestamp when document was added (milliseconds since epoch). */
  uploadedAt: number;
}

/**
 * AI research data for a company.
 * Stores the results of automated company research.
 * @deprecated Use CompanyResearch instead for comprehensive research data.
 */
export interface CompanyAIResearch {
  /** When the research was last performed (milliseconds since epoch). */
  lastResearched: number;
  /** Structured research data (flexible schema). */
  data: Record<string, any>;
}

/**
 * Comprehensive research data for a company.
 * Stores structured results of AI-powered company analysis.
 */
export interface CompanyResearch {
  /** When research was last performed (milliseconds since epoch) */
  lastResearched: number;

  /** Research version for cache invalidation */
  version: number;

  /** Executive Summary */
  executiveSummary?: {
    overview: string;
    keyHighlights: string[];
    suggestedTags?: string[];
    recommendation?: string;
  };

  /** Company Profile - Basic company information for Overview tab */
  companyProfile?: {
    website?: string;
    companyType?: CompanyType;
    industries?: string[];
    size?: CompanySize;
    stage?: CompanyStage;
    headquarters?: {
      city?: string;
      country?: string;
    };
    socialLinks?: {
      linkedin?: string;
      twitter?: string;
      github?: string;
    };
    foundedYear?: number;
  };

  /** Products & Solutions */
  productsAndSolutions?: {
    productPortfolio?: string[];
    coreProducts?: Array<{
      name: string;
      description: string;
      category?: string;
    }>;
    deploymentModel?: 'cloud' | 'on-premise' | 'hybrid' | 'saas';
    integrationCapabilities?: string[];
    productMaturity?: 'emerging' | 'growing' | 'mature' | 'declining';
  };

  /** Financials & Traction */
  financialsAndTraction?: {
    fundingHistory?: Array<{
      round: string;
      amount?: string;
      date?: string;
      investors?: string[];
    }>;
    totalRaised?: string;
    keyInvestors?: string[];
    revenueRange?: string;
    revenueModel?: 'subscription' | 'transactional' | 'licensing' | 'freemium' | 'hybrid';
    customerCount?: string;
    lastYearEarnings?: string;
    /** SWOT Analysis (moved from separate tab) */
    swot?: {
      strengths: string[];
      weaknesses: string[];
      opportunities: string[];
      threats: string[];
    };
  };

  /** Team & Leadership */
  teamAndLeadership?: {
    founders?: Array<{
      name: string;
      role: string;
      background?: string;
      linkedIn?: string;
    }>;
    keyExecutives?: Array<{
      name: string;
      role: string;
      background?: string;
    }>;
    teamSize?: string;
    engineeringRatio?: string;
    notableHires?: Array<{
      name: string;
      role: string;
      previousCompany?: string;
    }>;
  };

  /** Innovation Indicators */
  innovationIndicators?: {
    patentCount?: number;
    productVelocity?: 'low' | 'medium' | 'high';
    openSourceActivity?: {
      repos?: number;
      stars?: number;
      contributors?: number;
    };
    technicalPublications?: string[];
  };

  /** Partnerships & Ecosystem */
  partnershipsAndEcosystem?: {
    strategicPartners?: string[];
    technologyPartners?: string[];
    channelPartners?: string[];
    ecosystemPosition?: 'leader' | 'challenger' | 'follower' | 'niche';
  };

  /** Risk Assessment */
  riskAssessment?: {
    vendorRiskScore?: number; // 0-100
    regulatoryExposure?: 'low' | 'medium' | 'high';
    dependencyRisks?: string[];
    financialHealth?: 'strong' | 'stable' | 'concerning' | 'critical';
  };

  /** Research sources and confidence */
  metadata?: {
    sources: string[];
    confidenceScore: number;
    model: string;
  };
}

/**
 * Represents a company in the Scouting system.
 * Companies can be vendors, partners, competitors, or startups related to radar technologies.
 */
export interface Company {
  /** Unique identifier for the company. */
  id: string;
  /** Company name. */
  name: string;
  /** URL-safe slug for uniqueness enforcement (derived from name) */
  slug: string;
  /** Company description/overview. */
  description: string;
  /** URL to company logo (auto-fetched or uploaded). */
  logo?: string;
  /** Company website URL. */
  website: string;
  /** Array of company type classifications. */
  type: CompanyType[];
  /** Array of industries the company operates in (enum values). */
  industry: CompanyIndustry[];
  /** Custom industry names when 'other' is selected in industry array. */
  industryCustom?: string[];
  /** Company size category. Optional: research abstains when it cannot source it (AI-028). */
  size?: CompanySize;
  /** Funding/business stage. Optional: research abstains when it cannot source it (AI-028). */
  stage?: CompanyStage;
  /** Company headquarters location. */
  location: CompanyLocation;
  /** Current relationship status. */
  status: CompanyStatus;
  /** Custom tags for flexible categorization. */
  tags: string[];
  /** Social media and web presence links. */
  socialLinks: CompanySocialLinks;
  /** Funding information (optional). */
  fundingInfo?: CompanyFunding;
  /** Technologies the company uses or provides. */
  technologyStack: string[];
  /** Attached documents and links. */
  documents: CompanyDocument[];
  /** AI research results (optional). @deprecated Use research instead */
  aiResearch?: CompanyAIResearch;
  /** Comprehensive research data (optional). */
  research?: CompanyResearch;
  /** SWOT Analysis data (optional). */
  swot?: {
    strengths: string[];
    weaknesses: string[];
    opportunities: string[];
    threats: string[];
  };
  /** Source lineage for agent-created companies (optional). */
  source?: {
    type: 'agent' | 'signal';
    agentId?: string;
    agentName?: string;
    signalId?: string;
    taskTemplate?: string;
    createdAt: number;
  };
  /** AI metadata for agent-discovered companies (optional). */
  aiMetadata?: {
    relevanceScore?: number;
    discoveredAt?: number;
  };
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last update (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Represents a contact person within a company.
 * Companies can have multiple contacts.
 */
export interface Contact {
  /** Unique identifier for the contact. */
  id: string;
  /** Parent company ID. */
  companyId: string;
  /** Contact's full name. */
  name: string;
  /** Job title or role. */
  role: string;
  /** Email address. */
  email: string;
  /** Phone number (optional). */
  phone?: string;
  /** LinkedIn profile URL (optional). */
  linkedin?: string;
  /** Additional notes about this contact. */
  notes: string;
  /** Whether this is the primary contact for the company. */
  isPrimary: boolean;
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last update (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Represents the relationship between a company and a radar blip (entry).
 * Enables many-to-many relationships with metadata.
 */
export interface CompanyBlipRelationship {
  /** Unique identifier for the relationship. */
  id: string;
  /** Company ID. */
  companyId: string;
  /** Radar ID (which radar this relationship belongs to). */
  radarId: string;
  /** Radar entry ID (numeric ID of the blip). */
  radarEntryId: number;
  /** Type of relationship between company and technology. */
  relationshipType: RelationshipType;
  /** Notes specific to this relationship. */
  notes: string;
  /** Optional: Use case IDs that this relationship addresses. */
  useCaseIds?: string[];
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last update (milliseconds since epoch). */
  updatedAt: number;
}

/**
 * Represents a note or comment about a company.
 * Used to track interactions, meetings, and general observations.
 */
export interface CompanyNote {
  /** Unique identifier for the note. */
  id: string;
  /** Parent company ID. */
  companyId: string;
  /** User ID of the note author (future: integrate with auth). */
  userId?: string;
  /** Note content (supports markdown). */
  content: string;
  /** Type of note for categorization. */
  type: NoteType;
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last edit (milliseconds since epoch). Absent on notes never
   * edited (or edited before UX-006 introduced the stamp); readers fall back
   * to `createdAt`. The Notes tab shows its "edited" marker when this exceeds
   * `createdAt`. */
  updatedAt?: number;
}

// ============================================================================
// PROTOTYPE MANAGEMENT TYPES
// ============================================================================

/**
 * Document or artifact attached to a prototype.
 * Can be uploaded files (stored in Firebase Storage) or external links.
 */
export interface PrototypeDocument {
  /** Unique identifier for the document. */
  id: string;
  /** Display name of the document. */
  name: string;
  /** Type of document reference. */
  type: 'upload' | 'link';
  /** URL to the document (Firebase Storage URL or external link). */
  url: string;
  /** Timestamp when document was added (milliseconds since epoch). */
  uploadedAt: number;
}

/**
 * Cost breakdown item for detailed prototype cost tracking.
 * Phase 0 Task 0.2.4 - Granular cost tracking.
 */
export interface PrototypeCostBreakdownItem {
  /** Category of the cost (e.g., "Hardware", "Cloud", "Licensing", "Labor") */
  category: string;
  /** Amount in the prototype's currency */
  amount: number;
  /** Optional description of this cost line item */
  description?: string;
}

/**
 * Cost tracking data for a prototype.
 * Phase 0 Task 0.2.4 - Tracks estimated and actual costs.
 *
 * The `estimated` field can be auto-populated from linked technology's
 * `costToPrototype` value when a prototype is created.
 */
export interface PrototypeCosts {
  /** Estimated cost from linked technology's costToPrototype (in thousands, e.g., 50 = $50k) */
  estimated?: number;
  /** Actual incurred cost (in thousands, e.g., 75 = $75k) */
  actual?: number;
  /** Currency code (default: 'USD') */
  currency: string;
  /** Detailed cost breakdown by category */
  breakdown?: PrototypeCostBreakdownItem[];
  /** Timestamp when costs were last updated (milliseconds since epoch) */
  lastUpdated: number;
}

/**
 * Impact measurement data for a prototype.
 * Tracks both estimated and actual value delivered by the prototype.
 */
export interface PrototypeImpact {
  /** Type of business impact */
  type: 'Revenue Generation' | 'Cost Saving' | 'Business Transformation' | 'Risk Mitigation';

  /** Estimated value in USD */
  estimatedValue: number;

  /** Actual measured value in USD (if available) */
  actualValue?: number;

  /** Time to realize the impact (e.g., "3 months", "1 year") */
  timeToImpact: string;

  /** Confidence level in the estimate (0-100%) */
  confidence: number;

  /** Date when impact was actually measured (milliseconds since epoch) */
  measuredDate?: number;

  /** Additional notes about impact measurement */
  notes: string;
}

/**
 * Represents a prototype project demonstrating technology value to business units.
 * Prototypes are the bridge between radar technologies and tangible business outcomes.
 *
 * **Traceability Flow:**
 * Signal -> Technology -> Prototype -> Impact
 *
 * **Lifecycle:**
 * Ideation -> In Development -> Demo Ready -> Delivered -> Archived
 */
export interface Prototype {
  /** Unique identifier for the prototype */
  id: string;

  /** Prototype name/title */
  name: string;

  /** URL-safe slug for uniqueness enforcement (derived from name) */
  slug: string;

  /** Detailed description of what the prototype does */
  description: string;

  /** Current status in the prototype lifecycle */
  status: 'Ideation' | 'In Development' | 'Demo Ready' | 'Delivered' | 'Archived';

  /**
   * Linked technologies (radar entries) used in this prototype.
   * Format: "radarId:entryId" (e.g., "nutrition-bu:42")
   */
  linkedTechnologies: string[];

  /** Linked companies (vendors/partners used) */
  linkedCompanies: string[];

  /** Linked use cases this prototype addresses */
  linkedUseCases: string[];

  /** Linked strategies this prototype aligns with */
  linkedStrategies: string[];

  /** Target business unit name (matches an Org Unit of type 'business_unit') */
  targetBusinessUnit: string;

  /** Names of stakeholders/VPs who reviewed the prototype */
  presentedTo: string[];

  /** Date when prototype was presented to stakeholders (milliseconds since epoch) */
  presentationDate?: number;

  /**
   * Demo artifacts and resources.
   * Includes links to demos, repos, videos, and presentations.
   */
  artifacts: {
    /** Live demo URL (if available) */
    demoUrl?: string;
    /** Source code repository URL (e.g., GitHub) */
    repoUrl?: string;
    /** Demo video URL (e.g., Loom, YouTube) */
    demoVideo?: string;
    /** Presentation documents */
    presentations: PrototypeDocument[];
  };

  /** Impact measurement data */
  impact: PrototypeImpact;

  /**
   * Cost tracking data for the prototype (Phase 0 Task 0.2.4).
   * Tracks estimated and actual costs with optional breakdown.
   * Estimated cost can be auto-populated from linked technology's costToPrototype.
   */
  costs?: PrototypeCosts;

  /** Optional Jira epic link for large projects tracked externally */
  jiraEpic?: string;

  /** Team members who built the prototype */
  team: string[];

  /** AI-generated executive summary of the prototype (optional) */
  aiGeneratedBrief?: string;

  /** Timestamp of creation (milliseconds since epoch) */
  createdAt: number;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Prototype status type - exported for test files
 */
export type PrototypeStatus = 'Ideation' | 'In Development' | 'Demo Ready' | 'Delivered' | 'Archived';

/**
 * Business unit type - exported for test files
 */
export type BusinessUnit = string;

// ============================================================================
// EXTERNAL SIGNAL DETECTION TYPES
// ============================================================================

/**
 * Type of external signal source.
 * Each type corresponds to a different data fetcher.
 */
export type SignalType =
  | 'patent' // Google Patents, USPTO
  | 'paper' // arXiv, PubMed, IEEE
  | 'news' // NewsAPI, RSS feeds
  | 'funding' // Crunchbase, PitchBook
  | 'github' // GitHub trending, stars, forks
  | 'trend' // Google Trends
  | 'hackernews' // Hacker News (Algolia)
  | 'filing'; // SEC EDGAR filings

/**
 * Status of a signal in the review/import workflow.
 */
export type SignalStatus =
  | 'Detected' // Just detected by automated monitoring
  | 'Validated' // AI validation completed, awaiting human review
  | 'Approved' // Human approved, ready for import
  | 'Rejected' // Human rejected, not relevant
  | 'Imported' // Successfully imported as technology/company/use case
  | 'Archived'; // Archived for historical reference

/**
 * Sentiment analysis result for a signal.
 */
export type SignalSentiment = 'positive' | 'neutral' | 'negative';

/**
 * Represents an external signal detected by automated monitoring.
 * Signals are potential new technologies, companies, or market trends
 * discovered from patents, research papers, news, funding data, or GitHub.
 *
 * **Signal Lifecycle:**
 * 1. Detected (by background job)
 * 2. Validated (AI scores relevance and alignment)
 * 3. Approved/Rejected (by human if below auto-import threshold)
 * 4. Imported (converted to technology/company/use case)
 *
 * **Autopilot Mode:**
 * Signals with relevanceScore >= 90% are auto-imported.
 *
 * **Co-pilot Mode:**
 * All signals require human approval before import.
 */
export interface Signal {
  /** Unique identifier for the signal */
  id: string;

  /** Type of signal source */
  type: SignalType;

  /** Signal title/headline */
  title: string;

  /** URL-safe slug for uniqueness enforcement (derived from title) */
  slug: string;

  /** Signal description/summary */
  description: string;

  /** Source name (e.g., "Google Patents", "arXiv", "TechCrunch") */
  source: string;

  /** URL to the original source */
  url: string;

  /** Publication/detection date (milliseconds since epoch) */
  date: number;

  /** Additional metadata from the source */
  metadata?: Record<string, any>;

  /** AI-calculated relevance score (0-100%). Based on keyword matching and content analysis. */
  relevanceScore: number;

  /** AI-calculated strategic alignment score (0-100%). Based on strategy directives. */
  alignmentScore: number;

  /** Strategy IDs this signal aligns with */
  alignedStrategies: string[];

  /**
   * Automatically linked existing entities.
   * AI attempts to match signal to existing radar entries, companies, or use cases.
   */
  linkedEntities: {
    /** Existing technology IDs (format: "radarId:entryId") */
    technologies?: string[];
    /** Existing company IDs */
    companies?: string[];
    /** Existing use case IDs */
    useCases?: string[];
  };

  /** Current status in the signal workflow */
  status: SignalStatus;

  /**
   * Reference to imported entity (if signal was converted).
   * Example: If signal became a new technology, this stores the technology ID.
   */
  importedAs?: {
    type: 'technology' | 'company' | 'useCase';
    id: string;
  };

  /** AI sentiment analysis of the signal content */
  sentiment: SignalSentiment;

  /** AI-generated summary of the signal (2-3 sentences) */
  aiSummary: string;

  /** AI-generated validation notes (why relevant, why aligned, concerns) */
  validationNotes?: string;

  /**
   * Deep research data (optional).
   * Triggered for high-relevance signals to gather comprehensive insights.
   */
  deepResearch?: {
    /** When deep research was performed */
    performedAt: number;
    /** Full research results (structured data from deep-research flow) */
    data: Record<string, unknown>;
  };

  /**
   * Expanded content with deep analysis (Phase 4 enhancement).
   * Automatically generated after signal creation via background job.
   */
  expandedContent?: {
    /** Company/Technology deep dive */
    entityProfile?: {
      type: 'company' | 'technology' | 'trend';
      summary: string;
      keyFacts: string[];
      recentDevelopments: string[];
      keyPlayers?: string[];
      maturityAssessment?: string;
    };

    /** Strategic relevance analysis */
    strategicAnalysis?: {
      alignedStrategies: Array<{
        strategyId: string;
        strategyName: string;
        alignmentScore: number;
        alignmentReason: string;
      }>;
      radarImpact?: string;
      competitiveImplications?: string;
      opportunityOrThreat: 'opportunity' | 'threat' | 'neutral';
    };

    /** Actionable recommendations */
    recommendations?: {
      suggestedNextSteps: string[];
      questionsForInvestigation: string[];
      suggestedRadarPlacement?: {
        quadrant: string;
        ring: string;
        rationale: string;
      };
    };

    /** Related items */
    relatedItems?: {
      technologies: Array<{ id: string; name: string; relevance: string }>;
      companies: Array<{ id: string; name: string; relevance: string }>;
      signals: Array<{ id: string; title: string; relevance: string }>;
    };

    /** Reference sources used for analysis */
    sources?: Array<{
      title: string;
      url: string;
      /** Whether this source supports the signal's central claim. */
      verdict?: 'confirming' | 'contradicting' | 'inconclusive';
      description?: string;
      date?: string;
    }>;

    /** Expansion metadata */
    expandedAt: number;
    expansionModel: string;
    expansionDuration: number; // milliseconds
  };

  /**
   * GRAPH-063 — endpoints the expansion proposed that name nothing in this
   * workspace (or nothing the graph can ever project). They are dropped before
   * `expandedContent.relatedItems` is stored, and recorded here so an operator
   * can see what the model invented instead of it vanishing silently.
   */
  expansionRejectedEndpoints?: Array<{
    kind: 'technologies' | 'companies' | 'signals';
    proposedId: string;
    proposedLabel: string;
    reason: string;
  }>;

  /** Count of dropped endpoints for the most recent expansion (may exceed the stored list). */
  expansionRejectedEndpointCount?: number;

  /**
   * Trust score system (Phase 4 enhancement).
   * Provides confidence metrics for signal quality.
   */
  trustScore?: {
    overall: number; // 0-100
    breakdown: {
      sourceReliability: number; // 0-100: academic > news > social
      dataCompleteness: number; // 0-100: % of fields populated
      corroboration: number; // 0-100: multiple sources?
      aiConfidence: number; // 0-100: LLM's confidence
    };
    factors: string[]; // Human-readable factors
  };

  /**
   * User feedback system (Phase 4 enhancement).
   * Enables quality tracking and agent improvement.
   */
  feedback?: {
    vote?: 'up' | 'down';
    votedAt?: number;
    votedBy?: string;
    reason?: string; // Optional explanation for rejection
    includedInFeedbackLoop: boolean; // Whether to use for agent tuning
  };

  /** Timestamp when signal was detected (milliseconds since epoch) */
  detectedAt: number;

  /** Timestamp when signal was reviewed by human (milliseconds since epoch) */
  reviewedAt?: number;

  /**
   * UID of the human who reviewed the signal. Written server-side alongside
   * `reviewedAt` by `submitSignalFeedback(..., updateStatus = true)`
   * (`src/lib/signals/feedback.ts`) through an untyped update payload — the
   * type was simply lagging the write.
   */
  reviewedBy?: string;

  /** Timestamp when signal was processed/imported (milliseconds since epoch) */
  processedAt?: number;
}

// ============================================================================
// ENHANCED STRATEGY TYPES
// ============================================================================

/**
 * A single strategic directive.
 * Directives are explicit, measurable north-star statements that guide AI decision-making.
 *
 * **Example:**
 * - "Increase sustainable sourcing by 50%"
 * - "Launch 10 personalized nutrition products by 2027"
 * - "Reduce formulation time by 30%"
 */
export interface StrategyDirective {
  /** Unique identifier for the directive */
  id: string;

  /** The directive statement (explicit goal or constraint) */
  directive: string;

  /** Category for grouping */
  category: 'Growth' | 'Sustainability' | 'Innovation' | 'Efficiency' | 'Risk' | 'Custom';

  /**
   * Target metrics (optional).
   * Used for measuring progress and AI scoring.
   */
  metrics?: {
    /** Target value (e.g., "50% increase", "10 products") */
    target: string;
    /** Timeline to achieve target (e.g., "by 2027", "within 18 months") */
    timeline: string;
    /** Baseline value (e.g., "Current: 20%") */
    baseline?: string;
  };

  /**
   * Weight/priority of this directive (1-10).
   * Higher priority directives have more influence on AI scoring.
   * Default: 5
   */
  priority: number;
}

/**
 * Enhanced document type for strategies.
 * Includes AI extraction results.
 */
export interface StrategyDocument {
  /** Unique identifier for the document */
  id: string;

  /** Display name of the document */
  name: string;

  /** Type of document reference */
  type: 'upload' | 'link';

  /** URL to the document (Firebase Storage URL or external link) */
  url: string;

  /** Timestamp when document was added (milliseconds since epoch) */
  uploadedAt: number;

  /**
   * AI extraction results (optional).
   * Populated after smart document processing.
   */
  aiExtraction?: {
    /** AI-generated summary of document content */
    summary: string;
    /** Key points extracted from document */
    keyPoints: string[];
    /** Directives extracted by AI (suggestions for mainDirectives) */
    extractedDirectives: string[];
    /** When extraction was performed */
    processedAt: number;
  };
}

/**
 * Enhanced Strategy interface.
 *
 * **Changes from original:**
 * - Added `mainDirectives` array for structured goals
 * - Changed `links` to `documents` with AI extraction support
 * - Added `aiGeneratedSummary` for quick overview
 *
 * **Migration Required:**
 * Existing strategies need to add these new fields.
 * Default values:
 * - mainDirectives: []
 * - documents: (convert existing links)
 * - aiGeneratedSummary: undefined (will be generated on first load)
 */
export interface Strategy {
  /** Unique identifier for the strategy */
  id: string;

  /** Strategy name/title */
  name: string;

  /** URL-safe slug for uniqueness enforcement (derived from name) */
  slug: string;

  /** Brief summary of the strategy */
  description: string;

  /**
   * Main strategic directives (NEW).
   * Explicit, measurable goals that guide AI decision-making.
   * These are used by EvaluationAgent to score technology alignment.
   */
  mainDirectives: StrategyDirective[];

  /** Rich text content (markdown) */
  content: string;

  /**
   * Attached documents (UPDATED).
   * Previously was simple links, now supports uploads with AI extraction.
   */
  documents: StrategyDocument[];

  /**
   * External links (kept for backward compatibility).
   * Simple reference links without AI processing.
   */
  links: { title: string; url: string }[];

  /**
   * AI-generated summary (NEW).
   * Auto-generated from content and directives.
   * Updated whenever strategy content changes.
   */
  aiGeneratedSummary?: string;

  /** Timestamp of creation (milliseconds since epoch) */
  createdAt: number;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
}

// ============================================================================
// DASHBOARD DATA TYPES
// ============================================================================

/**
 * Individual item that needs user attention (for Dashboard).
 */
export interface NeedsAttentionItem {
  /** Unique identifier for this attention item */
  id: string;

  /** Type of item */
  type:
    | 'signal-pending'
    | 'signal-high-confidence'
    | 'technology-low-score'
    | 'technology-outdated'
    | 'agent-pending'
    | 'prototype-deadline';

  /** Title of the item */
  title: string;

  /** Description explaining why attention is needed */
  description: string;

  /** Priority level */
  priority: 'high' | 'medium' | 'low';

  /** Timestamp when the item was created/detected */
  timestamp: number;

  /** URL to navigate to for taking action */
  actionUrl: string;

  /** Additional metadata specific to the item type */
  metadata?: Record<string, any>;
}

/**
 * Portfolio metrics (for Dashboard).
 */
export interface PortfolioMetrics {
  /** Total number of technologies across all radars */
  totalTechnologies: number;

  /** Technologies grouped by ring */
  technologiesByRing: Record<string, number>;

  /**
   * Technologies grouped by stable `quadrantId`, with a denormalized display
   * name and placement count. Callers iterate `Object.values()` and read
   * `.name` / `.count` instead of treating the value as a raw number.
   */
  technologiesByQuadrant: Record<string, { name: string; count: number }>;

  /** Average strategic alignment score across all technologies */
  averageStrategicAlignment: number;

  /** Total number of companies tracked */
  totalCompanies: number;

  /** Total number of use cases */
  totalUseCases: number;

  /** Total number of strategies */
  totalStrategies: number;

  /** Total number of pain points */
  totalPainPoints: number;

  /** Prototype metrics */
  prototypeMetrics: {
    /** Total number of prototypes */
    total: number;
    /** Prototypes grouped by status */
    byStatus: Record<string, number>;
    /** Number of active prototypes (In Development, Demo Ready) */
    activeCount: number;
    /** Number of delivered prototypes */
    deliveredCount: number;
    /** Total estimated value across all prototypes */
    totalEstimatedValue: number;
    /** Total actual value from delivered prototypes */
    totalActualValue: number;
  };

  /** Signal detection metrics */
  signalMetrics: {
    /** Total number of signals detected */
    totalDetected: number;
    /** Number of signals pending review */
    pendingReview: number;
    /** Import rate (percentage of signals imported) */
    importRate: number;
    /** Average relevance score */
    averageRelevance: number;
    /** Signals grouped by type */
    byType: Record<string, number>;
  };

  /** Agent activity metrics */
  agentMetrics: {
    /** Total number of agent activities */
    totalActivities: number;
    /** Number of activities pending review */
    pendingReview: number;
    /** Auto-action rate (percentage of activities auto-approved) */
    autoActionRate: number;
    /** Average confidence score */
    averageConfidence: number;
    /** Activities grouped by agent type */
    byAgent: Record<string, number>;
  };
}

/**
 * A cross-entity update event (for Dashboard).
 * Tracks recent changes across all entity types.
 */
export interface DashboardUpdate {
  /** Unique identifier for the update */
  id: string;

  /** Type of entity that was updated */
  entityType: 'technology' | 'company' | 'prototype' | 'useCase' | 'strategy' | 'signal';

  /** ID of the entity */
  entityId: string;

  /** Name of the entity */
  entityName: string;

  /** Action performed */
  action: 'created' | 'updated' | 'deleted' | 'moved' | 'imported' | 'status_change';

  /** Human-readable description of the update */
  description: string;

  /** Timestamp of the update (milliseconds since epoch) */
  timestamp: number;

  /** URL to navigate to for viewing the update */
  actionUrl: string;
}

/**
 * Complete dashboard data.
 * Aggregated from multiple sources for the Dashboard UI.
 */
export interface DashboardData {
  /** Items requiring user attention */
  needsAttention: NeedsAttentionItem[];

  /** Portfolio metrics */
  portfolioMetrics: PortfolioMetrics;

  /** Recent agent activities (AI Agent Feed) */
  agentFeed: import('./agents').AgentActivity[];

  /** Recent cross-entity updates */
  recentUpdates: DashboardUpdate[];

  /** Timestamp when the dashboard data was last refreshed */
  lastRefreshed: number;
}
