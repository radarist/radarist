/**
 * @file lib/operation-settlement-repository.ts
 * @description ARUN-022 — server-only, APPEND-ONLY, owner-scoped repository for
 * provider actual/invoice settlements (see `@/lib/schemas/operation-settlement`).
 *
 * A settlement is an immutable record that a provider SETTLED a receipt's spend at
 * some amount. It is APPEND-ONLY: an exact replay of the same settlement is an
 * idempotent no-op; a settlement with the same identity but DIFFERENT facts throws
 * rather than overwriting a settled fact; and a genuinely new settlement (a later
 * correction, a different invoice) is a distinct document that persists alongside
 * the original — the receipt's canonical estimate is NEVER mutated.
 *
 * The `owner` on a settlement MUST match the referenced receipt's owner: a caller
 * can never settle another owner's receipt (verified server-side against the
 * stored receipt). Reads are owner-scoped and verify every document.
 *
 * @author Radarist Team
 * @created 2026-07-23
 */

import 'server-only';
import { db } from '@/lib/firebase-admin';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { createLogger } from '@/lib/logger';
import { getOperationReceipt } from '@/lib/operation-receipt-repository';
import {
  createOperationSettlementSchema,
  deriveOperationSettlementId,
  parseOperationSettlementDoc,
  resolveSettlementChain,
  settlementFactsFingerprint,
  type CreateOperationSettlementInput,
  type OperationSettlement,
  type SettlementResolution,
} from '@/lib/schemas/operation-settlement';

const log = createLogger('operation-settlement-repository');

const COLLECTION = 'operationSettlements';

/** Thrown when a settlement identity is re-recorded with different immutable facts. */
export class OperationSettlementConflictError extends Error {
  public readonly settlementId: string;
  public readonly existing: OperationSettlement;
  constructor(settlementId: string, existing: OperationSettlement) {
    super(`Operation settlement ${settlementId} already exists with different immutable facts`);
    this.name = 'OperationSettlementConflictError';
    this.settlementId = settlementId;
    this.existing = existing;
  }
}

/** Thrown when a settlement references a receipt the owner does not own (or that is absent). */
export class OperationSettlementOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationSettlementOwnershipError';
  }
}

/** Thrown when a correction's supersession chain is invalid (missing/cross-scope target, non-monotonic revision). */
export class OperationSettlementSupersessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationSettlementSupersessionError';
  }
}

/**
 * Read one settlement by its deterministic id, scoped to `owner`. Returns null
 * when absent or owned by someone else (fail closed — never leak across scopes).
 */
export async function getOperationSettlement(owner: string, id: string): Promise<OperationSettlement | null> {
  try {
    const snap = await db.collection(COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const settlement = parseOperationSettlementDoc(id, snap.data());
    if (settlement.owner !== owner) return null;
    return settlement;
  } catch (error) {
    log.error('Failed to read operation settlement', error, { settlementId: id });
    throw error;
  }
}

/**
 * Append one settlement against a receipt.
 *
 * @throws {z.ZodError} on invalid input.
 * @throws {OperationSettlementOwnershipError} if the receipt is absent or belongs to another owner.
 * @throws {OperationSettlementConflictError} on a conflicting replay.
 * @returns the stored settlement (fresh, or the pre-existing one on exact replay).
 */
export async function recordOperationSettlement(input: CreateOperationSettlementInput): Promise<OperationSettlement> {
  const validated = createOperationSettlementSchema.parse(input);

  // The settlement's owner MUST own the referenced receipt — never settle across
  // scopes. getOperationReceipt is already owner-scoped (returns null otherwise).
  const receipt = await getOperationReceipt(validated.owner, validated.receiptId);
  if (!receipt) {
    throw new OperationSettlementOwnershipError(
      `settlement references receipt ${validated.receiptId} that is absent or not owned by ${validated.owner}`
    );
  }

  // A correction must supersede an EXISTING settlement of the SAME owner + receipt,
  // with a revision exactly one past it. Cross-owner (getOperationSettlement is
  // owner-scoped → null), cross-receipt, and non-monotonic references fail closed
  // here; the reader ({@link resolveSettledAmount}) remains the final authority on
  // fork/cycle integrity that a single append cannot see.
  if (validated.supersedesSettlementId !== undefined) {
    const parent = await getOperationSettlement(validated.owner, validated.supersedesSettlementId);
    if (!parent) {
      throw new OperationSettlementSupersessionError(
        `settlement supersedes ${validated.supersedesSettlementId} that is absent or not owned by ${validated.owner}`
      );
    }
    if (parent.receiptId !== validated.receiptId) {
      throw new OperationSettlementSupersessionError(
        `settlement supersedes ${validated.supersedesSettlementId} that belongs to a different receipt`
      );
    }
    if (validated.revision !== parent.revision + 1) {
      throw new OperationSettlementSupersessionError(
        `settlement revision ${validated.revision} is not one past superseded revision ${parent.revision}`
      );
    }
  }

  const id = deriveOperationSettlementId(validated);
  const incomingFingerprint = settlementFactsFingerprint(validated as unknown as Record<string, unknown>);
  const ref = db.collection(COLLECTION).doc(id);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = parseOperationSettlementDoc(id, snap.data());
        if (settlementFactsFingerprint(existing as unknown as Record<string, unknown>) !== incomingFingerprint) {
          throw new OperationSettlementConflictError(id, existing);
        }
        return existing; // idempotent append
      }
      const settlement: OperationSettlement = { ...validated, id, recordedAt: new Date().toISOString() };
      tx.set(ref, sanitizeForFirestore(settlement));
      return settlement;
    });
  } catch (error) {
    log.error('Failed to record operation settlement', error, { settlementId: id, receiptId: validated.receiptId });
    throw error;
  }
}

/**
 * List every VERIFIED settlement for `owner` against one receipt. Owner +
 * receiptId equality predicates are pushed into Firestore; every returned document
 * is verified. The order is a STABLE listing order (occurrence, then id) for
 * display only — it is NOT the authority on which settlement is current. The
 * canonical current amount comes from {@link resolveSettledAmount}, which follows
 * the supersession chain and never guesses from ordering.
 */
export async function listOperationSettlementsByReceipt(
  owner: string,
  receiptId: string
): Promise<OperationSettlement[]> {
  try {
    const snap = await db.collection(COLLECTION).where('owner', '==', owner).where('receiptId', '==', receiptId).get();
    const settlements: OperationSettlement[] = [];
    for (const doc of snap.docs) {
      const settlement = parseOperationSettlementDoc(doc.id, doc.data());
      // Defense in depth: the query already scopes to this owner.
      if (settlement.owner === owner) settlements.push(settlement);
    }
    return settlements.sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1
    );
  } catch (error) {
    log.error('Failed to list operation settlements by receipt', error, { owner, receiptId });
    throw error;
  }
}

/**
 * Resolve a receipt's settlements to its ONE current settled amount, or a
 * fail-closed `conflicted` / `none`. This is the CANONICAL reader: it loads every
 * owner+receipt-scoped settlement and runs the strict single-chain validator
 * ({@link resolveSettlementChain}) — it selects the one proven head or reports
 * conflicted, and NEVER picks an amount by timestamp or id ordering.
 */
export async function resolveSettledAmount(owner: string, receiptId: string): Promise<SettlementResolution> {
  const settlements = await listOperationSettlementsByReceipt(owner, receiptId);
  return resolveSettlementChain(settlements);
}
