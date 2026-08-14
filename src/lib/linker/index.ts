/**
 * @file linker/index.ts
 * @description Linker Module - Universal Relations Discovery
 *
 * Exports all components of the automatic relation discovery system.
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

// Candidate generation pipeline
export {
  generateCandidates,
  generateCandidatesForSignal,
  generateDocumentMentionCandidates,
  generateTransitiveCandidates,
  type CandidateGeneratorOptions,
} from './candidate-generator';

// Candidate verification
export {
  verifyCandidatesWithAI,
  verifySingleCandidate,
  quickValidate,
  preFilterCandidates,
  type VerificationOptions,
  type VerificationResult,
} from './candidate-verifier';

// Relation ontology
export {
  validateRelation,
  canonicalizeRelation,
  isSymmetricRelation,
  getValidRelationTypes,
  getRelationDescription,
  getRelatedEntityTypes,
  RELATION_ONTOLOGY,
  SYMMETRIC_RELATIONS,
  CANONICAL_DIRECTION,
} from './relation-ontology';

// Metrics & tracking
export {
  saveLinkerRun,
  getLinkerRun,
  getRecentLinkerRuns,
  getLinkerStats,
  updateEntityTracking,
  getStaleEntityIds,
  getTrackedEntityIds,
  getEntityTracking,
  wasRecentlyProcessed,
  type LinkerEntityTracking,
  type PersistedLinkerRun,
} from './linker-metrics';

// Document scanning for entity mentions
export { scanDocumentForEntities, batchScanDocuments, getDocumentsToScan } from './document-scanner';
