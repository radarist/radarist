/**
 * @file lib/operation-context.ts
 * @description ARUN-022 — server-only ambient operation-usage sink.
 *
 * Provider spend happens DEEP (a Gemini grounded search three layers below the
 * Inngest handler that knows the owner and the parent correlation). Threading an
 * owner + correlation object through every provider helper signature is a large,
 * error-prone refactor, so instead the OUTER boundary opens an ambient
 * {@link OperationUsageSink} for the duration of its work, and each provider
 * chokepoint drops a correlation-FREE {@link CapturedProviderUsage} into whatever
 * sink is active (or into nothing, when no boundary opened one).
 *
 * Correlation is supplied LATER, by the outer boundary, when it converts the
 * captured usage into receipts (see `@/lib/operation-receipt-instrument`). This
 * matters because some parents (a verification run) do not know their full
 * correlation — the `verificationResultId` — until AFTER the provider call has
 * already happened.
 *
 * The sink is propagated with `AsyncLocalStorage`, so it flows through awaits
 * within the boundary's callback WITHOUT being passed as an argument, and two
 * concurrent boundaries never see each other's sink. Capture is a strict no-op
 * when no boundary is active, so instrumenting a chokepoint can never change
 * behaviour on an un-instrumented path.
 *
 * This module holds NO Firestore or provider dependency — it is pure ambient
 * plumbing. The mapping-and-persistence bridge is
 * `@/lib/operation-receipt-instrument`.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  OperationFeeState,
  OperationReceiptCounters,
  OperationReceiptExternalFees,
  OperationUsageCompleteness,
} from '@/lib/schemas/operation-receipt';

/**
 * One provider response's raw usage, captured at the chokepoint. It is
 * deliberately correlation-FREE (no owner / parent id) and content-FREE (no
 * prompt, no response text) — only counters, provider/model provenance inputs,
 * and honest completeness. The outer boundary attaches the correlation when it
 * records the receipt.
 */
export interface CapturedProviderUsage {
  /** The effective provider that served the call (e.g. `gemini`). A safe slug. */
  provider: string;
  /** The logical operation/tool slug that made the call (e.g. `gemini.grounded-generate`). */
  operation: string;
  /**
   * The IMMUTABLE provider-occurrence timestamp (ISO-8601), stamped at the
   * chokepoint when the response arrived. It becomes the receipt's `occurredAt`
   * (distinct from the server's persistence `recordedAt`) and is the `asOf` a
   * time-bounded rate prices against. Because it is captured into the buffer,
   * it survives an Inngest step's memoization and stays identical across replay.
   */
  occurredAt: string;
  /** What the caller asked for (kept as a separate fact from what was served). */
  requestedModel?: string;
  /**
   * What the provider says it served (raw `response.modelVersion`-style value).
   * Passed through {@link readProviderModel} when the receipt is built, so a
   * `models/` prefix or an absent value is handled centrally.
   */
  providerModel?: unknown;
  /** Raw provider-reported counters. Absent tiers are simply omitted. */
  counters: OperationReceiptCounters;
  /** Honest completeness of `counters` (never claim complete for an estimate). */
  usageCompleteness: OperationUsageCompleteness;
  /**
   * Tri-state provider-fee fact stamped by the chokepoint: `none` when no fee
   * applies, `known` with an `externalFees` amount, or `applicable-but-unknown`
   * when a fee applies but the provider reported no usable amount (e.g. a
   * grounded search whose free-tier-windowed charge is indeterminate). Never let
   * an unknown fee read as $0.
   */
  feeState: OperationFeeState;
  /** Provider surcharges not derivable from tokens (grounding/query/image fees). */
  externalFees?: OperationReceiptExternalFees;
}

/** A destination for captured provider usage during an operation scope. */
export interface OperationUsageSink {
  collect(usage: CapturedProviderUsage): void;
}

const storage = new AsyncLocalStorage<OperationUsageSink>();

/** The sink opened by the nearest enclosing boundary, or `undefined`. */
export function getOperationUsageSink(): OperationUsageSink | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with `sink` active as the ambient usage sink. Provider chokepoints
 * invoked (transitively) inside `fn` capture into `sink`. Nesting replaces the
 * sink for the inner scope only; the outer sink is restored on return.
 */
export function runWithOperationUsageSink<T>(sink: OperationUsageSink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

/**
 * Capture one provider response's usage into the ambient sink. A STRICT no-op
 * when no boundary is active — an un-instrumented call path is byte-for-byte
 * unchanged. Never throws: a broken sink must never break the provider call, so
 * a throwing `collect` is swallowed (the sink owner is responsible for its own
 * error handling).
 */
export function captureProviderUsage(usage: CapturedProviderUsage): void {
  const sink = storage.getStore();
  if (!sink) return;
  try {
    sink.collect(usage);
  } catch {
    // A capture failure must never propagate into the provider path.
  }
}
