/**
 * @file lib/company-review-admin.ts
 * @description AI-043 — the server-only, Admin-SDK repository for the auditable
 * human source-review ledger.
 *
 * Review decisions live in the top-level, server-owned `companyReviewEvents`
 * collection. Like `operationReceipts` / `apiKeys`, every legitimate access is
 * through the Admin SDK (which bypasses Firestore rules); direct browser access is
 * denied by `firestore.rules`. The derived readiness state is NEVER stored — it is
 * recomputed from these events by the pure `company-review.ts` module.
 *
 * Recording is ATOMIC: the Company is read and its current review projection is
 * re-derived INSIDE the same transaction that writes the decision, so a research
 * refresh between the reviewer's load and this write is caught — the decision is
 * refused as stale rather than silently bound to an outdated draft.
 *
 * Trust boundary: `ownerId` and `reviewerId` are resolved by the caller from the
 * authenticated session and are baked into the event and its document id. A client
 * never chooses them, the timestamp, or the id. An exact replay of the same
 * decision identity is idempotent; the same identity carrying different bound facts
 * (including a different reviewer) is a conflict, never a silent overwrite.
 */

import 'server-only';

import { createHash } from 'node:crypto';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { validateUpdateCompany } from '@/lib/schemas/company';
import { triggerEntityGraphSyncBestEffortServer } from '@/lib/entity-sync-server';
import {
  buildCompanyReviewProjection,
  canonicalCompanyFieldWrite,
  deriveCompanyReviewReadiness,
  normalizeReviewNote,
  structuredClaimValue,
  type CompanyReviewArtifactKind,
  type CompanyReviewDecision,
  type CompanyReviewEvent,
} from '@/lib/company-review';
import type { CompanyReviewDecisionInput } from '@/lib/schemas/company-review';
import type { Company } from '@/lib/types';

const log = createLogger('company-review-admin');

/** Server-owned ledger collection. Denied to all direct client access by rules. */
export const COMPANY_REVIEW_EVENTS_COLLECTION = 'companyReviewEvents';

/** The authenticated identities the server binds onto a recorded decision. */
export interface CompanyReviewActor {
  ownerId: string;
  reviewerId: string;
}

export interface RecordCompanyReviewDecisionResult {
  event: CompanyReviewEvent;
  outcome: 'recorded' | 'replayed';
}

/** A replay of the same decision identity carrying different bound facts. */
export class CompanyReviewConflictError extends Error {
  public readonly existing: CompanyReviewEvent;
  constructor(existing: CompanyReviewEvent) {
    super(
      `A different review decision already exists for idempotency identity "${existing.id}"; ` +
        `replays must carry identical facts.`
    );
    this.name = 'CompanyReviewConflictError';
    this.existing = existing;
  }
}

/** The company being reviewed does not exist. */
export class CompanyReviewCompanyNotFoundError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = 'CompanyReviewCompanyNotFoundError';
  }
}

/** The decision was made against a draft that is no longer current. */
export class CompanyReviewStaleDraftError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CompanyReviewStaleDraftError';
  }
}

/** Promotion was attempted before the whole current draft is reviewed + approved. */
export class CompanyReviewNotReadyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CompanyReviewNotReadyError';
  }
}

/**
 * Promotion was attempted for a draft that has no canonical Company fields to
 * write — a narrative draft (reviewed for trust, never promoted onto scalar
 * fields) or a structured draft whose approved claims map to no Company field. A
 * distinct, honest failure — NEVER a `{ promoted: [] }` "success".
 */
export class CompanyReviewNotPromotableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CompanyReviewNotPromotableError';
  }
}

/**
 * Deterministic, collision-resistant, rule-safe, TEXTUAL document id for a
 * decision. Derived from (ownerId, idempotencyKey) via a JSON-encoded tuple —
 * unambiguous with no control/NUL bytes — so the same owner replaying the same
 * key always targets the same document, two owners never collide, and the raw
 * key/owner never leak into the id (which also avoids Firestore's reserved
 * `__.*__` id pattern).
 */
function reviewEventDocId(ownerId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([ownerId, idempotencyKey]), 'utf8')
    .digest('hex');
  return `rev-${digest.slice(0, 48)}`;
}

/** The facts that define a decision's identity. Two records with equal facts are the same decision. */
function boundFactsOf(event: {
  companyId: string;
  ownerId: string;
  reviewerId: string;
  artifactKind: CompanyReviewArtifactKind;
  artifactVersion: string;
  area: string;
  areaDigest: string;
  draftDigest: string;
  sourceIds: string[];
  decision: CompanyReviewDecision;
  note?: string;
}): string {
  return JSON.stringify({
    companyId: event.companyId,
    ownerId: event.ownerId,
    reviewerId: event.reviewerId,
    artifactKind: event.artifactKind,
    artifactVersion: event.artifactVersion,
    area: event.area,
    areaDigest: event.areaDigest,
    draftDigest: event.draftDigest,
    sourceIds: [...event.sourceIds].sort(),
    decision: event.decision,
    note: event.note ?? null,
  });
}

function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/**
 * Record a human source-review decision atomically and idempotently. The
 * transaction reads the Company AND the decision document. IDEMPOTENCY IS CHECKED
 * FIRST: an already-recorded decision (same identity, same bound facts) replays —
 * even if the draft has since been refreshed — because recorded history is not
 * invalidated by a later research pass, so a network retry of a committed decision
 * is never wrongly refused as stale. Only a GENUINELY NEW decision re-derives the
 * current projection and must be bound to the CURRENT draft (artifact kind/version,
 * whole-draft digest, area digest, exact sources); a stale one is refused. A
 * same-identity submission carrying DIFFERENT facts is a conflict, never a silent
 * overwrite.
 */
export async function recordCompanyReviewDecision(
  input: CompanyReviewDecisionInput,
  actor: CompanyReviewActor
): Promise<RecordCompanyReviewDecisionResult> {
  const docId = reviewEventDocId(actor.ownerId, input.idempotencyKey);
  const eventRef = db.collection(COMPANY_REVIEW_EVENTS_COLLECTION).doc(docId);
  const companyRef = db.collection('companies').doc(input.companyId);
  const note = normalizeReviewNote(input.note);
  const sourceIds = [...input.sourceIds].sort();

  // The exact facts this submission claims (from the reviewer's input). These are
  // what a NEW write stores; the stale-check below guarantees they equal the
  // re-derived projection before any new write, so a later replay compares equal.
  const claimed = {
    companyId: input.companyId,
    ownerId: actor.ownerId,
    reviewerId: actor.reviewerId,
    artifactKind: input.artifactKind,
    artifactVersion: input.artifactVersion,
    area: input.area,
    areaDigest: input.areaDigest,
    draftDigest: input.draftDigest,
    sourceIds,
    decision: input.decision,
    ...(note ? { note } : {}),
  };
  const claimedFacts = boundFactsOf(claimed);

  return db.runTransaction(async (tx) => {
    // All reads before any write (Firestore transaction rule).
    const companySnap = await tx.get(companyRef);
    const eventSnap = await tx.get(eventRef);

    // Idempotency FIRST — before any staleness check. An already-recorded decision
    // replays regardless of an intervening draft refresh; a different-facts replay
    // of the same identity is a conflict.
    if (eventSnap.exists) {
      const existing = eventSnap.data() as CompanyReviewEvent;
      if (boundFactsOf(existing) !== claimedFacts) throw new CompanyReviewConflictError(existing);
      return { event: existing, outcome: 'replayed' as const };
    }

    // A genuinely NEW decision must be bound to the CURRENT draft.
    if (!companySnap.exists) throw new CompanyReviewCompanyNotFoundError(input.companyId);
    const projection = buildCompanyReviewProjection(companySnap.data() as Company);
    const area = projection.areas.find((candidate) => candidate.key === input.area);
    if (!area || !area.reviewable) {
      throw new CompanyReviewStaleDraftError(
        `Area "${input.area}" is not a current, reviewable claim on this draft. Reload and review again.`
      );
    }
    if (
      input.artifactKind !== projection.artifactKind ||
      input.artifactVersion !== projection.artifactVersion ||
      input.draftDigest !== projection.draftDigest ||
      input.areaDigest !== area.areaDigest ||
      !sameSorted(input.sourceIds, area.sourceIds)
    ) {
      throw new CompanyReviewStaleDraftError('The draft changed since it was loaded. Reload and review again.');
    }

    // Admin `.set()` rejects `undefined` fields, so `note` is included only when present.
    const event: CompanyReviewEvent = { id: docId, createdAt: Date.now(), ...claimed };
    tx.set(eventRef, event);
    log.info('Recorded company review decision', {
      companyId: event.companyId,
      artifactKind: event.artifactKind,
      area: event.area,
      decision: event.decision,
    });
    return { event, outcome: 'recorded' as const };
  });
}

/**
 * List an owner's review events for a company, oldest first (deterministic id
 * tie-break for equal timestamps). Owner-scoped: a caller never sees another
 * owner's decisions.
 */
export async function listCompanyReviewEvents(companyId: string, ownerId: string): Promise<CompanyReviewEvent[]> {
  const snap = await db
    .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
    .where('companyId', '==', companyId)
    .where('ownerId', '==', ownerId)
    .get();
  return snap.docs
    .map((doc) => doc.data() as CompanyReviewEvent)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Firestore `in` accepts at most 10 values per query — chunk to stay within it. */
export const REVIEW_EVENT_IN_CHUNK = 10;

/**
 * Read the caller's review events for a BOUNDED, explicit set of companies, grouped
 * by companyId. Scoped to the requested companies via chunked `in` queries — read
 * cost is bounded by the companies actually asked about, NOT by the owner's entire
 * lifetime of review history (which the previous owner-wide scan read on every
 * queue render). Used by the batch review-summary endpoint (no N+1, no unbounded
 * scan). Chunks run concurrently.
 */
export async function listCompanyReviewEventsForCompanies(
  ownerId: string,
  companyIds: readonly string[]
): Promise<Map<string, CompanyReviewEvent[]>> {
  const uniqueIds = [...new Set(companyIds)].filter((id) => typeof id === 'string' && id.length > 0);
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += REVIEW_EVENT_IN_CHUNK) {
    chunks.push(uniqueIds.slice(i, i + REVIEW_EVENT_IN_CHUNK));
  }

  const snaps = await Promise.all(
    chunks.map((chunk) =>
      db
        .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
        .where('ownerId', '==', ownerId)
        .where('companyId', 'in', chunk)
        .get()
    )
  );

  const grouped = new Map<string, CompanyReviewEvent[]>();
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const event = doc.data() as CompanyReviewEvent;
      const list = grouped.get(event.companyId) ?? [];
      list.push(event);
      grouped.set(event.companyId, list);
    }
  }
  return grouped;
}

/**
 * Fetch a single review event, owner-scoped. A foreign owner's event and an
 * absent event return the SAME `null` — foreign and absent are indistinguishable.
 */
export async function getCompanyReviewEvent(eventId: string, ownerId: string): Promise<CompanyReviewEvent | null> {
  const snap = await db.collection(COMPANY_REVIEW_EVENTS_COLLECTION).doc(eventId).get();
  if (!snap.exists) return null;
  const event = snap.data() as CompanyReviewEvent;
  if (event.ownerId !== ownerId) return null;
  return event;
}

/**
 * Look up an ALREADY-recorded decision by its (owner, attempt id) identity — the
 * durable idempotency record. Returns the committed event, or null when none exists.
 * The Assistant record path uses this to replay an exact retry (a committed-but-lost
 * response, re-sent with the original prepare-minted attempt id) WITHOUT a fresh
 * confirmation, while a genuinely new attempt id (not yet recorded) still routes
 * through the two-turn human gate. Owner-scoped, matching the doc-id namespacing.
 */
export async function findRecordedReviewDecision(
  ownerId: string,
  idempotencyKey: string
): Promise<CompanyReviewEvent | null> {
  return getCompanyReviewEvent(reviewEventDocId(ownerId, idempotencyKey), ownerId);
}

/**
 * Honest post-commit graph-handoff status — the canonical write is ALWAYS already
 * committed; this distinguishes four genuinely different outcomes rather than
 * collapsing them into one "ok":
 *  - `delivered`  — Inngest accepted the sync event.
 *  - `deferred`   — not delivered, but a DURABLE recovery anchor was recorded to
 *                   reconcile it later; the debt is tracked.
 *  - `suppressed` — graph sync is switched OFF by operator policy
 *                   (`GRAPH_SYNC_ENABLED=false`); not attempted, not a debt.
 *  - `failed`     — not delivered AND the recovery anchor could not be written, so
 *                   there is NO durable record to reconcile from. Surfaced, never
 *                   swallowed.
 */
export type CompanyReviewGraphSyncStatus = 'delivered' | 'deferred' | 'suppressed' | 'failed';

export interface PromoteCompanyReviewResult {
  /** Canonical Company fields written from currently-approved claims. */
  promoted: string[];
  /** Truthful post-commit graph-handoff status (see {@link CompanyReviewGraphSyncStatus}). */
  graphSync: CompanyReviewGraphSyncStatus;
}

/** Shallow undefined-strip so a `.update()` never carries `undefined` fields. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * AI-043 — the SEPARATE, EXPLICIT promotion action. Copies the reviewed value of
 * the current structured claims onto the canonical Company fields. This is the
 * ONLY path that promotes a reviewed value onto the Company — research writes
 * drafts, and recording a review decision never mutates the Company. Never called
 * automatically.
 *
 * READY-ONLY + ATOMIC: the Company and the caller's review events are read, the
 * current projection + readiness are re-derived, and the canonical update is
 * written ALL inside one Firestore transaction. Promotion proceeds only when the
 * WHOLE current draft is reviewed and approved with no blocker (contradiction,
 * evidence gap, incomplete sourcing, or unreviewable/rejected/needs-changes/
 * unreviewed area); otherwise it throws {@link CompanyReviewNotReadyError} and
 * writes nothing — never a partial promotion. Because the projection is
 * re-derived inside the transaction, a research refresh between the reviewer's
 * approval and this write cannot promote stale values (it fails readiness).
 * Replay is idempotent: re-running while already-promoted re-writes the same
 * values from the same ready draft.
 *
 * Shared-company policy: Company records are shared workspace entities (no owner
 * field; emulator rules are wide-open — see docs/LIMITATIONS.md). Canonical
 * mutation therefore requires only authentication (the same authority as
 * `updateCompany`), enforced by the API route. Promotion applies the CALLER'S OWN
 * owner-scoped approvals; another owner's private approvals never promote.
 * Recording a private approval does not, by itself, mutate the shared Company —
 * only this explicit, authenticated promotion does.
 *
 * Only structured claims map to canonical fields; narrative sections have no
 * scalar field mapping and are not promoted.
 */
export async function promoteApprovedCompanyReviewClaims(
  companyId: string,
  ownerId: string
): Promise<PromoteCompanyReviewResult> {
  const companyRef = db.collection('companies').doc(companyId);
  const eventsQuery = db
    .collection(COMPANY_REVIEW_EVENTS_COLLECTION)
    .where('companyId', '==', companyId)
    .where('ownerId', '==', ownerId);

  const promoted = await db.runTransaction(async (tx) => {
    // All reads before any write (Firestore transaction rule).
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) throw new CompanyReviewCompanyNotFoundError(companyId);
    const eventsSnap = await tx.get(eventsQuery);

    const company = companySnap.data() as Company;
    const events = eventsSnap.docs.map((docSnap) => docSnap.data() as CompanyReviewEvent);
    const projection = buildCompanyReviewProjection(company);
    const readiness = deriveCompanyReviewReadiness(projection, events);

    // Ready-only: the whole CURRENT draft must be approved with no blocker. A
    // refresh between the read and this write is caught here (re-derivation).
    if (!readiness.ready) {
      throw new CompanyReviewNotReadyError(
        'Promotion requires the whole current draft to be reviewed and approved with no blockers.'
      );
    }
    // Only structured claims map to canonical fields. A narrative draft is
    // reviewed for trust but has NO scalar mapping — refuse it explicitly rather
    // than reporting a hollow `{ promoted: [] }` success.
    if (projection.artifactKind !== 'structured') {
      throw new CompanyReviewNotPromotableError(
        'A narrative research draft is reviewed for trust, not promoted onto Company fields.'
      );
    }

    const updates: Record<string, unknown> = {};
    const promotedFields: string[] = [];
    const location = { city: company.location?.city ?? '', country: company.location?.country ?? '' };
    let locationTouched = false;

    // Readiness guarantees a current approved decision for every reviewable area.
    // Promotion writes the COMPLETE (untruncated) reviewed value through the SAME
    // `canonicalCompanyFieldWrite` mapping that gated reviewability — so it writes
    // EXACTLY what was reviewed, never the display-bounded value and never a coerced
    // or truncated one. A reviewable area always maps (non-null); the `continue` is
    // defensive.
    for (const area of projection.areas) {
      if (!area.reviewable) continue;
      const full = structuredClaimValue(company.aiResearch, area.key);
      const write = full !== undefined ? canonicalCompanyFieldWrite(area.key, full) : null;
      if (!write) continue;
      if (write.field === 'city') {
        location.city = write.value as string;
        locationTouched = true;
      } else if (write.field === 'country') {
        location.country = write.value as string;
        locationTouched = true;
      } else {
        updates[write.field] = write.value;
        promotedFields.push(write.field);
      }
    }
    if (locationTouched) {
      updates.location = location;
      promotedFields.push('location');
    }
    // A ready structured draft whose approved claims map to NO Company field has
    // nothing to promote — an honest failure, not a silent empty success.
    if (promotedFields.length === 0) {
      throw new CompanyReviewNotPromotableError(
        'The approved claims map to no canonical Company field — nothing to promote.'
      );
    }

    // Strict validation (exact enum/URL/industry members, NO normalization) INSIDE
    // the txn as belt-and-suspenders — every value already canonical, so it writes
    // unchanged.
    const validated = validateUpdateCompany(updates);
    tx.update(companyRef, stripUndefined({ ...validated, updatedAt: Date.now() }));
    return promotedFields;
  });

  // Post-commit graph handoff. The canonical write is ALREADY committed; report the
  // handoff truthfully across four distinct states rather than collapsing them.
  const graphSync = await settlePromotionGraphSync(companyId, promoted);
  return { promoted, graphSync };
}

/**
 * Trigger the post-commit graph handoff and classify it truthfully. Suppression
 * (operator policy) is checked FIRST and never attempts a send or records a debt;
 * otherwise the best-effort helper's outcome distinguishes a delivered send, a
 * durably-deferred one (recovery anchor written), and an unanchored failure.
 */
async function settlePromotionGraphSync(companyId: string, promoted: string[]): Promise<CompanyReviewGraphSyncStatus> {
  const suppressed = process.env.GRAPH_SYNC_ENABLED === 'false' || process.env.IMPULSE_GRAPH_SYNC_ENABLED === 'false';
  if (suppressed) {
    log.info('Promoted approved company review claims; graph sync suppressed by operator policy', {
      companyId,
      promoted,
    });
    return 'suppressed';
  }

  const outcome = await triggerEntityGraphSyncBestEffortServer('company', companyId, 'update');
  if (outcome.acknowledged) {
    log.info('Promoted approved company review claims to canonical fields', { companyId, promoted });
    return 'delivered';
  }
  if (outcome.anchorRecorded) {
    log.warn('Promotion committed; graph sync deferred to a durable recovery anchor', { companyId, promoted });
    return 'deferred';
  }
  // Not delivered AND no durable anchor — surfaced, never swallowed.
  log.error('Promotion committed but graph sync FAILED with no recovery anchor — Neo4j may be out of sync', undefined, {
    companyId,
    promoted,
  });
  return 'failed';
}
