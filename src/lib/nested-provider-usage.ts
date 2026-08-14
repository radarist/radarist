/**
 * @file lib/nested-provider-usage.ts
 * @description ARUN-022 — attribute NESTED provider spend to the tool that caused it.
 *
 * A chat turn's or a mission stage's headline spend was never the whole bill. When
 * the Assistant runs `deepResearch`, `generateInfographic`, or a company-research
 * tool, that tool makes its OWN provider calls three layers below the boundary that
 * knows the owner and correlation. Those chokepoints already capture into the
 * ambient sink (`@/lib/operation-context`), but the chat route never opened one, so
 * every nested response was captured into nothing and the turn's durable ledger
 * recorded only the main model. This module is the seam that closes that:
 *
 *   - {@link captureNestedToolUsage} opens an ambient sink for the duration of ONE
 *     tool execution and returns everything captured inside it, ATTRIBUTED to that
 *     tool. The callee's result and its errors pass through unchanged — a ledger
 *     concern must never alter the operation it observes — and spend captured
 *     BEFORE a throw is still handed back, because that spend was real.
 *
 *   - {@link nestedOperationSlug} is the deterministic attribution rule. The
 *     receipt's `operation` is the LOGICAL operation that made the call, and for a
 *     nested call that is genuinely "the Gemini call `deepResearch` made" — not
 *     bare `gemini.generate-text`. Prefixing keeps two different tools from
 *     deriving the SAME receipt identity under one parent (which would collapse two
 *     real responses into one slot and lose spend), and it is what lets an operator
 *     read a turn's ledger and see WHICH tool spent the money.
 *
 * The rewrite touches ONLY `operation` — a caller-owned label the outer boundary
 * legitimately knows more about than the chokepoint does. Every provider FACT
 * (counters, model, completeness, occurrence, fee state) passes through verbatim.
 * Nothing here prices, persists, or classifies accounting scope; the boundary that
 * owns the correlation does that via `@/lib/operation-receipt-instrument`.
 *
 * @author Radarist Team
 * @created 2026-07-29
 */

import 'server-only';
import {
  runWithOperationUsageSink,
  type CapturedProviderUsage,
  type OperationUsageSink,
} from '@/lib/operation-context';

/**
 * The receipt schema bounds `operation` at 120 characters and constrains it to a
 * lowercase slug. Attribution must never produce a value the write boundary would
 * reject — a rejected receipt is LOST spend, which is exactly what this module
 * exists to prevent — so the slug is truncated and normalized here rather than
 * failing validation later. Kept in sync with `MAX_OPERATION_LENGTH`.
 */
export const MAX_NESTED_OPERATION_LENGTH = 120;

/** The `tool.` marker that identifies an attributed nested operation. */
const NESTED_PREFIX = 'tool.';

/**
 * Normalize an arbitrary tool name into the receipt's slug alphabet
 * (`[a-z0-9][a-z0-9._-]*`). Tool names are internal identifiers, but they reach
 * this function as strings, so the normalization is defensive: anything outside the
 * alphabet collapses to `-`, and leading/trailing separators are trimmed. A name
 * that normalizes to nothing yields an empty string and the caller falls back to
 * the bare chokepoint operation rather than minting an invalid slug.
 */
function normalizeSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
}

/**
 * A stable 32-bit FNV-1a hash rendered as 8 lowercase hex chars. Used ONLY to keep
 * two long tool names that share a truncation prefix from colliding into one
 * operation slug (and therefore one receipt identity). It is deterministic, so a
 * replay derives the same id.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The nested-operation attribution rule: `tool.<tool>.<chokepoint operation>`.
 *
 * Deterministic and injective enough for identity: when the composed slug would
 * exceed the schema bound it is truncated and suffixed with a hash of the FULL
 * untruncated value, so two long names that share a prefix still derive different
 * slugs (and therefore different receipt ids) instead of silently merging two
 * responses into one ledger slot.
 */
export function nestedOperationSlug(toolName: string, chokepointOperation: string): string {
  const tool = normalizeSlugPart(toolName);
  const operation = normalizeSlugPart(chokepointOperation);
  // A chokepoint that reports no usable operation leaves nothing to attribute; the
  // receipt schema will reject an empty operation, so surface the raw value and let
  // the write boundary fail loudly rather than inventing a name.
  if (!operation) return chokepointOperation;
  if (!tool) return operation;
  const composed = `${NESTED_PREFIX}${tool}.${operation}`;
  if (composed.length <= MAX_NESTED_OPERATION_LENGTH) return composed;
  const suffix = `.${shortHash(composed)}`;
  return `${composed.slice(0, MAX_NESTED_OPERATION_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Return a copy of `usage` whose `operation` names the tool that caused it. Every
 * other field is passed through verbatim; the input is never mutated, so a caller
 * holding the original buffer sees no side effect.
 */
export function attributeCapturedUsageToTool(usage: CapturedProviderUsage, toolName: string): CapturedProviderUsage {
  return { ...usage, operation: nestedOperationSlug(toolName, usage.operation) };
}

/**
 * Appends every capture — attributed to one tool — DIRECTLY into a caller-owned
 * buffer, rather than snapshotting at return time.
 *
 * That distinction is load-bearing. A read tool is raced against a timeout, and a
 * timed-out read keeps running: its provider response can arrive AFTER the race has
 * already rejected. Because the ambient sink stays bound to that orphaned
 * continuation, a late capture still lands in the shared buffer and is still
 * flushed at terminalization. A snapshot taken when the race rejected would have
 * dropped exactly the spend a timeout makes most likely.
 */
class AttributingUsageSink implements OperationUsageSink {
  constructor(
    private readonly toolName: string,
    private readonly target: CapturedProviderUsage[]
  ) {}

  collect(usage: CapturedProviderUsage): void {
    this.target.push(attributeCapturedUsageToTool(usage, this.toolName));
  }
}

/**
 * Run ONE tool execution with an ambient usage sink active, appending every nested
 * provider response it causes into `target`, attributed to `toolName`.
 *
 * `execute`'s result and its errors pass through UNCHANGED — instrumentation must
 * never convert a real tool failure into a silent success, nor swallow one. Spend
 * that happened before a throw is already in `target`, so a failing tool's real
 * cost is still accounted.
 *
 * Concurrent executions are isolated by `AsyncLocalStorage`, so two tools running in
 * parallel each attribute only their own captures (into the same shared buffer).
 */
export function withNestedToolUsageCapture<T>(
  toolName: string,
  target: CapturedProviderUsage[],
  execute: () => Promise<T>
): Promise<T> {
  return runWithOperationUsageSink(new AttributingUsageSink(toolName, target), execute);
}
