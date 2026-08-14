/**
 * @file ai/reasoning/index.ts
 * @description AI Reasoning System - Multi-step analysis patterns
 *
 * This module exports reasoning patterns that guide AI assistants through
 * systematic information gathering and analysis for complex queries.
 *
 * @example
 * ```typescript
 * import { getPattern, getAllPatterns } from '@/lib/ai/reasoning';
 *
 * // Get a specific pattern
 * const pattern = getPattern('deep-analysis');
 *
 * // Get all patterns for MCP prompts
 * const patterns = getAllPatterns();
 * ```
 *
 * @author Radarist Team
 * @created 2026-01-25
 */

// Types
export type {
  ReasoningPatternId,
  ReasoningPattern,
  ReasoningStep,
  ToolReference,
  PatternExample,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptGetResult,
  QueryClassification,
  QueryComplexity,
} from './types';

// Pattern registry
export {
  REASONING_PATTERNS,
  getPattern,
  getPatternIds,
  getAllPatterns,
  getPatternsByPermission,
} from './patterns';
