/**
 * @file types.ts
 * @description Neo4j graph types for the Reified Assertion Model.
 *
 * This module defines the graph schema for Phase 4: Relations-as-Assertions.
 * Assertions are first-class nodes connecting subjects, objects, and predicates
 * with evidence backing.
 *
 * @phase Phase 4: Relations-as-Assertions (formerly Relations-as-Claims)
 * @author Radarist Team
 * @created 2026-01-09
 * @updated 2026-04-18 - :Claim vocabulary renamed to :Assertion (see 2026-04-18-schema-simplification migration)
 */

import type { EntityType, TransformationEntityType } from '@/lib/types';

// ============================================================================
// CLAIM STATUS
// ============================================================================

/**
 * Status of an Assertion in the curation lifecycle.
 *
 * Note: The type name is intentionally kept as `ClaimStatus` because it
 * describes the edge's `claimStatus` property (a 14,694-edge foreign-key-like
 * field), not the node label. The node-label rename happened at the Neo4j
 * level on 2026-04-18; the edge property rename is deferred (data migration).
 */
export type ClaimStatus =
  | 'proposed' // AI-suggested, pending review
  | 'curated' // Reviewed and approved by user
  | 'rejected' // Reviewed and rejected by user
  | 'derived'; // Automatically derived from other claims

// ============================================================================
// ASSERTION NODE
// ============================================================================

/**
 * An Assertion is a first-class node in Neo4j representing a relationship
 * between two entities with evidence backing.
 *
 * Example: "TensorFlow SOLVES Machine Learning complexity"
 */
export interface GraphAssertion {
  /** Unique identifier (matches Firestore relation ID for sync) */
  id: string;

  /**
   * Firestore Relation document ID this Assertion backs (set by the
   * relation-sync upsert, absent on assertions created outside that path).
   * The materialized typed edge MUST carry this same relationId — it is the
   * key invalidatePriorEdges uses to exclude the edge from self-invalidation
   * (CRIT-1) and the key the delete path uses to clean the edge up.
   */
  relationId?: string;

  /** Latest originating mutation trace, absent on pre-OBS-003 assertions. */
  correlationId?: string;

  /** Correlation half of the authoritative relation source generation. */
  sourceCorrelationId?: string;

  /** Graph-driving Firestore generation, absent on pre-OBS-003 assertions. */
  sourceFingerprint?: string;

  /** The assertion statement in natural language */
  statement?: string;

  /** Confidence score (0-100) */
  confidence: number;

  /**
   * B0 two-field confidence authority: the asserter's claimed value.
   * Refreshed on every re-sync (mirrors `confidence` for legacy rows that
   * predate the split). Optional because pre-B0 nodes/edges don't carry it
   * yet — readers must `COALESCE(effectiveConfidence, confidence, <default>)`.
   */
  assertedConfidence?: number;

  /**
   * B0 two-field confidence authority: the system's belief. Set on create;
   * NEVER clobbered by a re-sync (writers coalesce). Optional for the same
   * pre-B0-row reason as {@link assertedConfidence}.
   */
  effectiveConfidence?: number;

  /** Curation status */
  status: ClaimStatus;

  /** AI reasoning summary (why this assertion was made) */
  reasoningSummary?: string;

  /** Timestamp of creation */
  createdAt: number;

  /** Timestamp of last verification */
  lastVerifiedAt?: number;

  /** Timestamp of last update */
  updatedAt: number;

  // Subject entity reference
  subjectId: string;
  subjectType: TransformationEntityType;
  subjectName: string;

  // Object entity reference
  objectId: string;
  objectType: TransformationEntityType;
  objectName: string;

  // Predicate (relation type)
  predicate: string;

  // Asserter reference
  assertedBy: string; // "agent:scout" or "user:userId"
  asserterType: 'agent' | 'user';
}

/**
 * Back-compat alias. Internal callers should use {@link GraphAssertion}; the
 * `GraphClaim` name is preserved so out-of-tree imports don't break during
 * the vocabulary rollout.
 */
export type GraphClaim = GraphAssertion;

/**
 * Input for creating a new assertion.
 */
export interface CreateAssertionInput {
  /** Subject entity */
  subject: {
    id: string;
    type: TransformationEntityType;
    name: string;
  };

  /** Object entity */
  object: {
    id: string;
    type: TransformationEntityType;
    name: string;
  };

  /** Relation type (predicate) */
  predicate: string;

  /** Confidence score (0-100) */
  confidence: number;

  /** Optional reasoning summary */
  reasoningSummary?: string;

  /** Optional statement */
  statement?: string;

  /** Who asserted this assertion */
  assertedBy: string; // "agent:scout" or "user:userId"

  /** Evidence to attach */
  evidence?: EvidenceInput[];
}

/** Back-compat alias. */
export type CreateClaimInput = CreateAssertionInput;

// ============================================================================
// EVIDENCE NODE
// ============================================================================

/**
 * Evidence node in Neo4j supporting an Assertion.
 * Distinct from DocumentChunk - represents cited evidence for a specific assertion.
 */
export interface GraphEvidence {
  /** Unique identifier */
  id: string;

  /** Stable Relation-side identity used to merge Firestore and Neo4j views. */
  sourceKey?: string;

  /** Type of evidence source */
  sourceType: 'document_chunk' | 'signal' | 'entity_field' | 'web_ref' | 'user_assertion';

  /** Text snippet from the source */
  snippet: string;

  /** URL to the source (for web_ref) */
  sourceUrl?: string;

  /** Document ID (for document_chunk) */
  documentId?: string;

  /** Chunk ID within document */
  chunkId?: string;

  /** Signal ID (for signal type) */
  signalId?: string;

  /** Entity ID (for entity_field evidence) */
  entityId?: string;

  /** Entity type (for entity_field evidence) */
  entityType?: EntityType;

  /** Field name within the entity (for entity_field evidence) */
  entityField?: string;

  /** Page number in document */
  pageNumber?: number;

  /** Confidence that this evidence supports the assertion (0-100) */
  relevanceScore?: number;

  /** Timestamp when evidence was captured */
  capturedAt: number;

  /** Who captured this evidence */
  capturedBy?: string;
}

/**
 * Input for adding evidence to an assertion.
 */
export interface EvidenceInput {
  /** Stable identity used only for idempotent storage within one Assertion. */
  sourceKey?: string;

  /** Type of evidence */
  sourceType: 'document_chunk' | 'signal' | 'entity_field' | 'web_ref' | 'user_assertion';

  /** Text snippet */
  snippet: string;

  /** Source URL */
  sourceUrl?: string;

  /** Document ID */
  documentId?: string;

  /** Chunk ID */
  chunkId?: string;

  /** Signal ID */
  signalId?: string;

  /** Entity ID */
  entityId?: string;

  /** Entity type */
  entityType?: EntityType;

  /** Field name within the entity */
  entityField?: string;

  /** Page number */
  pageNumber?: number;

  /** Relevance score */
  relevanceScore?: number;
}

// ============================================================================
// RELATION TYPE NODE
// ============================================================================

/**
 * RelationType node representing a predicate type.
 * Makes predicates first-class citizens in the graph.
 */
export interface GraphRelationType {
  /** Relation type name (e.g., "SOLVES", "USES") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Whether this is a system-defined type */
  isSystem: boolean;

  /** Timestamp of creation */
  createdAt: number;
}

// ============================================================================
// ENTITY NODE
// ============================================================================

/**
 * Entity node representing any domain entity in Neo4j.
 * Synced from Firestore for graph traversal.
 */
export interface GraphEntity {
  /** Entity ID (matches Firestore ID) */
  id: string;

  /** Entity type */
  entityType: TransformationEntityType;

  /** Display name */
  name: string;

  /** Description */
  description?: string;

  /** Status (varies by type) */
  status?: string;

  /** Tags for categorization */
  tags?: string[];

  /** Timestamp of last sync from Firestore */
  syncedAt: number;

  /** Firestore updatedAt timestamp */
  firestoreUpdatedAt: number;
}

// ============================================================================
// AGENT & USER NODES
// ============================================================================

/**
 * Agent node representing an AI agent that can assert assertions.
 */
export interface GraphAgent {
  /** Agent ID (e.g., "agent:scout") */
  id: string;

  /** Agent name */
  name: string;

  /** Agent type */
  agentType: 'scout' | 'evaluation' | 'monitor' | 'custom';

  /** Timestamp of creation */
  createdAt: number;
}

/**
 * User node representing a human user who can assert assertions.
 */
export interface GraphUser {
  /** User ID (e.g., "user:abc123") */
  id: string;

  /** User display name */
  name: string;

  /** User email */
  email?: string;

  /** Timestamp of creation */
  createdAt: number;
}

// ============================================================================
// QUERY RESULTS
// ============================================================================

/**
 * Result of an "explain connection" query.
 * Returns why two entities are connected.
 */
export interface ConnectionExplanation {
  /** The assertion connecting the entities */
  claim: GraphAssertion;

  /** Evidence supporting the assertion */
  evidence: GraphEvidence[];

  /** Who asserted the assertion */
  asserter: GraphAgent | GraphUser;

  /** Relation type details */
  relationType: GraphRelationType;
}

/**
 * Result of an "assertions for entity" query.
 */
export interface EntityAssertions {
  /** Assertions where entity is the subject */
  asSubject: GraphAssertion[];

  /** Assertions where entity is the object */
  asObject: GraphAssertion[];

  /** Total assertion count */
  totalCount: number;
}

/** Back-compat alias. */
export type EntityClaims = EntityAssertions;

/**
 * Result of an "assertions citing document" query.
 */
export interface DocumentCitations {
  /** Document ID */
  documentId: string;

  /** Assertions that cite this document */
  claims: GraphAssertion[];

  /** Total citation count */
  citationCount: number;
}

// ============================================================================
// SYNC TYPES
// ============================================================================

/**
 * Sync operation types for Firestore → Neo4j sync.
 */
export type SyncOperation = 'create' | 'update' | 'delete';

/**
 * Sync queue item for failed syncs.
 */
export interface SyncQueueItem {
  /** Unique ID */
  id: string;

  /** Operation type */
  operation: SyncOperation;

  /** Entity type */
  entityType: 'claim' | 'evidence' | 'entity';

  /** Entity ID */
  entityId: string;

  /** Payload data */
  payload: Record<string, unknown>;

  /** Number of retry attempts */
  retryCount: number;

  /** Last error message */
  lastError?: string;

  /** Timestamp of creation */
  createdAt: number;

  /** Timestamp of last attempt */
  lastAttemptAt?: number;
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Statistics for the assertion graph.
 */
export interface AssertionGraphStats {
  /** Total assertions */
  totalClaims: number;

  /** Assertions by status */
  byStatus: Record<ClaimStatus, number>;

  /** Average confidence score */
  avgConfidence: number;

  /** Assertions with evidence */
  claimsWithEvidence: number;

  /** Total evidence nodes */
  totalEvidence: number;

  /** Assertions by asserter type */
  byAsserterType: {
    agent: number;
    user: number;
  };

  /** Most used relation types */
  topRelationTypes: Array<{
    name: string;
    count: number;
  }>;
}

/** Back-compat alias. */
export type ClaimGraphStats = AssertionGraphStats;
