/**
 * @file lib/operation-usage-map.ts
 * @description ARUN-022 — PURE provider-usage → receipt-field mappers.
 *
 * These functions have no Firestore / provider / ambient dependency, so a
 * provider chokepoint (e.g. `src/lib/ai/client.ts`) can map a response onto the
 * receipt counter set WITHOUT pulling the durable repository (and its
 * `firebase-admin` import) into its module graph. The persistence bridge that
 * DOES touch Firestore is `@/lib/operation-receipt-instrument`, which re-uses
 * these mappers.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import { readProviderModel } from '@/lib/ai/effective-model';
import type {
  OperationModelProvenance,
  OperationReceiptCounters,
  OperationUsageCompleteness,
} from '@/lib/schemas/operation-receipt';

/**
 * Split the requested model and the provider-reported model into the receipt's
 * three model fields, matching the schema's provenance contract exactly:
 *   - provider reported a model → `provider-reported`, `model` = that value;
 *   - provider reported nothing but we asked for one → `requested-fallback`,
 *     `model` = `requestedModel` (equal, since the served model fell back);
 *   - neither (a keyless / model-less API) → `unreported`, no `model`.
 */
export function resolveModelFields(
  requestedModel: string | undefined,
  providerModel: unknown
): { model?: string; requestedModel?: string; modelProvenance: OperationModelProvenance } {
  const served = readProviderModel(providerModel);
  if (served !== undefined) {
    return { model: served, requestedModel, modelProvenance: 'provider-reported' };
  }
  if (requestedModel !== undefined) {
    return { model: requestedModel, requestedModel, modelProvenance: 'requested-fallback' };
  }
  return { modelProvenance: 'unreported' };
}

/** The subset of Gemini `usageMetadata` fields the receipt counters map from. */
export interface GeminiUsageMetadataLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * A validated provider counter: PRESENT and valid (a finite, safe, nonnegative
 * INTEGER — an explicit 0 is valid and DISTINCT from absent), ABSENT, or
 * MALFORMED (present but fractional / negative / NaN / Infinity / unsafe). We
 * never silently coerce a malformed value to 0 — that would hide a data gap and
 * let a garbage response price as if complete.
 */
type ReadCounter = { status: 'valid'; value: number } | { status: 'absent' } | { status: 'malformed' };
function readProviderCounter(value: unknown): ReadCounter {
  if (value === undefined || value === null) return { status: 'absent' };
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return { status: 'malformed' };
  }
  return { status: 'valid', value };
}

/**
 * Map a Gemini `usageMetadata` onto the receipt counter set, keeping the tiers
 * DISTINCT (thinking is not folded into output; cached input is its own tier).
 * `promptTokenCount` is stored VERBATIM (the RAW total, INCLUDING the cached
 * subset in `cacheReadTokens`) — the pricing kernel applies cache semantics and
 * fails closed on an impossible cached>prompt fact.
 *
 * Completeness is HONEST and fail-closed:
 *   - absent `usageMetadata` → `unreported`;
 *   - a query-only observation (grounded search, no token accounting) → `partial`;
 *   - present metadata missing a required counter (prompt OR candidates), OR
 *     carrying ANY malformed counter → `partial`;
 *   - `complete` ONLY when both required counters (prompt, candidates) are present
 *     and valid and no present counter is malformed.
 * Required counters are recorded even when 0 (so an explicit zero is
 * distinguishable from absent); malformed values are dropped, never coerced to 0.
 */
export function geminiUsageToReceipt(
  usageMetadata: GeminiUsageMetadataLike | undefined,
  opts: { groundingQueryCount?: number } = {}
): { counters: OperationReceiptCounters; usageCompleteness: OperationUsageCompleteness } {
  const query = readProviderCounter(opts.groundingQueryCount);
  const queryN = query.status === 'valid' ? query.value : 0;

  if (!usageMetadata) {
    // A query-only observation has no token accounting: it is PARTIAL (we know a
    // grounded search happened but cannot bill it), never complete.
    if (queryN > 0) return { counters: { queryCount: queryN }, usageCompleteness: 'partial' };
    return { counters: {}, usageCompleteness: 'unreported' };
  }

  const prompt = readProviderCounter(usageMetadata.promptTokenCount);
  const candidates = readProviderCounter(usageMetadata.candidatesTokenCount);
  const thoughts = readProviderCounter(usageMetadata.thoughtsTokenCount);
  const cacheRead = readProviderCounter(usageMetadata.cachedContentTokenCount);

  const counters: OperationReceiptCounters = {};
  // Required counters recorded even at 0 (explicit-zero ≠ absent); optional ones
  // only when > 0. Malformed values are NEVER recorded.
  if (prompt.status === 'valid') counters.promptTokens = prompt.value;
  if (candidates.status === 'valid') counters.outputTokens = candidates.value;
  if (thoughts.status === 'valid' && thoughts.value > 0) counters.thinkingTokens = thoughts.value;
  if (cacheRead.status === 'valid' && cacheRead.value > 0) counters.cacheReadTokens = cacheRead.value;
  if (queryN > 0) counters.queryCount = queryN;

  const requiredValid = prompt.status === 'valid' && candidates.status === 'valid';
  const anyMalformed = [prompt, candidates, thoughts, cacheRead, query].some((r) => r.status === 'malformed');
  const usageCompleteness: OperationUsageCompleteness = requiredValid && !anyMalformed ? 'complete' : 'partial';
  return { counters, usageCompleteness };
}

/**
 * The Anthropic SDK `Usage` fields the receipt counters map from. Counters are
 * `number | null` in the SDK; `null` is treated as absent. The provider contract
 * (Anthropic docs + the SDK comment) is that `input_tokens` EXCLUDES cache, so
 * total input = `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` — cache is DISJOINT (the rate-card kernel's Anthropic
 * `cachedInputIsSubsetOfInput: false`). `output_tokens` already INCLUDES
 * thinking, so no thinking counter is emitted (the kernel would reject it for a
 * provider whose output includes thinking).
 */
export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Per-TTL cache-write breakdown. Present when the extended-cache-TTL detail
   * is reported; `null` otherwise. */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/**
 * Map an Anthropic SDK `Usage` onto the receipt counter set WITHOUT guessing a
 * cache-write TTL:
 *   - `input_tokens` → `promptTokens` (excludes cache — disjoint semantics);
 *   - `output_tokens` → `outputTokens` (already includes thinking);
 *   - `cache_read_input_tokens` → `cacheReadTokens` (disjoint, additive);
 *   - cache writes — the explicit `cache_creation` breakdown is used directly
 *     when present (`ephemeral_5m_input_tokens` → `cacheWrite5mTokens`,
 *     `ephemeral_1h_input_tokens` → `cacheWrite1hTokens`). When ONLY the
 *     aggregate `cache_creation_input_tokens` is reported (no breakdown) the
 *     Anthropic default cache TTL is 5 minutes — this codebase never sends the
 *     1-hour extended-cache-TTL beta — so the aggregate is recorded as
 *     `cacheWrite5mTokens`. This is the documented default, NOT a guess between
 *     tiers; a turn that actually opts into 1h caching reports the breakdown and
 *     is split correctly.
 *
 * Completeness is HONEST and fail-closed (same rules as the Gemini mapper):
 *   - absent `usage` → `unreported`;
 *   - a missing required counter (`input_tokens` OR `output_tokens`), OR any
 *     malformed counter → `partial`;
 *   - `complete` ONLY when both required counters are present and valid and no
 *     present counter is malformed. Required counters are recorded even when 0
 *     (explicit-zero ≠ absent); malformed values are dropped, never coerced to 0.
 */
export function anthropicUsageToReceipt(
  usage: AnthropicUsageLike | undefined
): { counters: OperationReceiptCounters; usageCompleteness: OperationUsageCompleteness } {
  if (!usage) {
    return { counters: {}, usageCompleteness: 'unreported' };
  }
  const input = readProviderCounter(usage.input_tokens);
  const output = readProviderCounter(usage.output_tokens);
  const cacheRead = readProviderCounter(usage.cache_read_input_tokens);
  const breakdown = usage.cache_creation ?? undefined;
  const write5mExplicit = readProviderCounter(breakdown?.ephemeral_5m_input_tokens);
  const write1hExplicit = readProviderCounter(breakdown?.ephemeral_1h_input_tokens);
  const aggregate = readProviderCounter(usage.cache_creation_input_tokens);

  const counters: OperationReceiptCounters = {};
  if (input.status === 'valid') counters.promptTokens = input.value;
  if (output.status === 'valid') counters.outputTokens = output.value;
  if (cacheRead.status === 'valid' && cacheRead.value > 0) counters.cacheReadTokens = cacheRead.value;
  // Explicit per-TTL breakdown wins and is never guessed apart. When the
  // breakdown is absent the aggregate is the documented 5-minute default (no
  // 1h beta is in use), so it lands in cacheWrite5mTokens as a single tier.
  const hasExplicitBreakdown = write5mExplicit.status !== 'absent' || write1hExplicit.status !== 'absent';
  if (hasExplicitBreakdown) {
    if (write5mExplicit.status === 'valid' && write5mExplicit.value > 0) counters.cacheWrite5mTokens = write5mExplicit.value;
    if (write1hExplicit.status === 'valid' && write1hExplicit.value > 0) counters.cacheWrite1hTokens = write1hExplicit.value;
  } else if (aggregate.status === 'valid' && aggregate.value > 0) {
    counters.cacheWrite5mTokens = aggregate.value;
  }

  const requiredValid = input.status === 'valid' && output.status === 'valid';
  const anyMalformed = [input, output, cacheRead, write5mExplicit, write1hExplicit, aggregate].some(
    (r) => r.status === 'malformed'
  );
  // When the provider reports BOTH the aggregate and the per-TTL breakdown,
  // they are two representations of the same cache-write tokens. A mismatch is
  // contradictory provider truth: preserve the explicit counters for
  // diagnostics, but never let the response price as complete.
  const breakdownTotal =
    (write5mExplicit.status === 'valid' ? write5mExplicit.value : 0) +
    (write1hExplicit.status === 'valid' ? write1hExplicit.value : 0);
  const aggregateMismatch =
    hasExplicitBreakdown && aggregate.status === 'valid' && aggregate.value !== breakdownTotal;
  const usageCompleteness: OperationUsageCompleteness =
    requiredValid && !anyMalformed && !aggregateMismatch ? 'complete' : 'partial';
  return { counters, usageCompleteness };
}
