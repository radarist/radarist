// ============================================================================
// COMMON / SHARED TYPES
// ============================================================================
// Foundational types used across multiple domains: base entities, evidence,
// transformation entity types, SLO budgets, claims, AI call logs.

/**
 * Extended entity types for the Innovation Brain transformation.
 * Includes new entities to be added in Phase 3.
 *
 * @phase Phase 3: New Entities
 */
export type TransformationEntityType =
  | 'technology' // Radar entry (format: "radarId:entryId")
  | 'company' // Company ID
  | 'useCase' // Use case ID
  | 'strategy' // Strategy ID
  | 'prototype' // Prototype ID
  | 'signal' // Signal ID
  // NEW in Phase 3:
  | 'org_unit' // Organizational unit (BU, team, department)
  | 'initiative' // Strategic initiative with budget/timeline
  | 'pain_point' // Business pain point to be solved
  | 'document'; // Uploaded document

/**
 * Evidence reference for traceability.
 * Used to cite sources for claims, relations, and AI-generated content.
 *
 * @phase Phase 2: Evidence Layer
 */
export interface EvidenceRef {
  /** Unique identifier for the evidence source */
  id: string;

  /** Stable graph-storage identity for idempotent evidence accrual. */
  sourceKey?: string;

  /** Type of evidence */
  type: 'document_chunk' | 'signal' | 'entity_field' | 'web_ref' | 'user_assertion';

  /** Relevant text snippet from the source */
  snippet?: string;

  /** URL to the source (for web_ref) */
  url?: string;

  /** Document ID (for document_chunk) */
  documentId?: string;

  /** Chunk index within document (for document_chunk) */
  chunkIndex?: number;

  /** Stable chunk identifier when the source exposes one. */
  chunkId?: string;

  /** Source page when the evidence came from a paginated document. */
  pageNumber?: number;

  /** Signal ID (for signal type) */
  signalId?: string;

  /** Entity ID (for entity_field evidence) */
  entityId?: string;

  /** Entity type (for entity_field evidence) */
  entityType?: EntityType;

  /** Field name within the entity (for entity_field evidence) */
  entityField?: string;

  /** Confidence score (0-100) that this evidence supports the claim */
  confidence?: number;

  /** Timestamp when evidence was captured */
  capturedAt: number;
}

/**
 * Base entity interface for standardized CRUD operations.
 * All entities in the system should extend this interface.
 *
 * @phase Phase 3: New Entities
 */
export interface BaseEntity {
  /** Unique identifier for the entity */
  id: string;

  /** Entity type discriminator */
  entityType: TransformationEntityType;

  /** Display name of the entity */
  name: string;

  /** Description of the entity */
  description?: string;

  /** Status (varies by entity type, but standardized for filtering) */
  status?: string;

  /** Tags for categorization and filtering */
  tags?: string[];

  /** Source lineage (how this entity was created) */
  source?: {
    type: 'manual' | 'agent' | 'signal' | 'import';
    agentId?: string;
    agentName?: string;
    signalId?: string;
    importSource?: string;
    createdAt: number;
  };

  /** AI metadata for agent-created entities */
  aiMetadata?: {
    relevanceScore?: number;
    confidenceScore?: number;
    discoveredAt?: number;
    model?: string;
  };

  /** Timestamp of creation (milliseconds since epoch) */
  createdAt: number;

  /** Timestamp of last update (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * AI-generated claim with evidence backing.
 * Used for Relations-as-Claims in Phase 4.
 *
 * @phase Phase 4: Relations-as-Claims
 */
export interface Claim {
  /** Unique identifier for the claim */
  id: string;

  /** The claim statement (e.g., "TensorFlow enables ML models") */
  statement: string;

  /** Confidence score (0-100) */
  confidence: number;

  /** Evidence references supporting this claim */
  evidenceRefs: EvidenceRef[];

  /** Source of the claim (AI model or user) */
  source: {
    type: 'ai' | 'user';
    model?: string;
    userId?: string;
    createdAt: number;
  };

  /** Whether this claim has been verified by a user */
  verified?: boolean;

  /** User who verified the claim */
  verifiedBy?: string;

  /** When the claim was verified */
  verifiedAt?: number;
}

/**
 * AI Call Log entry for tracking AI operations.
 * Used by AgentRun to track all AI invocations.
 *
 * @phase Phase 4: Agent Durability
 */
export interface AICallLog {
  /** Unique identifier for this call */
  id: string;

  /** Timestamp of the call */
  timestamp: number;

  /** Model used */
  model: string;

  /** Operation type */
  operation: 'generate' | 'structured' | 'function_call' | 'embedding';

  /** Input token count */
  inputTokens: number;

  /** Output token count */
  outputTokens: number;

  /** Duration in milliseconds */
  durationMs: number;

  /** Estimated cost in USD */
  costUsd: number;

  /** Whether the call succeeded */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Input prompt (truncated if too long) */
  promptPreview?: string;

  /** Output preview (truncated if too long) */
  outputPreview?: string;
}

/**
 * Non-functional SLO configuration for monitoring.
 *
 * @phase Phase 0: Foundation Hardening
 */
export interface SLOBudget {
  /** AI client SLOs */
  ai: {
    maxLatencyMs: number;
    maxCostPerRequest: number;
    maxDailyCost: number;
  };
  /** Vector search SLOs */
  vectorSearch: {
    maxLatencyMs: number;
    minRecall: number;
  };
  /** Graph traversal SLOs */
  graphTraversal: {
    maxLatencyMs: number;
    maxHops: number;
  };
  /** Firestore→Neo4j sync SLOs */
  sync: {
    maxLatencyMs: number;
    maxRetries: number;
  };
  /** Agent execution SLOs */
  agent: {
    maxExecutionMs: number;
    minSuccessRate: number;
  };
}

/**
 * Default SLO budgets for the Innovation Brain platform.
 */
export const SLO_BUDGETS: SLOBudget = {
  ai: {
    maxLatencyMs: 3000,
    maxCostPerRequest: 0.01,
    maxDailyCost: 10,
  },
  vectorSearch: {
    maxLatencyMs: 500,
    minRecall: 0.8,
  },
  graphTraversal: {
    maxLatencyMs: 100,
    maxHops: 5,
  },
  sync: {
    maxLatencyMs: 5000,
    maxRetries: 3,
  },
  agent: {
    maxExecutionMs: 60000,
    minSuccessRate: 0.9,
  },
};

/**
 * Graph sync status for entities synced to Neo4j.
 * - pending: Waiting to be synced
 * - synced: Successfully synced
 * - failed: Sync failed (will be retried)
 *
 * @phase Knowledge Tab Sprint
 */
export type GraphSyncStatus = 'pending' | 'synced' | 'failed';

/**
 * Document visibility level for future permissions.
 *
 * @phase Knowledge Tab Sprint
 */
export type DocumentVisibility = 'public' | 'workspace' | 'private';

/**
 * Entity type for relations.
 * Identifies what kind of entity is being linked.
 */
export type EntityType =
  | 'technology' // Radar entry (format: "radarId:entryId")
  | 'company' // Company ID
  | 'useCase' // Use case ID
  | 'strategy' // Strategy ID
  | 'prototype' // Prototype ID
  | 'signal' // Signal ID
  | 'document' // Document ID (Evidence Layer)
  | 'orgUnit' // Organizational Unit ID (Phase 3)
  | 'initiative' // Initiative ID (Phase 3)
  | 'painPoint' // Pain Point ID (Phase 3)
  | 'radarPlacement'; // RadarPlacement ID (Phase 2)

/**
 * Snapshot of an entity at a specific point in time.
 * Stored in relations to avoid N+1 queries.
 * Updated when the source entity changes.
 */
export interface EntitySnapshot {
  /** Entity type */
  type: EntityType;

  /** Entity ID */
  id: string;

  /** Entity name (cached for quick display) */
  name: string;

  /** Entity description (cached for quick display) */
  description?: string;

  /** Entity status/state (cached for filtering) */
  status?: string;

  /** Entity tags (cached for filtering) */
  tags?: string[];

  /** Additional metadata specific to entity type */
  metadata?: Record<string, any>;

  /** Timestamp when snapshot was last updated (milliseconds since epoch) */
  snapshotAt: number;
}
