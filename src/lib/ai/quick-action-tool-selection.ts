/**
 * @file quick-action-tool-selection.ts
 * @description Pure, fail-open tool-catalog selection for trusted Assistant
 * quick actions (PERF-010).
 *
 * General typed chat must keep the normal catalog: message text is deliberately
 * not an input to this module. A catalog is narrowed only when the caller passes
 * explicit quick-action metadata with the exact trusted source marker and an
 * action identifier registered in QUICK_ACTION_TOOLS.
 */

import { QUICK_ACTION_TOOLS } from '@/lib/ai/assistant-surface';
import type { AIChatQuickActionMetadata } from '@/types/ai-assistant';

export const ASSISTANT_QUICK_ACTION_SOURCE = 'assistant-quick-action' as const;

/**
 * Turn metadata constructed from an explicitly submitted Assistant quick
 * action. `actionId` is the AIQuickAction.action value (for example,
 * `proactive_insights`), not the human-readable label or prompt text.
 *
 * This marker is not an authorization boundary. Quick-action selection can
 * only remove declarations from the caller-provided catalog; tool executors
 * continue to enforce their existing authorization and confirmation policies.
 */
export type TrustedQuickActionMetadata = AIChatQuickActionMetadata;

interface NamedTool {
  name: string;
}

export type QuickActionToolSelectionReason =
  | 'trusted-quick-action'
  | 'missing-metadata'
  | 'untrusted-source'
  | 'unknown-action'
  | 'incomplete-catalog';

export interface QuickActionToolSelection<T extends NamedTool> {
  /** The declarations to offer to the model for this turn. */
  tools: T[];
  /** `quick-action` only when a recognized mapping was applied completely. */
  mode: 'normal' | 'quick-action';
  reason: QuickActionToolSelectionReason;
  actionId?: string;
  requiredToolNames?: readonly string[];
}

type ParsedQuickActionMetadata =
  | { actionId: string; reason: 'valid' }
  | { reason: 'missing-metadata' | 'untrusted-source' };

function readQuickActionMetadata(metadata: unknown): ParsedQuickActionMetadata {
  if (metadata === undefined || metadata === null) {
    return { reason: 'missing-metadata' };
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { reason: 'untrusted-source' };
  }

  const candidate = metadata as Record<string, unknown>;
  if (candidate.source !== ASSISTANT_QUICK_ACTION_SOURCE || typeof candidate.actionId !== 'string') {
    return { reason: 'untrusted-source' };
  }

  return { actionId: candidate.actionId, reason: 'valid' };
}

function normalSelection<T extends NamedTool>(
  normalCatalog: T[],
  reason: Exclude<QuickActionToolSelectionReason, 'trusted-quick-action'>,
  actionId?: string,
  requiredToolNames?: readonly string[]
): QuickActionToolSelection<T> {
  return {
    // Preserve exact fallback parity, including array identity. The caller may
    // already have applied a policy such as the mission-scale subtraction.
    tools: normalCatalog,
    mode: 'normal',
    reason,
    ...(actionId === undefined ? {} : { actionId }),
    ...(requiredToolNames === undefined ? {} : { requiredToolNames }),
  };
}

/**
 * Narrow a caller-provided normal catalog for a recognized trusted quick
 * action. Missing, malformed, unknown, or incomplete metadata fails open to the
 * exact normal catalog so a typed request can never be starved by heuristics.
 *
 * The function never adds a declaration and never mutates either input.
 */
export function selectToolsForQuickAction<T extends NamedTool>(
  normalCatalog: T[],
  metadata?: unknown
): QuickActionToolSelection<T> {
  const parsed = readQuickActionMetadata(metadata);
  if (parsed.reason !== 'valid') {
    return normalSelection(normalCatalog, parsed.reason);
  }

  const actionId = parsed.actionId;
  if (!Object.prototype.hasOwnProperty.call(QUICK_ACTION_TOOLS, actionId)) {
    return normalSelection(normalCatalog, 'unknown-action', actionId);
  }

  const requiredToolNames = QUICK_ACTION_TOOLS[actionId];
  if (!Array.isArray(requiredToolNames) || requiredToolNames.length === 0) {
    return normalSelection(normalCatalog, 'unknown-action', actionId);
  }

  const required = new Set(requiredToolNames);
  const selected = normalCatalog.filter((tool) => required.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));

  // QUICK_ACTION_TOOLS is contract-checked against CORE_AI_TOOLS. Keep this
  // runtime guard because the caller may pass a previously narrowed catalog or
  // a catalog with duplicate/missing declarations. A partially capable action
  // is less honest than retaining the caller's normal policy.
  if (selected.length !== required.size || requiredToolNames.some((name) => !selectedNames.has(name))) {
    return normalSelection(normalCatalog, 'incomplete-catalog', actionId, requiredToolNames);
  }

  return {
    tools: selected,
    mode: 'quick-action',
    reason: 'trusted-quick-action',
    actionId,
    requiredToolNames,
  };
}

export interface ToolCatalogMeasurement {
  toolCount: number;
  serializedCharacters: number;
  /** Deterministic planning estimate; provider billing remains authoritative. */
  approximateTokens: number;
}

/**
 * Measure declaration payload size without a tokenizer dependency. The
 * characters/4 estimate is intentionally approximate but stable enough for a
 * regression benchmark comparing two catalogs built from the same schema.
 */
export function measureToolCatalog(tools: readonly unknown[]): ToolCatalogMeasurement {
  const serialized = JSON.stringify(tools);
  return {
    toolCount: tools.length,
    serializedCharacters: serialized.length,
    approximateTokens: Math.ceil(serialized.length / 4),
  };
}

export interface ToolCatalogReduction {
  toolCount: number;
  serializedCharacters: number;
  approximateTokens: number;
  approximateTokenReductionRatio: number;
}

/** Compare a narrowed catalog with its normal per-turn baseline. */
export function measureToolCatalogReduction(
  normalCatalog: readonly unknown[],
  selectedCatalog: readonly unknown[]
): ToolCatalogReduction {
  const normal = measureToolCatalog(normalCatalog);
  const selected = measureToolCatalog(selectedCatalog);
  return {
    toolCount: normal.toolCount - selected.toolCount,
    serializedCharacters: normal.serializedCharacters - selected.serializedCharacters,
    approximateTokens: normal.approximateTokens - selected.approximateTokens,
    approximateTokenReductionRatio:
      normal.approximateTokens === 0
        ? 0
        : (normal.approximateTokens - selected.approximateTokens) / normal.approximateTokens,
  };
}
