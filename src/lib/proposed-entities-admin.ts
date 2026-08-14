/**
 * @file proposed-entities-admin.ts
 * @description Admin-SDK store + triage operations for net-new entities staged
 * for human review — the dimension-agnostic twin of proposed-assessments-admin.
 *
 * SAFETY INVARIANT (replaces the cut calibration gate, SD-3): a net-new entity is
 * ALWAYS written `pending` and is NEVER auto-applied. There is no autopilot path;
 * `adminCreateEntity` runs ONLY inside `approveProposedEntity`.
 *
 * SD-8: no `expiresAt` TTL field (consistent with the assessment twin); rejected
 * proposals follow the same 30-day retention window. Server-only.
 */
import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  proposedEntitySchema,
  generateProposedEntityKey,
  type ProposedEntity,
  type ProposedEntityStatus,
} from '@/lib/schemas/proposed-entity';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { ENTITY_CONFIGS, DuplicateEntityError, type EntityType } from '@/lib/entity-factory-shared';
import { coalescePainPointApprovalData } from '@/lib/pain-points-shared';
import { applyInboxOrder, type InboxOrder } from '@/lib/discovery/inbox-ordering';

const log = createLogger('proposed-entities-admin');

const COLLECTION_NAME = 'proposedEntities';
const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CreateProposedEntityInput = Omit<
  ProposedEntity,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'appliedBy'
  | 'appliedAt'
  | 'appliedEntityId'
  | 'feedbackReason'
>;

export interface ProposedEntityFilters {
  status?: ProposedEntityStatus;
  entityType?: string;
  /** Inbox order — default 'recency' (back-compat); 'uncertainty' surfaces near-50 first. */
  order?: InboxOrder;
}

function removeUndefinedFields<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Normalize a name for the dedup key (case/whitespace-insensitive). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function getProposedEntities(filters?: ProposedEntityFilters): Promise<ProposedEntity[]> {
  let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME);
  if (filters?.status) q = q.where('status', '==', filters.status);
  else if (filters?.entityType) q = q.where('entityType', '==', filters.entityType);

  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data() as ProposedEntity);
  const filtered = rows.filter((r) => !filters?.entityType || r.entityType === filters.entityType);
  return applyInboxOrder(filtered, filters?.order);
}

export async function getProposedEntityById(id: string): Promise<ProposedEntity | null> {
  const snap = await db.collection(COLLECTION_NAME).doc(id).get();
  return snap.exists ? (snap.data() as ProposedEntity) : null;
}

// ── Create (idempotent, ALWAYS pending) ────────────────────────────────────

export async function createProposedEntityIfNotExists(
  input: CreateProposedEntityInput
): Promise<{ created: boolean; entity: ProposedEntity; reason?: string }> {
  const key = generateProposedEntityKey(input.entityType, normalizeName(input.name), input.primaryDomain);
  const now = Date.now();
  const existing = await getProposedEntityById(key);

  if (existing) {
    if (existing.status === 'pending') return { created: false, entity: existing, reason: 'already_pending' };
    if (existing.status === 'approved') return { created: false, entity: existing, reason: 'already_approved' };
    if (existing.status === 'dismissed') return { created: false, entity: existing, reason: 'dismissed' };
    if (existing.status === 'rejected' && existing.updatedAt > now - REJECTION_RETENTION_MS) {
      return { created: false, entity: existing, reason: 'recently_rejected' };
    }
  }

  // ALWAYS pending — there is no auto-apply branch (the load-bearing safety invariant).
  const entity: ProposedEntity = proposedEntitySchema.parse({
    ...input,
    id: key,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  await db.collection(COLLECTION_NAME).doc(key).set(removeUndefinedFields(entity));
  return { created: true, entity };
}

export async function updateProposedEntity(
  id: string,
  updates: Partial<Omit<ProposedEntity, 'id' | 'createdAt'>>
): Promise<ProposedEntity> {
  const ref = db.collection(COLLECTION_NAME).doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`Proposed entity not found: ${id}`);
  const merged = removeUndefinedFields({ ...updates, updatedAt: Date.now() });
  await ref.update(merged);
  return { ...(existing.data() as ProposedEntity), ...merged };
}

// ── Triage operations ──────────────────────────────────────────────────────

/**
 * Approve = create the net-new entity via the admin factory. On a duplicate the
 * entity is resolved as already-known (its existing id is recorded) and the
 * proposal is still marked approved. This is the ONLY place adminCreateEntity runs.
 */
export async function approveProposedEntity(id: string, reviewedBy: string): Promise<ProposedEntity> {
  const proposal = await getProposedEntityById(id);
  if (!proposal) throw new Error(`Proposed entity not found: ${id}`);
  if (proposal.status === 'approved') return proposal; // idempotent
  if (proposal.status !== 'pending') throw new Error(`Cannot approve entity in status '${proposal.status}'`);

  const now = Date.now();
  const config = ENTITY_CONFIGS[proposal.entityType as EntityType];
  const data = {
    [config?.nameField ?? 'name']: proposal.name,
    ...(proposal.description ? { description: proposal.description } : {}),
    ...proposal.data,
  };

  // Sparse triage proposals (e.g. a scout pain point) can omit the required
  // array and enum fields. Coalesce painPoint payloads to the canonical
  // library-safe shape before minting so the new document can never crash
  // readers (UX-059). Other entity types are untouched.
  const finalData =
    proposal.entityType === 'painPoint'
      ? coalescePainPointApprovalData(data)
      : data;

  let appliedEntityId: string | undefined;
  try {
    const result = await adminCreateEntity(proposal.entityType as EntityType, finalData, { upsert: false });
    appliedEntityId = (result.entity as { id: string }).id;
  } catch (error) {
    if (error instanceof DuplicateEntityError) {
      appliedEntityId = error.existingId; // resolve already_known
      log.info('proposed entity already known — marking approved', { id, entityType: proposal.entityType });
    } else {
      throw error;
    }
  }

  return updateProposedEntity(id, {
    status: 'approved',
    reviewedBy,
    reviewedAt: now,
    appliedBy: reviewedBy,
    appliedAt: now,
    appliedEntityId,
  });
}

export async function rejectProposedEntity(
  id: string,
  reviewedBy: string,
  feedbackReason?: string
): Promise<ProposedEntity> {
  const proposal = await getProposedEntityById(id);
  if (!proposal) throw new Error(`Proposed entity not found: ${id}`);
  if (proposal.status === 'rejected') return proposal;
  return updateProposedEntity(id, {
    status: 'rejected',
    reviewedBy,
    reviewedAt: Date.now(),
    feedbackReason: feedbackReason as ProposedEntity['feedbackReason'],
  });
}

export async function dismissProposedEntity(id: string, reviewedBy: string): Promise<ProposedEntity> {
  const proposal = await getProposedEntityById(id);
  if (!proposal) throw new Error(`Proposed entity not found: ${id}`);
  if (proposal.status === 'dismissed') return proposal;
  return updateProposedEntity(id, { status: 'dismissed', reviewedBy, reviewedAt: Date.now() });
}
