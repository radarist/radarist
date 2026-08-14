/**
 * @file lib/schemas/operation-settlement.ts
 * @description ARUN-022 — provider ACTUAL/invoice settlement, kept SEPARATE from
 * the immutable receipt's canonical estimate.
 *
 * A receipt's cost is always the canonical ESTIMATE (computed from the rate card;
 * see `@/lib/operation-receipt-pricing`). A provider-SETTLED amount (an invoice, a
 * reconciled billing export) is a DIFFERENT KIND of fact with its own provenance
 * and arrival time, so it is recorded here as an APPEND-ONLY, owner-scoped
 * settlement that REFERENCES a receipt — never as a mutation or an override of the
 * receipt's estimate. Multiple settlements may accrue against one receipt (a
 * correction supersedes by recency in a reader), and the original estimate always
 * survives for audit.
 *
 * Privacy: content-free, exactly like receipts — only bounded opaque ids,
 * timestamps, and monetary facts. No prompts/responses/URLs/headers/keys.
 *
 * @author Radarist Team
 * @created 2026-07-23
 */

import { z } from 'zod';

const OPAQUE_ID_RE = /^[A-Za-z0-9:_.-]+$/;
/** A settlement id embeds `~`-framed opaque components, so its ref allows `~` too. */
const SETTLEMENT_ID_RE = /^[A-Za-z0-9:_.~-]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_ID_REF_LENGTH = 200;
const MAX_OWNER_LENGTH = 128;
const MAX_MICROS = 1_000_000_000_000_000; // 1e15
const MAX_REVISION = 1_000_000;

const opaqueId = (max: number) => z.string().min(1).max(max).regex(OPAQUE_ID_RE);
const settlementIdRef = z.string().min(1).max(1500).regex(SETTLEMENT_ID_RE);
const microUnits = z.number().int().nonnegative().max(MAX_MICROS);

/**
 * Canonicalize an ISO-8601 datetime to a single normal form (UTC `Z`, millisecond
 * precision) so equivalent representations of ONE instant
 * (`2026-07-23T00:00:00Z` ≡ `2026-07-23T00:00:00.000Z` ≡ `2026-07-23T02:00:00+02:00`)
 * derive the SAME settlement identity — never two ids, and never a fingerprint
 * mismatch on an idempotent replay. The input is already schema-validated as a
 * datetime with a timezone; a defensive NaN guard keeps a malformed value from
 * ever reaching identity derivation.
 */
export function canonicalizeIso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError('operation-settlement occurredAt is not a valid ISO-8601 instant');
  }
  return new Date(ms).toISOString();
}

/**
 * Coverage of a settled amount, mirroring the receipt's cost coverage: token
 * charges only, or tokens plus the provider's external fees.
 */
export const settlementCoverageSchema = z.enum(['tokens', 'tokens-and-fees']);
export type SettlementCoverage = z.infer<typeof settlementCoverageSchema>;

/**
 * A settlement is a FULL SNAPSHOT of the settled amount, never a delta:
 * `actualAmountMicros` is always the complete settled amount as of this
 * settlement, so an aggregator reads exactly one number and never sums a
 * "correction" on top of a "base". A correction is a NEW settlement that
 * SUPERSEDES the one it replaces via `supersedesSettlementId`, forming a strict
 * single chain (rev 0 → rev 1 → …). The canonical reader ({@link
 * resolveSettlementChain}) selects the one proven head or reports conflicted — it
 * NEVER guesses the current amount from timestamp or id ordering. All earlier
 * settlements are preserved append-only.
 */
const settlementFactsShape = {
  /** The receipt this settlement reconciles (its deterministic id). */
  receiptId: z.string().min(1).max(1500),
  /** The owner scope — MUST equal the receipt's owner (enforced by the repository). */
  owner: opaqueId(MAX_OWNER_LENGTH),
  /** The FULL provider-settled amount in exact integer micro-units (a snapshot, not a delta). */
  actualAmountMicros: microUnits,
  /** Explicit currency — never fabricated. */
  currency: z.string().regex(CURRENCY_RE),
  /** What the settled amount covers. */
  covers: settlementCoverageSchema,
  /** A bounded reference to the settlement evidence (invoice id, export id). */
  evidenceRef: opaqueId(MAX_ID_REF_LENGTH),
  /**
   * The immutable time the settlement OCCURRED (invoice/export instant), ISO-8601.
   * CANONICALIZED to UTC millisecond form on input so two equivalent
   * representations of one instant derive the same settlement identity.
   */
  occurredAt: z.string().datetime({ offset: true }).transform(canonicalizeIso),
  /**
   * The monotonic revision of this settlement in its supersession chain: 0 for the
   * base (no `supersedesSettlementId`), N+1 for the settlement that supersedes
   * revision N. The repository enforces the exact +1 against the referenced
   * settlement; the reader rejects any non-monotonic chain.
   */
  revision: z.number().int().nonnegative().max(MAX_REVISION),
  /**
   * The settlement this one CORRECTS (its id). Absent for a base (revision 0)
   * settlement; present (and revision ≥ 1) for a correction. Must reference an
   * earlier settlement of the SAME owner + receipt (verified by the repository);
   * cross-owner / cross-receipt / cyclic / forking references are rejected.
   */
  supersedesSettlementId: settlementIdRef.optional(),
};

/**
 * Base ⇒ revision 0 (no supersession); a correction ⇒ revision ≥ 1 with an
 * explicit `supersedesSettlementId`. The exact +1 and single-chain integrity are
 * enforced by the repository (which can read the referenced settlement) and the
 * canonical reader.
 */
function refineSettlementRevision(
  value: { revision: number; supersedesSettlementId?: string },
  ctx: z.RefinementCtx
): void {
  if (value.supersedesSettlementId === undefined) {
    if (value.revision !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a base settlement (no supersedesSettlementId) must be revision 0',
        path: ['revision'],
      });
    }
  } else if (value.revision < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a superseding settlement must be revision >= 1',
      path: ['revision'],
    });
  }
}

/** Facts required to append one settlement against a receipt. */
export const createOperationSettlementSchema = z
  .object(settlementFactsShape)
  .strict()
  .superRefine(refineSettlementRevision);
export type CreateOperationSettlementInput = z.infer<typeof createOperationSettlementSchema>;

/** A stored settlement: the create facts plus server-managed metadata. */
export const operationSettlementSchema = z
  .object({
    ...settlementFactsShape,
    id: z.string().min(1).max(1500),
    /** ISO-8601 time the settlement was persisted (≠ `occurredAt`). */
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(refineSettlementRevision);
export type OperationSettlement = z.infer<typeof operationSettlementSchema>;

const METADATA_FIELDS = new Set(['id', 'recordedAt']);

/** A stored settlement failed verification, or an append saw a conflicting duplicate. */
export class OperationSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationSettlementError';
  }
}

/**
 * Guard an id component: printable ASCII only, no `/` (Firestore-reserved),
 * bounded length. `~` IS allowed here (unlike the receipt-id components) because
 * one component — `receiptId` — is itself a full length-framed receipt id that
 * contains `~`; the length prefix makes every component boundary unambiguous
 * regardless of `~` inside, so injectivity holds.
 */
function assertIdComponent(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1500) {
    throw new RangeError('operation-settlement identity component is empty or too long');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x2f) {
      throw new RangeError('operation-settlement identity component is not id-safe');
    }
  }
}

/**
 * Deterministic, owner-scoped, Firestore-safe settlement id. Length-framed so a
 * component boundary can never shift. The identity is
 * `(owner, receiptId, occurredAt, evidenceRef, revision)`. `occurredAt` is
 * CANONICALIZED first, so equivalent ISO representations of one instant derive the
 * same id. `revision` is part of the identity so a CORRECTION that reuses the same
 * evidence at the same instant (a corrected invoice) gets a DISTINCT id and
 * persists ALONGSIDE the base, rather than colliding with — and being rejected as
 * a conflict against — the record it supersedes. An exact replay of one settlement
 * targets the same slot (idempotent); genuinely different settlements get distinct
 * ids and BOTH persist.
 */
export function deriveOperationSettlementId(input: {
  owner: string;
  receiptId: string;
  occurredAt: string;
  evidenceRef: string;
  revision: number;
}): string {
  const parts = [
    input.owner,
    input.receiptId,
    canonicalizeIso(input.occurredAt),
    input.evidenceRef,
    String(input.revision),
  ];
  for (const part of parts) assertIdComponent(part);
  return `opsettl~v1~${parts.map((part) => `${part.length}~${part}`).join('~')}`;
}

/** Stable serialization of a settlement's immutable facts (everything except server metadata). */
export function settlementFactsFingerprint(settlement: Record<string, unknown>): string {
  const facts: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(settlement)) {
    if (!METADATA_FIELDS.has(key) && val !== undefined) facts[key] = val;
  }
  return JSON.stringify(
    Object.keys(facts)
      .sort()
      .map((k) => [k, facts[k]])
  );
}

/**
 * Validate and verify a stored settlement before trusting it: schema (incl. ISO
 * timestamps), and doc-id == embedded id == derived identity.
 */
export function parseOperationSettlementDoc(docId: string, data: unknown): OperationSettlement {
  const settlement = operationSettlementSchema.parse(data);
  if (settlement.id !== docId) {
    throw new OperationSettlementError(`settlement doc id ${docId} does not match embedded id ${settlement.id}`);
  }
  const derived = deriveOperationSettlementId(settlement);
  if (derived !== settlement.id) {
    throw new OperationSettlementError(`settlement ${settlement.id} does not match its derived identity ${derived}`);
  }
  return settlement;
}

// ==========================================================================
// CANONICAL SETTLEMENT RESOLUTION (single proven head, or fail closed)
// ==========================================================================

/**
 * The outcome of resolving a receipt's settlements to its ONE current settled
 * amount:
 *   - `none` — no settlements exist for the receipt (the canonical estimate stands).
 *   - `settled` — the settlements form a single valid chain; `head` is the proven
 *     current full-snapshot amount, `chainLength` the number of settlements it
 *     supersedes back to the base.
 *   - `conflicted` — the settlements cannot be resolved to one proven head (a fork,
 *     a cycle, a dangling/cross-scope supersession, a non-monotonic revision, a
 *     disconnected branch, or competing heads). A reader MUST surface this and
 *     never pick an amount by timestamp or id ordering.
 */
export type SettlementResolution =
  | { status: 'none' }
  | { status: 'settled'; head: OperationSettlement; chainLength: number }
  | { status: 'conflicted'; reason: string };

/**
 * Resolve a set of settlements (all already owner + receipt scoped and verified)
 * to the one proven current settlement, or `conflicted`. This is the ONLY sanctioned
 * way to read "the current settled amount": it validates a STRICT single
 * supersession chain and never guesses.
 *
 * A valid chain has exactly one base (revision 0, no supersession), each later
 * settlement supersedes exactly one existing settlement with `revision = target+1`,
 * no settlement is superseded by more than one (no fork), there is exactly one head
 * (not superseded by anything), and the head walks back through every settlement
 * with no cycle (full coverage). Anything else is `conflicted`.
 */
export function resolveSettlementChain(settlements: readonly OperationSettlement[]): SettlementResolution {
  if (settlements.length === 0) return { status: 'none' };

  const byId = new Map<string, OperationSettlement>();
  for (const s of settlements) {
    if (byId.has(s.id)) return { status: 'conflicted', reason: `duplicate settlement id ${s.id}` };
    byId.set(s.id, s);
  }

  const superseded = new Set<string>();
  for (const s of settlements) {
    const target = s.supersedesSettlementId;
    if (target === undefined) {
      if (s.revision !== 0) return { status: 'conflicted', reason: `base settlement ${s.id} is not revision 0` };
      continue;
    }
    const parent = byId.get(target);
    // Dangling / cross-owner / cross-receipt references land outside this scoped set.
    if (!parent) {
      return { status: 'conflicted', reason: `settlement ${s.id} supersedes unknown/out-of-scope ${target}` };
    }
    if (parent.owner !== s.owner || parent.receiptId !== s.receiptId) {
      return { status: 'conflicted', reason: `settlement ${s.id} supersedes a cross-scope settlement ${target}` };
    }
    if (superseded.has(target)) {
      return { status: 'conflicted', reason: `two settlements supersede ${target} (competing heads)` };
    }
    if (s.revision !== parent.revision + 1) {
      return { status: 'conflicted', reason: `settlement ${s.id} revision is not one past ${target}` };
    }
    superseded.add(target);
  }

  const heads = settlements.filter((s) => !superseded.has(s.id));
  if (heads.length !== 1) {
    return { status: 'conflicted', reason: `expected exactly one head, found ${heads.length}` };
  }

  // Walk head → base; reject a cycle and require the chain to cover every settlement.
  const seen = new Set<string>();
  let cursor: OperationSettlement | undefined = heads[0];
  while (cursor) {
    if (seen.has(cursor.id)) return { status: 'conflicted', reason: `cycle at settlement ${cursor.id}` };
    seen.add(cursor.id);
    cursor = cursor.supersedesSettlementId ? byId.get(cursor.supersedesSettlementId) : undefined;
  }
  if (seen.size !== settlements.length) {
    return { status: 'conflicted', reason: 'settlements are not a single connected chain' };
  }

  return { status: 'settled', head: heads[0], chainLength: seen.size - 1 };
}
