/**
 * @file index.ts
 * @description Unified AI module exports
 *
 * Central export point for all AI-related functionality.
 * This module provides a clean interface to the AI client abstraction layer.
 *
 * @author Radarist Team
 * @created 2025-11-26
 * @updated 2025-01-07 - Added reliability layer exports
 */

// Export main AI client functions
export {
  generateContent,
  generateContentWithMetadata,
  generateStructuredContent,
  generateEmbedding,
  generateEmbeddings,
  generateEmbeddingWithMetadata,
} from './client';

// Export constants (from non-server file to avoid 'use server' restrictions)
export {
  TaskType,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
} from './constants';

// Export research functions
export { researchCompany, type CompanyResearchResult } from './research-company';

// Export reliability utilities (Phase 0)
export {
  // Core functions
  withRetry,
  withRateLimit,
  withCircuitBreaker,
  withCostBudget,
  withReliability,
  // State accessors
  getRateLimiter,
  getCircuitBreaker,
  getCostTracker,
  // Health check
  getAIHealthStatus,
  // Logging
  logAIOperation,
  getRecentLogs,
  getLogStats,
  generateRequestId,
  // Utilities
  isRetryableError,
  calculateBackoffDelay,
  trackCost,
  resetAllReliabilityState,
  // Configuration
  DEFAULT_RELIABILITY_CONFIG,
  MODEL_PRICING,
} from './reliability';

// Export types
export type {
  GeminiModel,
  ThinkingLevel,
  GenerationConfig,
  GenerationResult,
} from './client';

export type {
  AIReliabilityConfig,
  AILogEntry,
  AIHealthStatus,
  CircuitState,
  ReliabilityOptions,
  ReliabilityResult,
} from './reliability';
