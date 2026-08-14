/**
 * @file lib/pipeline/index.ts
 * @description Daily pipeline module exports
 *
 * This module provides all pipeline-related functionality:
 * - Entity extraction from signals
 * - Entity deduplication (fuzzy matching)
 * - Relation proposal (co-occurrence + AI)
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

// Entity Extraction
export {
  extractEntitiesFromSignal,
  extractEntitiesFromSignals,
  getUniqueEntities,
  filterEntitiesByType,
  getExtractionStats,
  type ExtractedEntity,
  type ExtractionResult,
  type BatchExtractionResult,
} from './entity-extraction';

// Deduplication
export {
  deduplicateEntities,
  mergeEntities,
  normalizeString,
  normalizeCompanyName,
  calculateSimilarity,
  levenshteinDistance,
  isSimilar,
  isAbbreviationMatch,
  getDeduplicationStats,
  type DuplicateGroup,
  type DeduplicationResult,
  type DeduplicationOptions,
} from './deduplication';

// Relation Proposal
export {
  findCoOccurrences,
  proposeRelationsFromCoOccurrence,
  proposeRelationsWithAI,
  proposeRelations,
  groupProposalsByType,
  filterByConfidence,
  getProposalStats,
  type ProposedRelation,
  type RelationProposalResult,
  type CoOccurrence,
} from './relation-proposal';

// Alignment Calculation
export {
  calculateSignalAlignment,
  recalculateAlignmentScores,
  getSignificantChanges,
  getImprovedSignals,
  getDeclinedSignals,
  getAlignmentStats,
  type AlignmentScoreChange,
  type AlignmentRecalculationResult,
  type AlignmentCalculationOptions,
} from './alignment-calculation';

// Graph Refresh
export {
  refreshGraphProjection,
  verifyGraphIntegrity,
  getGraphRefreshStats,
  type GraphRefreshResult,
  type GraphRefreshOptions,
} from './graph-refresh';
