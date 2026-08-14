/**
 * @file linker/types.ts
 * @description Type definitions for the Linker system
 *
 * These types were originally in src/lib/agents/types.ts and have been
 * extracted here as part of the Agent SDK migration.
 * The linker module is independent of the old agent system.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

// ============================================================================
// ENTITY CONTEXT
// ============================================================================

/**
 * Rich context for an entity in the Linker system.
 * Provides description, industry, tags, and other metadata
 * that helps AI make better relation decisions.
 */
export interface EntityContext {
  /** Entity name */
  name: string;

  /** Entity description (for understanding what it does/is) */
  description?: string;

  /** Industry or sector (for companies) */
  industry?: string;

  /** Category or quadrant (for technologies) */
  category?: string;

  /** Associated tags/keywords */
  tags?: string[];

  /** Summary (for signals/documents) */
  summary?: string;

  /** Content snippet (for signals/documents - first 500 chars) */
  contentSnippet?: string;

  /** Source information (for signals) */
  source?: string;

  /** Flexible field for type-specific additional context */
  additionalContext?: string;
}

// ============================================================================
// LINKER CANDIDATE
// ============================================================================

/**
 * A candidate relation discovered by the Linker Agent.
 *
 * Extended in Phase 2 to include rich entity context for better AI verification.
 * The sourceContext and targetContext fields provide description, industry,
 * tags, and other metadata that helps Gemini make accurate relation decisions.
 */
export interface LinkerCandidate {
  /** Source entity ID */
  sourceId: string;

  /** Source entity type */
  sourceType: string;

  /** Source entity name */
  sourceName: string;

  /** Rich context for source entity (Phase 2 enhancement) */
  sourceContext?: EntityContext;

  /** Target entity ID */
  targetId: string;

  /** Target entity type */
  targetType: string;

  /** Target entity name */
  targetName: string;

  /** Rich context for target entity (Phase 2 enhancement) */
  targetContext?: EntityContext;

  /** Proposed relation type */
  relationType: string;

  /** Confidence score (0-100) */
  confidence: number;

  /** How this candidate was discovered */
  discoveryMethod: 'heuristic' | 'embedding' | 'transitive' | 'document_mention';

  /** Similarity score if discovered via embeddings */
  similarityScore?: number;

  /** Evidence snippets supporting this relation */
  evidenceSnippets?: string[];

  /** Whether this candidate requires web grounding for verification */
  requiresGrounding?: boolean;

  /** AI-suggested relation type (if different from proposed) */
  suggestedRelationType?: string;
}

// ============================================================================
// LINKER RUN METRICS
// ============================================================================

/**
 * Metrics from a Linker Agent run.
 */
export interface LinkerRunMetrics {
  /** Unique run identifier */
  runId: string;

  /** When the run started */
  startedAt: number;

  /** When the run completed */
  completedAt?: number;

  /** Number of entities processed as sources */
  entitiesProcessed: number;

  /** Number of candidates generated */
  candidatesGenerated: number;

  /** Number of candidates that passed AI verification */
  candidatesVerified: number;

  /** Number of proposals created */
  proposalsCreated: number;

  /** Number of proposals skipped (already exists) */
  proposalsSkipped: number;

  /** Average confidence of created proposals */
  avgConfidence: number;

  /** Breakdown by discovery method */
  byDiscoveryMethod: {
    heuristic: number;
    embedding: number;
    transitive: number;
    document_mention: number;
  };

  /** Breakdown by relation type */
  byRelationType: Record<string, number>;

  /** Errors encountered */
  errors: string[];
}
