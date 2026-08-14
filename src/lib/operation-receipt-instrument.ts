/**
 * @file lib/operation-receipt-instrument.ts
 * @description ARUN-022 — server-only bridge from a captured provider response
 * to a durable operation-usage receipt.
 *
 * The schema (`@/lib/schemas/operation-receipt`) and repository
 * (`@/lib/operation-receipt-repository`) are the FOUNDATION. This module is the
 * INSTRUMENTATION seam every provider boundary shares, so the persistence path is
 * written and tested exactly once (the PURE response→field mappers,
 * `resolveModelFields` / `geminiUsageToReceipt`, live in
 * `@/lib/operation-usage-map` so a chokepoint can map without importing the
 * repository):
 *   - {@link recordCapturedUsage} turns one captured usage + a correlation into a
 *     durable receipt, best-effort.
 *   - {@link BufferingUsageSink} + {@link flushCapturedUsage} implement the
 *     capture-now / correlate-later flow: a boundary opens the sink, provider
 *     chokepoints capture into it, and the boundary flushes each captured usage
 *     into a receipt once it knows the full correlation (e.g. after a
 *     verification result id is minted).
 *
 * Cost is NOT priced here, and NEVER supplied by this seam. The immutable cost is
 * derived from the raw provider facts INSIDE the repository's persistence boundary
 * by the ONE canonical rate card (`@/lib/operation-receipt-pricing`) — fail-closed
 * to `unavailable` when it cannot be priced. A provider ACTUAL/invoice is a
 * SEPARATE, append-only, owner-scoped settlement (`@/lib/operation-settlement-
 * repository`), never a cost passed through here.
 *
 * Recording is BEST-EFFORT and non-fatal: a ledger write must never break the
 * provider operation it observes. Failures (including a genuine conflicting
 * replay, which signals an identity bug) are logged and swallowed here; the
 * repository logs them too.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import 'server-only';
import { createLogger } from '@/lib/logger';
import { OperationReceiptConflictError, recordOperationReceiptWithOutcome } from '@/lib/operation-receipt-repository';
import { upsertParentAccountingMarker } from '@/lib/operation-accounting-marker-repository';
import { isValidMarkerOccurredAt } from '@/lib/schemas/operation-accounting-marker';
import { runWithOperationUsageSink } from '@/lib/operation-context';
import { resolveModelFields } from '@/lib/operation-usage-map';
import {
  type CreateOperationReceiptInput,
  type OperationAccountingScope,
  type OperationReceipt,
  type OperationReceiptCorrelation,
} from '@/lib/schemas/operation-receipt';
import type { CapturedProviderUsage, OperationUsageSink } from '@/lib/operation-context';

const log = createLogger('operation-receipt-instrument');

/** Identity discriminators for one captured usage within a correlation. */
export interface ReceiptIdentitySeed {
  /** Stable per-call discriminator (opaque id). Two distinct calls differ here. */
  invocationId: string;
  /** 0-based retry attempt of this invocation. Defaults to 0. */
  attempt?: number;
  /** 0-based provider response within the attempt. Defaults to 0. */
  responseOrdinal?: number;
}

/**
 * The terminal outcome of recording ONE captured usage:
 *   - `written`    — a genuinely new durable receipt;
 *   - `replayed`   — an idempotent replay of an already-durable receipt;
 *   - `conflicted` — the identity already held DIFFERENT immutable facts (a real
 *     receipt loss — the newer observed spend could not be recorded);
 *   - `failed`     — validation / transport failure (a receipt loss).
 * `written` and `replayed` carry the receipt; `conflicted`/`failed` carry `null`.
 */
export type CaptureOutcome = 'written' | 'replayed' | 'conflicted' | 'failed';

/** The result of recording one captured usage: its outcome and the receipt (if durable). */
export interface RecordedUsageResult {
  outcome: CaptureOutcome;
  receipt: OperationReceipt | null;
}

/**
 * The structured outcome of flushing a batch of captured usages: how many were
 * expected and how each terminated (the four terminal states partition `expected`
 * exactly). `complete` is true only when nothing conflicted and nothing failed —
 * i.e. every expected capture became a durable receipt. `receipts` are the durable
 * ones (written or replayed). `markerPersisted` reports whether the durable
 * loss/accounting marker for this batch was actually written: `false` means the
 * marker write FAILED, so the loss record itself may be lost and the caller must
 * decide how to react (retry, alert) rather than trust that the outcome is durable.
 * It is `true` when a marker was written or none was needed (an empty flush).
 */
export interface FlushResult {
  expected: number;
  written: number;
  replayed: number;
  conflicted: number;
  failed: number;
  receipts: OperationReceipt[];
  complete: boolean;
  markerPersisted: boolean;
}

/**
 * Record ONE captured provider usage as a durable receipt under `correlation`,
 * classified by `accountingScope` (the anti-double-count axis the OUTER boundary
 * owns — the chokepoint cannot know whether it is a parent-owned or a nested
 * call). Best-effort and non-fatal: any failure is classified into a
 * {@link CaptureOutcome} (never thrown), so instrumentation never breaks the
 * observed provider operation AND a loss is reported honestly rather than swallowed.
 */
export async function recordCapturedUsage(
  correlation: OperationReceiptCorrelation,
  usage: CapturedProviderUsage,
  identity: ReceiptIdentitySeed,
  accountingScope: OperationAccountingScope
): Promise<RecordedUsageResult> {
  let input: CreateOperationReceiptInput;
  try {
    const modelFields = resolveModelFields(usage.requestedModel, usage.providerModel);
    // Build the RAW-facts create input only. The immutable cost is derived from
    // these facts INSIDE the repository by the ONE canonical rate card — this seam
    // never supplies a cost, so a forged amount / model / tier / rate / breakdown /
    // currency can never be injected, and a provider ACTUAL never enters a receipt
    // (that is a separate append-only settlement). Pricing fails closed to
    // `unavailable` for an unknown provider/model/fee/tier or malformed usage.
    input = {
      correlation,
      operation: usage.operation,
      invocationId: identity.invocationId,
      attempt: identity.attempt ?? 0,
      responseOrdinal: identity.responseOrdinal ?? 0,
      provider: usage.provider,
      ...modelFields,
      counters: usage.counters,
      usageCompleteness: usage.usageCompleteness,
      occurredAt: usage.occurredAt,
      accountingScope,
      feeState: usage.feeState,
      ...(usage.externalFees ? { externalFees: usage.externalFees } : {}),
    };
  } catch (error) {
    log.error('Failed to build operation-usage receipt input (best-effort, non-fatal)', error, {
      operation: usage.operation,
      provider: usage.provider,
      parentType: correlation.parentType,
    });
    return { outcome: 'failed', receipt: null };
  }

  try {
    const { receipt, outcome } = await recordOperationReceiptWithOutcome(input);
    return { outcome, receipt };
  } catch (error) {
    // A conflict is a DISTINCT, meaningful loss (the identity already held different
    // facts) — classify it apart from a generic failure so the marker can report it.
    if (error instanceof OperationReceiptConflictError) {
      log.error('operation-usage receipt conflicted (best-effort, non-fatal)', error, {
        operation: usage.operation,
        provider: usage.provider,
        parentType: correlation.parentType,
      });
      return { outcome: 'conflicted', receipt: null };
    }
    log.error('Failed to record operation-usage receipt (best-effort, non-fatal)', error, {
      operation: usage.operation,
      provider: usage.provider,
      parentType: correlation.parentType,
    });
    return { outcome: 'failed', receipt: null };
  }
}

/**
 * A sink that buffers every captured usage so a boundary can flush them into
 * receipts once it knows the full correlation. Buffering is JSON-plain, so the
 * buffer survives an Inngest step's memoization (capture in one step, flush in
 * another) as ordinary serialized data.
 */
export class BufferingUsageSink implements OperationUsageSink {
  private readonly buffer: CapturedProviderUsage[] = [];

  collect(usage: CapturedProviderUsage): void {
    this.buffer.push(usage);
  }

  /** The captured usages in capture order. */
  get captured(): readonly CapturedProviderUsage[] {
    return this.buffer;
  }
}

/**
 * Run `fn` with a fresh buffering sink active and return `fn`'s result together
 * with everything the provider chokepoints captured during it. This is the
 * capture side of the capture-now / correlate-later flow: the caller flushes the
 * returned `captured` with {@link flushCapturedUsage} once it knows the full
 * correlation.
 *
 * `fn`'s own errors propagate unchanged — only the usage bookkeeping is added, so
 * this never converts a real failure into a silent success. Opening the sink
 * cannot itself fail (sink construction + AsyncLocalStorage are pure); a caller
 * that wants the ledger to be strictly optional should guard the IMPORT of this
 * module, not this call.
 */
export async function withCapturedUsage<T>(
  fn: () => Promise<T>
): Promise<{ result: T; captured: CapturedProviderUsage[] }> {
  const sink = new BufferingUsageSink();
  const result = await runWithOperationUsageSink(sink, fn);
  return { result, captured: [...sink.captured] };
}

/**
 * Flush a set of captured usages into receipts under one correlation, deriving a
 * STABLE, distinct identity per capture from its buffer position:
 *   - `invocationId` = `${invocationPrefix}.${index}` (each capture is one call);
 *   - `attempt` = 0, `responseOrdinal` = 0.
 * Re-flushing the same captures under the same correlation and prefix targets the
 * same receipt ids, so a legitimate replay is idempotent rather than a duplicate.
 *
 * `invocationPrefix` MUST be stable across replay (e.g. a minted result id), so
 * derive it from a memoized fact, never a fresh random value.
 *
 * `accountingScope` classifies each capture. It may be a single scope for the
 * whole batch (e.g. a verification's captures are all `standalone`) or a RESOLVER
 * `(usage) => scope` when one boundary mixes main-vs-nested calls (e.g. a chat
 * turn where the main model is `included-in-parent` and a nested image/research
 * call is `additional-to-parent`).
 *
 * Returns a STRUCTURED {@link FlushResult} — how many captures were expected,
 * written, replayed, conflicted, or failed — and UPSERTS a durable parent
 * accounting marker recording that outcome, so receipt LOSS (a conflict or
 * failure) is durably VISIBLE rather than silently swallowed. `complete` is true
 * only when nothing conflicted and nothing failed. The marker write is itself
 * best-effort (a marker failure never breaks the flush or the observed operation).
 */
export async function flushCapturedUsage(
  correlation: OperationReceiptCorrelation,
  captured: readonly CapturedProviderUsage[],
  invocationPrefix: string,
  accountingScope: OperationAccountingScope | ((usage: CapturedProviderUsage) => OperationAccountingScope)
): Promise<FlushResult> {
  const resolveScope = typeof accountingScope === 'function' ? accountingScope : () => accountingScope;
  const receipts: OperationReceipt[] = [];
  const counts = { written: 0, replayed: 0, conflicted: 0, failed: 0 };
  for (let index = 0; index < captured.length; index += 1) {
    const usage = captured[index];
    const { outcome, receipt } = await recordCapturedUsage(
      correlation,
      usage,
      { invocationId: `${invocationPrefix}.${index}` },
      resolveScope(usage)
    );
    counts[outcome] += 1;
    if (receipt) receipts.push(receipt);
  }

  // Persist the durable accounting marker so a loss is visible. Keyed PER BATCH
  // (batchId = invocationPrefix) so an independent later batch under the same
  // parent writes a DISTINCT slot and can never erase this batch's loss; a re-flush
  // of THIS batch upserts the same slot idempotently. Empty flush (no provider
  // calls) records nothing — there is nothing to account, so markerPersisted stays
  // true (nothing needed persisting).
  let markerPersisted = true;
  if (captured.length > 0) {
    // Robust occurrence time: the max of the VALID capture timestamps. A malformed
    // provider timestamp must NEVER block recording the loss — if none is valid the
    // marker is written with occurredAt ABSENT ("occurrence unknown").
    const validTimes = captured.map((u) => u.occurredAt).filter(isValidMarkerOccurredAt);
    const occurredAt = validTimes.length > 0 ? validTimes.reduce((max, t) => (t > max ? t : max)) : undefined;
    try {
      await upsertParentAccountingMarker({
        owner: correlation.owner,
        parentType: correlation.parentType,
        correlationId: correlation.correlationId,
        batchId: invocationPrefix,
        expected: captured.length,
        written: counts.written,
        replayed: counts.replayed,
        conflicted: counts.conflicted,
        failed: counts.failed,
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      });
    } catch (error) {
      // The loss record itself failed to persist — surface it to the caller via
      // markerPersisted rather than swallowing it (the loss may otherwise vanish).
      markerPersisted = false;
      log.error('Failed to upsert parent accounting marker (best-effort, non-fatal)', error, {
        parentType: correlation.parentType,
        correlationId: correlation.correlationId,
        batchId: invocationPrefix,
      });
    }
  }

  return {
    expected: captured.length,
    ...counts,
    receipts,
    complete: counts.conflicted === 0 && counts.failed === 0,
    markerPersisted,
  };
}
