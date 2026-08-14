/**
 * @file proposed-assessments-admin.ts
 * @description Admin-SDK store + triage operations for build-mission **evaluation**
 * verdicts staged as proposed Assessments (the "Assessment" triage lane). Mirrors
 * `proposed-relations-admin.ts` (deterministic id, dedup branches, 30-day
 * rejection window, inline removeUndefinedFields) — the difference is what
 * `approve` applies: a RadarPlacement (ring) + a Technology TRL (only if unset).
 *
 * Server-only. The client twin `proposed-assessments.ts` provides reads/triage
 * via API routes; the SoR mutation always runs here.
 */
import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  proposedAssessmentSchema,
  generateAssessmentKey,
  type ProposedAssessment,
  type ProposedAssessmentStatus,
} from '@/lib/schemas/proposed-assessment';
import {
  adminGetPlacementForTechnologyOnRadar,
  adminCreateRadarPlacement,
  adminUpdateRadarPlacement,
  PlacementAuthorizationError,
} from '@/lib/radar-placement-admin';
import { adminGetOwnedRadarById, RadarAuthorizationError } from '@/lib/radars-admin';
import { resolveRadarTarget } from '@/lib/build-mission-radar-target';
import { applyInboxOrder, type InboxOrder } from '@/lib/discovery/inbox-ordering';

const log = createLogger('proposed-assessments-admin');

const COLLECTION_NAME = 'proposedAssessments';
const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Input to create a proposal — id/status/timestamps are derived/defaulted. */
export type CreateProposedAssessmentInput = Omit<
  ProposedAssessment,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'appliedBy'
  | 'appliedAt'
  | 'appliedPlacementId'
  | 'feedbackReason'
>;

export interface ProposedAssessmentFilters {
  status?: ProposedAssessmentStatus;
  technologyId?: string;
  runId?: string;
  /** Inbox order — default 'recency' (back-compat); 'uncertainty' surfaces near-50 first. */
  order?: InboxOrder;
}

function removeUndefinedFields<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function getProposedAssessments(filters?: ProposedAssessmentFilters): Promise<ProposedAssessment[]> {
  let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME);
  if (filters?.status) q = q.where('status', '==', filters.status);
  else if (filters?.technologyId) q = q.where('technologyId', '==', filters.technologyId);
  else if (filters?.runId) q = q.where('sourceRunId', '==', filters.runId);

  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data() as ProposedAssessment);
  // Re-apply non-primary filters in-memory (no composite index needed).
  const filtered = rows.filter(
    (r) =>
      (!filters?.technologyId || r.technologyId === filters.technologyId) &&
      (!filters?.runId || r.sourceRunId === filters.runId)
  );
  return applyInboxOrder(filtered, filters?.order);
}

export async function getProposedAssessmentById(id: string): Promise<ProposedAssessment | null> {
  const snap = await db.collection(COLLECTION_NAME).doc(id).get();
  return snap.exists ? (snap.data() as ProposedAssessment) : null;
}

// ── Create (idempotent) ──────────────────────────────────────────────────

export async function createProposedAssessmentIfNotExists(
  input: CreateProposedAssessmentInput
): Promise<{ created: boolean; assessment: ProposedAssessment; reason?: string }> {
  const key = generateAssessmentKey(input.technologyId, input.sourceRunId);
  const now = Date.now();
  const existing = await getProposedAssessmentById(key);

  if (existing) {
    if (existing.status === 'pending') return { created: false, assessment: existing, reason: 'already_pending' };
    if (existing.status === 'approved') return { created: false, assessment: existing, reason: 'already_approved' };
    if (existing.status === 'dismissed') return { created: false, assessment: existing, reason: 'dismissed' };
    if (existing.status === 'rejected' && existing.updatedAt > now - REJECTION_RETENTION_MS) {
      return { created: false, assessment: existing, reason: 'recently_rejected' };
    }
  }

  const assessment: ProposedAssessment = proposedAssessmentSchema.parse({
    ...input,
    id: key,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  await db.collection(COLLECTION_NAME).doc(key).set(removeUndefinedFields(assessment));
  return { created: true, assessment };
}

export async function updateProposedAssessment(
  id: string,
  updates: Partial<Omit<ProposedAssessment, 'id' | 'createdAt'>>
): Promise<ProposedAssessment> {
  const ref = db.collection(COLLECTION_NAME).doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`Proposed assessment not found: ${id}`);
  const merged = removeUndefinedFields({ ...updates, updatedAt: Date.now() });
  await ref.update(merged);
  return { ...(existing.data() as ProposedAssessment), ...merged };
}

// ── Triage operations ──────────────────────────────────────────────────────

export type PlacementOutcome = 'applied' | 'failed' | 'unresolved' | 'already-approved-without-placement';

export interface AssessmentApprovalAttempt {
  assessment: ProposedAssessment;
  placementOutcome: PlacementOutcome;
}

/** True only for the two owner-policy denials this approval path can surface. */
export function isProposedAssessmentRadarAuthorizationError(error: unknown): boolean {
  return error instanceof RadarAuthorizationError || error instanceof PlacementAuthorizationError;
}

export type RequiredPlacementApprovalResult =
  | { applied: true; assessment: ProposedAssessment }
  | {
      applied: false;
      assessment: ProposedAssessment;
      reason: Exclude<PlacementOutcome, 'applied'>;
    };

async function approveProposedAssessmentInternal(
  id: string,
  reviewedBy: string,
  opts: {
    radarId?: string;
    quadrantId?: string;
    requirePlacement: boolean;
    placementOwnerId: string;
  }
): Promise<AssessmentApprovalAttempt> {
  const proposal = await getProposedAssessmentById(id);
  if (!proposal) throw new Error(`Proposed assessment not found: ${id}`);
  if (proposal.status === 'approved') {
    if (proposal.appliedPlacementId) {
      // Fully applied — idempotent short-circuit.
      return { assessment: proposal, placementOutcome: 'applied' };
    }
    // BUILD-005: approved but the placement never landed (write failed, or no
    // target resolved at the time). Re-approving IS the advertised retry path —
    // the toast says "try approving again" and the no-target toast says "add it
    // to a radar to apply this placement". Fall through and attempt the
    // placement again: target resolution runs fresh, the TRL write is guarded
    // (only sets when unset), and the final status update simply refreshes the
    // apply bookkeeping. Pre-fix this branch short-circuited, making both
    // recovery promises impossible to keep.
  } else if (proposal.status !== 'pending') {
    throw new Error(`Cannot approve assessment in status '${proposal.status}'`);
  }

  // Resolve the radar target: explicit reviewer pick > the tech's CURRENT
  // placement (fresh, placement-first) > the target baked onto the proposal at
  // creation. The baked value can be stale — a tech unplaced at creation (baked
  // to the config default) may since have been placed on a different radar;
  // trusting the bake would apply to the wrong radar and duplicate the blip. A
  // fresh resolve reflects where the tech actually sits now. Only when opts fully
  // specify a target (e.g. the autopilot pass) do we skip the extra read.
  let radarId = opts?.radarId;
  let quadrantId = opts?.quadrantId;
  if (!radarId || !quadrantId) {
    const resolved = await resolveRadarTarget(proposal.technologyId);
    radarId = radarId ?? resolved.radarId ?? proposal.radarId;
    quadrantId = quadrantId ?? resolved.quadrantId ?? proposal.quadrantId;
  }

  const rationale = `Build-mission evaluation ${proposal.sourceRunId}: ${proposal.recommendation}${
    proposal.trl ? ` (TRL ${proposal.trl})` : ''
  }, confidence ${proposal.confidence}.`;

  // Create / update the RadarPlacement.
  let appliedPlacementId: string | undefined;
  let placementOutcome: PlacementOutcome = 'unresolved';
  if (radarId && quadrantId) {
    // Approval may change both a RadarPlacement and canonical Technology TRL.
    // Resolve the target through the same owner-only radar boundary as direct
    // mutations before exposing placement existence or changing either record.
    // Missing, foreign, and ownerless radars are intentionally indistinguishable.
    await adminGetOwnedRadarById(radarId, opts.placementOwnerId);
    try {
      const existing = await adminGetPlacementForTechnologyOnRadar(proposal.technologyId, radarId);
      if (existing) {
        const updated = await adminUpdateRadarPlacement(
          existing.id,
          {
            ring: proposal.proposedRing,
            trlScore: proposal.trl,
            rationale,
            status: 'New',
          },
          { requireOwnerId: opts.placementOwnerId }
        );
        appliedPlacementId = updated.id;
      } else {
        const created = await adminCreateRadarPlacement(
          {
            technologyId: proposal.technologyId,
            radarId,
            quadrantId,
            ring: proposal.proposedRing,
            trlScore: proposal.trl,
            rationale,
            status: 'New',
            placedBy: opts.placementOwnerId,
          },
          { requireOwnerId: opts.placementOwnerId }
        );
        appliedPlacementId = created.id;
      }
      placementOutcome = 'applied';
    } catch (error) {
      // An authorization failure is never a best-effort placement failure:
      // allowing the proposal/TRL transaction to continue would let a caller
      // approve changes against a foreign radar.
      if (error instanceof PlacementAuthorizationError) throw error;
      placementOutcome = 'failed';
      log.warn('placement apply failed', {
        id,
        requirePlacement: opts.requirePlacement,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    log.info('no radar target resolved — verdict approved without a placement', { id });
  }

  // Machine approval is placement-first. A failed required placement must not
  // mutate canonical Technology.trl while the proposal remains pending.
  if (opts.requirePlacement && placementOutcome !== 'applied') {
    log.warn('required placement did not land — leaving assessment and canonical TRL unchanged', {
      id,
      reviewedBy,
      placementOutcome,
    });
    return { assessment: proposal, placementOutcome };
  }

  // BUILD-011: canonical TRL + proposal status commit ATOMICALLY (one
  // Firestore transaction over the two plain docs this module owns). Pre-fix
  // they were separate writes, so a status failure after a TRL write left a
  // mutated Technology with a still-pending proposal — and vice versa. The
  // placement (a separate service write above) is intentionally OUTSIDE the
  // transaction: if this transaction fails after a landed placement, the
  // proposal stays pending and a re-approval CONVERGES — the existing
  // placement is re-applied idempotently (update path, same values) and the
  // transaction retries. Both failure orders end in full application.
  //
  // AUDIT-024 — this is the module's EXPLICIT consistency contract:
  // convergence-on-retry, NOT atomicity. The placement cannot join the
  // transaction without folding the radar-placement service's write (audit
  // fields, sync trigger) into this module; the accepted trade is a possibly
  // radar-visible placement while the proposal is still pending, healed by
  // the next approval. Both failure
  // orders are pinned against real Firestore in
  // tests/emulator/worker-admin-contracts.emulator.ts.
  const now = Date.now();
  const statusUpdate = removeUndefinedFields({
    status: 'approved' as const,
    reviewedBy,
    reviewedAt: now,
    appliedBy: reviewedBy,
    appliedAt: now,
    appliedPlacementId,
    radarId,
    quadrantId,
    updatedAt: now,
  });
  await db.runTransaction(async (tx) => {
    const propRef = db.collection(COLLECTION_NAME).doc(id);
    const techRef = db.collection('technologies').doc(proposal.technologyId);
    const techSnap = proposal.trl !== undefined ? await tx.get(techRef) : null;

    if (proposal.trl !== undefined && techSnap) {
      const currentTrl = techSnap.data()?.trl;
      if (techSnap.exists && (currentTrl === undefined || currentTrl === null)) {
        tx.update(techRef, { trl: proposal.trl, updatedAt: now });
      } else if (currentTrl !== undefined && currentTrl !== proposal.trl) {
        log.info('TRL conflict — canonical kept, eval TRL recorded on placement only', {
          technologyId: proposal.technologyId,
          currentTrl,
          proposedTrl: proposal.trl,
        });
      }
    }
    tx.update(propRef, statusUpdate);
  });

  const assessment = { ...proposal, ...statusUpdate } as ProposedAssessment;
  return { assessment, placementOutcome };
}

/**
 * Records a human approval and best-effort applies its radar placement and TRL,
 * returning BOTH the assessment and the honest `placementOutcome` ('applied' |
 * 'failed' | 'unresolved'). Same behavior as `approveProposedAssessment` — that
 * wrapper delegates here and just drops the outcome. Use this variant when the
 * caller must report truthfully what happened (e.g. the `approveAssessment` AI
 * tool, BUILD-005): 'failed' means the placement write didn't land (retryable),
 * 'unresolved' means no radar target could be resolved (supply one and retry).
 */
export async function approveProposedAssessmentWithOutcome(
  id: string,
  reviewedBy: string,
  opts?: { radarId?: string; quadrantId?: string }
): Promise<AssessmentApprovalAttempt> {
  return approveProposedAssessmentInternal(id, reviewedBy, {
    ...opts,
    requirePlacement: false,
    placementOwnerId: reviewedBy,
  });
}

/**
 * Records a human approval and best-effort applies its radar placement and TRL.
 * The verdict remains authoritative even when the placement cannot be written;
 * callers can inspect `appliedPlacementId` to surface that condition.
 */
export async function approveProposedAssessment(
  id: string,
  reviewedBy: string,
  opts?: { radarId?: string; quadrantId?: string }
): Promise<ProposedAssessment> {
  const result = await approveProposedAssessmentWithOutcome(id, reviewedBy, opts);
  return result.assessment;
}

/**
 * Attempts an autopilot approval only when its required radar placement lands.
 * The discriminated result prevents callers from treating a deferred proposal
 * as approved and keeps canonical TRL unchanged on placement failure.
 * `reviewedBy` remains machine provenance; `placementOwnerId` is the real
 * authenticated mission owner used for owner-only radar authorization.
 */
export async function approveProposedAssessmentWithRequiredPlacement(
  id: string,
  reviewedBy: string,
  target: { radarId: string; quadrantId: string },
  placementOwnerId: string
): Promise<RequiredPlacementApprovalResult> {
  const result = await approveProposedAssessmentInternal(id, reviewedBy, {
    ...target,
    requirePlacement: true,
    placementOwnerId,
  });
  if (result.placementOutcome === 'applied') {
    if (result.assessment.status !== 'approved') {
      throw new Error(`Required placement landed but assessment ${id} was not approved`);
    }
    return { applied: true, assessment: result.assessment };
  }
  return {
    applied: false,
    assessment: result.assessment,
    reason: result.placementOutcome,
  };
}

export async function rejectProposedAssessment(
  id: string,
  reviewedBy: string,
  feedbackReason?: string
): Promise<ProposedAssessment> {
  const proposal = await getProposedAssessmentById(id);
  if (!proposal) throw new Error(`Proposed assessment not found: ${id}`);
  if (proposal.status === 'rejected') return proposal;
  return updateProposedAssessment(id, { status: 'rejected', reviewedBy, reviewedAt: Date.now(), feedbackReason });
}

export async function dismissProposedAssessment(id: string, reviewedBy: string): Promise<ProposedAssessment> {
  const proposal = await getProposedAssessmentById(id);
  if (!proposal) throw new Error(`Proposed assessment not found: ${id}`);
  if (proposal.status === 'dismissed') return proposal;
  return updateProposedAssessment(id, { status: 'dismissed', reviewedBy, reviewedAt: Date.now() });
}
