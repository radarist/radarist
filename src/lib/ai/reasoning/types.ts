/**
 * @file ai/reasoning/types.ts
 * @description Type definitions for the AI reasoning system
 *
 * The reasoning system provides structured patterns for multi-step
 * AI analysis, enabling deeper insights through systematic tool usage.
 *
 * @author Radarist Team
 * @created 2026-01-25
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Reasoning pattern identifier
 */
export type ReasoningPatternId =
  | 'deep-analysis'
  | 'technology-scout'
  | 'competitive-landscape'
  | 'strategic-fit'
  | 'signal-triage'
  | 'gap-analysis'
  | 'trend-synthesis';

/**
 * Tool reference with usage context
 */
export interface ToolReference {
  /** Tool name (matches AI tool registry) */
  name: string;
  /** When to use this tool in the pattern */
  purpose: string;
  /** Whether this tool is required or optional */
  required: boolean;
}

/**
 * Reasoning step in a multi-step pattern
 */
export interface ReasoningStep {
  /** Step identifier (1, 2, 3...) */
  step: number;
  /** Human-readable action name */
  action: string;
  /** Detailed description of what to do */
  description: string;
  /** Tools commonly used in this step */
  suggestedTools: ToolReference[];
  /** Questions to answer in this step */
  keyQuestions: string[];
}

/**
 * Example query with expected reasoning approach
 */
export interface PatternExample {
  /** User query */
  query: string;
  /** Brief reasoning approach */
  approach: string;
  /** Expected tool sequence */
  toolSequence: string[];
}

/**
 * Complete reasoning pattern definition
 */
export interface ReasoningPattern {
  /** Unique identifier */
  id: ReasoningPatternId;
  /** Display name */
  name: string;
  /** Short description for selection */
  description: string;
  /** When to apply this pattern */
  applicableWhen: string[];
  /** System prompt instructions */
  systemPrompt: string;
  /** Ordered reasoning steps */
  steps: ReasoningStep[];
  /** Example applications */
  examples: PatternExample[];
  /** Required permissions for full pattern execution */
  requiredPermissions: ('read' | 'write' | 'signals' | 'admin')[];
}

// ============================================================================
// MCP Prompt Types (matching MCP spec)
// ============================================================================

/**
 * MCP Prompt argument definition
 */
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * MCP Prompt definition (for prompts/list)
 */
export interface McpPrompt {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

/**
 * MCP Prompt message (for prompts/get response)
 */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

/**
 * MCP prompts/get response
 */
export interface McpPromptGetResult {
  description: string;
  messages: McpPromptMessage[];
}

// ============================================================================
// Query Classification
// ============================================================================

/**
 * Query complexity level
 */
export type QueryComplexity = 'simple' | 'moderate' | 'complex';

/**
 * Query classification result
 */
export interface QueryClassification {
  /** Detected complexity */
  complexity: QueryComplexity;
  /** Suggested reasoning pattern */
  suggestedPattern: ReasoningPatternId | null;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reasoning for classification */
  reasoning: string;
}
