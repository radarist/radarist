/**
 * @file lib/technology-research-admin.ts
 * @description TEST-022 — narrow admin helper for technology-research state
 * transitions that both trigger paths need.
 *
 * Uses the narrow admin-helper pattern: the HTTP
 * route and the Assistant tool both need this, so it lives in one server-only
 * module rather than being duplicated at each call site.
 */

import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { decideResearchDispatch, type ResearchDispatchDecision } from '@/lib/technology-research-dispatch';
import type { DeepResearchData, PendingSnapshotRefresh, Technology, TechnologyResearch } from '@/lib/types';

const log = createLogger('technology-research-admin');

export type ResearchReleaseReason = 'dispatch-failed' | 'worker-failed';

type ResearchAttemptInactiveReason = 'not-found' | 'stale-attempt' | 'already-settled' | 'handoff-pending';
export type ResearchArtifactKind = 'comprehensive' | 'deep';

export type ResearchAttemptInspection =
  | { active: true; technology: Technology }
  | { active: false; reason: Exclude<ResearchAttemptInactiveReason, 'handoff-pending'> }
  | { active: false; reason: 'handoff-pending'; technology: Technology };

export class PendingSnapshotRefreshPersistenceError extends Error {
  readonly code = 'PENDING_SNAPSHOT_REFRESH_PERSISTENCE_FAILED';

  constructor(
    readonly technologyId: string,
    readonly attemptToken: number,
    cause: unknown
  ) {
    super(`Could not persist snapshot-refresh recovery debt for ${technologyId}`, { cause });
    this.name = 'PendingSnapshotRefreshPersistenceError';
  }
}

export interface ResearchAttemptCompletion {
  completedAt: number;
  research: TechnologyResearch;
  trl?: number;
  timeToImpact?: 'H1' | 'H2' | 'H3';
  description?: string;
  category?: Technology['category'];
  githubUrl?: string;
  tags?: string[];
}

export interface DeepResearchAttemptCompletion {
  completedAt: number;
  research: DeepResearchData;
}

export type ResearchAttemptCompletionResult =
  | { completed: true; technologyName: string; updatedFields: string[] }
  | { completed: false; reason: ResearchAttemptInactiveReason };

export type ResearchDispatchClaim =
  | { claimed: true; startedAt: number; reason: Extract<ResearchDispatchDecision, { allowed: true }>['reason'] }
  | { claimed: false; reason: 'already-running'; startedAt?: number }
  | { claimed: false; reason: 'not-found' };

/**
 * Atomically claim the one research dispatch slot on a Technology.
 *
 * Firestore retries this callback if another UI/Assistant request changes the
 * document after the read. The retry then sees `pending` and refuses, so only
 * one caller can send the Inngest event. `startedAt` is also the attempt token
 * used by the conditional rollback below.
 */
export async function claimResearchDispatch(technologyId: string, startedAt: number): Promise<ResearchDispatchClaim> {
  const technologyRef = db.collection('technologies').doc(technologyId);

  return db.runTransaction<ResearchDispatchClaim>(async (transaction) => {
    const snapshot = await transaction.get(technologyRef);
    if (!snapshot.exists) return { claimed: false, reason: 'not-found' };

    const technology = snapshot.data() as Technology;
    const decision = decideResearchDispatch(technology, startedAt);
    if (!decision.allowed) {
      return { claimed: false, reason: decision.reason, startedAt: decision.startedAt };
    }

    transaction.update(technologyRef, {
      researchStatus: 'pending',
      researchStartedAt: startedAt,
      updatedAt: startedAt,
    });
    return { claimed: true, startedAt, reason: decision.reason };
  });
}

function classifyAttempt(
  technology: Technology,
  startedAt: number
): Exclude<ResearchAttemptInactiveReason, 'handoff-pending'> | undefined {
  if (technology.researchStatus !== 'pending') return 'already-settled';
  if (technology.researchStartedAt !== startedAt) return 'stale-attempt';
  return undefined;
}

/**
 * Read the canonical Technology only when `startedAt` still owns its active
 * research slot. Workers call this before provider spend, so delayed/replayed
 * events cannot research a stale snapshot or charge for an already-settled
 * attempt.
 */
export async function inspectResearchAttempt(
  technologyId: string,
  startedAt: number,
  artifactKind?: ResearchArtifactKind
): Promise<ResearchAttemptInspection> {
  const technologyRef = db.collection('technologies').doc(technologyId);

  return db.runTransaction<ResearchAttemptInspection>(async (transaction) => {
    const snapshot = await transaction.get(technologyRef);
    if (!snapshot.exists) return { active: false, reason: 'not-found' };

    const technology = { ...snapshot.data(), id: technologyId } as Technology;
    const hasExactCompletedArtifact =
      technology.researchStatus === 'completed' &&
      technology.researchStartedAt === startedAt &&
      ((artifactKind === 'comprehensive' && technology.comprehensiveResearch !== undefined) ||
        (artifactKind === 'deep' && technology.deepResearch !== undefined));
    if (hasExactCompletedArtifact) {
      // A prior execution committed the paid result but did not finish its
      // handoff/debt step. Resume only that idempotent phase; never re-enter the
      // provider or persistence steps.
      return { active: false, reason: 'handoff-pending', technology };
    }
    const reason = classifyAttempt(technology, startedAt);
    return reason ? { active: false, reason } : { active: true, technology };
  });
}

function mergeResearchTags(current: string[] | undefined, generated: string[] | undefined): string[] {
  const merged = new Set<string>();
  for (const value of [...(current ?? []), ...(generated ?? [])]) {
    if (typeof value !== 'string') continue;
    const tag = value.trim();
    if (tag.length === 0 || tag.length > 50) continue;
    merged.add(tag);
    if (merged.size === 20) break;
  }
  return [...merged];
}

/**
 * Atomically persist one research result if and only if its attempt token is
 * still current. The transaction reads the latest document before deriving
 * optional fields, preserving user edits made while the provider was running.
 */
export async function completeResearchAttempt(
  technologyId: string,
  startedAt: number,
  completion: ResearchAttemptCompletion
): Promise<ResearchAttemptCompletionResult> {
  const technologyRef = db.collection('technologies').doc(technologyId);

  return db.runTransaction<ResearchAttemptCompletionResult>(async (transaction) => {
    const snapshot = await transaction.get(technologyRef);
    if (!snapshot.exists) return { completed: false, reason: 'not-found' };

    const technology = { ...snapshot.data(), id: technologyId } as Technology;
    if (
      technology.researchStatus === 'completed' &&
      technology.researchStartedAt === startedAt &&
      technology.comprehensiveResearch
    ) {
      // The original transaction may have preserved concurrent user fields,
      // so a replay cannot infer which optional values it actually wrote from
      // the completion payload alone. Report only the persisted research
      // artifact instead of fabricating refresh fields.
      return { completed: true, technologyName: technology.name, updatedFields: ['comprehensiveResearch'] };
    }
    const inactiveReason = classifyAttempt(technology, startedAt);
    if (inactiveReason) return { completed: false, reason: inactiveReason };

    const updates: Record<string, unknown> = {
      comprehensiveResearch: completion.research,
      researchStatus: 'completed',
      // Retain the last-start token after success. If Firestore commits just
      // before Inngest checkpoints this step, a retry can recognize its own
      // completed write and still deliver the refresh events exactly once.
      researchStartedAt: startedAt,
      updatedAt: completion.completedAt,
    };
    const updatedFields = ['comprehensiveResearch'];

    if (completion.trl !== undefined && technology.trl === undefined) {
      updates.trl = completion.trl;
      updatedFields.push('trl');
    }
    if (completion.timeToImpact !== undefined && technology.timeToImpact === undefined) {
      updates.timeToImpact = completion.timeToImpact;
      updatedFields.push('timeToImpact');
    }
    if (completion.description && (!technology.description || technology.description.length < 50)) {
      updates.description = completion.description;
      updatedFields.push('description');
    }
    if (completion.category && !technology.category) {
      updates.category = completion.category;
      updatedFields.push('category');
    }
    if (completion.githubUrl && !technology.githubUrl) {
      updates.githubUrl = completion.githubUrl;
      updatedFields.push('githubUrl');
    }

    const tags = mergeResearchTags(technology.tags, completion.tags);
    if (tags.length > 0) {
      updates.tags = tags;
      updatedFields.push('tags');
    }

    transaction.update(technologyRef, updates);
    return { completed: true, technologyName: technology.name, updatedFields };
  });
}

/**
 * Persist the basic deep-research payload only while `startedAt` still owns
 * the Technology's research slot. Keeping this separate from the
 * comprehensive completion keeps the two stored payloads explicit while they
 * share the same attempt-token authority contract.
 */
export async function completeDeepResearchAttempt(
  technologyId: string,
  startedAt: number,
  completion: DeepResearchAttemptCompletion
): Promise<ResearchAttemptCompletionResult> {
  const technologyRef = db.collection('technologies').doc(technologyId);

  return db.runTransaction<ResearchAttemptCompletionResult>(async (transaction) => {
    const snapshot = await transaction.get(technologyRef);
    if (!snapshot.exists) return { completed: false, reason: 'not-found' };

    const technology = { ...snapshot.data(), id: technologyId } as Technology;
    if (
      technology.researchStatus === 'completed' &&
      technology.researchStartedAt === startedAt &&
      technology.deepResearch
    ) {
      // Firestore may commit immediately before Inngest checkpoints the save
      // step. Recognize that exact completion so the retry converges without
      // rewriting the entity or charging the provider again.
      return { completed: true, technologyName: technology.name, updatedFields: ['deepResearch'] };
    }

    const inactiveReason = classifyAttempt(technology, startedAt);
    if (inactiveReason) return { completed: false, reason: inactiveReason };

    transaction.update(technologyRef, {
      deepResearch: completion.research,
      researchStatus: 'completed',
      // Retain the token so an exact post-commit replay is distinguishable
      // from a newer attempt or a different research kind.
      researchStartedAt: startedAt,
      updatedAt: completion.completedAt,
    });

    return { completed: true, technologyName: technology.name, updatedFields: ['deepResearch'] };
  });
}

/**
 * Release a technology from `pending` after a dispatch that never reached the
 * worker.
 *
 * Both trigger paths write `pending` BEFORE sending the Inngest event, so a
 * send failure previously left the technology showing "Researching…" for the
 * whole stale window with no job in existence that could ever clear it — and,
 * on the Assistant path, while the model was simultaneously told the request
 * had failed. Releasing restores the state the user is actually in and makes
 * an immediate retry possible.
 *
 * Best-effort by design: it is called from a failure path that is already
 * about to surface an error, so it must never replace that error with its own.
 */
export async function releaseResearchPending(
  technologyId: string,
  reason: ResearchReleaseReason,
  startedAt: number
): Promise<{ released: boolean }> {
  try {
    const technologyRef = db.collection('technologies').doc(technologyId);
    const released = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(technologyRef);
      if (!snapshot.exists) return false;

      const technology = snapshot.data() as Technology;
      if (technology.researchStatus !== 'pending' || technology.researchStartedAt !== startedAt) return false;

      transaction.update(technologyRef, {
        researchStatus: 'failed',
        researchStartedAt: FieldValue.delete(),
        updatedAt: Date.now(),
      });
      return true;
    });
    if (released) {
      log.warn('Released technology from pending research', { technologyId, reason, startedAt });
    } else {
      log.info('Skipped stale research rollback', { technologyId, reason, startedAt });
    }
    return { released };
  } catch (error) {
    // Surface the rollback failure without masking the original dispatch error.
    log.error('Failed to release technology from pending research', error instanceof Error ? error : undefined, {
      technologyId,
      reason,
      startedAt,
    });
    return { released: false };
  }
}

/**
 * ARUN-028 — record durable debt that a completed attempt's post-research
 * snapshot refresh (`app/technology.updated`) was not dispatched.
 *
 * The research itself is already committed with `researchStatus:'completed'`;
 * this NEVER touches that status. A persistence failure is thrown so Inngest's
 * bounded function retry can re-enter the handoff-only path. The completed
 * artifact remains completed throughout; swallowing this failure would lose
 * the sole immediate recovery anchor.
 */
export async function recordPendingSnapshotRefresh(
  technologyId: string,
  attemptToken: number,
  error?: unknown
): Promise<void> {
  try {
    const ref = db.collection('technologies').doc(technologyId);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const technology = snapshot.data() as Technology;
      const existing = technology.pendingSnapshotRefresh;
      const attempts = existing && existing.attemptToken === attemptToken ? existing.attempts + 1 : 1;
      const pending: PendingSnapshotRefresh = {
        attemptToken,
        recordedAt: Date.now(),
        attempts,
        ...(error ? { lastError: error instanceof Error ? error.message : String(error) } : {}),
      };
      transaction.update(ref, { pendingSnapshotRefresh: pending, updatedAt: Date.now() });
    });
    log.warn('Recorded durable post-research snapshot-refresh debt', { technologyId, attemptToken });
  } catch (recordError) {
    log.error(
      'Failed to record pending snapshot refresh debt; handoff retry required',
      recordError instanceof Error ? recordError : undefined,
      { technologyId, attemptToken }
    );
    throw new PendingSnapshotRefreshPersistenceError(technologyId, attemptToken, recordError);
  }
}

/**
 * Clear the snapshot-refresh debt once the refresh has been re-dispatched.
 * Token-guarded: a stale replay can never clear a newer attempt's debt.
 */
export async function clearPendingSnapshotRefresh(technologyId: string, attemptToken: number): Promise<boolean> {
  try {
    const ref = db.collection('technologies').doc(technologyId);
    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const technology = snapshot.data() as Technology;
      if (!technology.pendingSnapshotRefresh || technology.pendingSnapshotRefresh.attemptToken !== attemptToken) {
        return false;
      }
      transaction.update(ref, { pendingSnapshotRefresh: FieldValue.delete(), updatedAt: Date.now() });
      return true;
    });
  } catch (clearError) {
    log.error('Failed to clear pending snapshot refresh debt', clearError instanceof Error ? clearError : undefined, {
      technologyId,
      attemptToken,
    });
    return false;
  }
}

/**
 * List technologies that carry outstanding snapshot-refresh debt, for the
 * replay drainer. Bounded so a runaway backlog cannot fan out unboundedly.
 */
export async function listTechnologiesWithPendingSnapshotRefresh(
  limit = 100
): Promise<Array<{ id: string; attemptToken: number }>> {
  const snapshot = await db
    .collection('technologies')
    .where('pendingSnapshotRefresh.attemptToken', '>', 0)
    .limit(limit)
    .get();
  return snapshot.docs.flatMap((doc) => {
    const technology = doc.data() as Technology;
    const token = technology.pendingSnapshotRefresh?.attemptToken;
    return typeof token === 'number' ? [{ id: doc.id, attemptToken: token }] : [];
  });
}
