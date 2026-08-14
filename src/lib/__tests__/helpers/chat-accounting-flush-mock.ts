/**
 * AI-029 — shared test helper: build a priced FlushResult from captured provider
 * usages using the REAL pure pricing kernel (`priceReceiptCounters`), with NO
 * Firestore. Route-level tests let the real `terminalizeChatAccounting` run and
 * mock only `flushCapturedUsage` (via this helper) so the canonical pricing path
 * is exercised end-to-end without a durable store. Per-response accounting
 * correctness (tiers, cache, replay, conflicts, markers) is covered by the
 * dedicated adversarial suite against a disposable Firestore.
 *
 * Receipts include the immutable model/counter facts used by both
 * `deriveHeadlineCost` and `deriveAgentRunUsage`. The real repository writes
 * additional identity metadata; this stub keeps only the fields the terminal
 * projection consumes.
 */
import { priceReceiptCounters } from '@/lib/operation-receipt-pricing';
import { resolveModelFields } from '@/lib/operation-usage-map';
import type {
  OperationCost,
  OperationModelProvenance,
  OperationReceipt,
} from '@/lib/schemas/operation-receipt';
import type { CapturedProviderUsage } from '@/lib/operation-context';
import type { FlushResult } from '@/lib/operation-receipt-instrument';

/** A content-free priced receipt carrying the immutable accounting facts. */
function minimalReceipt(
  cost: OperationCost,
  index: number,
  capture: CapturedProviderUsage,
  modelFields: {
    model?: string;
    requestedModel?: string;
    modelProvenance: OperationModelProvenance;
  }
): OperationReceipt {
  return {
    cost,
    id: `rcpt-${index}`,
    provider: capture.provider,
    operation: capture.operation,
    ...modelFields,
    counters: capture.counters,
    usageCompleteness: capture.usageCompleteness,
    occurredAt: capture.occurredAt,
    feeState: capture.feeState,
    ...(capture.externalFees ? { externalFees: capture.externalFees } : {}),
  } as unknown as OperationReceipt;
}

/**
 * Price each capture with the real kernel and return a complete FlushResult. The
 * caller controls `complete` / `markerPersisted` via opts so conflict/marker
 * failure scenarios can be injected without touching the kernel.
 */
export function buildPricedFlushResult(
  captured: readonly CapturedProviderUsage[],
  opts: { complete?: boolean; markerPersisted?: boolean; conflicted?: number; failed?: number } = {}
): FlushResult {
  const receipts: OperationReceipt[] = [];
  for (let index = 0; index < captured.length; index += 1) {
    const capture = captured[index];
    const modelFields = resolveModelFields(capture.requestedModel, capture.providerModel);
    const cost = priceReceiptCounters({
      provider: capture.provider,
      model: modelFields.model,
      requestedModel: modelFields.requestedModel,
      modelProvenance: modelFields.modelProvenance,
      usageCompleteness: capture.usageCompleteness,
      counters: capture.counters,
      feeState: capture.feeState,
      ...(capture.externalFees ? { externalFees: capture.externalFees } : {}),
      occurredAt: capture.occurredAt,
    });
    receipts.push(minimalReceipt(cost, index, capture, modelFields));
  }
  const conflicted = opts.conflicted ?? 0;
  const failed = opts.failed ?? 0;
  const written = Math.max(0, captured.length - conflicted - failed);
  return {
    expected: captured.length,
    written,
    replayed: 0,
    conflicted,
    failed,
    receipts,
    complete: opts.complete ?? (conflicted === 0 && failed === 0),
    markerPersisted: opts.markerPersisted ?? true,
  };
}
