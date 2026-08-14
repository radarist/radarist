/**
 * @file lib/inngest/functions/run-build-mission.ts
 * @description Supervisor for build missions (kind 'build') — the second
 * mission pipeline alongside run-agent-mission.ts (research).
 *
 * The agent (Claude Code headless) runs INSIDE a sandbox container; this
 * function supervises from outside: it launches bounded sessions detached,
 * polls the transcript by byte offset in short steps (never a long exec in
 * one step.run),
 * verifies acceptance checks itself via driver exec, and parks at
 * step.waitForEvent human gates (budget top-up, stall, final approval).
 *
 * The methodology pack inside the workspace drives WHAT happens each
 * session (phases 00→08 incl. QA-FAIL fix loops); the supervisor is
 * phase-agnostic and enforces only budgets, stall detection, gates, and
 * final verification (all checks green + QA verdict PASS — self-reports
 * are never trusted).
 *
 * The shared build-capability module owns the feature boundary.
 */
import { inngest } from '../client';
import { captureDurableInstantMs } from '../durable-duration';
import { declareDomainOutcome } from '../domain-outcome';
import { domainOutcomeForBuildExit } from '@/lib/build-mission-lineage';
import type { DomainOutcome } from '@/lib/observability/terminal-outcome';
import { emitAgentEvent } from '@/lib/agent-events';
import { importSandbox } from '@/lib/agent-import';
import {
  appendBuildGate,
  type BuildSessionCompletion,
  finalizeBuildSessionAccounting,
  getMissionById,
  reconcileBuildMissionCostAccounting,
  reserveBuildSessionBudget,
  updateMission,
} from '@/lib/missions';
// AUDIT-016 — the cumulative spend authority. Dependency-free by design, so it is
// safe to import statically here because it has no Firebase/Firestore reach.
import { clampCapUsd, getBuildMissionHardCapUsd, remainingBudgetUsd } from '@/lib/build-mission-budget';
import { createLogger } from '@/lib/logger';
import { config } from '@/lib/config';
import type { Mission } from '@/lib/schemas/mission';
import type { EntityType, RelationType } from '@/lib/types';
import { hasArtifactMotivation, resolveEvaluationPublishChannel } from '@/lib/schemas/mission-build';
import { machineRelationAutoApprovalThreshold } from '@/lib/graph/materialization-policy';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { launchReviewedPreview } from '@/lib/build-preview-workspace';
import { monotonicBuildProgress, type ObservableBuildPhase } from '@/lib/build-mission-progress';
import { classifyBuildTerminal, type BuildTerminalClassification } from '@/lib/build-mission-terminal';
import { validateStoredBuildContextManifest } from '@/lib/build-mission-context';

const log = createLogger('run-build-mission');

/**
 * ARUN-030 — how many sandbox sessions this build is RECORDED as having launched.
 *
 * Drives one decision only: whether a reflection is warranted. Zero sessions means
 * nothing ever ran inside the sandbox, so there is nothing to reflect on and
 * writing one would invent agent behaviour that never happened.
 *
 * Read from the durable recovery ledger rather than a live counter, because the
 * failure path runs in `onFailure` where no in-handler state survives.
 */
function countRecordedBuildSessions(mission: Mission | null | undefined): number {
  return mission?.recovery?.attempts?.length ?? 0;
}

/**
 * Classify a build supervisor failure into a canonical outcome.
 *
 * `Mission.status: 'failed'` is too coarse for the outcomes this row requires to
 * be distinguishable. Two refinements are made, both from evidence the run already
 * persisted:
 *
 * - **preflight-failed** — the supervisor refused BEFORE provisioning or any paid
 *   launch (build missions disabled, mission not found, wrong kind, an invalid
 *   stored context manifest). Nothing was spent and nothing partially wrote.
 * - **provider-fatal** — a non-retryable provider status aborted the run. Retrying
 *   cannot help; the fix is configuration.
 *
 * Anything else stays `failed`. Matching is on the exact messages this file throws,
 * so an unrelated error is never talked into a category it does not belong to.
 */
function classifyBuildFailureOutcome(message: string | undefined, mission: Mission | null | undefined): DomainOutcome {
  const text = message ?? '';
  if (
    text.startsWith('Build missions are disabled') ||
    /^Mission \S+ not found$/.test(text) ||
    /^Mission \S+ is not a build mission$/.test(text) ||
    text.startsWith('Build context reference not found')
  ) {
    return 'preflight-failed';
  }
  // The supervisor aborts on the FIRST fatal API status and records it on the
  // recovery terminal evidence, so this reads a persisted fact rather than
  // pattern-matching provider prose.
  const apiStatus = mission?.recovery?.terminal?.apiErrorStatus;
  if (typeof apiStatus === 'number' && FATAL_API_STATUSES.has(apiStatus)) return 'provider-fatal';
  return 'failed';
}

/**
 * Persist build lineage from a failure path (`onFailure`), where there is no
 * `step` to memoize with.
 *
 * Fully swallowed: `onFailure` is already the last line of defence, and a lineage
 * write that threw here would lose the Mission-state reconciliation that ran just
 * before it.
 */
async function persistBuildLineageFromFailure(input: {
  missionId: string;
  userId: string;
  exit: string;
  outcome: DomainOutcome;
  sessions: number;
  spentUsd?: number;
  summary: string;
  errors?: string[];
}): Promise<void> {
  try {
    const { persistBuildMissionLineage } = await import('@/lib/build-mission-lineage');
    // No `durationMs`: this path never observed the supervised run's own endpoints,
    // so its elapsed time is genuinely unknowable and the run row renders "—"
    // rather than a fabricated 0 (the ARUN-008 rule).
    await persistBuildMissionLineage(input);
  } catch (lineageError) {
    log.error(
      'Could not persist build lineage from the failure handler',
      lineageError instanceof Error ? lineageError : new Error(String(lineageError)),
      { missionId: input.missionId, exit: input.exit }
    );
  }
}

/** Allow only minor scheduler/clock skew around a reviewer session. */
const QA_CLOCK_TOLERANCE_MS = 5_000;
const REVIEWER_SCREENSHOT_PREFIX = '.impulse/qa-screenshots/';

type Sandbox = Awaited<ReturnType<typeof importSandbox>>;

type BuildExit =
  | 'qa-pass'
  | 'caps-exhausted'
  | 'turns-exhausted'
  | 'budget-exhausted'
  | 'qa-attempts-exhausted'
  | 'builder-contract-violation'
  | 'reviewer-precondition'
  | 'reviewer-contract-violation'
  | 'qa-failed'
  | 'qa-budget-insufficient'
  | 'empty-sessions'
  | 'fatal-session-error'
  | null;

type SessionRole = 'builder' | 'reviewer';

/**
 * HTTP statuses on a session's result line that are NOT worth retrying: the
 * request is malformed (400), the key is bad (401), the account is out of
 * credit (402), access is denied (403), or the model id is wrong (404).
 * Re-launching identical sessions can only reproduce the same failure, so the
 * supervisor aborts on the FIRST occurrence instead of burning the session cap
 * (the LangChain/Mem0 evals failed this way — 16 instant 404s in one minute
 * mislabelled "session cap exhausted"). Transient statuses (429 rate-limit,
 * 5xx/529 overloaded) are deliberately excluded — those the loop retries.
 */
const FATAL_API_STATUSES = new Set([400, 401, 402, 403, 404]);

interface PlanResult {
  exit: BuildExit;
  phase: string;
  model: string;
  objective: string;
  role: SessionRole;
  startedAt: string;
  qaCheckedAtBefore: string | null;
  gitHeadBefore: string | null;
  reviewerWorkspaceSnapshotBefore: ReviewerWorkspaceSnapshot | null;
}

interface ReviewerWorkspaceSnapshot {
  version: 1;
  algorithm: 'sha256';
  digest: string;
  entries: number;
  bytes: number;
}

/**
 * Consecutive degenerate sessions (0 turns, $0) that trip the fast-fail guard.
 * A healthy session always does *some* work; a session that launches but does
 * nothing means the in-container CLI couldn't run (e.g. the sandbox went stale
 * after a long human-gate gap and the host slept). Without this, such sessions
 * are counted as "completed" and the loop silently burns the whole session cap,
 * then reports a misleading "cap exhausted". Two in a row tolerates one blip.
 */
const EMPTY_SESSION_ABORT = 2;

/** Human-readable terminal reasons for the failure record + agent event. */
const EXIT_MESSAGES: Record<NonNullable<BuildExit>, string> = {
  'qa-pass': 'QA passed',
  'caps-exhausted': 'session cap exhausted before QA pass',
  'turns-exhausted':
    'the builder reached its explicit turn boundary before a clean reviewer handoff. The exact retained workspace can continue only through a separately authorized bounded recovery.',
  'budget-exhausted':
    'the mission reached its cumulative spend ceiling (all sessions, top-ups and iterations combined) before QA passed. ' +
    'No further top-up can be granted, so the run stopped rather than asking for money it is not allowed to spend. ' +
    'The workspace volume is preserved — start a new mission to continue.',
  'qa-attempts-exhausted': 'QA still failing after the maximum fix attempts',
  'builder-contract-violation':
    'the Limitless builder did not produce a clean phase-08 handoff, or attempted to author its own QA verdict. The workspace was preserved without accepting that verdict.',
  'reviewer-precondition':
    'the Limitless reviewer was not launched because the workspace lacked a clean phase-08 handoff, green checks, phase-07 evidence, or an unambiguous git baseline.',
  'reviewer-contract-violation':
    'the fresh Limitless reviewer changed non-QA files or failed to produce a fresh, internally consistent QA verdict. The verdict was rejected and the workspace was preserved.',
  'qa-failed':
    'the fresh Limitless reviewer rejected the artifact. Findings were preserved; fixing and re-review require a separately approved resume.',
  'qa-budget-insufficient':
    'the Limitless mission did not have enough remaining headroom for its protected fresh-reviewer budget, so no underfunded or uncapped session was launched.',
  'empty-sessions':
    'sandbox produced consecutive unproductive sessions (the transcript never got past CLI init, or every run errored before doing work), ' +
    'so the environment is almost certainly degraded (e.g. the container went stale after a long gate gap / host sleep). ' +
    'Failed fast instead of exhausting the session budget; the workspace volume is preserved for inspection.',
  'fatal-session-error':
    'the agent session failed with a non-retryable API error (bad model id, authentication, or access). ' +
    'Aborted immediately rather than re-running identical sessions — see the session error for the exact message.',
};

interface FinalizeResult {
  costUsd: number;
  missionCostUsd: number;
  turns: number;
  subtype: string | null;
  phase: string;
  missionDone: boolean;
  qaCheckedAt: string | null;
  qaVerdict: 'PASS' | 'FAIL' | null;
  qaFailCount: number;
  qaFindings: Array<{
    severity: 'critical' | 'major' | 'minor';
    title: string;
    detail: string;
    story?: string;
  }>;
  hasCriticalQaFinding: boolean;
  checksValid: boolean;
  failingChecks: number;
  failingChecksHash: string | null;
  /**
   * BUILD-039: set when declared checks need a browser this runtime cannot
   * execute. Non-null means the acceptance run was REFUSED, not failed — the
   * defect is in the recreated runtime, so its results must never reach the
   * stall fingerprint or buy another paid session.
   */
  checkDependencyFailure: string | null;
  /**
   * Task 6: 1 when the machine visual gate failed for a solution artifact
   * whose STATUS already says 'done' (0 for non-solution artifacts, or when
   * phase isn't 'done' yet — the check only runs once verification is live).
   * Mirrors `failingChecks` into the SAME-SESSION fast-exit at 4e below: the
   * mission-methodology skill has the QA-PASS session set phase 'done' and
   * stop in that same turn, so finalize (not just the next plan step) must
   * also honor the gate or a clean-checks/clean-QA solution build would
   * publish having never run the visual gate at all.
   */
  visualFailing: number;
  /**
   * True only when the supervisor observed the durable completion marker,
   * parsed a successful result line, and read exit code 0 from the session.
   */
  sessionSucceeded: boolean;
  sessionExitCode: number | null;
  /** Git generation that the fresh reviewer actually inspected. */
  reviewedGitHead: string | null;
  /** Full non-QA workspace state immediately after the reviewer runtime ended. */
  reviewedWorkspaceSnapshot: ReviewerWorkspaceSnapshot | null;
  killed: boolean;
  /**
   * Did the session do real work? False when the transcript never got past
   * the `system/init` event (the CLI launched but made no model turn — a
   * degraded sandbox) OR when the result reported an error (`is_error`).
   * Distinguishes "never ran / errored out" from "ran and was killed mid-work"
   * (the latter has a full transcript and no error). Drives the empty-streak
   * guard so error storms can't quietly burn the whole session cap.
   */
  producedWork: boolean;
  /** Human-readable error text from the result line when `is_error` is set. */
  sessionError: string | null;
  /** True when the error is a non-retryable API status (see FATAL_API_STATUSES). */
  fatal: boolean;
  readyForQa: boolean;
  qaEvidenceReady: boolean;
  reviewerChanges: string[];
  /** Dirty paths relative to the accepted post-review HEAD. */
  reviewerResidualChanges: string[];
  finalizedAt: string;
  terminal: BuildTerminalClassification;
}

const REVIEWER_ALLOWED_PATHS = new Set(['.impulse/STATUS.json', '.impulse/qa-report.json']);

function isAllowedReviewerPath(path: string): boolean {
  return REVIEWER_ALLOWED_PATHS.has(path) || path.startsWith('.impulse/qa-screenshots/');
}

function reviewerSnapshotsEqual(
  left: ReviewerWorkspaceSnapshot | null,
  right: ReviewerWorkspaceSnapshot | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.version === right.version &&
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.entries === right.entries &&
    left.bytes === right.bytes
  );
}

function parseCanonicalIsoTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

function refFromMission(sandbox: Sandbox, cfg: BuildCfg, mission: Pick<Mission, 'id'>) {
  return {
    driver: cfg.driver,
    missionId: mission.id,
    containerName: sandbox.containerNameFor(mission.id),
    volumeName: sandbox.volumeNameFor(mission.id),
    image: sandbox.fullImageName(cfg),
    hostPort: 0, // informational on the ref; the container's mapping persists
    workspacePath: cfg.workspacePath,
  };
}

type BuildSandboxDriver = ReturnType<Sandbox['getDriver']>;
type BuildSandboxRef = Awaited<ReturnType<Sandbox['provisionSandbox']>>['ref'];

async function prepareIsolatedCheckWorkspace(
  driver: BuildSandboxDriver,
  ref: BuildSandboxRef,
  isolatedPath: string
): Promise<BuildSandboxRef> {
  const commands: Array<{ argv: string[]; context: string; timeoutMs?: number }> = [
    {
      argv: ['/bin/rm', '-rf', '--', isolatedPath],
      context: 'Failed to clear isolated acceptance-check workspace',
    },
    {
      argv: ['/bin/cp', '-a', '--', '.', isolatedPath],
      context: 'Failed to prepare isolated acceptance-check workspace',
      timeoutMs: 120_000,
    },
    {
      argv: ['/bin/chown', '-R', 'preview:preview', '--', isolatedPath],
      context: 'Failed to assign isolated acceptance-check workspace',
      timeoutMs: 120_000,
    },
    {
      argv: ['/bin/chown', 'node:node', '--', ref.workspacePath],
      context: 'Failed to isolate retained workspace ownership',
    },
    {
      argv: ['/bin/chmod', '0700', '--', ref.workspacePath],
      context: 'Failed to isolate retained workspace permissions',
    },
  ];

  for (const command of commands) {
    const result = await driver.exec(ref, command.argv, {
      ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
      user: 'root',
    });
    if (result.code !== 0) {
      throw new Error(`${command.context}: ${result.stderr || result.stdout}`.trim());
    }
  }

  return { ...ref, workspacePath: isolatedPath };
}

function cleanupRefFromMission(
  sandbox: Sandbox,
  cfg: BuildCfg,
  mission: Pick<Mission, 'id' | 'sandbox'>
): BuildSandboxRef {
  if (!mission.sandbox) return refFromMission(sandbox, cfg, mission);
  return {
    driver: cfg.driver,
    missionId: mission.id,
    containerName: mission.sandbox.containerName,
    volumeName: mission.sandbox.volumeName,
    image: mission.sandbox.image,
    hostPort: mission.sandbox.hostPort ?? 0,
    workspacePath: mission.sandbox.workspacePath,
  };
}

async function stopAndVerifyRuntime(driver: BuildSandboxDriver, ref: BuildSandboxRef, context: string): Promise<void> {
  if (await driver.isRunning(ref)) {
    await driver.stop(ref);
  }
  if (await driver.isRunning(ref)) {
    throw new Error(`${context}: runtime ${ref.containerName} is still running after stop`);
  }
}

/** Resolved BuildConfig shape (kept loose — the sandbox layer owns the schema). */
type BuildCfg = ReturnType<Sandbox['loadBuildConfig']>;

interface StageModels {
  plan: string;
  build: string;
  qa: string;
  escalation: string;
}

function modelForPhase(models: StageModels, phase: string, escalated: boolean): string {
  if (escalated) return models.escalation;
  if (phase === '06-build' || phase === '07-self-test') return models.build;
  if (phase === '08-qa') return models.qa;
  return models.plan;
}

interface SandboxStatusObservation {
  attemptedAt: string;
  health: 'valid' | 'missing' | 'malformed';
  status: { phase: ObservableBuildPhase } | null;
  digest: string | null;
}

function lastObservablePhase(mission: Mission | null): ObservableBuildPhase {
  const phase = mission?.buildStatusLastValidPhase ?? mission?.buildPhase;
  return phase && phase !== 'published' ? phase : '00-inception';
}

function statusObservationUpdate(observation: SandboxStatusObservation, mission: Mission | null) {
  if (!observation.status) {
    return {
      phase: lastObservablePhase(mission),
      update: {
        buildStatusAttemptedAt: observation.attemptedAt,
        buildStatusHealth: observation.health,
      } as Partial<Mission>,
    };
  }
  const progress = monotonicBuildProgress({
    previousPhase: mission?.buildPhase,
    previousProgress: mission?.progress,
    observedPhase: observation.status.phase,
  });
  return {
    phase: observation.status.phase,
    update: {
      ...progress,
      buildStatusAttemptedAt: observation.attemptedAt,
      buildStatusObservedAt: observation.attemptedAt,
      buildStatusHealth: 'valid' as const,
      buildStatusLastValidPhase: progress.buildPhase,
      ...(observation.digest ? { buildStatusDigest: observation.digest } : {}),
    } satisfies Partial<Mission>,
  };
}

function recoveryReasonForExit(
  exit: Exclude<BuildExit, 'qa-pass' | null>
): 'turns-exhausted' | 'budget-exhausted' | 'session-cap-exhausted' | 'runtime-failure' | 'review-failure' {
  if (exit === 'turns-exhausted') return 'turns-exhausted';
  if (exit === 'budget-exhausted' || exit === 'qa-budget-insufficient') return 'budget-exhausted';
  if (exit === 'caps-exhausted') return 'session-cap-exhausted';
  if (
    exit === 'qa-attempts-exhausted' ||
    exit === 'reviewer-precondition' ||
    exit === 'reviewer-contract-violation' ||
    exit === 'qa-failed'
  ) {
    return 'review-failure';
  }
  return 'runtime-failure';
}

function completeActiveRecoveryAttempt(
  mission: Mission | null,
  input: {
    reason: 'budget-exhausted' | 'runtime-failure';
    completedAt: string;
    failure: string;
  }
): Mission['recovery'] | undefined {
  const recovery = mission?.recovery;
  if (!recovery) return undefined;
  const observedPhase = mission.buildStatusLastValidPhase ?? mission.buildPhase;
  const phase = observedPhase && observedPhase !== 'published' ? observedPhase : recovery.terminal.phase;
  return {
    terminal: {
      reason: input.reason,
      recordedAt: input.completedAt,
      phase,
      ...(mission.buildStatusObservedAt ? { statusObservedAt: mission.buildStatusObservedAt } : {}),
      ...(mission.buildStatusHealth ? { statusHealth: mission.buildStatusHealth } : {}),
      ...(mission.buildStatusAttemptedAt ? { statusAttemptedAt: mission.buildStatusAttemptedAt } : {}),
      ...(mission.buildStatusDigest ? { statusDigest: mission.buildStatusDigest } : {}),
    },
    ...(recovery.authorizedMaxTurns ? { authorizedMaxTurns: recovery.authorizedMaxTurns } : {}),
    attempts: recovery.attempts.map((attempt) =>
      attempt.id === recovery.activeOperationId
        ? {
            ...attempt,
            status: 'completed' as const,
            completedAt: input.completedAt,
            failure: input.failure.slice(0, 1000),
          }
        : attempt
    ),
  };
}

/** Consecutive-identical-failure streak ending at the latest session. */
function stallStreak(sessions: NonNullable<Mission['sessions']>): number {
  let streak = 0;
  let hash: string | null | undefined;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const h = sessions[i].failingChecksHash;
    if (!h) break;
    if (hash === undefined) hash = h;
    if (h !== hash) break;
    streak++;
  }
  return streak;
}

export const runBuildMission = inngest.createFunction(
  {
    id: 'run-build-mission',
    // Same rationale as run-agent-mission: a retry would re-bill full agent
    // sessions. Recovery happens via resume (volume + STATUS persist).
    retries: 0,
    concurrency: [
      { limit: Number.parseInt(process.env.IMPULSE_BUILD_CONCURRENCY || '1', 10) || 1 },
      // A global cap alone does not prevent two queued Resume/Iterate events
      // from supervising the same persisted volume. Serialize by mission too.
      { limit: 1, key: 'event.data.missionId' },
    ],
    cancelOn: [{ event: 'app/build-mission.cancel.requested', match: 'data.missionId' }],
    // No timeouts.finish: approval gates legitimately wait days. The
    // build-specific GC cron is the safety net (IMPULSE_BUILD_GC_THRESHOLD_HOURS).
    onFailure: async ({ event, error }) => {
      const missionId = (event.data.event.data as { missionId?: string }).missionId;
      const userId = (event.data.event.data as { userId?: string }).userId ?? 'unknown';
      if (!missionId) return;
      log.error('Build mission failed', error, { missionId });
      let mission: Mission | null = null;
      let stoppedSandbox: Mission['sandbox'] | undefined;
      try {
        mission = await getMissionById(missionId);
        const sandbox = await importSandbox();
        const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
        const ref = cleanupRefFromMission(sandbox, cfg, mission ?? { id: missionId, sandbox: undefined });
        await stopAndVerifyRuntime(sandbox.getDriver(cfg.driver), ref, `Build mission ${missionId} failure cleanup`);
        if (mission?.sandbox) stoppedSandbox = { ...mission.sandbox, state: 'stopped' };
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        log.error(
          'Build mission failure cleanup could not be verified',
          cleanupError instanceof Error ? cleanupError : new Error(cleanupMessage),
          { missionId }
        );
        // Preserve the non-terminal mission state so Cancel/GC remains able to
        // retry cleanup. Never claim failed/paused over an unverified runtime.
        try {
          await updateMission(missionId, {
            errors: [
              error.message ?? 'build mission failed',
              `Runtime cleanup could not be verified: ${cleanupMessage}`,
            ],
          });
        } catch (stateError) {
          log.error(
            'Failed to persist build cleanup-required evidence',
            stateError instanceof Error ? stateError : new Error(String(stateError)),
            { missionId }
          );
        }
        try {
          await emitAgentEvent({
            type: 'agent.error',
            userId,
            agentType: 'builder',
            missionId,
            data: {
              missionId,
              kind: 'build',
              error: error.message,
              cleanupRequired: true,
            },
          });
        } catch (eventError) {
          log.error(
            'Failed to emit build cleanup-required event',
            eventError instanceof Error ? eventError : new Error(String(eventError)),
            { missionId }
          );
        }
        return;
      }

      const recoveredPublishedDocument = Boolean(
        mission &&
        mission.artifactKind !== 'solution' &&
        mission.buildPhase === 'published' &&
        mission.artifact?.documentId
      );
      try {
        if (recoveredPublishedDocument && mission?.artifact?.documentId) {
          const previewUrl = mission.artifact.previewUrl ?? `document:${mission.artifact.documentId}`;
          await updateMission(missionId, {
            status: 'completed',
            progress: 100,
            completedAt: new Date().toISOString(),
            ...(stoppedSandbox ? { sandbox: stoppedSandbox } : {}),
            result: `Document published: ${previewUrl} (entity ${mission.artifact.documentId}). Runtime cleanup recovered after orchestration failure.`,
          });
          await emitAgentEvent({
            type: 'agent.completed',
            userId,
            agentType: 'builder',
            missionId,
            data: {
              missionId,
              kind: 'build',
              artifactKind: mission.artifactKind,
              documentId: mission.artifact.documentId,
              previewUrl,
              recoveredCleanup: true,
            },
          });
          await inngest.send({
            name: 'app/build-mission.completed',
            data: { missionId, userId, documentId: mission.artifact.documentId },
          });
          // ARUN-030: a document that WAS published and whose cleanup recovered is
          // a real delivery, and it needs lineage as much as the happy path. It is
          // recorded `partial`, not `success`: orchestration failed after publish,
          // so the artifact exists but the run did not complete cleanly.
          await persistBuildLineageFromFailure({
            missionId,
            userId,
            exit: 'recovered-cleanup',
            outcome: 'partial',
            sessions: countRecordedBuildSessions(mission),
            spentUsd: mission.costUsd,
            summary: `Document published (${mission.artifact.documentId}); runtime cleanup recovered after an orchestration failure.`,
          });
          return;
        }

        const completedAt = new Date().toISOString();
        const recovery = mission?.recovery;
        const failedRecovery = recovery
          ? {
              terminal: {
                reason: 'runtime-failure' as const,
                recordedAt: completedAt,
                phase: mission?.buildPhase && mission.buildPhase !== 'published' ? mission.buildPhase : '00-inception',
                ...(mission?.buildStatusObservedAt ? { statusObservedAt: mission.buildStatusObservedAt } : {}),
              },
              ...(recovery.authorizedMaxTurns ? { authorizedMaxTurns: recovery.authorizedMaxTurns } : {}),
              attempts: recovery.attempts.map((attempt) =>
                attempt.id === recovery.activeOperationId
                  ? { ...attempt, status: 'completed' as const, completedAt, failure: error.message.slice(0, 1000) }
                  : attempt
              ),
            }
          : undefined;
        await updateMission(missionId, {
          status: 'failed',
          buildState: 'paused',
          completedAt,
          errors: [error.message ?? 'build mission failed'],
          ...(stoppedSandbox ? { sandbox: stoppedSandbox } : {}),
          ...(failedRecovery ? { recovery: failedRecovery } : {}),
        });
        await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
        await emitAgentEvent({
          type: 'agent.error',
          userId,
          agentType: 'builder',
          missionId,
          data: { missionId, kind: 'build', error: error.message },
        });

        // This path can terminate before any AgentRun, Episode, or Reflection is
        // produced. It is also the path a preflight refusal and a provider-fatal abort take, so the
        // outcome is classified from the error rather than flattened to `failed`:
        // an unreachable-config refusal spent nothing, and a non-retryable provider
        // status means retrying is useless — two different operator stories.
        await persistBuildLineageFromFailure({
          missionId,
          userId,
          exit: 'supervisor-failure',
          outcome: classifyBuildFailureOutcome(error.message, mission),
          sessions: countRecordedBuildSessions(mission),
          spentUsd: mission?.costUsd,
          summary: `Build failed after retries: ${(error.message ?? 'build mission failed').slice(0, 300)}`,
          errors: [error.message ?? 'build mission failed'],
        });
      } catch (cleanupError) {
        log.error(
          'Build mission failure state reconciliation failed after verified runtime cleanup',
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          { missionId }
        );
      }
    },
  },
  { event: 'app/build-mission.run.requested' },
  async ({ event, step }) => {
    const { missionId, userId, instructions, recoveryOperationId } = event.data as {
      missionId: string;
      userId: string;
      /** Present on iterate dispatches: new work for an existing artifact. */
      instructions?: string;
      recoveryOperationId?: string;
    };

    // OBS-006/ARUN-030: durable start instant. A build is supervised across many
    // per-step HTTP requests (bounded transcript polls, `waitForEvent` gates), so a
    // handler-body `Date.now()` would measure only the final slice.
    const buildStartedAtMs = await captureDurableInstantMs(step, 'capture-build-start');

    /**
     * ARUN-030 — the ONE terminal exit for this supervisor.
     *
     * Every `return` below routes through here, so no exit can persist a Mission
     * doc while leaving the build with no AgentRun, Episode, or Reflection. It
     * also attaches the OBS-001 business-outcome
     * declaration, so the transport record stops standing in for the result.
     *
     * The lineage write is a `step.run` keyed by the exit token: only one exit
     * executes per run, and keying by exit keeps the memoized step legible in the
     * Inngest dashboard.
     */
    const finalizeBuildRun = async <T extends Record<string, unknown>>(
      exit: string,
      payload: T,
      lineage: { spentUsd?: number; sessions: number; summary: string; errors?: string[]; outputId?: string }
    ) => {
      // Fail closed: an exit nobody mapped is recorded as `failed`, never as a
      // delivery. `domainOutcomeForBuildExit` returns undefined for unknown exits
      // precisely so a newly-added exit cannot default to success.
      const outcome = domainOutcomeForBuildExit(exit) ?? 'failed';
      const buildEndedAtMs = await captureDurableInstantMs(step, `capture-build-end-${exit}`);
      await step.run(`persist-build-lineage-${exit}`, async () => {
        const { persistBuildMissionLineage } = await import('@/lib/build-mission-lineage');
        return persistBuildMissionLineage({
          missionId,
          userId,
          exit,
          outcome,
          sessions: lineage.sessions,
          durationMs: Math.max(0, buildEndedAtMs - buildStartedAtMs),
          ...(lineage.spentUsd !== undefined ? { spentUsd: lineage.spentUsd } : {}),
          ...(lineage.outputId ? { outputId: lineage.outputId } : {}),
          ...(lineage.errors ? { errors: lineage.errors } : {}),
          summary: lineage.summary,
        });
      });
      return declareDomainOutcome({ ...payload, outcome: exit }, { outcome, reason: exit });
    };

    // ── 1. Load + validate ──────────────────────────────────────────────
    const init = await step.run('load-and-validate', async () => {
      const sandbox = await importSandbox();
      const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
      if (!cfg.enabled) throw new Error('Build missions are disabled (IMPULSE_BUILD_ENABLED=false)');
      const mission = await getMissionById(missionId);
      if (!mission) throw new Error(`Mission ${missionId} not found`);
      if (mission.kind !== 'build') throw new Error(`Mission ${missionId} is not a build mission`);
      const recoveryAttempt = recoveryOperationId
        ? mission.recovery?.attempts.find((attempt) => attempt.id === recoveryOperationId)
        : undefined;
      if (
        recoveryOperationId &&
        (mission.recovery?.activeOperationId !== recoveryOperationId ||
          !recoveryAttempt ||
          !['dispatching', 'running'].includes(recoveryAttempt.status) ||
          recoveryAttempt.volumeName !== mission.sandbox?.volumeName)
      ) {
        return {
          skipOutcome: 'recovery-operation-rejected' as const,
          missionStatus: mission.status,
          missionBuildState: mission.buildState ?? null,
        };
      }
      if (mission.status !== 'pending' || (mission.buildState !== undefined && mission.buildState !== 'provisioning')) {
        // Inngest's mission-keyed concurrency queues duplicate dispatches; it
        // does not discard them. Once the preceding run releases the lock, the
        // durable mission state is the second line of defence. Only a freshly
        // dispatched pending/provisioning mission may acquire the supervisor.
        return {
          skipOutcome: 'duplicate-suppressed' as const,
          missionStatus: mission.status,
          missionBuildState: mission.buildState ?? null,
        };
      }
      // Firestore is not a trusted typed boundary. Re-validate every persisted
      // context field and its derived digest/size before any status mutation,
      // paid launch, or Docker provisioning. A direct mutation fails closed.
      const contextManifest =
        mission.contextManifest === undefined ? null : validateStoredBuildContextManifest(mission.contextManifest);
      // BUILD-012: the `limitless` tier selects a premium config profile over
      // the SAME pipeline. Precedence for models is cfg.models < limitless <
      // mission.modelOverrides; the mission budget cap still wins over both
      // tiers' defaults.
      const limitless = (mission.buildMode ?? 'standard') === 'limitless';
      // AUDIT-016: the cap is clamped to the cumulative ceiling here, at the one
      // place every run reads it — a mission whose cap was raised past the
      // ceiling by earlier top-ups/iterations cannot spend the excess.
      const capUsd = clampCapUsd(
        mission.budget?.capUsd ?? (limitless ? cfg.limitless.missionCapUsd : cfg.budget.missionCapUsd)
      );
      return {
        cfg,
        prompt: mission.prompt,
        capUsd,
        // AUDIT-016: spend is CUMULATIVE across runs. `mission.costUsd` is the
        // durable counter the finalize step already maintains (and that
        // BuildMissionCard already renders against the cap) — the supervisor
        // simply never read it, and re-zeroed its own counter on every
        // invocation. Seeding from it here is what makes an Iterate accountable
        // for what the previous iterations already spent.
        //
        // Read inside the memoized `load-and-validate` step so a replay sees the
        // SAME seed rather than re-reading a counter the run has since advanced.
        priorSpentUsd: mission.buildCostAccounting?.maximumExposureUsd ?? mission.costUsd ?? 0,
        // Session transcript ordinals survive Resume/Iterate invocations.
        // Historical records contain a start and completion entry per index;
        // taking max+1 is stable across those duplicates.
        nextSessionIndex: (mission.sessions ?? []).reduce((max, session) => Math.max(max, session.index), -1) + 1,
        topUps: mission.budget?.topUps ?? [],
        buildMode: mission.buildMode ?? 'standard',
        // Per-mission stage models (artifact dispatch form) win over the tier.
        models: {
          ...cfg.models,
          ...(limitless
            ? {
                // A fresh Limitless mission starts in phase 00, so its single
                // `/goal` builder is selected through the plan slot. Override
                // that slot too; otherwise the advertised Opus tier silently
                // launches its only build session on the standard plan model.
                plan: cfg.limitless.buildModel,
                build: cfg.limitless.buildModel,
                qa: cfg.limitless.qaModel,
                escalation: cfg.limitless.escalationModel,
              }
            : {}),
          ...(mission.modelOverrides ?? {}),
        },
        // Scopes sandbox platform-MCP exposure (evaluation → none; see S).
        artifactKind: mission.artifactKind ?? 'solution',
        // Task 5: per-artifact palette/theme, threaded to the provisioner so
        // it can seed `.impulse/design-brief.json` for the visual gate.
        // Inngest serializes the step return as JSON — `?? null` keeps this
        // explicit and serializable rather than an implicit `undefined` drop.
        designBrief: mission.designBrief ?? null,
        // BUILD-036: immutable context manifest resolved at dispatch. `?? null`
        // keeps it explicit/serializable across the Inngest step boundary; the
        // supervisor reads it here and never re-resolves, so replay reproduces
        // the same workspace context.
        contextManifest,
        hasSandbox: Boolean(mission.sandbox),
        sandboxContainerName: mission.sandbox?.containerName ?? null,
        sandboxVolumeName: mission.sandbox?.volumeName ?? null,
        sandboxHostPort: mission.sandbox?.hostPort ?? 0,
        priorProgress: mission.progress,
        priorPhase: mission.buildPhase ?? null,
        recoveryOperationId: recoveryOperationId ?? null,
        recoveryMaxTurns: recoveryOperationId ? (mission.recovery?.authorizedMaxTurns ?? null) : null,
        recovery: recoveryOperationId ? (mission.recovery ?? null) : null,
      };
    });
    if ('skipOutcome' in init) {
      log.info('Skipping stale or duplicate build-mission dispatch', {
        missionId,
        status: init.missionStatus,
        buildState: init.missionBuildState,
      });
      // ARUN-030: a suppressed duplicate or rejected recovery did NOT run a build
      // and must not acquire lineage — the mission it refers to already owns
      // (or will own) its own. It is a transport no-op, declared `skipped` so
      // nothing counts it as either a delivery or a failure.
      return declareDomainOutcome(
        {
          outcome: init.skipOutcome,
          status: init.missionStatus,
          buildState: init.missionBuildState,
        },
        { outcome: 'skipped', reason: init.skipOutcome }
      );
    }
    const cfg = init.cfg as BuildCfg;
    const stageModels = init.models as StageModels;
    // BUILD-012/013: resolve the effective session caps + effort for this tier.
    // Standard is byte-identical to before (effort undefined → no --effort flag).
    const limitless = init.buildMode === 'limitless';
    const sess = limitless
      ? {
          max: cfg.limitless.maxSessions,
          maxTurns: cfg.limitless.maxTurns,
          maxMinutes: cfg.limitless.maxMinutes,
          maxCostUsd: cfg.limitless.sessionMaxCostUsd,
          reviewerMaxCostUsd: cfg.limitless.reviewerMaxCostUsd,
        }
      : {
          max: cfg.sessions.max,
          maxTurns: cfg.sessions.maxTurns,
          maxMinutes: cfg.sessions.maxMinutes,
          maxCostUsd: cfg.sessions.maxCostUsd,
          reviewerMaxCostUsd: 0,
        };
    const recoveredBuilderMaxTurns =
      Number.isSafeInteger(init.recoveryMaxTurns) && (init.recoveryMaxTurns ?? 0) > 0
        ? Number(init.recoveryMaxTurns)
        : null;
    const effortForBuild = (escalated: boolean): string | undefined =>
      limitless ? (escalated ? cfg.limitless.escalationEffort : cfg.limitless.effort) : undefined;

    // ── 2. Mark running ─────────────────────────────────────────────────
    await step.run('mark-running', async () => {
      const recovery = init.recovery;
      const runningRecovery =
        recovery && init.recoveryOperationId
          ? {
              ...recovery,
              attempts: recovery.attempts.map((attempt) =>
                attempt.id === init.recoveryOperationId
                  ? { ...attempt, status: 'running' as const, startedAt: new Date().toISOString() }
                  : attempt
              ),
            }
          : undefined;
      await updateMission(missionId, {
        status: 'running',
        buildState: 'provisioning',
        progress: Math.max(5, init.priorProgress ?? 0),
        budget: { capUsd: init.capUsd, warnThreshold: cfg.budget.warnThreshold, topUps: init.topUps },
        ...(runningRecovery ? { recovery: runningRecovery } : {}),
      });
      await emitAgentEvent({
        type: 'agent.started',
        userId,
        agentType: 'builder',
        missionId,
        data: { missionId, kind: 'build', capUsd: init.capUsd },
      });
    });

    // ── 3. Provision (or resume) the sandbox ────────────────────────────
    const provisioned = await step.run('provision-sandbox', async () => {
      const sandbox = await importSandbox();
      const driver = sandbox.getDriver(cfg.driver);
      const image = sandbox.fullImageName(cfg);
      const imageCheck = await sandbox.defaultExec('docker', ['image', 'inspect', image]);
      if (imageCheck.code !== 0) {
        throw new Error(`Sandbox image ${image} not found — run: npx tsx scripts/build-sandbox-image.ts`);
      }

      let reusedSandbox = false;
      let activeRef = refFromMission(sandbox, cfg, { id: missionId });
      let hostPort: number;

      // BUILD-036: bake the resolved context manifest into MISSION.md as a
      // rendered "## Authorized context" section so the builder sees its
      // authorized grounding; the raw manifest is also written verbatim to
      // .impulse/context-manifest.json by the provisioner. init.contextManifest
      // is the immutable value persisted at dispatch (never re-resolved), so
      // this is deterministic across replay/iterate.
      let briefWithContext = init.prompt;
      if (init.contextManifest) {
        const { renderContextManifestSection } = await import('@/lib/build-mission-context');
        const section = renderContextManifestSection(init.contextManifest);
        if (section) briefWithContext = `${init.prompt}\n\n${section}`;
      }

      if (init.hasSandbox) {
        // The mission record is the sole authority for persisted runtime
        // identity. Never fall back to generated names: doing so can silently
        // mount an empty volume and make a resume look like a fresh build.
        if (!init.sandboxContainerName || !init.sandboxVolumeName) {
          throw new Error(`Cannot resume ${missionId}: persisted sandbox runtime identity is incomplete`);
        }
        hostPort = init.sandboxHostPort;
        if (!Number.isInteger(hostPort) || hostPort <= 0) {
          throw new Error(`Cannot safely recreate ${init.sandboxContainerName}: persisted host port is missing`);
        }
        activeRef = {
          ...activeRef,
          containerName: init.sandboxContainerName,
          volumeName: init.sandboxVolumeName,
          hostPort,
        };

        // Probe the recorded volume before destroying any container. Docker
        // would otherwise create a new empty named volume during recreation,
        // losing the only observable signal that persisted work disappeared.
        const volumeProbe = await sandbox.defaultExec('docker', ['volume', 'inspect', activeRef.volumeName]);
        if (volumeProbe.code !== 0) {
          throw new Error(`Cannot resume ${missionId}: persisted sandbox volume ${activeRef.volumeName} is missing`);
        }

        // Mission code owns the same UID as PID 1 and can poison HOME, process
        // state, or the configured environment. Every persisted reuse therefore
        // receives a newly-created runtime; only the verified named volume and
        // the exact recorded host port cross this boundary.
        const result = await sandbox.recreateSandboxRuntime({
          cfg,
          missionId,
          driver,
          ref: activeRef,
          hostPort,
          artifactKind: init.artifactKind,
        });
        activeRef = result.ref;
        reusedSandbox = true;
        for (const warning of result.warnings) log.warn('runtime recreation warning', { missionId, warning });
      } else {
        const result = await sandbox.provisionSandbox({
          cfg,
          missionId,
          brief: briefWithContext,
          driver,
          artifactKind: init.artifactKind,
          designBrief: init.designBrief,
          contextManifest: init.contextManifest,
        });
        hostPort = result.ref.hostPort;
        activeRef = result.ref;
        for (const warning of result.warnings) log.warn('provision warning', { missionId, warning });
      }

      if (reusedSandbox) {
        // A preserved volume is user-controlled state. Restore the trusted
        // current host-package hooks, skills, settings, and MCP config before
        // reading any resume state from it (the container image may be stale).
        await sandbox.refreshWorkspaceControlPlane({
          cfg,
          missionId,
          driver,
          ref: activeRef,
          artifactKind: init.artifactKind,
        });
      }

      let statusObservation = await sandbox.readStatusObservation(driver, activeRef);
      let status = statusObservation.status;
      const staleQa = limitless ? await sandbox.readQaReport(driver, activeRef) : null;

      if (instructions) {
        // Iterate: the artifact is never finished. Refresh MISSION.md from
        // the (already-appended) mission prompt and point STATUS back into
        // the build phase with the new objective — the next session's
        // reconciliation rule picks it up from there.
        await sandbox.writeWorkspaceFile(driver, activeRef, 'MISSION.md', briefWithContext);
        if (init.contextManifest) {
          // Re-seed the immutable manifest so the retained workspace stays
          // consistent even if a prior session mutated the file (BUILD-036).
          await sandbox.writeWorkspaceFile(
            driver,
            activeRef,
            '.impulse/context-manifest.json',
            JSON.stringify(init.contextManifest, null, 2) + '\n'
          );
        }
        if (staleQa) await sandbox.archiveQaReport(driver, activeRef, `iterate-${init.nextSessionIndex}`);
        const iterated = {
          ...(status ?? sandbox.INITIAL_STATUS),
          phase: '06-build',
          readyForQa: false,
          blocked: null,
          handoff: {
            reason: 'iteration requested by the user',
            nextObjective: instructions,
          },
          notes: [
            ...(status?.notes ?? []),
            `${new Date().toISOString().slice(0, 10)}: iteration requested — ${instructions.slice(0, 200)}`,
          ],
        };
        await sandbox.writeWorkspaceFile(
          driver,
          activeRef,
          '.impulse/STATUS.json',
          JSON.stringify(iterated, null, 2) + '\n'
        );
        status = iterated;
      } else if (limitless && reusedSandbox && (status?.phase === '08-qa' || status?.phase === 'done')) {
        // Do not execute workspace-authored checks in this credential-bearing
        // resume runtime. The reviewer plan re-runs them below from an isolated
        // preview-owned copy after crossing a secretless container boundary.
        const gitHead = await sandbox.readWorkspaceGitHead(driver, activeRef);
        const workspaceChanges = gitHead
          ? await sandbox.listWorkspaceChangesSince(driver, activeRef, gitHead)
          : ['<missing-git-head>'];
        const cleanPhase08Handoff =
          status.phase === '08-qa' &&
          status.readyForQa &&
          !staleQa &&
          (await sandbox.hasQaHandoffEvidence(driver, activeRef)) &&
          Boolean(gitHead) &&
          workspaceChanges.length === 0;

        if (!cleanPhase08Handoff) {
          if (staleQa) {
            await sandbox.archiveQaReport(driver, activeRef, `resume-${init.nextSessionIndex}-${staleQa.verdict}`);
          }
          const resumed = {
            ...(status ?? sandbox.INITIAL_STATUS),
            phase: '06-build' as const,
            readyForQa: false,
            blocked: null,
            handoff: {
              reason:
                staleQa?.verdict === 'FAIL'
                  ? 'fresh reviewer rejected the previous build'
                  : 'the previous QA state was incomplete or untrusted',
              nextObjective: staleQa
                ? `Fix or revalidate the archived QA findings, rerun phase 07, and hand off for a new reviewer: ${staleQa.summary.slice(0, 500)}`
                : 'Revalidate the build, rerun phase 07, and produce a clean phase-08 reviewer handoff.',
            },
            notes: [
              ...(status?.notes ?? []),
              `${new Date().toISOString().slice(0, 10)}: invalid prior QA state normalized before controlled resume`,
            ],
          };
          await sandbox.writeWorkspaceFile(
            driver,
            activeRef,
            '.impulse/STATUS.json',
            JSON.stringify(resumed, null, 2) + '\n'
          );
          status = resumed;
        }
      }

      // Re-read after any trusted normalization write; this is the observation
      // persisted to the operator-facing mission state.
      statusObservation = await sandbox.readStatusObservation(driver, activeRef);
      const currentMission = await getMissionById(missionId);
      const statusTruth = statusObservationUpdate(statusObservation, currentMission);
      const processTelemetry = driver.processTelemetry ? await driver.processTelemetry(activeRef) : undefined;
      if (processTelemetry && (processTelemetry.limit === null || processTelemetry.zombies > 0)) {
        throw new Error(
          processTelemetry.limit === null
            ? `Sandbox ${activeRef.containerName} has no finite PID limit`
            : `Sandbox ${activeRef.containerName} contains ${processTelemetry.zombies} zombie process(es)`
        );
      }

      await updateMission(missionId, {
        ...statusTruth.update,
        buildState: 'session-running',
        sandbox: {
          driver: cfg.driver,
          image,
          containerName: activeRef.containerName,
          volumeName: activeRef.volumeName,
          hostPort,
          workspacePath: cfg.workspacePath,
          state: 'running',
          createdAt: new Date().toISOString(),
          ...(processTelemetry
            ? { processTelemetry: { ...processTelemetry, observedAt: new Date().toISOString() } }
            : {}),
        },
      });
      return { hostPort, ref: activeRef };
    });

    // ── 4. Bounded session loop ─────────────────────────────────────────
    // AUDIT-016: seeded from cumulative mission spend, NOT 0. Re-zeroing this on
    // every invocation is what let an Iterate start with a clean slate against a
    // cap it had just raised, so the budget gate below could never fire.
    let spentUsd = init.priorSpentUsd;
    // Dedupe QA verdicts by checkedAt — a FAIL report stays on disk until
    // the next fresh reviewer overwrites it. Rebuilt deterministically from
    // memoized finalize outputs on every re-invocation.
    let lastQaCheckedAt: string | null = null;
    let capUsd = init.capUsd;
    let escalated = false;
    let exit: BuildExit = null;
    let emptyStreak = 0;
    // Most recent session error text (any error) and the fatal one that forced
    // an abort — surfaced in the failure record so the UI shows the real cause
    // (e.g. "model not found: claude-fable-5") instead of a generic exit label.
    let lastSessionError: string | null = null;
    let fatalError: string | null = null;
    let lastTerminal: BuildTerminalClassification | null = null;
    // Set only by a reviewer accepted during this invocation. Firestore's
    // persisted qaGate intentionally cannot repopulate this authority.
    let acceptedReviewerGitHead: string | null = null;
    let acceptedReviewerResidualChanges: string[] | null = null;
    let acceptedReviewerWorkspaceSnapshot: ReviewerWorkspaceSnapshot | null = null;
    let acceptedReviewerSessionIndex: number | null = null;
    const sessionSummaries: NonNullable<Mission['sessions']> = [];

    for (let n = 0; n < sess.max && !exit; n++) {
      const sessionIndex = init.nextSessionIndex + n;
      // 4a. Plan: read STATUS, route the model, record session start.
      const plan = (await step.run(`session-${n}-plan`, async (): Promise<PlanResult> => {
        const sandbox = await importSandbox();
        const driver = sandbox.getDriver(cfg.driver);
        let ref = provisioned.ref;
        if (n > 0) {
          // A completed wrapper/process group is not a complete container
          // trust boundary: mission code can deliberately detach with setsid.
          // Recreate the credential runtime before every later session so only
          // the retained, re-fingerprinted volume crosses the boundary.
          const recreated = await sandbox.recreateSandboxRuntime({
            cfg,
            missionId,
            driver,
            ref,
            hostPort: provisioned.hostPort,
            hostEnv: process.env,
            artifactKind: init.artifactKind,
          });
          ref = recreated.ref;
          await sandbox.refreshWorkspaceControlPlane({
            cfg,
            missionId,
            driver,
            ref,
            artifactKind: init.artifactKind,
          });
          for (const warning of recreated.warnings) {
            log.warn('between-session runtime recreation warning', { missionId, session: sessionIndex, warning });
          }
        }
        const statusObservation = await sandbox.readStatusObservation(driver, ref);
        const currentMission = await getMissionById(missionId);
        const statusTruth = statusObservationUpdate(statusObservation, currentMission);
        const status = statusObservation.status;
        const phase = statusTruth.phase;
        const role: SessionRole = limitless && (phase === '08-qa' || phase === 'done') ? 'reviewer' : 'builder';
        const startedAt = new Date().toISOString();
        let qaBefore = limitless ? null : await sandbox.readQaReport(driver, ref);
        let gitHeadBefore: string | null = null;
        let reviewerWorkspaceSnapshotBefore: ReviewerWorkspaceSnapshot | null = null;
        let objective = status?.handoff?.nextObjective ?? `continue from phase ${phase}`;
        if (phase === 'done') {
          if (limitless) {
            // A persisted PASS belongs to an earlier invocation. It is not a
            // capability token for this run: only a reviewer launched and
            // accepted below may authorize this invocation's publish step.
            return {
              exit: 'builder-contract-violation',
              phase,
              model: '',
              objective: '',
              role,
              startedAt,
              qaCheckedAtBefore: qaBefore?.checkedAt ?? null,
              gitHeadBefore: null,
              reviewerWorkspaceSnapshotBefore: null,
            };
          }
          // A persisted Standard-mode `done` is never an authorization token,
          // and workspace-authored checks must not execute in this credential
          // runtime. Launch a bounded revalidation session; finalize will run
          // the checks from a secretless, preview-owned copy.
          const qa = qaBefore ?? (await sandbox.readQaReport(driver, ref));
          objective =
            `Revalidate the completed mission and leave its checks and QA state consistent ` +
            `(persisted QA verdict: ${qa?.verdict ?? 'missing'}).`;
        }

        if (limitless && role === 'reviewer') {
          // Builder-authored acceptance commands are untrusted code. Run them
          // from a disposable copy in a secretless runtime, prove they did not
          // mutate the retained volume, then recreate once more before giving
          // the independent reviewer a provider credential.
          const precheckRuntime = await sandbox.recreateSandboxRuntime({
            cfg,
            missionId,
            driver,
            ref,
            hostPort: provisioned.hostPort,
            artifactKind: init.artifactKind,
            purpose: 'preview',
          });
          for (const warning of precheckRuntime.warnings) {
            log.warn('reviewer precheck runtime recreation warning', { missionId, warning });
          }
          await sandbox.refreshWorkspaceControlPlane({
            cfg,
            missionId,
            driver,
            ref: precheckRuntime.ref,
            artifactKind: init.artifactKind,
          });
          const snapshotBeforeChecks = await sandbox.captureReviewerWorkspaceSnapshot(
            driver,
            precheckRuntime.ref,
            sessionIndex
          );
          const isolatedCheckPath = `/tmp/radarist-pre-review-checks-${sessionIndex}`;
          const isolatedCheckRef = await prepareIsolatedCheckWorkspace(driver, precheckRuntime.ref, isolatedCheckPath);
          const checks = await sandbox.loadChecks(driver, isolatedCheckRef, { user: 'preview' });
          const checksValid = Boolean(checks && checks.length > 0);
          const results = checksValid
            ? await sandbox.runChecks(driver, isolatedCheckRef, checks!, { user: 'preview' })
            : [];
          const failing = checksValid ? results.filter((check: { ok: boolean }) => !check.ok).length : 1;
          const snapshotAfterChecks = await sandbox.captureReviewerWorkspaceSnapshot(
            driver,
            precheckRuntime.ref,
            sessionIndex
          );
          const prechecksPreservedWorkspace = reviewerSnapshotsEqual(snapshotBeforeChecks, snapshotAfterChecks);

          const recreated = await sandbox.recreateSandboxRuntime({
            cfg,
            missionId,
            driver,
            ref: precheckRuntime.ref,
            hostPort: provisioned.hostPort,
            hostEnv: process.env,
            artifactKind: init.artifactKind,
          });
          for (const warning of recreated.warnings) {
            log.warn('reviewer runtime recreation warning', { missionId, warning });
          }
          await sandbox.refreshWorkspaceControlPlane({
            cfg,
            missionId,
            driver,
            ref: recreated.ref,
            artifactKind: init.artifactKind,
          });
          const reviewerStatus = await sandbox.readStatus(driver, recreated.ref);
          qaBefore = await sandbox.readQaReport(driver, recreated.ref);
          gitHeadBefore = await sandbox.readWorkspaceGitHead(driver, recreated.ref);
          const preReviewChanges = gitHeadBefore
            ? await sandbox.listWorkspaceChangesSince(driver, recreated.ref, gitHeadBefore)
            : ['<missing-git-head>'];
          const evidenceReady = await sandbox.hasQaHandoffEvidence(driver, recreated.ref);
          reviewerWorkspaceSnapshotBefore = await sandbox.captureReviewerWorkspaceSnapshot(
            driver,
            recreated.ref,
            sessionIndex
          );
          if (
            reviewerStatus?.phase !== '08-qa' ||
            !reviewerStatus.readyForQa ||
            qaBefore ||
            !checksValid ||
            failing > 0 ||
            !prechecksPreservedWorkspace ||
            !evidenceReady ||
            !gitHeadBefore ||
            preReviewChanges.length > 0 ||
            !reviewerWorkspaceSnapshotBefore
          ) {
            return {
              exit: 'reviewer-precondition',
              phase,
              model: '',
              objective: '',
              role,
              startedAt,
              qaCheckedAtBefore: qaBefore?.checkedAt ?? null,
              gitHeadBefore,
              reviewerWorkspaceSnapshotBefore,
            };
          }
          objective = 'independently run phase-08 adversarial QA without changing product code';
        } else if (limitless) {
          qaBefore = await sandbox.readQaReport(driver, ref);
          if (qaBefore) {
            return {
              exit: 'builder-contract-violation',
              phase,
              model: '',
              objective: '',
              role,
              startedAt,
              qaCheckedAtBefore: qaBefore.checkedAt,
              gitHeadBefore: null,
              reviewerWorkspaceSnapshotBefore: null,
            };
          }
        }
        const model = modelForPhase(stageModels, phase === 'done' ? '06-build' : phase, escalated);
        await updateMission(missionId, {
          ...statusTruth.update,
          buildState: role === 'reviewer' ? 'qa' : 'session-running',
        });
        await emitAgentEvent({
          type: 'agent.thinking',
          userId,
          agentType: 'builder',
          missionId,
          data: {
            missionId,
            kind: 'build',
            phase,
            session: sessionIndex,
            role,
            model,
            objective: objective.slice(0, 300),
          },
        });
        return {
          exit: null,
          phase,
          model,
          objective,
          role,
          startedAt,
          qaCheckedAtBefore: qaBefore?.checkedAt ?? null,
          gitHeadBefore,
          reviewerWorkspaceSnapshotBefore,
        };
      })) as PlanResult;
      if (plan.exit) {
        exit = plan.exit;
        break;
      }
      const launchedMaxTurns =
        plan.role === 'builder' && recoveredBuilderMaxTurns !== null ? recoveredBuilderMaxTurns : sess.maxTurns;

      // 4b. Launch detached.
      // BUILD-014: cap this launch's CLI spend at the LOWER of the configured
      // per-session budget and the remaining mission budget (capUsd tracks
      // top-ups, spentUsd the cumulative spend). The post-hoc gate at 4g still
      // pauses the mission on cap exhaustion; this stops a single runaway
      // session from blowing past the cap before that gate can fire.
      const remainingMissionBudgetUsd = remainingBudgetUsd(capUsd, spentUsd);
      // AUDIT-016 — FAIL CLOSED. With `spentUsd` now seeded from cumulative
      // spend, `remaining === 0` is reachable for the first time (an iterate on
      // an already-exhausted mission). Launching here would hand the sandbox a
      // 0 budget, which used to DROP `--max-budget-usd` and run the CLI with no
      // cap at all. Stop the run instead — there is no money left to spend and
      // no top-up can be granted past the ceiling.
      if (remainingMissionBudgetUsd <= 0) {
        exit = 'budget-exhausted';
        break;
      }
      let sessionBudgetUsd: number;
      if (limitless && plan.role === 'reviewer') {
        if (remainingMissionBudgetUsd < sess.reviewerMaxCostUsd) {
          exit = 'qa-budget-insufficient';
          break;
        }
        sessionBudgetUsd = sess.reviewerMaxCostUsd;
      } else if (limitless) {
        const builderHeadroom = remainingMissionBudgetUsd - sess.reviewerMaxCostUsd;
        if (builderHeadroom <= 0) {
          exit = 'qa-budget-insufficient';
          break;
        }
        sessionBudgetUsd = Math.min(sess.maxCostUsd, builderHeadroom);
      } else {
        sessionBudgetUsd = Math.min(sess.maxCostUsd, remainingMissionBudgetUsd);
      }
      const reservation = await step.run(`session-${n}-reserve`, async () =>
        reserveBuildSessionBudget(
          missionId,
          {
            index: sessionIndex,
            role: plan.role,
            objective: plan.objective.slice(0, 2000),
            model: plan.model,
            startedAt: plan.startedAt,
            reservedCostUsd: sessionBudgetUsd,
          },
          capUsd
        )
      );
      if (reservation.status === 'budget-exceeded') {
        // Another durable writer advanced the ledger after load-and-validate.
        // The transaction refused the reservation, so no paid process may start.
        spentUsd = reservation.missionCostUsd;
        exit = 'budget-exhausted';
        break;
      }
      // The full envelope is durably charged before detached execution. A
      // missing result therefore cannot disappear from cumulative spend.
      spentUsd = reservation.missionCostUsd;
      await step.run(`session-${n}-launch`, async () => {
        const sandbox = await importSandbox();
        const driver = sandbox.getDriver(cfg.driver);
        const ref = provisioned.ref;
        // `/goal` is an explicit compatibility opt-in for the builder only.
        // Phase 08 always receives the frozen independent-reviewer contract.
        const useGoal =
          limitless &&
          plan.role === 'builder' &&
          cfg.limitless.useGoal &&
          (init.artifactKind === 'solution' || init.artifactKind === 'evaluation');
        const kickoff =
          plan.role === 'reviewer'
            ? sandbox.QA_REVIEW_PROMPT
            : useGoal
              ? sandbox.buildGoalKickoff(init.artifactKind as 'solution' | 'evaluation')
              : sandbox.KICKOFF_PROMPT;
        await sandbox.launchSession(driver, ref, {
          index: sessionIndex,
          model: plan.model,
          maxTurns: launchedMaxTurns,
          maxMinutes: sess.maxMinutes,
          prompt: kickoff,
          maxBudgetUsd: sessionBudgetUsd,
          effort: effortForBuild(escalated),
        });
      });

      // 4c. Poll: short watch windows, step.sleep between them. Each poll
      // step holds the HTTP invocation well under serve-route limits.
      const maxPolls = Math.ceil((sess.maxMinutes * 60) / cfg.poll.watchSeconds);
      let offset = 0;
      let sessionDone = false;
      for (let k = 0; k < maxPolls && !sessionDone; k++) {
        const poll = await step.run(`session-${n}-poll-${k}`, async () => {
          const sandbox = await importSandbox();
          const driver = sandbox.getDriver(cfg.driver);
          const ref = provisioned.ref;
          const watchDeadline = Date.now() + cfg.poll.watchSeconds * 1000;
          let localOffset = offset;
          let done = false;
          const killed = false;
          let rest = '';
          while (Date.now() < watchDeadline) {
            const { chunk, nextOffset } = await sandbox.readTranscriptFrom(driver, ref, sessionIndex, localOffset);
            localOffset = nextOffset;
            const parsed = sandbox.parseChunk(rest + chunk);
            rest = parsed.rest;
            for (const ev of parsed.events) {
              if (ev.kind === 'tool-use') {
                await emitAgentEvent({
                  type: 'agent.tool_call',
                  userId,
                  agentType: 'builder',
                  missionId,
                  data: {
                    missionId,
                    kind: 'build',
                    session: sessionIndex,
                    role: plan.role,
                    tool: ev.tool,
                    summary: ev.summary.slice(0, 200),
                  },
                });
              }
            }
            if (await sandbox.isSessionDone(driver, ref, sessionIndex)) {
              done = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, cfg.poll.intervalSeconds * 1000));
          }
          const statusObservation = await sandbox.readStatusObservation(driver, ref);
          const currentMission = await getMissionById(missionId);
          const statusTruth = statusObservationUpdate(statusObservation, currentMission);
          if (
            statusObservation.health !== currentMission?.buildStatusHealth ||
            (statusObservation.digest && statusObservation.digest !== currentMission?.buildStatusDigest)
          ) {
            await updateMission(missionId, statusTruth.update);
          }
          return { offset: localOffset, done, killed };
        });
        offset = (poll as { offset: number }).offset;
        sessionDone = (poll as { done: boolean }).done;
      }

      // Wall-clock cap: the poll budget (maxPolls × watchSeconds ≈
      // sessions.maxMinutes) ran out with the session still alive — kill it.
      // killSession arms .impulse/force-stop first so an in-flight Stop hook
      // releases. Cost is enforced at session boundaries via the mission
      // cap; mid-session spend is only visible in the final result line.
      if (!sessionDone) {
        await step.run(`session-${n}-kill`, async () => {
          const sandbox = await importSandbox();
          const driver = sandbox.getDriver(cfg.driver);
          await sandbox.killSession(driver, provisioned.ref, sessionIndex);
        });
      }

      // 4d. Finalize: authoritative result, supervisor-run checks, stall hash.
      const fin = (await step.run(`session-${n}-finalize`, async (): Promise<FinalizeResult> => {
        const sandbox = await importSandbox();
        const driver = sandbox.getDriver(cfg.driver);
        const ref = provisioned.ref;

        // Session authority lives in the current container's root-owned control
        // directory, not in the agent-writable workspace. Read it before the
        // credential runtime is destroyed and recreated for verification.
        const transcript = await sandbox.readFullTranscript(driver, ref, sessionIndex);
        const result = sandbox.extractResult(transcript);
        const sessionExitCode = await sandbox.readSessionExitCode(driver, ref, sessionIndex);
        await sandbox.quiesceSession(driver, ref, sessionIndex);

        // A process can deliberately escape the session PGID with setsid.
        // Cross a whole-container boundary after every session, including a
        // Standard builder, before executing checks or reading mutable verdict
        // state. Only the retained workspace volume survives this transition.
        const recreated = await sandbox.recreateSandboxRuntime({
          cfg,
          missionId,
          driver,
          ref,
          hostPort: provisioned.hostPort,
          artifactKind: init.artifactKind,
          purpose: 'preview',
        });
        const activeRef = recreated.ref;
        let reviewedWorkspaceSnapshot: ReviewerWorkspaceSnapshot | null = null;
        if (limitless && plan.role === 'reviewer') {
          await sandbox.resetWorkspaceGitControlPlane(driver, recreated.ref);
          reviewedWorkspaceSnapshot = await sandbox.captureReviewerWorkspaceSnapshot(
            driver,
            recreated.ref,
            sessionIndex
          );
        }
        for (const warning of recreated.warnings) {
          log.warn('post-session runtime recreation warning', {
            missionId,
            session: sessionIndex,
            role: plan.role,
            warning,
          });
        }
        const sessionSucceeded = Boolean(
          sessionDone && result && result.isError !== true && result.subtype === 'success' && sessionExitCode === 0
        );
        // A session that never ran emits only the `system/init` line. A
        // session that ran (even if killed before a final result) has many
        // transcript lines. Use line count, not cost/turns, so a legitimately
        // killed-mid-work session is NOT mistaken for an empty one. An errored
        // result that failed at the very start (≤1 turn) accomplished nothing,
        // so it counts as unproductive and trips the degenerate guard. But a
        // session that did many turns of real work and only then hit a
        // transient error (e.g. a 429 the CLI surfaced after its own retries)
        // IS productive — don't mislabel it "degraded sandbox". Fatal 4xx is
        // handled separately (fast-abort) regardless of turn count.
        const transcriptLines = transcript ? transcript.split('\n').filter((l: string) => l.trim()).length : 0;
        const errored = result?.isError === true;
        // Prefer the model's own error text; fall back to the status code; and
        // for the degenerate case (is_error with neither) emit a concrete,
        // honest message rather than a context-free "API error".
        const sessionError = errored
          ? result?.resultText?.trim() ||
            (typeof result?.apiErrorStatus === 'number'
              ? `API error ${result.apiErrorStatus}`
              : 'session reported an error with no detail (CLI emitted is_error without a message or status)')
          : null;
        const fatal =
          errored && typeof result?.apiErrorStatus === 'number' && FATAL_API_STATUSES.has(result.apiErrorStatus);
        const erroredWithoutWork = errored && (result?.numTurns ?? 0) <= 1;
        const producedWork = transcriptLines > 1 && !erroredWithoutWork;
        const missionAtFinalize = await getMissionById(missionId);
        const statusObservation = await sandbox.readStatusObservation(driver, activeRef);
        const statusTruth = statusObservationUpdate(statusObservation, missionAtFinalize);
        const status = statusObservation.status;
        const phase = statusTruth.phase;

        // Freeze every reviewer-authored verdict/evidence field before any
        // builder-authored acceptance command is executed. Checks are useful
        // verification inputs, but they are untrusted code and must never be
        // able to rewrite the independent review that authorizes publication.
        let qaReport: Awaited<ReturnType<typeof sandbox.readQaReport>> =
          plan.role === 'reviewer' ? await sandbox.readQaReport(driver, activeRef) : null;
        let qaEvidenceReady =
          limitless && plan.role === 'reviewer' ? await sandbox.hasQaHandoffEvidence(driver, activeRef) : false;
        const reviewerChanges: string[] =
          limitless && plan.role === 'reviewer' && plan.gitHeadBefore
            ? await sandbox.listWorkspaceChangesSince(driver, activeRef, plan.gitHeadBefore)
            : [];
        const reviewedGitHead =
          limitless && plan.role === 'reviewer' ? await sandbox.readWorkspaceGitHead(driver, activeRef) : null;
        const reviewerResidualChanges =
          limitless && plan.role === 'reviewer' && reviewedGitHead
            ? await sandbox.listWorkspaceChangesSince(driver, activeRef, reviewedGitHead)
            : [];

        const reviewerWorkspaceInitiallyUnchanged =
          plan.role !== 'reviewer' ||
          reviewerSnapshotsEqual(plan.reviewerWorkspaceSnapshotBefore, reviewedWorkspaceSnapshot);
        let checkRef = activeRef;
        if (reviewerWorkspaceInitiallyUnchanged) {
          const isolatedCheckPath = `/tmp/radarist-finalize-checks-${sessionIndex}`;
          checkRef = await prepareIsolatedCheckWorkspace(driver, activeRef, isolatedCheckPath);
        }

        let checks: Awaited<ReturnType<typeof sandbox.loadChecks>> = null;
        let checkResults: Awaited<ReturnType<typeof sandbox.runChecks>> = [];
        let visualFailing = 0;
        // Every workspace-authored check runs as the distinct preview UID in a
        // disposable copy. It cannot traverse the retained node-owned volume,
        // including from delayed/background check processes.
        const isolatedCheckOpts = { user: 'preview' as const };
        checks = reviewerWorkspaceInitiallyUnchanged
          ? await sandbox.loadChecks(driver, checkRef, isolatedCheckOpts)
          : null;
        // BUILD-039: this runtime was recreated after the session that installed
        // the browser. Prove a browser is executable AS the preview check user
        // before believing any result; otherwise a destroyed dependency is
        // reported as N mission-side check failures, rejects a genuine
        // STATUS=done + durable qa=PASS, and opens a stall that buys another
        // paid session to "fix" a defect the mission never had.
        let checkDependencyFailure: string | null = null;
        if (checks && checks.length > 0) {
          const dependencies = await sandbox.verifyCheckDependencies(driver, checkRef, checks, isolatedCheckOpts);
          if (dependencies.required && !dependencies.satisfied) {
            checkDependencyFailure = dependencies.detail || 'no executable browser in the recreated runtime';
            log.error('acceptance checks refused: declared dependency missing after runtime recreation', {
              missionId,
              session: sessionIndex,
              detail: checkDependencyFailure,
            });
          } else {
            checkResults = await sandbox.runChecks(driver, checkRef, checks, isolatedCheckOpts);
          }
        }
        if (
          reviewerWorkspaceInitiallyUnchanged &&
          phase === 'done' &&
          init.buildMode === 'limitless' &&
          init.artifactKind === 'solution'
        ) {
          const gate = await sandbox.runVisualGate(driver, checkRef, isolatedCheckOpts);
          if (!gate.ok) {
            visualFailing = 1;
            log.warn('visual gate failed', { missionId, session: sessionIndex, output: gate.output });
          }
        }
        if (plan.role !== 'reviewer') {
          qaReport = await sandbox.readQaReport(driver, activeRef);
          qaEvidenceReady = limitless ? await sandbox.hasQaHandoffEvidence(driver, activeRef) : false;
        }
        const reviewedWorkspaceSnapshotAfterChecks =
          plan.role === 'reviewer'
            ? await sandbox.captureReviewerWorkspaceSnapshot(driver, activeRef, sessionIndex)
            : reviewedWorkspaceSnapshot;
        const reviewerWorkspaceUnchanged =
          reviewerWorkspaceInitiallyUnchanged &&
          (plan.role !== 'reviewer' ||
            reviewerSnapshotsEqual(reviewedWorkspaceSnapshot, reviewedWorkspaceSnapshotAfterChecks));
        // A refused acceptance run left checkResults empty. Without this guard
        // that reads as "0 failing" — a false green that would let a mission
        // publish having never run its own checks.
        const checksValid = Boolean(checks && checks.length > 0) && !checkDependencyFailure;
        const fingerprint = checkDependencyFailure
          ? `acceptance checks refused: ${checkDependencyFailure}`
          : checksValid
            ? sandbox.failureFingerprintInput(checkResults)
            : 'acceptance checks are missing, invalid, or empty';
        const failing = checksValid ? checkResults.filter((c: { ok: boolean }) => !c.ok).length : 1;
        const hash = fingerprint
          ? (await import('crypto')).createHash('sha256').update(fingerprint).digest('hex')
          : null;

        const mission = missionAtFinalize;
        // A FAIL report sits on disk until the next fresh reviewer
        // overwrites it — count an attempt only when checkedAt is new
        // (returned to the loop; persisted via qaGate.attempts).
        const priorFails = mission?.qaGate?.attempts ?? 0;
        const isNewVerdict = Boolean(qaReport) && qaReport!.checkedAt !== lastQaCheckedAt;
        const qaFailCount = qaReport?.verdict === 'FAIL' && isNewVerdict ? priorFails + 1 : priorFails;
        const hasCriticalQaFinding = Boolean(
          qaReport?.findings.some((finding: { severity: string }) => finding.severity === 'critical')
        );
        const qaFindings = (qaReport?.findings ?? [])
          .slice(0, 20)
          .map(
            (finding: {
              severity: 'critical' | 'major' | 'minor';
              title: string;
              detail?: string;
              story?: string;
            }) => ({
              severity: finding.severity,
              title: finding.title.slice(0, 200),
              detail: (finding.detail ?? '').slice(0, 2000),
              ...(finding.story ? { story: finding.story } : {}),
            })
          );

        const costUsd = result?.totalCostUsd ?? sessionBudgetUsd;
        const costEstimated = result === null;
        const observedFinalizedAt = new Date().toISOString();
        const terminal = classifyBuildTerminal({
          source: 'session',
          sessionDone,
          exitCode: sessionExitCode,
          launchedMaxTurns,
          result,
        });
        const sessionExitReason: 'completed' | 'max-turns' | 'timeout' | 'error' | 'budget' =
          terminal.reason === 'completed'
            ? 'completed'
            : terminal.reason === 'turns-exhausted'
              ? 'max-turns'
              : terminal.reason === 'budget-exhausted'
                ? 'budget'
                : terminal.basis === 'session-timeout'
                  ? 'timeout'
                  : 'error';
        const summary: BuildSessionCompletion = {
          index: sessionIndex,
          role: plan.role,
          objective: '',
          model: plan.model,
          startedAt: plan.startedAt,
          endedAt: observedFinalizedAt,
          turns: result?.numTurns ?? 0,
          costUsd,
          ...(costEstimated ? { costEstimated: true } : {}),
          // is_error can be set even when subtype === 'success' (e.g. a 404),
          // so check it before trusting subtype.
          exitReason: sessionExitReason,
          failingChecksHash: hash,
          ...(sessionError ? { error: sessionError.slice(0, 2000) } : {}),
        };
        // ARUN-004: accumulate token usage alongside cost so the Agent Runs
        // token-usage summary reflects build spend (previously build tokens were
        // parsed off the result line and then dropped — the widget read 0). The
        // session result's `usage` is the CLI's final cumulative count for that
        // session; cache-read/write are not broken out, so this is input+output
        // approximate, but it is the real order of magnitude, not zero.
        const sessionInput = Math.max(0, Math.round(result?.usage?.input_tokens ?? 0));
        const sessionOutput = Math.max(0, Math.round(result?.usage?.output_tokens ?? 0));
        // The ledger needs the same counts WITHOUT the absent-to-zero coercion
        // above: a session whose result line reported no usage has UNKNOWN
        // tokens, and a receipt that recorded 0 would assert a known zero.
        const reportedInputTokens =
          typeof result?.usage?.input_tokens === 'number' && Number.isFinite(result.usage.input_tokens)
            ? sessionInput
            : undefined;
        const reportedOutputTokens =
          typeof result?.usage?.output_tokens === 'number' && Number.isFinite(result.usage.output_tokens)
            ? sessionOutput
            : undefined;
        const accounting = await finalizeBuildSessionAccounting(missionId, summary, {
          input: sessionInput,
          output: sessionOutput,
        });

        // ARUN-022 (build envelope) — a paid sandbox session is provider spend
        // and belongs in the durable operation-usage ledger, not only in the
        // mission's own cost field. Best-effort and fully contained: a ledger
        // failure must never perturb the build it observes.
        try {
          const { flushBuildSessionUsageReceipt } = await import('@/lib/mission-usage-receipts');
          await flushBuildSessionUsageReceipt({
            missionId,
            owner: `user:${userId}`,
            sessionIndex,
            requestedModel: summary.model,
            // The DURABLE completion timestamp (stable on replay by contract), so
            // a step retry re-derives the same receipt identity and settles the
            // same row instead of creating a duplicate.
            occurredAt: accounting.endedAt,
            // Pass counters ONLY when the CLI actually reported them. The
            // mission token ledger above coerces an absent count to 0; a receipt
            // must not, or an unreported session would read as a known zero.
            ...(reportedInputTokens !== undefined ? { inputTokens: reportedInputTokens } : {}),
            ...(reportedOutputTokens !== undefined ? { outputTokens: reportedOutputTokens } : {}),
            // Only a real CLI result line is a provider ACTUAL. When the result
            // was missing or malformed the supervisor charged the full budget
            // reservation (costEstimated) — an exposure ceiling, not something
            // the provider billed — so it must never be recorded as a settlement.
            ...(costEstimated ? {} : { authoritativeCostUsd: result.totalCostUsd }),
            // Per-SERVED-model usage + the session cache-write tier split, when
            // this CLI version reports them. They upgrade the session from ONE
            // aggregate receipt (requested-model guess, unpriceable estimate) to
            // one receipt per model the provider actually served, each settled
            // with that model's own authoritative cost. Absent on older CLI
            // versions, where the aggregate fallback still runs.
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(result?.cacheCreation ? { cacheCreation: result.cacheCreation } : {}),
          });
        } catch (receiptError) {
          log.warn('Build session usage receipt failed (best-effort, non-fatal)', {
            missionId,
            sessionIndex,
            error: receiptError instanceof Error ? receiptError.message : String(receiptError),
          });
        }

        const processTelemetry = driver.processTelemetry ? await driver.processTelemetry(activeRef) : undefined;
        await updateMission(missionId, {
          ...statusTruth.update,
          ...(processTelemetry && mission?.sandbox
            ? {
                sandbox: {
                  ...mission.sandbox,
                  state: 'running' as const,
                  processTelemetry: { ...processTelemetry, observedAt: new Date().toISOString() },
                },
              }
            : {}),
        });

        return {
          costUsd: accounting.chargedCostUsd,
          missionCostUsd: accounting.missionCostUsd,
          turns: result?.numTurns ?? 0,
          subtype: result?.subtype ?? null,
          phase,
          missionDone: phase === 'done',
          qaCheckedAt: qaReport?.checkedAt ?? null,
          qaVerdict: qaReport?.verdict ?? null,
          qaFailCount,
          qaFindings,
          hasCriticalQaFinding,
          checksValid,
          failingChecks: failing,
          failingChecksHash: hash,
          checkDependencyFailure,
          visualFailing,
          sessionSucceeded,
          sessionExitCode,
          reviewedGitHead,
          reviewedWorkspaceSnapshot: reviewerWorkspaceUnchanged ? reviewedWorkspaceSnapshot : null,
          killed: !sessionDone,
          producedWork,
          sessionError,
          fatal,
          readyForQa: status?.readyForQa ?? false,
          qaEvidenceReady,
          reviewerChanges,
          reviewerResidualChanges,
          finalizedAt: accounting.endedAt,
          terminal,
        };
      })) as FinalizeResult;

      spentUsd = fin.missionCostUsd;
      lastTerminal = fin.terminal;
      if (fin.sessionError) lastSessionError = fin.sessionError;
      sessionSummaries.push({
        index: sessionIndex,
        role: plan.role,
        objective: '',
        model: plan.model,
        startedAt: '',
        failingChecksHash: fin.failingChecksHash,
      });

      // BUILD-039: the acceptance run was refused because the recreated runtime
      // could not execute a declared dependency. That is a platform defect, not
      // a mission defect — stop here rather than escalating or opening a stall
      // gate whose only resolution would be to spend on another session.
      if (fin.checkDependencyFailure) {
        const failure = `build runtime could not satisfy declared check dependencies: ${fin.checkDependencyFailure}`;
        await step.run(`session-${n}-check-dependency-failure`, async () => {
          const sandbox = await importSandbox();
          await stopAndVerifyRuntime(
            sandbox.getDriver(cfg.driver),
            provisioned.ref,
            `Build mission ${missionId} check-dependency failure`
          );
          const stoppedMission = await getMissionById(missionId);
          const completedAt = new Date().toISOString();
          const completedRecovery = completeActiveRecoveryAttempt(stoppedMission, {
            reason: 'runtime-failure',
            completedAt,
            failure,
          });
          await updateMission(missionId, {
            status: 'failed',
            buildState: 'paused',
            completedAt,
            errors: [failure],
            ...(stoppedMission?.sandbox ? { sandbox: { ...stoppedMission.sandbox, state: 'stopped' as const } } : {}),
            ...(completedRecovery ? { recovery: completedRecovery } : {}),
          });
          await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
        });
        return finalizeBuildRun(
          'runtime-failure',
          { spentUsd, sessions: sessionSummaries.length },
          {
            spentUsd,
            sessions: sessionSummaries.length,
            summary:
              `Build stopped after ${sessionSummaries.length} session(s): the recreated runtime could not ` +
              `execute a declared check dependency, so acceptance was refused rather than reported as failing. ` +
              `$${spentUsd.toFixed(2)} spent.`,
          }
        );
      }

      if (fin.terminal.reason === 'budget-exhausted') {
        exit = 'budget-exhausted';
        break;
      }
      if (limitless && plan.role === 'builder' && fin.terminal.reason === 'turns-exhausted') {
        exit = 'turns-exhausted';
        break;
      }

      // A provider-reported last-call overrun must not publish merely because
      // the same session also produced a PASS. Exact-cap completion is valid.
      if (spentUsd > capUsd) {
        exit = 'budget-exhausted';
        break;
      }

      // 4d.4. Fatal API error → abort on the FIRST occurrence. A bad model id /
      // auth / access error (4xx) is not transient; re-launching identical
      // sessions only reproduces it and burns the cap behind a misleading
      // "caps-exhausted". Surface the exact message instead.
      if (fin.fatal) {
        log.warn('aborting: non-retryable session error', {
          missionId,
          session: sessionIndex,
          error: fin.sessionError,
        });
        exit = 'fatal-session-error';
        fatalError = fin.sessionError;
        break;
      }

      // 4d.5. Degenerate-session guard. A session whose transcript never got
      // past `system/init` (or that errored before doing work) is unproductive
      // — fail fast rather than letting such sessions silently consume the cap.
      if (!fin.producedWork) {
        emptyStreak += 1;
        if (emptyStreak >= EMPTY_SESSION_ABORT) {
          log.warn('aborting: consecutive unproductive sessions (sandbox likely degraded)', {
            missionId,
            emptyStreak,
            session: sessionIndex,
          });
          exit = 'empty-sessions';
          break;
        }
      } else {
        emptyStreak = 0;
      }

      const persistQa = async () => {
        if (!fin.qaVerdict || !fin.qaCheckedAt) return;
        await step.run(`session-${n}-persist-qa`, async () => {
          await updateMission(missionId, {
            qaGate: {
              attempts: Math.min(fin.qaFailCount, 3),
              verdict: fin.qaVerdict!,
              findings: fin.qaFindings,
            },
          });
        });
        lastQaCheckedAt = fin.qaCheckedAt;
      };

      if (limitless && plan.role === 'builder') {
        const cleanHandoff =
          fin.sessionSucceeded &&
          fin.phase === '08-qa' &&
          fin.readyForQa &&
          fin.qaEvidenceReady &&
          fin.checksValid &&
          fin.failingChecks === 0 &&
          !fin.missionDone &&
          fin.qaVerdict === null;
        if (!cleanHandoff) {
          exit = 'builder-contract-violation';
          break;
        }
      } else if (limitless) {
        const changedNonQa = fin.reviewerChanges.filter((path) => !isAllowedReviewerPath(path));
        const checkedAtMs = parseCanonicalIsoTimestamp(fin.qaCheckedAt);
        const startedAtMs = Date.parse(plan.startedAt);
        const finalizedAtMs = Date.parse(fin.finalizedAt);
        const freshVerdict =
          fin.qaCheckedAt !== null &&
          fin.qaCheckedAt !== plan.qaCheckedAtBefore &&
          checkedAtMs !== null &&
          Number.isFinite(startedAtMs) &&
          Number.isFinite(finalizedAtMs) &&
          checkedAtMs >= startedAtMs - QA_CLOCK_TOLERANCE_MS &&
          checkedAtMs <= finalizedAtMs + QA_CLOCK_TOLERANCE_MS;
        const hasFreshReviewerEvidence =
          init.artifactKind !== 'solution' ||
          fin.reviewerChanges.some(
            (path) => path.startsWith(REVIEWER_SCREENSHOT_PREFIX) && path.length > REVIEWER_SCREENSHOT_PREFIX.length
          );
        const consistentVerdict =
          (fin.qaVerdict === 'PASS' &&
            !fin.hasCriticalQaFinding &&
            fin.missionDone &&
            fin.checksValid &&
            fin.failingChecks === 0 &&
            fin.visualFailing === 0) ||
          (fin.qaVerdict === 'FAIL' && fin.phase === '08-qa' && !fin.missionDone && fin.checksValid);
        const workspaceUnchanged = reviewerSnapshotsEqual(
          plan.reviewerWorkspaceSnapshotBefore,
          fin.reviewedWorkspaceSnapshot
        );
        if (
          !fin.sessionSucceeded ||
          !fin.reviewedGitHead ||
          !workspaceUnchanged ||
          changedNonQa.length > 0 ||
          !freshVerdict ||
          !hasFreshReviewerEvidence ||
          !consistentVerdict
        ) {
          log.warn('Limitless reviewer contract rejected', {
            missionId,
            session: sessionIndex,
            changedNonQa,
            phase: fin.phase,
            qa: fin.qaVerdict,
            checksValid: fin.checksValid,
            hasCriticalFinding: fin.hasCriticalQaFinding,
            hasFreshReviewerEvidence,
            workspaceUnchanged,
          });
          exit = 'reviewer-contract-violation';
          break;
        }
        await persistQa();
        if (fin.qaVerdict === 'PASS') {
          acceptedReviewerGitHead = fin.reviewedGitHead;
          acceptedReviewerResidualChanges = [...fin.reviewerResidualChanges].sort();
          acceptedReviewerWorkspaceSnapshot = fin.reviewedWorkspaceSnapshot;
          acceptedReviewerSessionIndex = sessionIndex;
        }
        exit = fin.qaVerdict === 'PASS' ? 'qa-pass' : 'qa-failed';
        break;
      } else if (fin.qaVerdict && fin.qaCheckedAt !== lastQaCheckedAt) {
        await persistQa();
      }

      // 4e. Mission finished?
      if (fin.missionDone) {
        if (
          fin.sessionSucceeded &&
          fin.qaVerdict === 'PASS' &&
          fin.checksValid &&
          fin.failingChecks === 0 &&
          fin.visualFailing === 0
        ) {
          exit = 'qa-pass';
          break;
        }
        // STATUS claims done but verification disagrees — treat as stall-grade.
        log.warn('STATUS=done but verification failed', {
          missionId,
          qa: fin.qaVerdict,
          failing: fin.failingChecks,
          visualFailing: fin.visualFailing,
        });
      }

      // 4f. QA attempts exhausted?
      if (fin.qaVerdict === 'FAIL' && fin.qaFailCount > cfg.qaMaxAttempts + 1) {
        exit = 'qa-attempts-exhausted';
        break;
      }

      // 4g. Budget gate.
      // AUDIT-016 — do not open a gate we are forbidden to resolve. Once the cap
      // has reached the cumulative ceiling, no top-up can raise it; asking anyway
      // would re-open this gate on every loop and park the run at `waitForEvent`
      // for `gates.timeoutHours` before auto-denying. Exit terminally instead.
      if (spentUsd >= capUsd && capUsd >= getBuildMissionHardCapUsd()) {
        exit = 'budget-exhausted';
        break;
      }
      if (spentUsd >= capUsd && n < sess.max - 1) {
        await step.run(`session-${n}-budget-gate-request`, async () => {
          await appendBuildGate(missionId, { gate: 'budget', requestedAt: new Date().toISOString() });
          await updateMission(missionId, { buildState: 'awaiting-budget' });
          await emitAgentEvent({
            type: 'agent.thinking',
            userId,
            agentType: 'builder',
            missionId,
            data: { missionId, kind: 'build', gate: 'budget', spentUsd, capUsd },
          });
        });
        const resolved = await step.waitForEvent(`wait-budget-${n}`, {
          event: 'app/build-mission.gate.resolved',
          if: `async.data.missionId == "${missionId}" && async.data.gate == "budget"`,
          timeout: `${cfg.gates.timeoutHours}h`,
        });
        const decision = (resolved?.data as { decision?: string; topUpUsd?: number } | undefined) ?? null;
        if (!decision || decision.decision !== 'approve') {
          await step.run(`session-${n}-budget-deny`, async () => {
            const sandbox = await importSandbox();
            await stopAndVerifyRuntime(
              sandbox.getDriver(cfg.driver),
              provisioned.ref,
              `Build mission ${missionId} budget denial`
            );
            const stoppedMission = await getMissionById(missionId);
            const completedAt = new Date().toISOString();
            const failure = decision ? 'budget top-up denied' : 'budget gate timed out';
            const completedRecovery = completeActiveRecoveryAttempt(stoppedMission, {
              reason: 'budget-exhausted',
              completedAt,
              failure,
            });
            await updateMission(missionId, {
              status: 'failed',
              buildState: 'paused',
              completedAt,
              errors: [failure],
              ...(stoppedMission?.sandbox ? { sandbox: { ...stoppedMission.sandbox, state: 'stopped' as const } } : {}),
              ...(completedRecovery ? { recovery: completedRecovery } : {}),
            });
            await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
          });
          return finalizeBuildRun(
            'budget-denied',
            { spentUsd, sessions: sessionSummaries.length },
            {
              spentUsd,
              sessions: sessionSummaries.length,
              summary: `Build stopped at a budget gate after ${sessionSummaries.length} session(s); $${spentUsd.toFixed(2)} spent.`,
              errors: [decision ? 'budget top-up denied' : 'budget gate timed out'],
            }
          );
        }
        // AUDIT-016: a human may approve any top-up the route accepts, but the
        // ceiling still binds. Clamp, and record the amount ACTUALLY granted —
        // the ledger used to store the amount *requested*, so after any clamp
        // `initialCap + Σ topUps` no longer equalled `capUsd`.
        const capBeforeTopUp = capUsd;
        capUsd = clampCapUsd(capUsd + (decision.topUpUsd ?? 0));
        const grantedUsd = capUsd - capBeforeTopUp;
        await step.run(`session-${n}-budget-approve`, async () => {
          const mission = await getMissionById(missionId);
          await updateMission(missionId, {
            buildState: 'session-running',
            budget: {
              capUsd,
              warnThreshold: cfg.budget.warnThreshold,
              topUps: [
                ...(mission?.budget?.topUps ?? []),
                { amountUsd: grantedUsd, grantedAt: new Date().toISOString(), grantedBy: userId },
              ],
            },
          });
        });
      }

      // 4h. Stall: escalate on N identical failure fingerprints, human gate after.
      const streak = stallStreak(sessionSummaries.filter((s) => s.failingChecksHash !== undefined));
      if (streak >= cfg.stall.pauseAfter) {
        await step.run(`session-${n}-stall-gate-request`, async () => {
          await appendBuildGate(missionId, { gate: 'stall', requestedAt: new Date().toISOString() });
          await updateMission(missionId, { buildState: 'awaiting-stall' });
        });
        const resolved = await step.waitForEvent(`wait-stall-${n}`, {
          event: 'app/build-mission.gate.resolved',
          if: `async.data.missionId == "${missionId}" && async.data.gate == "stall"`,
          timeout: `${cfg.gates.timeoutHours}h`,
        });
        const decision = (resolved?.data as { decision?: string } | undefined) ?? null;
        if (!decision || decision.decision !== 'approve') {
          await step.run(`session-${n}-stall-deny`, async () => {
            const sandbox = await importSandbox();
            await stopAndVerifyRuntime(
              sandbox.getDriver(cfg.driver),
              provisioned.ref,
              `Build mission ${missionId} stall denial`
            );
            const stoppedMission = await getMissionById(missionId);
            const completedAt = new Date().toISOString();
            const failure = decision ? 'stall gate denied' : 'stall gate timed out';
            const completedRecovery = completeActiveRecoveryAttempt(stoppedMission, {
              reason: 'runtime-failure',
              completedAt,
              failure,
            });
            await updateMission(missionId, {
              status: 'failed',
              buildState: 'paused',
              completedAt,
              errors: [failure],
              ...(stoppedMission?.sandbox ? { sandbox: { ...stoppedMission.sandbox, state: 'stopped' as const } } : {}),
              ...(completedRecovery ? { recovery: completedRecovery } : {}),
            });
            await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
          });
          return finalizeBuildRun(
            'stall-denied',
            { spentUsd, sessions: sessionSummaries.length },
            {
              spentUsd,
              sessions: sessionSummaries.length,
              summary: `Build stopped at a stall gate after ${sessionSummaries.length} session(s); $${spentUsd.toFixed(2)} spent.`,
            }
          );
        }
        escalated = true; // human said continue — use the escalation model
      } else if (streak >= cfg.stall.escalateAfter) {
        escalated = true;
      } else if (fin.failingChecksHash === null) {
        escalated = false;
      }
    }

    // ── 5. Terminal without QA pass → fail honestly. ────────────────────
    if (exit !== 'qa-pass') {
      await step.run('fail-without-pass', async () => {
        const sandbox = await importSandbox();
        const driver = sandbox.getDriver(cfg.driver);
        const statusObservation = await sandbox.readStatusObservation(driver, provisioned.ref);
        const missionBeforeStop = await getMissionById(missionId);
        const statusTruth = statusObservationUpdate(statusObservation, missionBeforeStop);
        const gitHead = await sandbox.readWorkspaceGitHead(driver, provisioned.ref);
        const processTelemetry = driver.processTelemetry ? await driver.processTelemetry(provisioned.ref) : undefined;
        await stopAndVerifyRuntime(driver, provisioned.ref, `Build mission ${missionId} terminal failure`);
        const reason = exit ?? 'caps-exhausted';
        // Lead with the concrete session error when we have one (the real
        // cause — e.g. a 404 model id), then the exit summary for context.
        // Otherwise just the exit summary. Bound the detail (session error text
        // is normally short, but the source is the model — never trust length).
        const detail = (fatalError ?? lastSessionError)?.slice(0, 2000);
        const errors = detail ? [detail, EXIT_MESSAGES[reason]] : [EXIT_MESSAGES[reason]];
        const completedAt = new Date().toISOString();
        const recovery = missionBeforeStop?.recovery;
        const terminalReason = recoveryReasonForExit(reason);
        const terminalEvidence = lastTerminal?.evidence;
        const completedRecovery = recovery
          ? {
              terminal: {
                reason: terminalReason,
                recordedAt: completedAt,
                phase: statusTruth.update.buildPhase ?? missionBeforeStop?.buildPhase ?? '00-inception',
                statusObservedAt: statusObservation.attemptedAt,
                ...(gitHead ? { gitHead } : {}),
                ...(terminalEvidence?.observedTurns !== null && terminalEvidence?.observedTurns !== undefined
                  ? { turnsUsed: terminalEvidence.observedTurns }
                  : {}),
                ...(terminalEvidence?.launchedMaxTurns !== null && terminalEvidence?.launchedMaxTurns !== undefined
                  ? { maxTurns: terminalEvidence.launchedMaxTurns }
                  : {}),
                reviewerReserveUsd: sess.reviewerMaxCostUsd,
                ...(terminalEvidence?.subtype ? { rawExitSubtype: terminalEvidence.subtype } : {}),
                ...(terminalEvidence?.resultExcerpt ? { resultExcerpt: terminalEvidence.resultExcerpt } : {}),
                ...(terminalEvidence?.apiStatus !== null && terminalEvidence?.apiStatus !== undefined
                  ? { apiErrorStatus: terminalEvidence.apiStatus }
                  : {}),
                ...(terminalEvidence?.exitCode !== null && terminalEvidence?.exitCode !== undefined
                  ? { exitCode: terminalEvidence.exitCode }
                  : {}),
                statusHealth: statusObservation.health,
                ...(statusTruth.update.buildStatusLastValidPhase
                  ? { lastValidPhase: statusTruth.update.buildStatusLastValidPhase }
                  : {}),
                statusAttemptedAt: statusObservation.attemptedAt,
                ...(statusObservation.digest ? { statusDigest: statusObservation.digest } : {}),
              },
              ...(recovery.authorizedMaxTurns ? { authorizedMaxTurns: recovery.authorizedMaxTurns } : {}),
              attempts: recovery.attempts.map((attempt) =>
                attempt.id === recovery.activeOperationId
                  ? { ...attempt, status: 'completed' as const, completedAt, failure: errors[0]?.slice(0, 1000) }
                  : attempt
              ),
            }
          : {
              terminal: {
                reason: terminalReason,
                recordedAt: completedAt,
                phase: statusTruth.update.buildPhase ?? missionBeforeStop?.buildPhase ?? '00-inception',
                statusObservedAt: statusObservation.attemptedAt,
                ...(gitHead ? { gitHead } : {}),
                reviewerReserveUsd: sess.reviewerMaxCostUsd,
                statusHealth: statusObservation.health,
                statusAttemptedAt: statusObservation.attemptedAt,
                ...(statusObservation.digest ? { statusDigest: statusObservation.digest } : {}),
              },
              attempts: [],
            };
        await updateMission(missionId, {
          ...statusTruth.update,
          status: 'failed',
          buildState: 'paused',
          completedAt,
          errors,
          recovery: completedRecovery,
          ...(missionBeforeStop?.sandbox
            ? {
                sandbox: {
                  ...missionBeforeStop.sandbox,
                  state: 'stopped' as const,
                  ...(processTelemetry ? { processTelemetry: { ...processTelemetry, observedAt: completedAt } } : {}),
                },
              }
            : {}),
        });
        await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
        await emitAgentEvent({
          type: 'agent.error',
          userId,
          agentType: 'builder',
          missionId,
          data: { missionId, kind: 'build', reason, spentUsd },
        });
      });
      return finalizeBuildRun(
        exit ?? 'caps-exhausted',
        { spentUsd, sessions: sessionSummaries.length },
        {
          spentUsd,
          sessions: sessionSummaries.length,
          summary: `Build ended without publishing (${exit ?? 'caps-exhausted'}) after ${sessionSummaries.length} session(s); $${spentUsd.toFixed(2)} spent.`,
        }
      );
    }

    // ── 6. Publish (NO human gate here). Budget/stall/QA gates already ran;
    //    the only post-run human gate is the Assessment triage lane (or
    //    autopilot). A green run auto-publishes the deliverable; every
    //    system-of-record change is proposed for triage. Publish branches by
    //    artifactKind: solution → Prototype; evaluation/architecture/report →
    //    a verdict Document (+ for evaluation, a proposed Assessment).
    const published = await step.run('publish-artifact', async () => {
      const sandbox = await importSandbox();
      const driver = sandbox.getDriver(cfg.driver);
      let ref = provisioned.ref;
      const mission = await getMissionById(missionId);
      const artifactKind = mission?.artifactKind ?? 'solution';
      const title = mission?.prompt.match(/^#\s*Mission:\s*(.+)$/m)?.[1]?.trim() ?? `Build mission ${missionId}`;
      const motivation = mission?.motivation;
      const previewUrl = `http://localhost:${provisioned.hostPort}`;
      const hasMotivation = hasArtifactMotivation(motivation);

      const stoppedSandbox = () => ({
        driver: ref.driver,
        image: ref.image,
        containerName: ref.containerName,
        volumeName: ref.volumeName,
        hostPort: ref.hostPort,
        workspacePath: ref.workspacePath,
        state: 'stopped' as const,
        createdAt: mission?.sandbox?.createdAt ?? new Date().toISOString(),
      });

      // A retry may resume after the document + findings were persisted but
      // before the credential-bearing runtime was durably recorded as stopped.
      // Do not re-read the stopped container or duplicate graph side effects;
      // finish the outstanding cleanup idempotently.
      if (artifactKind !== 'solution' && mission?.buildPhase === 'published' && mission.artifact?.documentId) {
        await stopAndVerifyRuntime(driver, ref, `Build mission ${missionId} publish recovery`);
        await updateMission(missionId, { sandbox: stoppedSandbox() });
        return {
          outputId: mission.artifact.documentId,
          previewUrl: mission.artifact.previewUrl ?? previewUrl,
          kind: artifactKind as 'evaluation' | 'architecture' | 'report',
        };
      }

      // Artifact harvesting and preview launch must never share a runtime with
      // an agent/provider credential. Destroying the credential runtime also
      // kills detached/setsid children that could otherwise race the accepted
      // snapshot and rewrite a non-solution verdict after QA.
      const recreated = await sandbox.recreateSandboxRuntime({
        cfg,
        missionId,
        driver,
        ref,
        hostPort: provisioned.hostPort,
        artifactKind,
        purpose: 'preview',
      });
      ref = recreated.ref;
      for (const warning of recreated.warnings) {
        log.warn('publish runtime recreation warning', { missionId, artifactKind, warning });
      }

      const assertAcceptedReviewerWorkspace = async () => {
        if (!limitless) return;
        const currentGitHead = await sandbox.readWorkspaceGitHead(driver, ref);
        const currentChanges = acceptedReviewerGitHead
          ? [...(await sandbox.listWorkspaceChangesSince(driver, ref, acceptedReviewerGitHead))].sort()
          : null;
        const currentSnapshot =
          acceptedReviewerSessionIndex !== null
            ? await sandbox.captureReviewerWorkspaceSnapshot(driver, ref, acceptedReviewerSessionIndex)
            : null;
        if (
          !acceptedReviewerGitHead ||
          !acceptedReviewerResidualChanges ||
          !acceptedReviewerWorkspaceSnapshot ||
          currentGitHead !== acceptedReviewerGitHead ||
          JSON.stringify(currentChanges) !== JSON.stringify(acceptedReviewerResidualChanges) ||
          !reviewerSnapshotsEqual(currentSnapshot, acceptedReviewerWorkspaceSnapshot)
        ) {
          throw new Error(
            `Refusing to publish ${missionId}: workspace generation or worktree no longer matches the accepted fresh review`
          );
        }
      };
      await assertAcceptedReviewerWorkspace();
      const acceptedReview =
        limitless &&
        acceptedReviewerGitHead &&
        acceptedReviewerResidualChanges &&
        acceptedReviewerWorkspaceSnapshot &&
        acceptedReviewerSessionIndex !== null
          ? {
              gitHead: acceptedReviewerGitHead,
              residualChanges: acceptedReviewerResidualChanges,
              workspaceSnapshot: acceptedReviewerWorkspaceSnapshot,
              sessionIndex: acceptedReviewerSessionIndex,
            }
          : undefined;
      if (limitless && !acceptedReview) {
        throw new Error(`Refusing to publish ${missionId}: accepted reviewer evidence is incomplete`);
      }

      // ── solution → a Prototype (the only kind that IS a prototype) ──
      if (artifactKind === 'solution') {
        // This is trusted supervisor orchestration after QA. Do not use a
        // login shell: mission code can write the container user's profile on
        // an earlier turn and thereby replace PATH commands or mutate the
        // reviewed workspace before preview launch.
        // Run the preview from a container-layer copy of the exact accepted
        // workspace. Dev servers may write generated caches; keeping those
        // writes off the persisted volume makes the post-readiness integrity
        // comparison meaningful and preserves the reviewed source snapshot.
        await launchReviewedPreview({
          driver,
          ref,
          buildSanitizedShellCommand: sandbox.buildSanitizedShellCommand,
          retainedWorkspacePath: ref.workspacePath,
          containerPort: cfg.containerPort,
          forbiddenValues: sandbox.resolveContainerSecretValues(
            cfg,
            process.env,
            sandbox.platformServersFor(cfg, artifactKind)
          ),
        });
        const { waitForPreviewReady } = await import('@/lib/build-preview-readiness');
        if (!(await waitForPreviewReady(previewUrl))) {
          throw new Error(`Preview failed readiness checks at ${previewUrl}; artifact was not published`);
        }
        // npm lifecycle scripts are part of the reviewed project and can run a
        // builder-authored predev hook. Recheck after readiness so a hook that
        // commits or edits product files cannot mutate the accepted generation
        // and still receive a Demo Ready publication.
        await assertAcceptedReviewerWorkspace();
        const { adminCreateEntity, adminGetEntityByField, adminUpdateEntity } =
          await import('@/lib/entity-factory-admin');
        const prototypeData = {
          name: title.slice(0, 120),
          description: `Autonomously built prototype (mission ${missionId}). QA verdict: PASS. Spend: $${spentUsd.toFixed(2)}.`,
          status: 'Demo Ready',
          linkedTechnologies: motivation?.sourceTechnologyId ? [motivation.sourceTechnologyId] : [],
          linkedCompanies: [],
          linkedUseCases: motivation?.useCaseIds ?? [],
          linkedStrategies: motivation?.strategyIds ?? [],
          targetBusinessUnit: '',
          presentedTo: [],
          team: ['build-mission'],
          artifacts: { demoUrl: previewUrl, presentations: [] },
          impact: {
            type: 'Business Transformation',
            estimatedValue: 0,
            timeToImpact: 'TBD',
            confidence: 0,
            notes: 'Auto-published by a build mission — impact not yet assessed.',
          },
          costs: { actual: spentUsd / 1000, currency: 'USD' }, // costs are in $k
          missionId,
          previewUrl,
          source: 'build-mission',
        };
        // Identity is the MISSION, not the title-slug. A re-publish / Iterate of
        // THIS mission updates its own prototype; two distinct missions that happen
        // to share a title must NOT clobber each other. The old `{ upsert: true }`
        // keyed on slug and silently overwrote the first mission's prototype
        // (its missionId, previewUrl, spend) the moment a same-titled mission ran.
        const existingPrototype = await adminGetEntityByField<{ id: string }>('prototype', 'missionId', missionId);
        let prototypeId: string;
        if (existingPrototype) {
          await adminUpdateEntity('prototype', existingPrototype.id, prototypeData);
          prototypeId = existingPrototype.id;
        } else {
          // skipUniquenessCheck: the missionId lookup already guarantees one
          // prototype per mission, so a same-title slug collision with a DIFFERENT
          // mission must mint a distinct doc rather than update theirs. (Prototypes
          // are fetched by id, never by slug, so a duplicate slug is harmless.)
          const created = await adminCreateEntity('prototype', prototypeData, { skipUniquenessCheck: true });
          prototypeId = (created.entity as { id: string }).id;
        }

        let proposedRelations = 0;
        let linkFailed = 0;
        if (hasMotivation) {
          const { connectArtifactToGraph } = await import('@/lib/build-mission-graph');
          const result = await connectArtifactToGraph({
            prototypeId,
            prototypeName: title,
            motivation: motivation!,
            evidenceSummary: `Prototype "${title}" built and QA-passed by mission ${missionId} (spend $${spentUsd.toFixed(2)}, ${sessionSummaries.length} sessions).`,
            missionId,
          });
          proposedRelations = result.proposed;
          linkFailed = result.failed;
        }
        const findings: NonNullable<Mission['findings']> = [
          {
            title: 'QA passed — prototype published',
            detail: `Prototype ${prototypeId} published from mission ${missionId}; ${proposedRelations} graph relation(s) proposed for review.`,
            kind: 'verdict',
            confidence: 100,
          },
        ];
        // Motivation relations connect the published prototype back to the tech /
        // use-cases / strategies it was built for. If any could not be staged, the
        // prototype ships partially disconnected from the graph — surface it as a
        // risk rather than reporting a clean publish. (connectArtifactToGraph never
        // throws on a single failed target; `failed` is how it tells us.)
        if (linkFailed > 0) {
          log.error('prototype motivation links partially FAILED to stage', undefined, {
            missionId,
            prototypeId,
            proposed: proposedRelations,
            failed: linkFailed,
          });
          findings.push({
            title: 'Some prototype graph links FAILED',
            detail: `${linkFailed} of ${proposedRelations + linkFailed} motivation relation(s) for "${title}" could not be staged for review — the prototype is published but partially disconnected from the graph. Stage the missing links from /triage/relations or re-run.`,
            kind: 'risk',
            confidence: 100,
          });
        }
        await updateMission(missionId, {
          buildState: 'publishing',
          artifact: {
            prototypeId,
            previewUrl,
            ...(acceptedReview ? { acceptedReview } : {}),
            publishedAt: new Date().toISOString(),
          },
          buildPhase: 'published',
          findings,
        });
        return { outputId: prototypeId, previewUrl, kind: 'solution' as const };
      }

      // ── evaluation | architecture | report → a verdict Document ──
      type EvalVerdict = {
        trl?: number;
        confidence?: number;
        recommendation?: 'adopt' | 'trial' | 'assess' | 'hold';
        metrics: Array<{ name: string; value: string; command?: string }>;
        findings: Array<{
          title: string;
          detail: string;
          kind: 'verdict' | 'benchmark' | 'risk' | 'observation';
          metric?: string;
          confidence?: number;
        }>;
        summary?: string;
      };
      const verdict =
        artifactKind === 'evaluation' ? ((await sandbox.readVerdict(driver, ref)) as EvalVerdict | null) : null;
      if (artifactKind === 'evaluation' && !verdict) {
        const error =
          `Evaluation ${missionId} passed QA but did not produce a valid .impulse/verdict.json. ` +
          'Publication for this run was rejected before any Document, Assessment, or graph-relation write; ' +
          'the workspace and any prior artifact were preserved for inspection.';
        await stopAndVerifyRuntime(driver, ref, `Build mission ${missionId} invalid evaluation verdict`);
        await updateMission(missionId, {
          status: 'failed',
          buildState: 'paused',
          completedAt: new Date().toISOString(),
          errors: [error],
          sandbox: stoppedSandbox(),
        });
        await emitAgentEvent({
          type: 'agent.error',
          userId,
          agentType: 'builder',
          missionId,
          data: { missionId, kind: 'build', artifactKind, error },
        });
        return {
          rejected: 'evaluation-verdict-missing' as const,
          kind: artifactKind,
        };
      }
      const { adminCreateDocument, adminGetDocumentBySourceRunId, adminUpdateDocument } =
        await import('@/lib/document-admin');
      const summary = verdict?.summary ?? `${artifactKind} artifact produced by build mission ${missionId}.`;
      const docInput = {
        title: title.slice(0, 200),
        type: 'markdown' as const,
        description: summary.slice(0, 4000),
        aiSummary: verdict?.summary?.slice(0, 2000),
        storageUrl: '',
        mimeType: 'text/markdown',
        uploadedBy: 'build-mission',
        tags: ['build-mission', artifactKind, missionId],
        visibility: 'workspace' as const,
        sourceRunId: missionId,
        sourceMissionId: missionId,
        structuredMetrics: (verdict?.metrics ?? []).map((m) => ({ name: m.name, value: m.value, command: m.command })),
      };
      // Idempotent: update the prior doc on re-publish/Iterate, else create.
      const existingDoc = await adminGetDocumentBySourceRunId(missionId);
      let documentId: string;
      if (existingDoc) {
        await adminUpdateDocument(existingDoc.id, docInput);
        documentId = existingDoc.id;
      } else {
        documentId = (await adminCreateDocument(docInput)).id;
      }

      const findings: NonNullable<Mission['findings']> = [];
      let assessmentId: string | undefined;

      const publishChannel = resolveEvaluationPublishChannel(artifactKind, motivation);
      if (publishChannel === 'assessment') {
        const technologyId = motivation!.sourceTechnologyId!;
        // verdict → findings (kept on the mission for getArtifactFindings)
        if (verdict) {
          if (verdict.trl !== undefined) {
            findings.push({
              title: `Proposed TRL ${verdict.trl}${verdict.recommendation ? ` — ${verdict.recommendation}` : ''} (hands-on)`,
              detail: `${verdict.summary || 'Evaluation verdict.'} Review and apply in /triage/assessment.`,
              kind: 'verdict',
              ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
            });
          }
          for (const m of verdict.metrics.slice(0, 10)) {
            findings.push({
              title: m.name,
              detail: m.command ? `Measured via: ${m.command}` : 'Benchmark metric.',
              kind: 'benchmark',
              metric: m.value.slice(0, 120),
            });
          }
          for (const f of verdict.findings.slice(0, 15)) {
            findings.push({
              title: f.title.slice(0, 200),
              detail: f.detail.slice(0, 2000),
              kind: f.kind,
              ...(f.metric ? { metric: f.metric.slice(0, 120) } : {}),
              ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
            });
          }
        } else {
          findings.push({
            title: 'Evaluation completed without a structured verdict',
            detail: `No .impulse/verdict.json was produced by mission ${missionId}.`,
            kind: 'observation',
          });
        }

        // Propose the Assessment (TRL/recommendation → radar ring) + an
        // `evaluates` relation (Document → Technology). All human-triaged.
        const { createProposedAssessmentIfNotExists } = await import('@/lib/proposed-assessments-admin');
        const { resolveRadarTarget, canAutopilotApplyAssessment } = await import('@/lib/build-mission-radar-target');
        const { RING_BY_RECOMMENDATION } = await import('@/lib/schemas/proposed-assessment');
        const { connectArtifactToGraph } = await import('@/lib/build-mission-graph');

        const recommendation = verdict?.recommendation ?? 'assess';
        const confidence = verdict?.confidence ?? 0;
        const target = await resolveRadarTarget(technologyId);
        const assessmentResult = await createProposedAssessmentIfNotExists({
          technologyId,
          recommendation,
          trl: verdict?.trl,
          confidence,
          evidence: {
            metrics: verdict?.metrics ?? [],
            findings: (verdict?.findings ?? []).map((f) => ({
              title: f.title,
              detail: f.detail,
              kind: f.kind,
              confidence: f.confidence,
            })),
          },
          proposedRing: RING_BY_RECOMMENDATION[recommendation],
          radarId: target.radarId,
          quadrantId: target.quadrantId,
          sourceRunId: missionId,
          sourceDocumentId: documentId,
        });
        assessmentId = assessmentResult.assessment.id;

        const rel = await connectArtifactToGraph({
          prototypeId: documentId,
          prototypeName: title,
          artifactType: 'document',
          motivation: { sourceTechnologyId: technologyId, useCaseIds: [], painPointIds: [], strategyIds: [] },
          predicateOverride: { technology: 'evaluates' },
          evidenceSummary: `Evaluation of "${title}" by build mission ${missionId}.`,
          missionId,
          confidence: confidence || 80,
        });

        // The evaluates→technology link is this assessment's graph footprint. If it
        // failed to stage, the verdict is orphaned (no /triage/relations entry) and
        // autopilot below has nothing to approve — surface it loudly rather than
        // completing as if the technology were linked.
        if (rel.failed > 0) {
          log.error('evaluation verdict could NOT be linked to its technology (orphaned)', undefined, {
            missionId,
            technologyId,
            failed: rel.failed,
          });
          findings.push({
            title: 'Verdict graph-link FAILED',
            detail: `The evaluation completed but its evaluates→technology relation could not be staged — the verdict is NOT in /triage/relations and autopilot cannot apply it. Re-run or stage the link manually.`,
            kind: 'risk',
            confidence: 100,
          });
        }

        // Autopilot: auto-apply ONLY when confidence ≥ threshold, and only the
        // proposals newly created this run (re-publish never re-applies).
        if (config.flags.buildAutopilotEnabled && confidence >= config.thresholds.buildAssessmentAutoApprove) {
          let assessmentOutcome = assessmentResult.created ? 'not-attempted' : 'not-created';
          let relationsApproved = 0;
          try {
            const { approveProposedAssessmentWithRequiredPlacement } = await import('@/lib/proposed-assessments-admin');
            const { approveProposedRelationAsMachine } = await import('@/lib/proposed-relations-admin');
            // BUILD-006: an autopilot application is a MACHINE outcome, not human
            // evidence. It is deliberately NOT recorded into the owner's
            // InterestProfile posterior (`recordProposalFeedback` writes 'acted'
            // human labels) — doing so poisoned the human-preference signal with
            // the system's own decisions. Machine telemetry stays out of the human
            // labels for BOTH the assessment and the relations below.
            if (assessmentResult.created && canAutopilotApplyAssessment(target)) {
              // requirePlacement: the machine may only claim the verdict when the
              // radar placement actually lands. approve swallows placement-create
              // failures (tech-missing / duplicate races); without this it would
              // still mark the verdict `approved` with no blip. On failure it
              // leaves the assessment `pending` for human triage instead.
              assessmentOutcome = 'attempting';
              const approval = await approveProposedAssessmentWithRequiredPlacement(
                assessmentId,
                'assessment-autopilot',
                {
                  radarId: target.radarId,
                  quadrantId: target.quadrantId,
                },
                userId
              );
              assessmentOutcome = approval.applied
                ? 'applied'
                : approval.reason === 'already-approved-without-placement'
                  ? 'approved-without-placement'
                  : `deferred:${approval.reason}`;
              if (!approval.applied) {
                const remainsPending = approval.assessment.status === 'pending';
                log.warn('autopilot could not apply the assessment placement', {
                  missionId,
                  assessmentId,
                  reason: approval.reason,
                  assessmentStatus: approval.assessment.status,
                });
                findings.push({
                  title: 'Autopilot placement not applied',
                  detail: remainsPending
                    ? `Evaluation of "${title}" met the autopilot bar but the radar placement did not land (${approval.reason}); it was left for human triage. Approve it from /triage/assessment.`
                    : `Evaluation of "${title}" was already approved without a radar placement; autopilot did not rewrite that human verdict. Review its radar placement manually.`,
                  kind: 'risk',
                  confidence: confidence || 0,
                });
              }
            } else if (assessmentResult.created) {
              // No radar target resolved (default config: no BUILD_DEFAULT_RADAR_ID
              // and not exactly one radar). Leave the assessment `proposed` for
              // human triage rather than approving it into a phantom placement and
              // recording false "approved" learning.
              log.info('autopilot deferred assessment — no radar target resolved; left proposed for human triage', {
                missionId,
                assessmentId,
              });
              assessmentOutcome = 'deferred:target-unresolved';
            }
            // Relations approved by autopilot are MACHINE actions too — pass NO
            // feedbackUserId, so `recordRelationTriageFeedback` (keyed on
            // feedbackUserId) records nothing into the human InterestProfile.
            const machineRelationFloor = machineRelationAutoApprovalThreshold(
              getDiscoveryConfig().asserterReliabilityEnabled
            );
            if (confidence >= machineRelationFloor) {
              for (const pid of rel.proposedIds) {
                const relationApproval = await approveProposedRelationAsMachine(pid, 'assessment-autopilot');
                if (relationApproval.applied) relationsApproved += 1;
              }
            } else if (rel.proposedIds.length > 0) {
              log.info('autopilot retained sub-threshold relations for human triage', {
                missionId,
                confidence,
                threshold: machineRelationFloor,
                relationsDeferred: rel.proposedIds.length,
              });
            }
            // Honest telemetry — report the actual machine outcome; never claim an
            // unconditional "applied" when the placement was deferred or failed.
            log.info('autopilot outcome', {
              missionId,
              confidence,
              assessmentOutcome,
              relationsApproved,
              relationsDeferred: rel.proposedIds.length - relationsApproved,
              relationsTotal: rel.proposedIds.length,
            });
          } catch (error) {
            log.warn('autopilot apply incomplete', {
              missionId,
              assessmentOutcome,
              relationsApproved,
              relationsDeferred: rel.proposedIds.length - relationsApproved,
              relationsTotal: rel.proposedIds.length,
              error: error instanceof Error ? error.message : String(error),
            });
            findings.push({
              title: 'Autopilot graph application incomplete',
              detail: `Assessment outcome: ${assessmentOutcome}; approved ${relationsApproved} of ${rel.proposedIds.length} proposed relations. Review the remaining items in triage.`,
              kind: 'risk',
              confidence: confidence || 0,
            });
          }
        }
      } else if (publishChannel === 'entity') {
        // A non-technology evaluation (e.g. useCase) stages an `evaluates` relation,
        // Document → the EXISTING evaluated entity (motivation.sourceEntityId) — mirroring
        // the technology path's Document→Technology link rather than minting a phantom
        // net-new entity. The verdict body lives in the published Document + the run
        // findings; the relation links it to the real entity and surfaces in
        // /triage/relations. Stays PENDING for human review (no auto-apply).
        const evaluatedType = motivation!.entityType!;
        findings.push({
          title: `${evaluatedType} evaluation completed`,
          detail: `Evaluation of "${title}" by build mission ${missionId} — review the link in /triage/relations.`,
          kind: 'verdict',
          confidence: verdict?.confidence ?? 0,
        });
        const { connectArtifactToGraph } = await import('@/lib/build-mission-graph');
        const rel = await connectArtifactToGraph({
          prototypeId: documentId,
          prototypeName: title,
          artifactType: 'document',
          motivation: motivation!,
          predicateOverride: { [evaluatedType]: 'evaluates' } as Partial<Record<EntityType, RelationType>>,
          evidenceSummary: `Evaluation of "${title}" by build mission ${missionId}.`,
          missionId,
          // Honest confidence: an absent verdict defaults to 80 (the doc was published),
          // but an explicit verdict.confidence (incl. 0) is preserved — never coerce a
          // "no structured verdict" 0 up to a confident 80.
          confidence: verdict?.confidence ?? 80,
        });
        // The lone `evaluates` relation IS this verdict's entire graph footprint. If it
        // failed to stage, the paid-for verdict is orphaned (no /triage/relations entry,
        // and the sweep will re-dispatch since no pending relation exists) — surface it
        // loudly rather than completing the mission as if the verdict were linked.
        if (rel.failed > 0) {
          log.error('non-tech evaluation verdict could NOT be linked to its entity (orphaned)', undefined, {
            missionId,
            entityType: evaluatedType,
            sourceEntityId: motivation!.sourceEntityId,
          });
          findings.push({
            title: 'Verdict graph-link FAILED',
            detail: `The evaluation completed but its evaluates→${evaluatedType} relation could not be staged — the verdict is NOT in /triage/relations. Re-run or stage the link manually.`,
            kind: 'risk',
            confidence: 100,
          });
        }
      } else {
        // architecture/report (or evaluation lacking a source technology):
        // a Document + proposed motivation relations, no Assessment.
        findings.push({
          title: `${artifactKind} document published`,
          detail: `Document ${documentId} produced by build mission ${missionId}.`,
          kind: 'verdict',
          confidence: 100,
        });
        if (hasMotivation) {
          const { connectArtifactToGraph } = await import('@/lib/build-mission-graph');
          const rel = await connectArtifactToGraph({
            prototypeId: documentId,
            prototypeName: title,
            artifactType: 'document',
            motivation: motivation!,
            evidenceSummary: `${artifactKind} artifact by build mission ${missionId}.`,
            missionId,
          });
          // Motivation relations are this document's only graph footprint. A silent
          // partial failure here would leave the artifact disconnected with no
          // triage entry to recover from — surface it as a risk finding.
          if (rel.failed > 0) {
            log.error('document motivation links partially FAILED to stage', undefined, {
              missionId,
              documentId,
              artifactKind,
              proposed: rel.proposed,
              failed: rel.failed,
            });
            findings.push({
              title: 'Some document graph links FAILED',
              detail: `${rel.failed} of ${rel.proposed + rel.failed} motivation relation(s) for "${title}" could not be staged — the ${artifactKind} is published but partially disconnected from the graph. Stage the missing links from /triage/relations or re-run.`,
              kind: 'risk',
              confidence: 100,
            });
          }
        }
      }

      await updateMission(missionId, {
        buildState: 'publishing',
        artifact: {
          documentId,
          ...(assessmentId ? { assessmentId } : {}),
          previewUrl,
          publishedAt: new Date().toISOString(),
        },
        buildPhase: 'published',
        findings,
      });
      // Non-solution artifacts publish durable Documents, not a live app.
      // Keeping their provider/internal credentials in a running container has
      // no product value, so stop and verify the runtime while retaining the
      // volume for harvest/debugging. The retry branch above closes a narrow
      // artifact-written/runtime-state-write failure window.
      await stopAndVerifyRuntime(driver, ref, `Build mission ${missionId} publish cleanup`);
      await updateMission(missionId, { sandbox: stoppedSandbox() });
      return { outputId: documentId, previewUrl, kind: artifactKind as 'evaluation' | 'architecture' | 'report' };
    });

    if ('rejected' in published) {
      return finalizeBuildRun(
        published.rejected,
        { spentUsd, sessions: sessionSummaries.length },
        {
          spentUsd,
          sessions: sessionSummaries.length,
          summary: `Build passed QA but publication was rejected (${published.rejected}); $${spentUsd.toFixed(2)} spent across ${sessionSummaries.length} session(s).`,
        }
      );
    }

    // ── 7. Finalize. ─────────────────────────────────────────────────────
    const isProto = published.kind === 'solution';
    await step.run('finalize', async () => {
      const completedAt = new Date().toISOString();
      const mission = await getMissionById(missionId);
      const recovery = mission?.recovery;
      const completedRecovery = recovery
        ? {
            terminal: recovery.terminal,
            ...(recovery.authorizedMaxTurns ? { authorizedMaxTurns: recovery.authorizedMaxTurns } : {}),
            attempts: recovery.attempts.map((attempt) =>
              attempt.id === recovery.activeOperationId
                ? { ...attempt, status: 'completed' as const, completedAt }
                : attempt
            ),
          }
        : undefined;
      await updateMission(missionId, {
        status: 'completed',
        progress: 100,
        completedAt,
        ...(completedRecovery ? { recovery: completedRecovery } : {}),
        result: `${isProto ? 'Prototype' : 'Document'} published: ${published.previewUrl} (entity ${published.outputId}). Total spend $${spentUsd.toFixed(2)} across ${sessionSummaries.length} sessions.`,
      });
      await reconcileBuildMissionCostAccounting(missionId, { state: 'terminal', observedAt: completedAt });
      await emitAgentEvent({
        type: 'agent.completed',
        userId,
        agentType: 'builder',
        missionId,
        data: {
          missionId,
          kind: 'build',
          artifactKind: published.kind,
          ...(isProto ? { prototypeId: published.outputId } : { documentId: published.outputId }),
          previewUrl: published.previewUrl,
          spentUsd,
        },
      });
      await inngest.send({
        name: 'app/build-mission.completed',
        data: {
          missionId,
          userId,
          ...(isProto ? { prototypeId: published.outputId } : { documentId: published.outputId }),
        },
      });
    });

    return finalizeBuildRun(
      'published',
      { spentUsd, sessions: sessionSummaries.length, outputId: published.outputId },
      {
        spentUsd,
        sessions: sessionSummaries.length,
        outputId: published.outputId,
        summary: `${isProto ? 'Prototype' : 'Document'} published (${published.outputId}); $${spentUsd.toFixed(2)} spent across ${sessionSummaries.length} session(s).`,
      }
    );
  }
);
