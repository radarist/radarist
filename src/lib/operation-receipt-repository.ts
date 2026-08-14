/**
 * @file lib/operation-receipt-repository.ts
 * @description ARUN-022 — server-only durable writer/reader for
 * operation-usage receipts (see `@/lib/schemas/operation-receipt`).
 *
 * A receipt is an IMMUTABLE record of one provider response. This repository
 * enforces that immutability at the write chokepoint:
 *   - the document id is the owner-scoped deterministic receipt identity, so a
 *     re-record of the same operation targets the same slot;
 *   - inside a transaction, if the slot already holds a receipt whose immutable
 *     facts are byte-identical, the write is an idempotent no-op returning the
 *     stored receipt (safe under Inngest retries / replays);
 *   - if the slot holds a receipt with DIFFERENT immutable facts, the write
 *     throws `OperationReceiptConflictError` rather than overwriting a settled
 *     fact.
 *
 * Reads are OWNER-SCOPED and verify every document before returning it, so a
 * receipt is never handed to — or mixed with — a different owner's scope. The
 * by-correlation reader pushes `correlation.owner`, `correlation.parentType`,
 * and `correlation.correlationId` equality predicates into Firestore (multiple
 * equality filters are served by single-field indexes via a merge join — no
 * composite index) and keeps the in-memory owner+parentType check only as
 * defense. `parentType` is part of the receipt identity, so a `correlationId`
 * that repeats across different parent types cannot mix into one result. It
 * needs no composite index and no security-rules change (Admin SDK writes/reads
 * bypass rules; client access is denied in `firestore.rules`).
 *
 * FOUNDATION ONLY: this module never instruments a provider and never triggers
 * provider spend — it only persists and reads receipts handed to it.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import 'server-only';
import { db } from '@/lib/firebase-admin';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { createLogger } from '@/lib/logger';
import { priceReceiptCounters } from '@/lib/operation-receipt-pricing';
import {
  createOperationReceiptSchema,
  deriveOperationReceiptId,
  LegacyReplayAmbiguityError,
  legacyComparableFingerprint,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  operationReceiptSchema,
  parseOperationReceiptDoc,
  receiptFactsFingerprint,
  receiptIdentity,
  type CreateOperationReceiptInput,
  type OperationCost,
  type OperationParentType,
  type OperationReceipt,
} from '@/lib/schemas/operation-receipt';

const log = createLogger('operation-receipt-repository');

const COLLECTION = 'operationReceipts';

/**
 * Thrown when a receipt identity is re-recorded with immutable facts that
 * differ from the already-stored receipt. Carries the stored side so callers
 * can log the exact divergence.
 */
export class OperationReceiptConflictError extends Error {
  public readonly receiptId: string;
  public readonly existing: OperationReceipt;

  constructor(receiptId: string, existing: OperationReceipt) {
    super(`Operation receipt ${receiptId} already exists with different immutable facts`);
    this.name = 'OperationReceiptConflictError';
    this.receiptId = receiptId;
    this.existing = existing;
  }
}

/**
 * A stored document in an owner's ledger slice failed verification. A canonical
 * accounting read fails closed with this error rather than silently omitting a
 * corrupt receipt and under-reporting spend.
 */
export class OperationReceiptLedgerIntegrityError extends Error {
  public readonly receiptId: string;

  constructor(receiptId: string, cause?: unknown) {
    super(`Operation receipt ${receiptId} failed ledger-integrity verification`);
    this.name = 'OperationReceiptLedgerIntegrityError';
    this.receiptId = receiptId;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Derive the immutable canonical cost for a receipt from its RAW provider facts,
 * using the ONE canonical pricing kernel. This is the ONLY place a current (v2)
 * receipt's cost is minted: it is a deterministic function of the raw facts, so a
 * caller can never supply, forge, or override the amount / model / tier / rate /
 * breakdown / currency, and a provider ACTUAL never enters a receipt (it is a
 * separate append-only settlement). Fails closed to an `unavailable` cost — never
 * a guessed number — for an unknown provider/model/fee/tier or malformed usage.
 */
function deriveReceiptCost(validated: CreateOperationReceiptInput): OperationCost {
  return priceReceiptCounters({
    provider: validated.provider,
    model: validated.model,
    requestedModel: validated.requestedModel,
    modelProvenance: validated.modelProvenance,
    usageCompleteness: validated.usageCompleteness,
    counters: validated.counters,
    feeState: validated.feeState,
    externalFees: validated.externalFees,
    occurredAt: validated.occurredAt,
  });
}

/**
 * The write outcome for one receipt: a genuinely new document was `written`, or an
 * idempotent `replayed` (an existing byte-identical / matching-legacy record was
 * preserved with no re-write). A conflict throws; it is not an outcome value.
 */
export type ReceiptWriteOutcome = 'written' | 'replayed';

/** A recorded receipt plus whether it was freshly written or an idempotent replay. */
export interface RecordedOperationReceipt {
  receipt: OperationReceipt;
  outcome: ReceiptWriteOutcome;
}

/**
 * Record one operation receipt and report whether it was freshly `written` or an
 * idempotent `replayed`. The input carries the RAW provider facts ONLY — never a
 * `cost`; the immutable cost is DERIVED here, inside the persistence boundary, from
 * the canonical pricing kernel, so a forged/actual/mismatched cost is
 * unrepresentable at this seam. The fully-formed receipt is re-validated against
 * the stored schema (v2 provenance included) before it is written.
 *
 * @throws {z.ZodError} if the input fails validation (incl. the value-level boundary).
 * @throws {OperationReceiptConflictError} on a conflicting replay (incl. an
 *   undecidable legacy-vs-current normalization, which fails closed to a conflict).
 */
export async function recordOperationReceiptWithOutcome(
  input: CreateOperationReceiptInput
): Promise<RecordedOperationReceipt> {
  const validated = createOperationReceiptSchema.parse(input);
  // Mint the canonical cost from the raw facts (never trusted from the caller).
  const cost = deriveReceiptCost(validated);
  const id = deriveOperationReceiptId(receiptIdentity(validated));
  // The full non-metadata fact set for the current (v2) receipt, including the
  // derived cost — the fingerprint an exact v2 replay must match byte-for-byte.
  const incomingFacts: Record<string, unknown> = { ...(validated as unknown as Record<string, unknown>), cost };
  const incomingFingerprint = receiptFactsFingerprint(incomingFacts);
  const ref = db.collection(COLLECTION).doc(id);

  try {
    return await db.runTransaction<RecordedOperationReceipt>(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        // Verify the stored document before any replay/conflict decision —
        // malformed stored data must fail closed, never be trusted or returned.
        const existing = parseOperationReceiptDoc(id, snap.data());
        if (existing.schemaVersion === undefined) {
          // A current (v2) write over an existing LEGACY (v1) document at the same
          // identity: compare the SHARED RAW provider facts (provider, model,
          // counters normalized per the PROVIDER'S cache semantics, usage, fees).
          // If they match, this is an idempotent replay of the SAME provider
          // response recorded before the occurrence/scope/fee facts existed — the
          // mere ABSENCE of those v2-only fields, and a legacy→canonical COST
          // upgrade, must not conflict, so preserve the immutable legacy record. If
          // any raw fact DIFFERS it is a genuine conflict — the newer observed
          // spend must NOT silently disappear behind the legacy doc. An undecidable
          // normalization (unknown provider with cached tokens) ALSO fails closed
          // to a conflict rather than silently replaying. The incoming create input
          // is a v2 write (raw prompt), so it is normalized as v2.
          let idempotent: boolean;
          try {
            const existingV1 = legacyComparableFingerprint(existing as unknown as Record<string, unknown>);
            const incomingV1 = legacyComparableFingerprint({
              ...incomingFacts,
              schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
            });
            idempotent = existingV1 === incomingV1;
          } catch (error) {
            if (error instanceof LegacyReplayAmbiguityError) {
              throw new OperationReceiptConflictError(id, existing);
            }
            throw error;
          }
          if (!idempotent) {
            throw new OperationReceiptConflictError(id, existing);
          }
          log.info('Preserving legacy operation receipt over a matching v2 re-record (idempotent)', {
            receiptId: id,
            operation: validated.operation,
          });
          return { receipt: existing, outcome: 'replayed' };
        }
        if (receiptFactsFingerprint(existing as unknown as Record<string, unknown>) !== incomingFingerprint) {
          throw new OperationReceiptConflictError(id, existing);
        }
        // Exact replay — idempotent, no re-write. Preserve the original record.
        return { receipt: existing, outcome: 'replayed' };
      }

      // Re-validate the fully-formed receipt (defense in depth: the derived cost
      // and v2 provenance must satisfy the stored schema before it is persisted).
      const receipt: OperationReceipt = operationReceiptSchema.parse({
        ...validated,
        cost,
        id,
        recordedAt: new Date().toISOString(),
        schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
      });
      tx.set(ref, sanitizeForFirestore(receipt));
      return { receipt, outcome: 'written' };
    });
  } catch (error) {
    if (error instanceof OperationReceiptConflictError) {
      log.error('Conflicting operation-receipt replay rejected', error, {
        receiptId: id,
        operation: validated.operation,
      });
    } else {
      log.error('Failed to record operation receipt', error, { receiptId: id, operation: validated.operation });
    }
    throw error;
  }
}

/**
 * Record one operation receipt, returning the stored receipt (freshly written, or
 * the pre-existing one on idempotent replay). A thin wrapper over
 * {@link recordOperationReceiptWithOutcome} for callers that don't need the outcome.
 */
export async function recordOperationReceipt(input: CreateOperationReceiptInput): Promise<OperationReceipt> {
  return (await recordOperationReceiptWithOutcome(input)).receipt;
}

/**
 * Read a single receipt by its deterministic id, scoped to `owner`. Returns
 * null when the document is absent or belongs to a different owner (fail closed
 * — never leak across scopes even though the id already encodes the owner).
 */
export async function getOperationReceipt(owner: string, id: string): Promise<OperationReceipt | null> {
  try {
    const snap = await db.collection(COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const receipt = parseOperationReceiptDoc(id, snap.data());
    if (receipt.correlation.owner !== owner) return null;
    return receipt;
  } catch (error) {
    log.error('Failed to read operation receipt', error, { receiptId: id });
    throw error;
  }
}

/**
 * Read every VERIFIED receipt for `owner` tied to one parent correlation,
 * sorted by record time. BOTH `correlation.owner` and `correlation.correlationId`
 * equality predicates are pushed into Firestore (multiple equality filters are
 * served by single-field indexes via a merge join — no composite index), so a
 * different tenant's receipts are never downloaded; the in-memory owner check is
 * retained only as defense in depth.
 *
 * Every returned document is verified. A canonical accounting read must NOT
 * silently omit a corrupt receipt and under-count spend, so a verification
 * failure throws `OperationReceiptLedgerIntegrityError` (fail closed) rather than
 * skipping the document.
 */
export async function listOperationReceiptsByCorrelation(
  owner: string,
  parentType: OperationParentType,
  correlationId: string
): Promise<OperationReceipt[]> {
  try {
    const snap = await db
      .collection(COLLECTION)
      .where('correlation.owner', '==', owner)
      .where('correlation.parentType', '==', parentType)
      .where('correlation.correlationId', '==', correlationId)
      .get();
    const receipts: OperationReceipt[] = [];
    for (const doc of snap.docs) {
      let receipt: OperationReceipt;
      try {
        receipt = parseOperationReceiptDoc(doc.id, doc.data());
      } catch (error) {
        throw new OperationReceiptLedgerIntegrityError(doc.id, error);
      }
      // Defense in depth: the query already scopes to this owner + parentType.
      if (receipt.correlation.owner === owner && receipt.correlation.parentType === parentType) {
        receipts.push(receipt);
      }
    }
    return receipts.sort((a, b) =>
      a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1
    );
  } catch (error) {
    log.error('Failed to list operation receipts by correlation', error, { owner, parentType, correlationId });
    throw error;
  }
}
