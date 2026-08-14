/**
 * @file proposed-artifacts-admin.ts
 * @description Admin-SDK store + triage for ARTIFACT RECOMMENDATIONS — the fourth
 * proposal kind. A recommendation to produce a report / research doc / infographic
 * is ALWAYS written `pending` with generation `idle`; approval flips it to
 * `approved` + `generating`, and the triage route then dispatches the generation
 * job (this module stays Inngest-free so it is unit-testable in isolation). The
 * generation job calls `updateProposedArtifact` to record the output / failure.
 * Server-only.
 */
import 'server-only';

import { z } from 'zod';
import { db } from '@/lib/firebase-admin';
import { buildMissionDocument } from '@/lib/missions';
import { createLogger } from '@/lib/logger';
import {
  proposedArtifactSchema,
  generateProposedArtifactKey,
  type ProposedArtifact,
  type ProposedArtifactStatus,
  type ArtifactKind,
} from '@/lib/schemas/proposed-artifact';

const log = createLogger('proposed-artifacts-admin');

const COLLECTION_NAME = 'proposedArtifacts';
const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Built from the schema INPUT type so callers may rely on the Zod defaults
// (matchedTopics / params / confidence / scope are optional at the call site).
export type CreateProposedArtifactInput = Omit<
  z.input<typeof proposedArtifactSchema>,
  | 'id'
  | 'status'
  | 'generationStatus'
  | 'outputRef'
  | 'generationError'
  | 'createdAt'
  | 'updatedAt'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'appliedAt'
  | 'feedbackReason'
>;

export interface ProposedArtifactFilters {
  status?: ProposedArtifactStatus;
  artifactKind?: ArtifactKind;
}

/**
 * SEC-011: thrown for EVERY miss on an owner-scoped read/mutation — absent id,
 * another user's proposal, or an ownerless legacy doc. One error class (and one
 * route response) for all three, so a caller can never probe whether a foreign
 * id exists.
 */
export class ProposedArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Proposed artifact not found: ${id}`);
    this.name = 'ProposedArtifactNotFoundError';
  }
}

/**
 * Transactional owner-checked resolve. Reads the doc INSIDE the caller's
 * transaction so the ownership + status precondition cannot go stale between
 * check and write.
 */
async function resolveOwned(
  tx: FirebaseFirestore.Transaction,
  id: string,
  callerUid: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: ProposedArtifact }> {
  const ref = db.collection(COLLECTION_NAME).doc(id);
  const snap = await tx.get(ref);
  const data = snap.exists ? (snap.data() as ProposedArtifact) : null;
  if (!data || !data.sourceUserId || data.sourceUserId !== callerUid) {
    throw new ProposedArtifactNotFoundError(id);
  }
  return { ref, data };
}

function removeUndefinedFields<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A stable scope key so the same artifact-about-the-same-thing dedups. */
function scopeKey(input: CreateProposedArtifactInput): string {
  // An UPDATE recommendation is keyed on its target output, so it never collides with the
  // (already-approved) CREATE recommendation for the same scope.
  if (input.updateOf?.id) return `update:${input.updateOf.id}`;
  const ids = input.scope?.entityIds ?? [];
  return [...ids].sort().join(',') || (input.scope?.query ?? '');
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * SEC-011: owner-scoped listing. The equality filter on `sourceUserId` also
 * naturally excludes ownerless legacy docs (a missing field never equals a
 * UID) — they stay denied until an operator migration assigns an owner.
 * Equality-only filters need no composite index (merged single-field indexes).
 */
export async function getProposedArtifacts(
  ownerUid: string,
  filters?: ProposedArtifactFilters
): Promise<ProposedArtifact[]> {
  let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME).where('sourceUserId', '==', ownerUid);
  if (filters?.status) q = q.where('status', '==', filters.status);
  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data() as ProposedArtifact);
  const filtered = rows.filter((r) => !filters?.artifactKind || r.artifactKind === filters.artifactKind);
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProposedArtifactById(id: string): Promise<ProposedArtifact | null> {
  const snap = await db.collection(COLLECTION_NAME).doc(id).get();
  return snap.exists ? (snap.data() as ProposedArtifact) : null;
}

// ── Create (idempotent, ALWAYS pending + idle) ─────────────────────────────

export async function createProposedArtifactIfNotExists(
  input: CreateProposedArtifactInput
): Promise<{ created: boolean; entity: ProposedArtifact; reason?: string }> {
  // SEC-011: every recommendation is born owned. A creator without a real user
  // context must fail loudly here rather than mint an ownerless doc that no
  // authenticated surface will ever show or resolve again.
  const sourceUserId = input.sourceUserId?.trim();
  if (!sourceUserId) throw new Error('sourceUserId is required to create a proposed artifact');
  const key = generateProposedArtifactKey(input.artifactKind, input.title, scopeKey(input), sourceUserId);
  const now = Date.now();
  const existing = await getProposedArtifactById(key);

  if (existing) {
    if (existing.status === 'pending') return { created: false, entity: existing, reason: 'already_pending' };
    if (existing.status === 'approved') return { created: false, entity: existing, reason: 'already_approved' };
    if (existing.status === 'dismissed') return { created: false, entity: existing, reason: 'dismissed' };
    if (existing.status === 'rejected' && existing.updatedAt > now - REJECTION_RETENTION_MS) {
      return { created: false, entity: existing, reason: 'recently_rejected' };
    }
  }

  // ALWAYS pending + idle — generation only runs on approve (the safety invariant).
  const entity: ProposedArtifact = proposedArtifactSchema.parse({
    ...input,
    sourceUserId,
    id: key,
    status: 'pending',
    generationStatus: 'idle',
    createdAt: now,
    updatedAt: now,
  });

  await db.collection(COLLECTION_NAME).doc(key).set(removeUndefinedFields(entity));
  return { created: true, entity };
}

export async function updateProposedArtifact(
  id: string,
  updates: Partial<Omit<ProposedArtifact, 'id' | 'createdAt'>>
): Promise<ProposedArtifact> {
  const ref = db.collection(COLLECTION_NAME).doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`Proposed artifact not found: ${id}`);
  const merged = removeUndefinedFields({ ...updates, updatedAt: Date.now() });
  await ref.update(merged);
  return { ...(existing.data() as ProposedArtifact), ...merged };
}

// ── Execution identity (REPORT-005) ────────────────────────────────────────

const MISSIONS_COLLECTION = 'missions';

/**
 * REPORT-005: mint (or reuse) the durable execution mission for an approved
 * CREATE recommendation. One transaction re-reads the proposal, and either
 * returns the already-stamped `executionMissionId` or creates the mission doc
 * AND stamps the pointer atomically — so a replayed generation event can never
 * mint a second mission, and a crash can never leave an orphan pointer.
 *
 * Ownership: the mission's `userId` comes exclusively from the persisted
 * proposal's `sourceUserId` (never from event/request data). A missing or
 * ownerless proposal throws the same not-found error as every other
 * owner-scoped miss.
 */
export async function ensureExecutionMission(
  proposedArtifactId: string,
  opts: { prompt: string; agent: string }
): Promise<string> {
  return db.runTransaction(async (tx) => {
    const ref = db.collection(COLLECTION_NAME).doc(proposedArtifactId);
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as ProposedArtifact) : null;
    if (!data || !data.sourceUserId) throw new ProposedArtifactNotFoundError(proposedArtifactId);
    if (data.executionMissionId) return data.executionMissionId;

    const { id, firestoreData } = buildMissionDocument(data.sourceUserId, {
      prompt: opts.prompt,
      agent: opts.agent,
    });
    tx.set(db.collection(MISSIONS_COLLECTION).doc(id), firestoreData);
    tx.update(ref, { executionMissionId: id, updatedAt: Date.now() });
    log.info('execution mission minted for recommendation', { proposedArtifactId, missionId: id });
    return id;
  });
}

// ── Triage operations ──────────────────────────────────────────────────────

/**
 * Approve = greenlight generation. Flips status→approved and generationStatus→generating.
 * The actual job is dispatched by the triage route (this module is Inngest-free); the
 * job later calls updateProposedArtifact with the output / failure.
 *
 * SEC-011: `callerUid` is BOTH the reviewer identity and the ownership
 * precondition, checked transactionally — a non-owner (or an ownerless legacy
 * doc) resolves exactly like an absent id.
 *
 * `transitioned` tells the route whether THIS call performed the
 * pending→approved transition. The route dispatches generation only then — an
 * idempotent re-approve (double-click, retried request, second tab) must not
 * fire a second generation event, which for research would create a duplicate
 * deep-research document and for reports races the slot upsert.
 */
export async function approveProposedArtifact(
  id: string,
  callerUid: string
): Promise<{ artifact: ProposedArtifact; transitioned: boolean }> {
  return db.runTransaction(async (tx) => {
    const { ref, data } = await resolveOwned(tx, id, callerUid);
    if (data.status === 'approved') return { artifact: data, transitioned: false }; // idempotent
    if (data.status !== 'pending') throw new Error(`Cannot approve artifact in status '${data.status}'`);

    const now = Date.now();
    const updates = {
      status: 'approved' as const,
      generationStatus: 'generating' as const,
      reviewedBy: callerUid,
      reviewedAt: now,
      appliedAt: now,
      updatedAt: now,
    };
    tx.update(ref, updates);
    log.info('artifact recommendation approved — queuing generation', { id, artifactKind: data.artifactKind });
    return { artifact: { ...data, ...updates }, transitioned: true };
  });
}

export async function rejectProposedArtifact(
  id: string,
  callerUid: string,
  feedbackReason?: string
): Promise<ProposedArtifact> {
  return db.runTransaction(async (tx) => {
    const { ref, data } = await resolveOwned(tx, id, callerUid);
    if (data.status === 'rejected') return data;
    const updates = removeUndefinedFields({
      status: 'rejected' as const,
      reviewedBy: callerUid,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
      feedbackReason: feedbackReason as ProposedArtifact['feedbackReason'],
    });
    tx.update(ref, updates);
    return { ...data, ...updates } as ProposedArtifact;
  });
}

export async function dismissProposedArtifact(id: string, callerUid: string): Promise<ProposedArtifact> {
  return db.runTransaction(async (tx) => {
    const { ref, data } = await resolveOwned(tx, id, callerUid);
    if (data.status === 'dismissed') return data;
    const updates = {
      status: 'dismissed' as const,
      reviewedBy: callerUid,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    };
    tx.update(ref, updates);
    return { ...data, ...updates };
  });
}
