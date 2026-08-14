/**
 * @file lib/build-artifact-deletion.ts
 * @description BUILD-025 — fail-closed, retryable cascade deletion for a build
 * artifact (mission of kind 'build').
 *
 * The previous DELETE handler swallowed sandbox / Document / Assessment cleanup
 * failures, then deleted the mission (its own retry anchor) and returned
 * `{ ok: true }` regardless — so a partial failure orphaned resources AND
 * discarded the record needed to retry. This orchestrator instead:
 *
 *  - attempts every prerequisite and records a per-resource outcome;
 *  - deletes the mission ONLY when every prerequisite succeeded (the mission is
 *    the durable retry/accounting anchor — it must outlive any failure);
 *  - reports partial cleanup honestly so the caller can surface it and retry.
 *
 * Idempotent/replayable: the injected primitives are expected to no-op on an
 * already-removed resource (Firestore deletes are), so a retry after a partial
 * failure re-attempts only what is still present and converges.
 *
 * Effects are injected as `deps` so each failure ordering and a replay can be
 * unit-tested without a live build/sandbox.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('build-artifact-deletion');

/** A resource cleaned up when a build artifact is deleted, in cascade order. */
export type DeletionResourceKind = 'sandbox' | 'document' | 'prototype' | 'assessment' | 'mission';

export interface ResourceOutcome {
  resource: DeletionResourceKind;
  /** `deleted` = removed (or idempotently already-gone); `skipped` = not present
   *  / not attempted because a prerequisite failed; `failed` = attempt errored. */
  status: 'deleted' | 'skipped' | 'failed';
  error?: string;
}

export interface BuildArtifactDeletionResult {
  missionId: string;
  /** True only when the mission anchor itself was removed (full success). */
  deleted: boolean;
  outcomes: ResourceOutcome[];
  /** Resources whose deletion failed — non-empty ⇒ the mission was retained. */
  failedResources: DeletionResourceKind[];
}

/** The minimal mission shape this cascade reads. */
export interface DeletableBuildArtifact {
  id: string;
  sandbox?: unknown;
  artifact?: {
    documentId?: string;
    prototypeId?: string;
    assessmentId?: string;
  } | null;
}

export interface BuildArtifactDeletionDeps {
  destroySandbox: (mission: DeletableBuildArtifact) => Promise<void>;
  deleteDocument: (documentId: string) => Promise<void>;
  deletePrototype: (prototypeId: string) => Promise<void>;
  deleteAssessment: (assessmentId: string) => Promise<void>;
  deleteMission: (missionId: string) => Promise<void>;
}

/**
 * Run one cleanup step, converting a throw into a `failed` outcome (never
 * rethrows — the orchestrator decides what a failure means for the anchor).
 * `present` false ⇒ the resource does not exist on this artifact (`skipped`).
 */
async function runStep(
  resource: DeletionResourceKind,
  present: boolean,
  op: () => Promise<void>
): Promise<ResourceOutcome> {
  if (!present) return { resource, status: 'skipped' };
  try {
    await op();
    return { resource, status: 'deleted' };
  } catch (e) {
    return { resource, status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Delete a build artifact and everything it produced, fail-closed. See file doc.
 */
export async function deleteBuildArtifactCascade(
  mission: DeletableBuildArtifact,
  deps: BuildArtifactDeletionDeps
): Promise<BuildArtifactDeletionResult> {
  const artifact = mission.artifact ?? {};
  const outcomes: ResourceOutcome[] = [];

  // Prerequisites, in cascade order. Each is attempted regardless of the
  // others' outcomes so a single run reports the full picture.
  outcomes.push(await runStep('sandbox', Boolean(mission.sandbox), () => deps.destroySandbox(mission)));
  outcomes.push(await runStep('document', Boolean(artifact.documentId), () => deps.deleteDocument(artifact.documentId!)));
  outcomes.push(
    await runStep('prototype', Boolean(artifact.prototypeId), () => deps.deletePrototype(artifact.prototypeId!))
  );
  outcomes.push(
    await runStep('assessment', Boolean(artifact.assessmentId), () => deps.deleteAssessment(artifact.assessmentId!))
  );

  const failedResources = outcomes.filter((o) => o.status === 'failed').map((o) => o.resource);

  if (failedResources.length > 0) {
    // Retain the mission anchor for retry; do NOT report success.
    outcomes.push({ resource: 'mission', status: 'skipped' });
    log.warn('Build artifact deletion incomplete — mission retained for retry', {
      missionId: mission.id,
      failedResources,
    });
    return { missionId: mission.id, deleted: false, outcomes, failedResources };
  }

  // Every prerequisite is gone — safe to remove the anchor.
  const missionOutcome = await runStep('mission', true, () => deps.deleteMission(mission.id));
  outcomes.push(missionOutcome);
  if (missionOutcome.status === 'failed') {
    log.error('Build artifact prerequisites cleared but mission delete failed', new Error(missionOutcome.error), {
      missionId: mission.id,
    });
    return { missionId: mission.id, deleted: false, outcomes, failedResources: ['mission'] };
  }

  log.info('Build artifact deleted', { missionId: mission.id });
  return { missionId: mission.id, deleted: true, outcomes, failedResources: [] };
}
