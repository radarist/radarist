/**
 * @file mcp/prompts.ts
 * @description MCP Prompts implementation (L2 Skills-as-prompts).
 *
 * Exposes two prompt families over the MCP `prompts/*` surface:
 *
 *  1. **Skills** — the 48 servable analytical methods, surfaced from the
 *     build-time content-hashed manifest (`generated/skill-prompts.ts`,
 *     produced by Lane B's `scripts/build-skill-prompts.ts`). Each is listed
 *     under a namespaced `skill:<name>` and, on `prompts/get`, its body is
 *     **hash-verified** then wrapped through the untrusted-content boundary
 *     (`frameAsData`) before being handed to the host model.
 *
 *  2. **Legacy reasoning patterns** — the original 7 patterns
 *     (`deep-analysis`, `technology-scout`, …) kept under their existing
 *     **bare names** as aliases so already-connected clients don't break.
 *
 * Both families advertise a uniform generic argument schema —
 * `{ query (required), context (optional) }`.
 *
 * MCP Spec Reference:
 * - prompts/list: Returns available prompts
 * - prompts/get: Returns prompt with messages for execution
 *
 * @author Radarist Team
 * @created 2026-01-25
 */

import { createHash } from 'crypto';
import {
  getAllPatterns,
  getPattern,
  getPatternsByPermission,
  type ReasoningPattern,
  type ReasoningPatternId,
  type McpPrompt,
  type McpPromptArgument,
  type McpPromptMessage,
  type McpPromptGetResult,
} from '@/lib/ai/reasoning';
import type { ApiKey, ApiKeyPermission, SkillPrompt } from './types';
import { SKILL_PROMPTS } from './generated/skill-prompts';
import { frameAsData } from './untrusted';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/prompts');

/** Namespace prefix for skill-as-prompt names (`skill:<name>`). */
const SKILL_PREFIX = 'skill:';

/**
 * Uniform generic argument schema advertised for every prompt (skills + legacy
 * patterns alike). Keeping it identical across families means a host harness
 * can call any prompt with the same `{ query, context }` shape.
 */
const GENERIC_PROMPT_ARGUMENTS: McpPromptArgument[] = [
  {
    name: 'query',
    description: 'Your question or analysis request',
    required: true,
  },
  {
    name: 'context',
    description: 'Additional context or constraints (optional)',
    required: false,
  },
];

// ============================================================================
// Hash verification
// ============================================================================

/**
 * Recompute the tamper-evident digest of a skill body. MUST match the algorithm
 * used by the build script (`scripts/build-skill-prompts.ts`): a hex-encoded
 * SHA-256 over the UTF-8 body. The generated manifest is the trusted store; we
 * never read skill source files at request time.
 */
function computeBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// ============================================================================
// Prompt → MCP shape
// ============================================================================

/**
 * Convert a reasoning pattern to MCP prompt format (legacy alias, bare name).
 */
function patternToMcpPrompt(pattern: ReasoningPattern): McpPrompt {
  return {
    name: pattern.id,
    description: pattern.description,
    arguments: GENERIC_PROMPT_ARGUMENTS,
  };
}

/**
 * Convert a skill manifest entry to MCP prompt format (namespaced name).
 */
function skillToMcpPrompt(skill: SkillPrompt): McpPrompt {
  return {
    name: `${SKILL_PREFIX}${skill.name}`,
    description: skill.description,
    arguments: GENERIC_PROMPT_ARGUMENTS,
  };
}

// ============================================================================
// Prompt List Handler
// ============================================================================

/**
 * Handle prompts/list request.
 *
 * Returns the 48 skills (namespaced `skill:<name>`) plus the legacy reasoning
 * patterns filtered by the caller's permissions. Skills are public analytical
 * methods (no per-skill permission); the read budget is enforced upstream on
 * `prompts/get`.
 *
 * Signature is preserved (takes `apiKey`) so `server.ts` needs no change.
 *
 * @param apiKey - The authenticated API key
 * @returns List of available prompts
 */
export function handlePromptsList(apiKey: ApiKey): { prompts: McpPrompt[] } {
  // Every generated, servable skill is always advertised.
  const skillPrompts = SKILL_PROMPTS.map(skillToMcpPrompt);

  // Legacy patterns: permission-filtered for backward compatibility.
  const accessiblePatterns = getPatternsByPermission(apiKey.permissions as ('read' | 'write' | 'signals' | 'admin')[]);
  const patternPrompts = accessiblePatterns.map(patternToMcpPrompt);

  const prompts = [...skillPrompts, ...patternPrompts];

  log.info('prompts/list', {
    count: prompts.length,
    skills: skillPrompts.length,
    patterns: patternPrompts.length,
    userId: apiKey.userId,
  });

  return { prompts };
}

// ============================================================================
// Prompt Get Handler
// ============================================================================

/**
 * Build the system message for a reasoning pattern (legacy alias path).
 */
function buildSystemMessage(pattern: ReasoningPattern): string {
  const parts: string[] = [pattern.systemPrompt];

  // Add step-by-step guidance
  parts.push('\n## REASONING STEPS\n');
  for (const step of pattern.steps) {
    parts.push(`### Step ${step.step}: ${step.action}`);
    parts.push(step.description);

    if (step.suggestedTools.length > 0) {
      const tools = step.suggestedTools.map((t) => `- \`${t.name}\`: ${t.purpose}`).join('\n');
      parts.push(`\n**Suggested Tools:**\n${tools}`);
    }

    if (step.keyQuestions.length > 0) {
      const questions = step.keyQuestions.map((q) => `- ${q}`).join('\n');
      parts.push(`\n**Key Questions:**\n${questions}`);
    }

    parts.push('');
  }

  // Add examples
  if (pattern.examples.length > 0) {
    parts.push('## EXAMPLES\n');
    for (const example of pattern.examples) {
      parts.push(`**Query:** "${example.query}"`);
      parts.push(`**Approach:** ${example.approach}`);
      parts.push(`**Tool Sequence:** ${example.toolSequence.join(' → ')}\n`);
    }
  }

  return parts.join('\n');
}

/**
 * Build a user message with the query.
 */
function buildUserMessage(query: string, context?: string): string {
  let message = query;

  if (context) {
    message += `\n\n**Additional Context:** ${context}`;
  }

  return message;
}

/**
 * Parameters for prompts/get request.
 */
export interface PromptsGetParams {
  name: string;
  arguments?: Record<string, string>;
}

/**
 * Resolve a namespaced `skill:<name>` prompt: look it up in the trusted
 * manifest, verify its body hash, then frame the verified body as inert data.
 */
function getSkillPrompt(name: string, query: string, context: string | undefined, apiKey: ApiKey): McpPromptGetResult {
  const skillName = name.slice(SKILL_PREFIX.length);
  const skill = SKILL_PROMPTS.find((s) => s.name === skillName);

  if (!skill) {
    throw {
      code: -32004,
      message: `Prompt not found: ${name}`,
    };
  }

  // Tamper-evidence gate: the manifest body must match its build-time hash.
  const actualHash = computeBodyHash(skill.body);
  if (actualHash !== skill.contentHash) {
    log.error('skill prompt integrity check failed', new Error('skill body hash mismatch'), {
      name,
      expected: skill.contentHash,
      actual: actualHash,
    });
    throw {
      code: -32603,
      message: `Prompt body failed integrity check: ${name}`,
    };
  }

  // Wrap the verified body through the untrusted-content boundary so any
  // embedded "ignore previous instructions" payload is treated as data.
  const messages: McpPromptMessage[] = [
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: frameAsData(skill.body, name),
      },
    },
    {
      role: 'user',
      content: {
        type: 'text',
        text: buildUserMessage(query, context),
      },
    },
  ];

  log.info('prompts/get skill', { name, userId: apiKey.userId });

  return {
    description: skill.description,
    messages,
  };
}

/**
 * Resolve a legacy bare-name reasoning pattern (alias path).
 */
function getPatternPrompt(
  name: string,
  query: string,
  context: string | undefined,
  apiKey: ApiKey
): McpPromptGetResult {
  const pattern = getPattern(name as ReasoningPatternId);

  if (!pattern) {
    throw {
      code: -32004,
      message: `Prompt not found: ${name}`,
    };
  }

  // Check permissions
  const hasAdmin = apiKey.permissions.includes('admin');
  const hasRequired =
    hasAdmin ||
    pattern.requiredPermissions.every((p) =>
      (apiKey.permissions as ApiKeyPermission[]).includes(p as ApiKeyPermission)
    );

  if (!hasRequired) {
    throw {
      code: -32003,
      message: `Insufficient permissions for prompt: ${name}. Required: ${pattern.requiredPermissions.join(', ')}`,
    };
  }

  const messages: McpPromptMessage[] = [
    {
      role: 'assistant',
      content: {
        type: 'text',
        text: buildSystemMessage(pattern),
      },
    },
    {
      role: 'user',
      content: {
        type: 'text',
        text: buildUserMessage(query, context),
      },
    },
  ];

  log.info('prompts/get pattern', { name, userId: apiKey.userId });

  return {
    description: pattern.description,
    messages,
  };
}

/**
 * Handle prompts/get request.
 *
 * Dispatches on the name namespace: `skill:<name>` resolves the hash-verified
 * skill body; any other name resolves a legacy reasoning pattern alias.
 *
 * Signature is preserved (takes `apiKey`) so `server.ts` needs no change.
 *
 * @param params - Request parameters with prompt name and arguments
 * @param apiKey - The authenticated API key
 * @returns Prompt messages or throws error if not found / tampered
 */
export function handlePromptsGet(params: PromptsGetParams, apiKey: ApiKey): McpPromptGetResult {
  const { name, arguments: args } = params;

  if (!name) {
    throw {
      code: -32602,
      message: 'Prompt name is required',
    };
  }

  // Extract arguments (uniform schema across both families).
  const query = args?.query || 'No query provided';
  const context = args?.context;

  if (name.startsWith(SKILL_PREFIX)) {
    return getSkillPrompt(name, query, context, apiKey);
  }

  return getPatternPrompt(name, query, context, apiKey);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a prompt name is valid (skill or legacy pattern).
 */
export function isValidPromptName(name: string): boolean {
  if (name.startsWith(SKILL_PREFIX)) {
    const skillName = name.slice(SKILL_PREFIX.length);
    return SKILL_PROMPTS.some((s) => s.name === skillName);
  }
  return getPattern(name as ReasoningPatternId) !== null;
}

/**
 * Get all prompt names for autocomplete (namespaced skills + legacy aliases).
 */
export function getPromptNames(): string[] {
  return [...SKILL_PROMPTS.map((s) => `${SKILL_PREFIX}${s.name}`), ...getAllPatterns().map((p) => p.id)];
}

/**
 * Get a short description of a prompt (skill or legacy pattern).
 */
export function getPromptDescription(name: string): string | null {
  if (name.startsWith(SKILL_PREFIX)) {
    const skill = SKILL_PROMPTS.find((s) => s.name === name.slice(SKILL_PREFIX.length));
    return skill?.description ?? null;
  }
  const pattern = getPattern(name as ReasoningPatternId);
  return pattern?.description || null;
}
