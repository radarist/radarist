/**
 * @file build-mission-iterate.ts
 * @description Shared core for iterating a completed build mission with
 * follow-up instructions (BUILD-019).
 *
 * Extracted from `POST /api/missions/[id]/iterate` so the API route and the
 * `iterateBuildArtifact` AI tool (assistant + MCP/third-party agents) run the
 * SAME contract instead of forking it: append an "## Iteration N" block to the
 * brief, reset the QA slate (the iteration must earn its own PASS), bump the
 * budget cap, and re-dispatch the supervisor against the retained sandbox.
 *
 * Server-only by dependency (missions.ts admin paths + Inngest client).
 */

import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { isSystemPrincipal } from '@/lib/system-principals';
import { getMissionById, updateMission } from '@/lib/missions';
import type { Mission } from '@/lib/schemas/mission';
import { MISSION_PROMPT_MAX_CHARS } from '@/lib/schemas/mission';
import {
  clampCapUsd,
  getBuildMissionHardCapUsd,
  remainingBudgetUsd,
  resolveIterateBudget,
} from '@/lib/build-mission-budget';
import {
  buildRecoveryEligibility,
  DEFAULT_RECOVERY_ADDITIONAL_TURNS,
  resolveRecoveryTurnLimit,
} from '@/lib/build-mission-recovery';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';
import { importSandbox } from '@/lib/agent-import';
import { randomUUID } from 'node:crypto';

const log = createLogger('build-mission-iterate');

async function probeRetainedSandboxVolume(volumeName: string): Promise<RetainedVolumeProbe> {
  try {
    const sandbox = await importSandbox();
    const probe = await sandbox.defaultExec('docker', ['volume', 'inspect', volumeName]);
    if (probe.code !== 0) {
      return {
        ok: false,
        code: 'sandbox-reclaimed',
        error: `The retained workspace volume ${volumeName} no longer exists; start a new build instead`,
      };
    }
    return { ok: true };
  } catch (error) {
    log.error(
      'Failed to verify retained build workspace',
      error instanceof Error ? error : new Error(String(error)),
      { volumeName }
    );
    return {
      ok: false,
      code: 'dispatch-failed',
      error: 'The retained workspace could not be verified; no recovery authority was granted',
    };
  }
}

export type IterateFailureCode =
  | 'not-found'
  | 'forbidden'
  | 'not-build'
  | 'running'
  | 'no-sandbox'
  | 'sandbox-reclaimed'
  | 'operation-in-progress'
  | 'brief-too-long'
  | 'budget-exhausted'
  | 'not-limitless'
  | 'not-failed'
  | 'published'
  | 'invalid-recovery'
  | 'confirmation-required'
  | 'dispatch-failed';

export type IterateBuildMissionResult =
  { ok: true; missionId: string; iteration: number } | { ok: false; code: IterateFailureCode; error: string };

export type ResumeBuildMissionResult =
  | {
      ok: true;
      missionId: string;
      additionalTurns: number;
      additionalBudgetUsd: number;
      authorizedMaxTurns: number;
      capUsd: number;
    }
  | { ok: false; code: IterateFailureCode; error: string };

type RedispatchOk = { ok: true; capUsd: number };
type RedispatchFailure = { ok: false; code: IterateFailureCode; error: string };
type RetainedVolumeProbe = { ok: true } | RedispatchFailure;

/**
 * Shared precondition + budget gate for every path that re-dispatches the
 * supervisor against an EXISTING sandbox (iterate with new instructions,
 * resume toward the same goal). Callers have already fetched the mission and
 * handled the not-found case — this only covers checks that need the loaded
 * mission.
 *
 * Never throws for contract violations — callers map the discriminated
 * result onto their own surface (HTTP status codes; an honest chat message).
 */
function validateRedispatch(mission: Mission, userId: string, additionalUsd: number): RedispatchOk | RedispatchFailure {
  // ARUN-005: the local user may iterate system-dispatched builds too;
  // only another human's missions are forbidden.
  if (mission.userId !== userId && !isSystemPrincipal(mission.userId)) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }
  if (mission.kind !== 'build') {
    return { ok: false, code: 'not-build', error: 'Iterate only applies to build missions' };
  }
  if (mission.status === 'running' || mission.status === 'pending') {
    return { ok: false, code: 'running', error: 'Mission is still running — cancel it first or wait' };
  }
  if (!mission.sandbox) {
    return { ok: false, code: 'no-sandbox', error: 'Mission has no sandbox to resume' };
  }
  // AUDIT-017: the GC destroys the container AND its volume, then writes
  // `sandbox.state: 'destroyed'` — a field nothing read. `!mission.sandbox` is
  // still false for a reclaimed sandbox (the object survives), so an iterate past
  // the retention window sailed through this guard, provisioned a BRAND-NEW EMPTY
  // volume, and forced the agent into phase `06-build` against code that no
  // longer exists. Real spend, nonsense artifact, and the tool's "resumes the
  // same sandbox" promise was false.
  //
  // Guard on `state` alone. NOT on `harvest.reclaimedAt`: no writer ever clears
  // that, whereas `state` self-heals when a sandbox is re-provisioned — OR-ing
  // them would permanently brick a mission that has a perfectly good sandbox.
  if (mission.sandbox.state === 'destroyed') {
    return {
      ok: false,
      code: 'sandbox-reclaimed',
      error:
        'The sandbox for this mission was reclaimed after its retention window, so there is no workspace left to ' +
        'iterate on. Iterating would build from scratch in an empty container. Start a new mission instead.',
    };
  }

  // AUDIT-016: an Iterate used to raise the cap by a flat +$10 forever
  // (`capUsd = priorCap + additional`), while the supervisor re-zeroed its spend
  // counter on every run — so each iteration bought a fresh envelope and the
  // budget gate could never fire. Grant headroom against the mission's ACTUAL
  // cumulative spend, bounded by the cumulative ceiling, and refuse outright
  // when there is nothing left rather than dispatching a run that would spend
  // money only to stop at the gate.
  const budget = resolveIterateBudget({
    priorCapUsd: mission.budget?.capUsd ?? 25,
    priorSpentUsd: mission.costUsd ?? 0,
    additionalUsd,
  });
  if (budget.exhausted) {
    return {
      ok: false,
      code: 'budget-exhausted',
      error:
        `Mission has spent $${(mission.costUsd ?? 0).toFixed(2)} and reached the $${getBuildMissionHardCapUsd()} ` +
        `cumulative build ceiling — it cannot be iterated further. Start a new mission to continue.`,
    };
  }

  return { ok: true, capUsd: budget.capUsd };
}

/**
 * Validate preconditions and dispatch one iteration turn. Never throws for
 * contract violations — callers map the discriminated result onto their own
 * surface (HTTP status codes; an honest chat message).
 */
async function iterateBuildMissionUnlocked(input: {
  missionId: string;
  userId: string;
  instructions: string;
  additionalBudgetUsd?: number;
}): Promise<IterateBuildMissionResult> {
  const { missionId, userId, instructions } = input;
  const additionalBudgetUsd = input.additionalBudgetUsd ?? 10;

  const mission = await getMissionById(missionId);
  if (!mission) return { ok: false, code: 'not-found', error: 'Mission not found' };

  const validated = validateRedispatch(mission, userId, additionalBudgetUsd);
  if (!validated.ok) return validated;

  const iterationCount = (mission.prompt.match(/^## Iteration /gm)?.length ?? 0) + 1;
  const prompt = `${mission.prompt}\n\n---\n\n## Iteration ${iterationCount} (${new Date().toISOString().slice(0, 10)})\n\n${instructions}\n`;
  if (prompt.length > MISSION_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      code: 'brief-too-long',
      error: `Brief would exceed ${MISSION_PROMPT_MAX_CHARS} chars — start a new mission instead`,
    };
  }

  await updateMission(missionId, {
    prompt,
    status: 'pending',
    buildState: 'provisioning',
    buildPhase: '06-build',
    errors: [],
    // Fresh QA slate: the iteration must earn its own PASS.
    qaGate: { attempts: 0, findings: [] },
    budget: {
      capUsd: validated.capUsd,
      warnThreshold: mission.budget?.warnThreshold ?? 0.8,
      topUps: mission.budget?.topUps ?? [],
    },
  });
  await inngest.send({
    name: 'app/build-mission.run.requested',
    data: { missionId, userId, instructions },
  });

  log.info('Build mission iteration dispatched', { missionId, iterationCount, additionalBudgetUsd });
  return { ok: true, missionId, iteration: iterationCount };
}

export async function iterateBuildMission(input: {
  missionId: string;
  userId: string;
  instructions: string;
  additionalBudgetUsd?: number;
}): Promise<IterateBuildMissionResult> {
  const releaseOperation = acquireBuildRuntimeOperation(input.missionId);
  if (!releaseOperation) {
    return {
      ok: false,
      code: 'operation-in-progress',
      error: 'A start, stop, cancel, delete, iterate, or resume operation is already in progress',
    };
  }
  try {
    return await iterateBuildMissionUnlocked(input);
  } finally {
    releaseOperation();
  }
}

/**
 * Relaunch a failed, unfinished Limitless build on the SAME sandbox toward the
 * SAME goal. Turn authority and spend authority are independent: the default
 * grants a bounded number of extra turns under the existing USD cap, while an
 * optional USD top-up is accepted only after the API's exact paid-action
 * confirmation and is appended to the mission ledger.
 *
 *   - no `prompt` change (no new "## Iteration N" block — same goal, not a
 *     revision), and `buildPhase` is deliberately left untouched rather than
 *     pinned back to `06-build`;
 *   - the dispatch event carries NO `instructions` field, so the supervisor's
 *     resume path (`run-build-mission.ts`) skips its MISSION.md/STATUS.json
 *     rewrite entirely and the session continues from wherever
 *     `.impulse/STATUS.json` last left off.
 *
 * Fresh QA slate still applies: the resumed work must earn its own PASS.
 */
async function resumeBuildMissionUnlocked(input: {
  missionId: string;
  userId: string;
  additionalTurns?: number;
  additionalBudgetUsd?: number;
  /** Set only by the authenticated API after exact paid-action redemption. */
  confirmedBy?: string;
  /** SHA-256 action digest; never the user-visible confirmation phrase. */
  confirmationFingerprint?: string;
}): Promise<ResumeBuildMissionResult> {
  const { missionId, userId } = input;
  const additionalTurns = input.additionalTurns ?? DEFAULT_RECOVERY_ADDITIONAL_TURNS;
  const additionalBudgetUsd = input.additionalBudgetUsd ?? 0;

  const mission = await getMissionById(missionId);
  if (!mission) return { ok: false, code: 'not-found', error: 'Mission not found' };

  if (mission.userId !== userId && !isSystemPrincipal(mission.userId)) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }
  const eligibility = buildRecoveryEligibility(mission);
  if (!eligibility.eligible) {
    const code: IterateFailureCode =
      eligibility.code === 'not-build'
        ? 'not-build'
        : eligibility.code === 'not-limitless'
          ? 'not-limitless'
          : eligibility.code === 'running'
            ? 'running'
            : eligibility.code === 'not-failed'
              ? 'not-failed'
              : eligibility.code === 'published'
                ? 'published'
                : eligibility.code;
    return { ok: false, code, error: eligibility.error };
  }
  const authorizedMaxTurns = resolveRecoveryTurnLimit(additionalTurns);
  if (authorizedMaxTurns === null) {
    return {
      ok: false,
      code: 'invalid-recovery',
      error: `Recovery must authorize between 1 and 160 turns for the next builder session`,
    };
  }
  if (!Number.isFinite(additionalBudgetUsd) || additionalBudgetUsd < 0) {
    return { ok: false, code: 'invalid-recovery', error: 'Additional budget must be a non-negative USD amount' };
  }
  if (additionalBudgetUsd > 0 && input.confirmedBy !== userId) {
    return {
      ok: false,
      code: 'confirmation-required',
      error: 'An exact session-bound spend confirmation is required before granting a build top-up',
    };
  }
  if (
    additionalBudgetUsd > 0 &&
    (typeof input.confirmationFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(input.confirmationFingerprint))
  ) {
    return {
      ok: false,
      code: 'confirmation-required',
      error: 'The paid recovery authorization is not bound to an exact action fingerprint',
    };
  }

  const priorCapUsd = mission.budget?.capUsd ?? 50;
  const priorExposureUsd = mission.buildCostAccounting?.maximumExposureUsd ?? mission.costUsd ?? 0;
  const priorHeadroomUsd = remainingBudgetUsd(priorCapUsd, priorExposureUsd);
  // Recovery confirmation authorizes a MAXIMUM cap increase, not an exact
  // amount the system must spend. Never expand the cap by more than the phrase
  // named, including when prior provider overshoot already exceeds the old cap.
  const recoveredCapUsd =
    additionalBudgetUsd > 0 ? clampCapUsd(priorCapUsd + additionalBudgetUsd) : priorCapUsd;
  if (additionalBudgetUsd > 0 && recoveredCapUsd - priorCapUsd !== additionalBudgetUsd) {
    return {
      ok: false,
      code: 'invalid-recovery',
      error: `The exact top-up would exceed the $${getBuildMissionHardCapUsd()} cumulative build ceiling`,
    };
  }
  const budget = {
    capUsd: recoveredCapUsd,
    headroomUsd: remainingBudgetUsd(recoveredCapUsd, priorExposureUsd),
    exhausted: remainingBudgetUsd(recoveredCapUsd, priorExposureUsd) <= 0,
  };
  if (budget.exhausted) {
    return {
      ok: false,
      code: 'budget-exhausted',
      error:
        `Mission has no remaining authority under its $${priorCapUsd.toFixed(2)} cap. ` +
        'Stage an explicit USD top-up or start a new mission.',
    };
  }

  const requestedAt = new Date().toISOString();
  const attemptId = `recovery-${randomUUID()}`;
  const previousAttempts = mission.recovery?.attempts ?? [];
  if (previousAttempts.length >= 100) {
    return {
      ok: false,
      code: 'invalid-recovery',
      error: 'This workspace reached its bounded recovery audit limit; start a new mission instead',
    };
  }
  const retainedSandbox = mission.sandbox;
  if (!retainedSandbox) {
    return { ok: false, code: 'no-sandbox', error: 'Mission has no retained sandbox to resume' };
  }
  const retainedVolume = await probeRetainedSandboxVolume(retainedSandbox.volumeName);
  if (!retainedVolume.ok) return retainedVolume;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const baseAttempt = {
    id: attemptId,
    requestedAt,
    requestedBy: userId,
    additionalTurns,
    additionalBudgetUsd,
    previousCapUsd: priorCapUsd,
    newCapUsd: budget.capUsd,
    maxNewExposureUsd: Math.max(0, budget.headroomUsd - priorHeadroomUsd),
    volumeName: retainedSandbox.volumeName,
    containerName: retainedSandbox.containerName,
    ...(retainedSandbox.containerId ? { containerId: retainedSandbox.containerId } : {}),
    driver: retainedSandbox.driver,
    ...(retainedSandbox.hostPort ? { hostPort: retainedSandbox.hostPort } : {}),
    ...(eligibility.terminal.gitHead ? { gitHead: eligibility.terminal.gitHead } : {}),
    expiresAt,
    ...(additionalBudgetUsd > 0
      ? { confirmedAt: requestedAt, confirmationFingerprint: input.confirmationFingerprint }
      : {}),
  };
  const dispatchingRecovery = {
    terminal: eligibility.terminal,
    authorizedMaxTurns,
    activeOperationId: attemptId,
    attempts: [...previousAttempts, { ...baseAttempt, status: 'dispatching' as const }],
  };
  const nextBudget = {
    capUsd: budget.capUsd,
    warnThreshold: mission.budget?.warnThreshold ?? 0.8,
    topUps: [
      ...(mission.budget?.topUps ?? []),
      ...(additionalBudgetUsd > 0 && budget.capUsd > priorCapUsd
        ? [{ amountUsd: budget.capUsd - priorCapUsd, grantedAt: requestedAt, grantedBy: userId }]
        : []),
    ],
  };

  await updateMission(missionId, {
    status: 'pending',
    buildState: 'provisioning',
    errors: [],
    // Fresh QA slate: the resumed work must earn its own PASS.
    qaGate: { attempts: 0, findings: [] },
    budget: nextBudget,
    recovery: dispatchingRecovery,
  });
  try {
    // NO `instructions` field: the supervisor does not rewrite MISSION.md and
    // simply resumes the retained sandbox toward the same goal.
    await inngest.send({
      name: 'app/build-mission.run.requested',
      data: { missionId, userId, recoveryOperationId: attemptId },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateMission(missionId, {
      status: 'failed',
      buildState: 'paused',
      completedAt: mission.completedAt ?? requestedAt,
      errors: [...(mission.errors ?? []), `Recovery dispatch failed: ${detail}`].slice(-20),
      budget: mission.budget ?? nextBudget,
      qaGate: mission.qaGate ?? { attempts: 0, findings: [] },
      recovery: {
        terminal: eligibility.terminal,
        ...(mission.recovery?.authorizedMaxTurns
          ? { authorizedMaxTurns: mission.recovery.authorizedMaxTurns }
          : {}),
        attempts: [...previousAttempts, { ...baseAttempt, status: 'dispatch-failed' as const, failure: detail.slice(0, 1000) }],
      },
    });
    return { ok: false, code: 'dispatch-failed', error: 'Recovery dispatch failed; no new authority was granted' };
  }

  await updateMission(missionId, {
    recovery: {
      ...dispatchingRecovery,
      attempts: [
        ...previousAttempts,
        { ...baseAttempt, status: 'running' as const, dispatchedAt: new Date().toISOString() },
      ],
    },
  });

  log.info('Build mission resumed', { missionId, additionalTurns, additionalBudgetUsd, authorizedMaxTurns });
  return {
    ok: true,
    missionId,
    additionalTurns,
    additionalBudgetUsd,
    authorizedMaxTurns,
    capUsd: budget.capUsd,
  };
}

export async function resumeBuildMission(input: {
  missionId: string;
  userId: string;
  additionalTurns?: number;
  additionalBudgetUsd?: number;
  confirmedBy?: string;
  confirmationFingerprint?: string;
}): Promise<ResumeBuildMissionResult> {
  const releaseOperation = acquireBuildRuntimeOperation(input.missionId);
  if (!releaseOperation) {
    return {
      ok: false,
      code: 'operation-in-progress',
      error: 'A start, stop, cancel, delete, iterate, or resume operation is already in progress',
    };
  }
  try {
    return await resumeBuildMissionUnlocked(input);
  } finally {
    releaseOperation();
  }
}
