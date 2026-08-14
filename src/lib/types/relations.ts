// ============================================================================
// RELATION TYPES
// ============================================================================
// Denormalized relations, proposed relations, evidence references,
// entity aliases, linker metrics, and reviewer feedback.

import type { EntityType, EntitySnapshot, EvidenceRef } from './common';

// ============================================================================
// DENORMALIZED RELATIONS TYPES (v3.0)
// ============================================================================

/**
 * Type of relationship between entities.
 * Used for tracking connections across the system.
 */
export type RelationType =
  | 'uses' // Technology uses another technology
  | 'enables' // Technology enables another technology
  | 'competes_with' // Technologies compete in the same space
  | 'vendor' // Company provides technology
  | 'user' // Company uses technology
  | 'partner' // Company partners on technology
  | 'competitor' // Company competes in technology space
  | 'addresses' // Technology addresses use case
  | 'requires' // Use case requires technology
  | 'aligns_with' // Technology aligns with strategy
  | 'supports' // Prototype uses technology
  | 'owned_by' // Entity owned by org unit (Phase 3)
  | 'sponsors' // OrgUnit sponsors initiative (Phase 3)
  | 'funds' // Initiative funds prototype (Phase 3)
  | 'solves' // Prototype/Technology solves pain point (Phase 3)
  | 'impacts' // Pain point impacts org unit (Phase 3)
  | 'drives' // Pain point drives initiative (Phase 3)
  // Universal Relations Sprint - new relation types
  | 'mentions' // Signal/Document mentions entity
  | 'documented_in' // Entity documented in Document
  | 'source' // Document is source of Signal
  | 'reveals' // Signal reveals PainPoint
  | 'experiences' // OrgUnit/Company experiences PainPoint
  | 'invests_in' // Initiative invests in Technology
  | 'parent' // OrgUnit parent relationship
  | 'child' // OrgUnit child relationship
  | 'demonstrates' // Prototype demonstrates UseCase
  | 'implements' // Initiative implements Strategy
  | 'informed_by' // Strategy informed by Signal
  | 'about' // Document/Signal about Entity
  // Enhanced Relations (v2 - for higher quality linking)
  | 'acquired_by' // Company acquired by another company
  | 'invested_in' // Company/Initiative invested in Company/Technology
  | 'integrates_with' // Technology integrates with another technology
  | 'alternative_to' // Technology is alternative to another (softer than competes)
  | 'built_on' // Technology built on another technology
  | 'customer_of' // Company is customer of another company
  | 'supplier_of' // Company is supplier to another company
  // Document-to-document semantic relations
  | 'references' // Document references another document
  | 'supersedes' // Document supersedes/replaces older version
  | 'supplements' // Document supplements another with additional context
  | 'cites' // Document cites another (academic-style)
  | 'related_to' // Documents are topically related
  // Explicit signal-to-signal types prevent meaningful links from collapsing
  // into the generic `custom` bucket.
  | 'evidences' // Concrete signal supports an abstract trend (signal→signal, asymmetric: concrete→abstract)
  | 'parallels' // Two signals describe the same phenomenon from different angles (signal→signal, symmetric)
  | 'narrows_to' // Broader-topic signal narrows to a specific-scope signal (signal→signal, asymmetric: broad→narrow)
  | 'complements' // Two use cases reinforce each other (useCase→useCase, symmetric)
  | 'compounds' // Pain point A intensifies / aggravates pain point B (painPoint→painPoint, asymmetric: cause→effect)
  | 'conflicts_with' // Two strategies are in tension over the same scope (strategy→strategy, symmetric)
  | 'engages' // Initiative engages a company as a vendor/partner (initiative→company, asymmetric)
  | 'evaluates' // Document/Prototype evaluates a Technology (artifact→technology, asymmetric — build-mission evaluation verdict)
  | 'custom'; // Custom relationship type — deferred placeholder; verifier should refine

/**
 * Represents a denormalized relationship between two entities.
 * Stores snapshots of both entities to avoid N+1 queries.
 *
 * **Key Benefits:**
 * - No more loading source/target entities separately
 * - Enables fast filtering and search on relations page
 * - Supports contextual graphs without multiple queries
 *
 * **Update Strategy:**
 * - Snapshots updated when source/target entity changes
 * - Background job can refresh stale snapshots (snapshotAt > 30 days)
 * - Relations page shows "outdated" indicator if snapshot is stale
 *
 * **Example Relations:**
 * - Technology "TensorFlow" (radar:42) uses Technology "Python" (radar:15)
 * - Company "Google" uses Technology "Kubernetes" (radar:8)
 * - Use Case "Flavor Prediction" requires Technology "ML Models" (radar:23)
 * - Strategy "AI First" aligns_with Technology "AutoML" (radar:31)
 */
export interface Relation {
  /** Unique identifier for the relation */
  id: string;

  /** System-owned mutation correlation used by the asynchronous graph projection. */
  sourceCorrelationId?: string;

  /** System-owned fingerprint of the graph-driving source state for this mutation. */
  sourceFingerprint?: string;

  /** Type of relationship */
  relationType: RelationType;

  /** Source entity snapshot (denormalized) */
  sourceSnapshot: EntitySnapshot;

  /** Target entity snapshot (denormalized) */
  targetSnapshot: EntitySnapshot;

  /** Optional notes about this relationship */
  notes?: string;

  /** Confidence score for AI-suggested relations (0-100) */
  confidence?: number;

  /** Whether this was suggested by AI (vs manually created) */
  aiSuggested?: boolean;

  /** Bare agent name ('linker'|'auto-linker'|'assistant'); only meaningful when aiSuggested. */
  agentName?: string;

  /** User ID who created/approved the relation */
  createdBy?: string;

  /** Timestamp of creation (milliseconds since epoch) */
  createdAt: number;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;

  // ========== Phase 4: Relations-as-Claims ==========

  /** Reference to Neo4j Claim ID (set after sync) */
  claimId?: string;

  /** Evidence references supporting this relation */
  evidenceRefs?: EvidenceRef[];

  /** Status of the claim in Neo4j */
  claimStatus?: 'proposed' | 'curated' | 'rejected' | 'derived';

  /** Summary of reasoning behind this relation */
  reasoningSummary?: string;
}

// ============================================================================
// UNIVERSAL RELATIONS TYPES (Universal Relations Sprint)
// ============================================================================
// Types for the Linker Agent, proposed relations, and entity resolution system.

/**
 * Source type for evidence references.
 * Identifies where the evidence was extracted from.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export type EvidenceSourceType =
  | 'document' // From an uploaded document
  | 'signal' // From a signal
  | 'entity_field' // From entity data (name, description, etc.)
  | 'web' // From web research
  | 'user'; // User-provided evidence

/**
 * Location within a document for evidence references.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface DocumentLocation {
  chunkId?: string; // Specific chunk within document
  startOffset?: number; // Character offset in source
  endOffset?: number;
  pageNumber?: number; // For PDFs
}

/**
 * Location within a signal for evidence references.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface SignalLocation {
  field: 'title' | 'summary' | 'content' | 'analysis';
  startOffset?: number;
  endOffset?: number;
}

/**
 * Location within an entity field for evidence references.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface EntityFieldLocation {
  entityType: EntityType;
  field: string; // Field name (e.g., 'description', 'analysis')
}

/**
 * Location for web-sourced evidence.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface WebLocation {
  url: string;
  title?: string;
  fetchedAt: number;
}

/**
 * Structured evidence reference with stable identifiers.
 * Provides auditable provenance for AI-discovered relationships.
 *
 * **Key Features:**
 * - Identifies exact source (document, signal, entity, web)
 * - Provides location within source (chunk, offset, page)
 * - Contains snippet for quick reference
 * - Hash for integrity verification
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface EvidenceReference {
  /** Type of evidence source */
  sourceType: EvidenceSourceType;

  /** ID of the source (document ID, signal ID, entity ID, etc.) */
  sourceId: string;

  /** Version of the source (for versioned documents) */
  sourceVersion?: number;

  /** Location within the source (varies by sourceType) */
  location: DocumentLocation | SignalLocation | EntityFieldLocation | WebLocation;

  /** The actual evidence text (max 500 chars, PII-sanitized) */
  snippet: string;

  /** SHA256 hash of snippet for integrity verification */
  snippetHash: string;

  /** When the evidence was extracted */
  extractedAt: number;
}

/**
 * Status of a proposed relation in the triage workflow.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export type ProposedRelationStatus =
  | 'pending' // Awaiting human review
  | 'approved' // Approved and relation created
  | 'rejected' // Rejected by human reviewer
  | 'dismissed' // Dismissed (don't re-propose)
  | 'processing' // Being processed (prevents concurrent approval)
  | 'removed'; // Previously approved, then removed by user

/**
 * Source of relation discovery.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export type RelationDiscoverySource =
  | 'linker-agent' // Discovered by Linker Agent batch job
  | 'auto-linker' // Discovered by real-time auto-linker
  | 'ai-assistant'; // Created via AI Assistant tool

/**
 * Minimal entity snapshot for proposed relations.
 * Contains only essential fields to minimize storage size.
 *
 * **Size Constraints:**
 * - name: max 100 chars
 * - description: max 500 chars, PII-stripped
 * - No tags, metadata, or other large fields
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface MinimalEntitySnapshot {
  /** Entity type */
  type: EntityType;

  /** Entity ID */
  id: string;

  /** Entity name (truncated to 100 chars) */
  name: string;

  /** Entity description (truncated to 500 chars, PII-stripped) */
  description?: string;

  /** Entity status (for filtering) */
  status?: string;

  /** Timestamp when snapshot was captured */
  snapshotAt: number;
}

/**
 * AI-proposed relation awaiting human review.
 * Stored in Firestore collection: `proposedRelations`
 *
 * **Workflow:**
 * 1. Linker Agent/Auto-linker discovers potential relation
 * 2. ProposedRelation created with status 'pending'
 * 3. Human reviews in triage UI
 * 4. On approval -> Relation created, status -> 'approved'
 * 5. On rejection -> status -> 'rejected', kept for 30 days
 *
 * **Idempotency:**
 * - Document ID = hash(sourceId + targetId + relationType)
 * - Prevents duplicate proposals
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface ProposedRelation {
  /** Unique identifier (hash-based for idempotency) */
  id: string;

  /** Source entity type */
  sourceType: EntityType;

  /** Source entity ID */
  sourceId: string;

  /** Denormalized source snapshot */
  sourceSnapshot: MinimalEntitySnapshot;

  /** Target entity type */
  targetType: EntityType;

  /** Target entity ID */
  targetId: string;

  /** Denormalized target snapshot */
  targetSnapshot: MinimalEntitySnapshot;

  /** Type of relationship */
  relationType: RelationType;

  /** AI confidence score (0-100) */
  confidence: number;

  /** AI explanation for why this relation exists */
  reasoning: string;

  /** Evidence supporting this relation (max 5 references) */
  evidence: EvidenceReference[];

  /** Current status in triage workflow */
  status: ProposedRelationStatus;

  /** How this relation was discovered */
  discoveredBy: RelationDiscoverySource;

  /** When reviewed (approved/rejected) */
  reviewedAt?: number;

  /** User ID who reviewed */
  reviewedBy?: string;

  /** Reviewer's feedback reason (for rejections) */
  feedbackReason?: string;

  /** If reviewer corrected the relation type */
  correctedRelationType?: RelationType;

  /** Linker run ID that created this (for metrics) */
  runId?: string;

  /** Prompt version used (for A/B testing) */
  promptVersion?: string;

  /**
   * The Firestore Relation id this proposal materialized on approval (B3 —
   * relation-write plumbing). Set by `approveProposedRelation` from
   * `adminCreateRelationFromIds`'s return value, or from
   * `DuplicateRelationError.existingRelation.id` on the idempotent-duplicate
   * path — either way the proposal remembers which relation it created so a
   * later triage decision (e.g. a reject on a re-triaged proposal) can target
   * the same graph edge for confidence recalibration.
   */
  relationId?: string;

  /** Timestamp when created */
  createdAt: number;

  /** Timestamp when last updated */
  updatedAt: number;
}

/**
 * Input type for creating a ProposedRelation.
 */
export type CreateProposedRelationInput = Omit<
  ProposedRelation,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'reviewedAt' | 'reviewedBy'
>;

// EntityAlias / AliasSource / CreateEntityAliasInput / ResolvedEntity were the
// type surface of the never-wired `entityAliases` subsystem (Universal Relations
// Sprint). Removed in DISC-012 along with `entity-aliases.ts`: the collection had
// zero writers/readers, and live entity resolution runs on Neo4j
// (`graph/resolve-entity.ts`, which defines its own `ResolvedEntity`).

/**
 * Per-run metrics for the Linker Agent.
 * Used to track quality and enable A/B testing of prompts.
 *
 * Stored in Firestore collection: `linkerMetrics`
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface LinkerMetrics {
  /** Unique run identifier */
  runId: string;

  /** Prompt version used (for A/B testing) */
  promptVersion: string;

  /** Model version used */
  modelVersion: string;

  /** Number of entities processed */
  entitiesProcessed: number;

  /** Number of candidates generated */
  candidatesGenerated: number;

  /** Number of proposals created */
  proposalsCreated: number;

  /** Number of proposals approved (updated as users review) */
  proposalsApproved: number;

  /** Number of proposals rejected (updated as users review) */
  proposalsRejected: number;

  /** Number of proposals dismissed (updated as users review) */
  proposalsDismissed: number;

  /** Estimated precision: approved / (approved + rejected) */
  precisionEstimate: number;

  /** Timestamp when run started */
  startedAt: number;

  /** Timestamp when run completed */
  completedAt?: number;

  /** Duration in milliseconds */
  durationMs?: number;

  /** Estimated Gemini cost for this run (USD) */
  estimatedCost?: number;
}

/**
 * Reviewer feedback for model improvement.
 * Tracks why proposals were rejected to improve prompts.
 *
 * Stored in Firestore collection: `reviewerFeedback`
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface ReviewerFeedback {
  /** Unique identifier */
  id: string;

  /** ID of the reviewed proposal */
  proposalId: string;

  /** Action taken */
  action: 'approved' | 'rejected' | 'dismissed';

  /** Reason for rejection (optional) */
  feedbackReason?: string;

  /** If reviewer corrected the relation type */
  reviewerCorrectedType?: RelationType;

  /** Prompt version when proposal was created */
  promptVersion: string;

  /** User ID who reviewed */
  reviewedBy: string;

  /** Timestamp of review */
  timestamp: number;
}

/**
 * Weekly performance summary for dashboards.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export interface LinkerPerformanceSummary {
  /** Week identifier (ISO week format: "2026-W03") */
  weekOf: string;

  /** Total proposals created this week */
  totalProposals: number;

  /** Approval rate (target: >70%) */
  approvalRate: number;

  /** Average confidence of approved proposals */
  avgConfidenceApproved: number;

  /** Average confidence of rejected proposals */
  avgConfidenceRejected: number;

  /** Total Gemini cost for the week (USD) */
  totalCost: number;
}

/**
 * Maps a ProposedRelation.discoveredBy value to the bare agent name stamped
 * onto Relation.agentName — B1 (distinct asserter identity). Unknown/missing
 * sources default to 'linker' (the most common discovery path).
 */
export function agentNameForDiscoverySource(discoveredBy?: string): string {
  switch (discoveredBy) {
    case 'linker-agent':
      return 'linker';
    case 'auto-linker':
      return 'auto-linker';
    case 'ai-assistant':
      return 'assistant';
    default:
      return 'linker';
  }
}

/**
 * Size limits for ProposedRelation storage.
 * Ensures proposals stay well under Firestore's 1MB limit.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export const PROPOSED_RELATION_LIMITS = {
  /** Max characters for snapshot name */
  SNAPSHOT_NAME_MAX: 100,
  /** Max characters for snapshot description */
  SNAPSHOT_DESCRIPTION_MAX: 500,
  /** Max characters for evidence snippet */
  EVIDENCE_SNIPPET_MAX: 500,
  /** Max evidence references per proposal */
  EVIDENCE_ARRAY_MAX: 5,
  /** Target max size for entire proposal (bytes) */
  PROPOSAL_MAX_SIZE: 100_000, // 100KB
} as const;

/**
 * Confidence thresholds per relation type.
 * Different relation types have different reliability thresholds.
 *
 * @phase Universal Relations Sprint - Phase 1
 */
export const RELATION_CONFIDENCE_THRESHOLDS: Record<RelationType, number> = {
  // High confidence relations (structured evidence)
  vendor: 85,
  user: 85,
  addresses: 80,
  requires: 80,
  supports: 80,
  solves: 80,
  funds: 85,
  owned_by: 85,
  sponsors: 85,
  parent: 90,
  child: 90,
  implements: 80,
  demonstrates: 80,
  invests_in: 85,

  // Medium confidence relations (semantic inference)
  uses: 70,
  enables: 70,
  aligns_with: 75,
  partner: 75,
  competitor: 75,
  competes_with: 75,
  drives: 70,
  impacts: 70,
  experiences: 70,
  informed_by: 70,

  // Lower confidence relations (often implied)
  mentions: 60,
  documented_in: 65,
  source: 70,
  reveals: 65,
  about: 60,
  references: 65,
  supersedes: 80,
  supplements: 65,
  cites: 70,
  related_to: 60,

  // Custom relations require higher confidence
  custom: 80,

  // Enhanced v2 relations (research-backed)
  acquired_by: 90, // M&A requires high confidence
  invested_in: 85, // Investment relations are fairly reliable
  integrates_with: 75, // Technical integration
  alternative_to: 75, // Market alternative
  built_on: 80, // Technical foundation
  customer_of: 85, // Commercial relationship
  supplier_of: 85, // Commercial relationship

  // 2026-05-13 — thresholds for the new verbs. Calibrated to match the
  // confidence tier of the closest existing predicate:
  //   - `evidences` / `narrows_to`: structural (a patent IS evidence of
  //     a trend), so high.
  //   - `parallels` / `complements`: semantic inference, medium.
  //   - `compounds`: causal claim between pain points, needs strong
  //     evidence, so high.
  //   - `conflicts_with`: strategic tension is interpretive, medium.
  //   - `engages`: commercial relationship, mirrors `customer_of` etc.
  evidences: 80,
  parallels: 70,
  narrows_to: 80,
  complements: 70,
  compounds: 80,
  conflicts_with: 75,
  engages: 85,
  evaluates: 80, // hands-on evaluation is strong evidence the artifact assessed the technology
};
