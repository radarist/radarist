/**
 * Leaf types for the AI tool layer.
 *
 * `ToolResult` / `ToolCall` live here (not in `tools.ts`) so that the per-category
 * tool modules can import the result type WITHOUT creating an import cycle back to
 * `tools.ts` (which dynamically imports their executors). `tools.ts` re-exports both
 * for backward compatibility, so existing `import { ToolResult } from '@/lib/ai/tools'`
 * call sites keep working.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Human-readable detail for structured errors (e.g. graph degradation). */
  message?: string;
  /**
   * AI-047 — proof from the tool itself that this outcome happened BEFORE any
   * mutation was attempted. Only a tool knows this; callers must never infer it.
   * Absent means "unknown", which stays conservative.
   */
  noMutation?: ToolNoMutationProof;
}

/**
 * AI-047 — the stage at which a write-classified tool stopped without touching
 * any durable state.
 *
 * - `validation` — the requested operation is not legal for these inputs.
 * - `lookup` — a referenced record could not be resolved.
 * - `authorization` — the caller's current turn does not authorize this write.
 * - `principal` — this principal class may never perform this write.
 * - `unexpected` — the tool threw, but provably before its first mutating call.
 */
export type PreWriteRefusalStage = 'validation' | 'lookup' | 'authorization' | 'principal' | 'unexpected';

export interface ToolNoMutationProof {
  /** Literal `false`. Present only when the tool KNOWS nothing was written. */
  mutationAttempted: false;
  stage: PreWriteRefusalStage;
}

// ============================================================================
// AI-011 / AI-041 — shared result-normalization boundary
// ============================================================================

/**
 * Tools that return their structured payload under a sibling key instead of
 * the canonical `data` slot. The surplus keys survive on the wire (the
 * `toolCalls` receipt ships the full object), but every contract consumer —
 * the model cap (`capToolResultForModel`), UI summaries/chips
 * (`summarizeToolCall`), entity-ref extraction, and mutation tracking — reads
 * `result.data`, so those payloads were silently invisible (`data:null`).
 *
 * `generateVisualization` is the only mutation in this set: its `data` carries
 * the persisted Firestore `visualizationId`. The graph Executive Q&A family is
 * read-only and must never be reinterpreted as a mutation.
 */
const SIBLING_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  compareCompetitors: ['comparison'],
  recommendTechInvestments: ['recommendations'],
  findVendors: ['vendors'],
  getTechSummary: ['summary'],
  generateVisualization: ['visualizationId', 'imageUrl', 'url'],
};

/**
 * Lift a tool's sibling payload keys into the canonical `data` slot WITHOUT
 * discarding the originals, so the structured payload reaches every consumer
 * that honors the `ToolResult` contract.
 *
 * Safe to run on every dispatch: it is a no-op for tools outside the registry,
 * for results that already set `data`, and for error envelopes (which carry no
 * sibling payload). The top-level keys are preserved by spread, so callers and
 * persisted receipts that read them directly are unaffected.
 */
export function normalizeToolResult(toolName: string, result: ToolResult): ToolResult {
  const keys = SIBLING_PAYLOAD_KEYS[toolName];
  if (!keys) return result;
  // Already conforming — a prior layer populated the canonical slot.
  if (result.data !== undefined) return result;
  const source = result as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  let found = false;
  for (const key of keys) {
    if (source[key] !== undefined) {
      payload[key] = source[key];
      found = true;
    }
  }
  if (!found) return result;
  return { ...result, data: payload };
}
