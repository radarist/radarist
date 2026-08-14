/**
 * @file lib/schemas/operation-accounting-marker.ts
 * @description ARUN-022 — a durable, content-free marker of whether a parent
 * operation's captured provider spend was FULLY recorded as receipts, so receipt
 * LOSS is visible instead of silently swallowed.
 *
 * A capture-and-flush pass turns each captured provider usage into a durable
 * receipt. The pass reports a structured outcome — how many were expected, written
 * fresh, idempotently replayed, conflicted, or failed. This marker persists that
 * outcome per parent correlation and derives an honest `accountingState`:
 *   - `complete`   — every expected capture became a durable receipt (no conflict,
 *     no failure); the parent's nested-spend accounting is whole.
 *   - `incomplete` — at least one capture conflicted or failed, so a total built
 *     from this parent's receipts is NOT provably whole. Never presented as
 *     complete.
 *
 * `accountingState` is DERIVED from the counts (never trusted from a caller), the
 * same fail-closed discipline as receipt cost. Privacy: content-free — only
 * bounded slugs, opaque ids, integer counts, and timestamps.
 *
 * @author Radarist Team
 * @created 2026-07-23
 */

import { z } from 'zod';
import { operationParentTypeSchema, type OperationParentType } from './operation-receipt';

const OPAQUE_ID_RE = /^[A-Za-z0-9:_.-]+$/;
const MAX_OWNER_LENGTH = 128;
const MAX_CORRELATION_ID_LENGTH = 200;
const MAX_BATCH_ID_LENGTH = 200;
const MAX_COUNT = 10_000_000;

const opaqueId = (max: number) => z.string().min(1).max(max).regex(OPAQUE_ID_RE);
const count = z.number().int().nonnegative().max(MAX_COUNT);
/** The ONE definition of the marker's occurrence-time contract, reused everywhere. */
const occurredAtSchema = z.string().datetime();

/**
 * True iff `value` is exactly what the marker's `occurredAt` accepts. Used by the
 * flush path to pick a valid occurrence time from captures WITHOUT trusting a
 * malformed provider timestamp — so a bad timestamp can never block the loss record.
 */
export function isValidMarkerOccurredAt(value: unknown): value is string {
  return occurredAtSchema.safeParse(value).success;
}

/** The structured outcome of one capture-and-flush pass. */
export interface AccountingFlushCounts {
  /** How many captured usages the flush attempted to persist. */
  expected: number;
  /** How many became a genuinely new durable receipt. */
  written: number;
  /** How many were idempotent replays of an already-durable receipt. */
  replayed: number;
  /** How many hit a conflicting identity (different immutable facts) — a receipt loss. */
  conflicted: number;
  /** How many failed to persist (validation / transport) — a receipt loss. */
  failed: number;
}

export type AccountingState = 'complete' | 'incomplete';

/**
 * Derive the honest accounting state from the counts: complete ONLY when nothing
 * conflicted and nothing failed (so every expected capture is durable). Fail
 * closed — any loss makes the state `incomplete`.
 */
export function deriveAccountingState(counts: AccountingFlushCounts): AccountingState {
  return counts.conflicted === 0 && counts.failed === 0 ? 'complete' : 'incomplete';
}

const flushCountsShape = {
  expected: count,
  written: count,
  replayed: count,
  conflicted: count,
  failed: count,
};

/**
 * Cross-field count integrity: the four terminal outcomes partition `expected`
 * exactly (written + replayed + conflicted + failed === expected), so a marker can
 * never over- or under-count the flush.
 */
function refineCountPartition(
  value: { expected: number; written: number; replayed: number; conflicted: number; failed: number },
  ctx: z.RefinementCtx
): void {
  const sum = value.written + value.replayed + value.conflicted + value.failed;
  if (sum !== value.expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `flush counts must partition expected (${value.expected}); got ${sum}`,
      path: ['expected'],
    });
  }
}

const markerIdentityShape = {
  owner: opaqueId(MAX_OWNER_LENGTH),
  parentType: operationParentTypeSchema,
  correlationId: opaqueId(MAX_CORRELATION_ID_LENGTH),
  /**
   * The FLUSH BATCH this marker records — a stable per-batch discriminator (the
   * flush's invocation prefix). ONE marker per (parent correlation × batch), so an
   * independent later batch under the SAME parent writes a DIFFERENT slot and can
   * NEVER erase an earlier batch's unresolved loss; a re-flush of the SAME batch
   * upserts the same slot idempotently. The parent's whole-of-accounting state is
   * DERIVED across every batch by {@link resolveParentAccountingState}.
   */
  batchId: opaqueId(MAX_BATCH_ID_LENGTH),
};

/** Facts required to record one parent-accounting marker. `accountingState` is DERIVED, not an input. */
export const createParentAccountingMarkerSchema = z
  .object({
    ...markerIdentityShape,
    ...flushCountsShape,
    /**
     * When the flush pass ran (ISO-8601). OPTIONAL: a malformed provider timestamp
     * must never PREVENT recording the loss — the loss counts are the terminal
     * fact — so when no valid occurrence time can be derived, the marker is written
     * with `occurredAt` ABSENT ("occurrence unknown") rather than failing.
     */
    occurredAt: occurredAtSchema.optional(),
  })
  .strict()
  .superRefine(refineCountPartition);
export type CreateParentAccountingMarkerInput = z.infer<typeof createParentAccountingMarkerSchema>;

/** A stored marker: the create facts + the DERIVED state + server metadata. */
export const parentAccountingMarkerSchema = z
  .object({
    ...markerIdentityShape,
    ...flushCountsShape,
    occurredAt: occurredAtSchema.optional(),
    accountingState: z.enum(['complete', 'incomplete']),
    id: z.string().min(1).max(1500),
    /** ISO-8601 time this marker was last written (a marker is a current-state upsert). */
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(refineCountPartition)
  .superRefine((value, ctx) => {
    // The stored state MUST match what the counts derive — never a trusted input.
    if (value.accountingState !== deriveAccountingState(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'accountingState must be derived from the counts (complete iff conflicted + failed === 0)',
        path: ['accountingState'],
      });
    }
  });
export type ParentAccountingMarker = z.infer<typeof parentAccountingMarkerSchema>;

/** A stored marker failed verification. */
export class ParentAccountingMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentAccountingMarkerError';
  }
}

function assertIdComponent(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1500) {
    throw new RangeError('parent-accounting-marker identity component is empty or too long');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x2f) {
      throw new RangeError('parent-accounting-marker identity component is not id-safe');
    }
  }
}

/**
 * Deterministic, owner-scoped, Firestore-safe marker id. Length-framed so a
 * component boundary can never shift. The identity is
 * `(owner, parentType, correlationId, batchId)` — ONE marker per parent
 * correlation PER FLUSH BATCH, so a re-flush of the same batch upserts the same
 * slot idempotently while an independent later batch under the same parent writes
 * a distinct slot and can never overwrite (erase) an earlier batch's loss.
 */
export function deriveParentAccountingMarkerId(input: {
  owner: string;
  parentType: OperationParentType;
  correlationId: string;
  batchId: string;
}): string {
  const parts = [input.owner, input.parentType, input.correlationId, input.batchId];
  for (const part of parts) assertIdComponent(part);
  return `opacct~v1~${parts.map((part) => `${part.length}~${part}`).join('~')}`;
}

/**
 * Validate and verify a stored marker before trusting it: schema (incl. the count
 * partition + derived-state consistency) and doc-id == embedded id == derived id.
 */
export function parseParentAccountingMarkerDoc(docId: string, data: unknown): ParentAccountingMarker {
  const marker = parentAccountingMarkerSchema.parse(data);
  if (marker.id !== docId) {
    throw new ParentAccountingMarkerError(`marker doc id ${docId} does not match embedded id ${marker.id}`);
  }
  const derived = deriveParentAccountingMarkerId(marker);
  if (derived !== marker.id) {
    throw new ParentAccountingMarkerError(`marker ${marker.id} does not match its derived identity ${derived}`);
  }
  return marker;
}

// ==========================================================================
// PARENT ROLL-UP — the whole-of-parent accounting state across every batch
// ==========================================================================

/**
 * The whole-of-parent accounting state, rolled up across EVERY flush batch under
 * one parent correlation. `accountingState` is `complete` ONLY when every batch is
 * complete — a single unresolved loss in ANY batch keeps the parent `incomplete`,
 * so an earlier loss can never be masked by a later successful batch. Counts are
 * summed across batches.
 */
export interface ParentAccountingState {
  accountingState: AccountingState;
  batchCount: number;
  expected: number;
  written: number;
  replayed: number;
  conflicted: number;
  failed: number;
}

/**
 * Roll up every batch marker for one parent into its whole-of-parent state, or
 * `null` when the parent has no markers. Terminal truth: the parent is complete
 * ONLY if every batch is complete; any batch's unresolved loss keeps it
 * incomplete. Pure — the caller supplies the already-verified, owner+correlation
 * scoped marker set.
 */
export function resolveParentAccountingState(markers: readonly ParentAccountingMarker[]): ParentAccountingState | null {
  if (markers.length === 0) return null;
  const totals = { expected: 0, written: 0, replayed: 0, conflicted: 0, failed: 0 };
  for (const m of markers) {
    totals.expected += m.expected;
    totals.written += m.written;
    totals.replayed += m.replayed;
    totals.conflicted += m.conflicted;
    totals.failed += m.failed;
  }
  return {
    accountingState: totals.conflicted === 0 && totals.failed === 0 ? 'complete' : 'incomplete',
    batchCount: markers.length,
    ...totals,
  };
}
