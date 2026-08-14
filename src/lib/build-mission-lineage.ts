/**
 * @file lib/build-mission-lineage.ts
 * @description ARUN-030 — persist a build mission's terminal lineage under the
 * REAL build-runtime identity.
 *
 * ## What was missing
 *
 * A build mission needs a Firestore AgentRun and Neo4j AgentRun, Episode, and
 * AgentReflection under the build identity. Two distinct defects are prevented:
 *
 * 1. *Fabricated identity* — closed by `@/lib/build-runtime-identity` (the schema
 *    no longer defaults a build mission's `agent` to `scout`).
 * 2. *Absent lineage* — `run-build-mission.ts` writes the Mission doc and emits
 *    agent events, but calls neither `createAgentRun` nor `createEpisode`. The
 *    Builds tab renders straight from Mission docs, so nothing surfaced the gap:
 *    a build was visible while having no run history, no episodic memory, and no
 *    reflection.
 *
 * ## The outcome mapping is explicit, not inferred
 *
 * A build ends through one of a dozen named supervisor exits. Rather than guess a
 * business outcome from `Mission.status` (which collapses "a human declined to
 * fund continuation" and "the provider rejected our API key" into one `failed`),
 * `domainOutcomeForBuildExit` maps each exit deliberately — and returns
 * `undefined` for anything unrecognised so a new exit fails closed instead of
 * silently reporting success.
 *
 * ## What is deliberately NOT written
 *
 * No AgentReflection is created when no session ever ran (a preflight refusal, a
 * denied gate before the first launch). The build supervisor has no reflection
 * stage of its own, and there is nothing to reflect on. `isNonAgentRuntime` lets
 * reconciliation report that as *by design* rather than as missing lineage — which
 * is exactly the distinction the row requires it to draw "without fabricating
 * success".
 */

import 'server-only';

import { createLogger } from '@/lib/logger';
import { BUILD_RUNTIME_AGENT_NAME } from '@/lib/build-runtime-identity';
import { agentRunStatusForDomainOutcome, type DomainOutcome } from '@/lib/observability/terminal-outcome';

const log = createLogger('build-mission-lineage');

/**
 * Supervisor exit → canonical business outcome.
 *
 * Grouping rationale (each line is a decision, not a convenience):
 * - `published` is the only delivery.
 * - Exhaustion exits are `partial`: the run made real progress and its workspace
 *   and any prior artifact are RETAINED for inspection, which is materially
 *   different from a build that produced nothing.
 * - The two human gates (`budget-denied`, `stall-denied`) are `cancelled`. Whether
 *   a reviewer actively declined or the gate expired unfunded, the run was stopped
 *   by the governance loop rather than by a defect — reporting it as `failed`
 *   would blame the build for a decision about it.
 * - `fatal-session-error` is `provider-fatal`: the supervisor aborts on the FIRST
 *   non-retryable provider status (400/401/402/403/404), because re-launching
 *   identical sessions can only reproduce it. Retrying is guaranteed useless and
 *   the fix is configuration — a distinction `failed` erases. (The LangChain/Mem0
 *   evals failed this way: 16 instant 404s mislabelled "session cap exhausted".)
 * - QA and contract violations are `failed`: QA is the gate that decides delivery.
 */
const BUILD_EXIT_OUTCOMES: Readonly<Record<string, DomainOutcome>> = {
  published: 'success',
  'qa-pass': 'success',

  'caps-exhausted': 'partial',
  'turns-exhausted': 'partial',
  'budget-exhausted': 'partial',
  'qa-attempts-exhausted': 'partial',
  'qa-budget-insufficient': 'partial',

  'budget-denied': 'cancelled',
  'stall-denied': 'cancelled',
  cancelled: 'cancelled',

  'fatal-session-error': 'provider-fatal',

  'qa-failed': 'failed',
  'builder-contract-violation': 'failed',
  'reviewer-precondition': 'failed',
  'reviewer-contract-violation': 'failed',
  'empty-sessions': 'failed',
  'evaluation-verdict-missing': 'failed',
  'assessment-write-failed': 'failed',
};

/**
 * Map a supervisor exit to a canonical outcome.
 *
 * Returns `undefined` for an unrecognised exit. Callers must then record `failed`
 * explicitly rather than defaulting to success — a new exit that nobody mapped
 * must never be reported as a delivery.
 */
export function domainOutcomeForBuildExit(exit: string | null | undefined): DomainOutcome | undefined {
  if (typeof exit !== 'string' || exit.length === 0) return undefined;
  return BUILD_EXIT_OUTCOMES[exit];
}

/** Every exit this module knows how to classify — used by the coverage test. */
export function knownBuildExits(): string[] {
  return Object.keys(BUILD_EXIT_OUTCOMES);
}

export interface BuildLineageInput {
  missionId: string;
  userId: string;
  /** The supervisor's exit token, verbatim. */
  exit: string;
  outcome: DomainOutcome;
  /** Cumulative provider spend the supervisor observed. */
  spentUsd?: number;
  /** Number of sandbox sessions launched. Zero ⇒ nothing ran ⇒ no reflection. */
  sessions: number;
  /** Durable elapsed time of the whole supervised build. */
  durationMs?: number;
  tokenUsage?: { input: number; output: number };
  /** The prototype/document id, when the run published one. */
  outputId?: string;
  /** Bounded terminal errors to carry onto the run row. */
  errors?: string[];
  /** Human-readable summary for the Episode and the run row's action. */
  summary: string;
}

export interface BuildLineageResult {
  agentRun: 'written' | 'failed';
  episode: 'finalized' | 'failed' | 'unavailable';
  reflection: 'written' | 'not-applicable' | 'failed';
}

/**
 * Persist the full terminal lineage of one build mission.
 *
 * Never throws: lineage is observability, and a graph outage must not fail a build
 * that already published. Every component reports its own result so a caller (and
 * the reconciler) can see exactly what landed instead of assuming all of it did.
 */
export async function persistBuildMissionLineage(input: BuildLineageInput): Promise<BuildLineageResult> {
  const result: BuildLineageResult = { agentRun: 'failed', episode: 'unavailable', reflection: 'not-applicable' };

  // ── Firestore AgentRun ────────────────────────────────────────────────────
  try {
    const { createAgentRun } = await import('@/lib/agent-runs');
    await createAgentRun({
      userId: input.userId,
      missionId: input.missionId,
      // ARUN-030: the REAL runtime, never a research profile that never ran.
      agentName: BUILD_RUNTIME_AGENT_NAME,
      kind: 'mission',
      action: input.summary.slice(0, 500),
      status: agentRunStatusForDomainOutcome(input.outcome),
      // A `partial` outcome also carries the flag the renderer turns into the
      // yellow "Partial" badge, so the coarse status never reads as a clean pass.
      ...(input.outcome === 'partial' ? { partial: true } : {}),
      tokenUsage: input.tokenUsage ?? { input: 0, output: 0 },
      ...(typeof input.spentUsd === 'number' && Number.isFinite(input.spentUsd)
        ? { costUsd: input.spentUsd }
        : { costUnavailableReason: 'accounting-incomplete' as const }),
      // ARUN-008: an unknowable duration renders as "—", never as a fabricated 0.
      duration: input.durationMs ?? 0,
      ...(input.durationMs === undefined ? { durationUnknown: true } : {}),
      ...(input.errors && input.errors.length > 0 ? { errors: input.errors.slice(0, 10) } : {}),
    });
    result.agentRun = 'written';
  } catch (error) {
    log.error(
      'Could not persist the build mission AgentRun',
      error instanceof Error ? error : new Error(String(error)),
      { missionId: input.missionId, exit: input.exit }
    );
  }

  // ── Neo4j Episode ─────────────────────────────────────────────────────────
  // Created and finalized here rather than at build start: the supervisor's
  // long-poll structure has no single early step that owns an Episode, and an
  // Episode opened at start would be left `active` by every path that returns
  // before this one. Creating it terminally means it is never a zombie.
  try {
    const { createEpisode, finalizeMissionEpisode } = await import('@/lib/graph/episodes');
    const episode = await createEpisode({
      agentName: BUILD_RUNTIME_AGENT_NAME,
      missionId: input.missionId,
      userId: input.userId,
      summary: input.summary.slice(0, 500),
    });
    await finalizeMissionEpisode({
      episodeId: episode.id,
      missionId: input.missionId,
      userId: input.userId,
      agentName: BUILD_RUNTIME_AGENT_NAME,
      status: input.outcome === 'success' || input.outcome === 'partial' ? 'completed' : 'failed',
      summary: input.summary.slice(0, 500),
      legacySummary: input.summary.slice(0, 500),
      missionOutcome: input.outcome,
    });
    result.episode = 'finalized';
  } catch (error) {
    // Neo4j is optional at runtime; `graph:health` is the standing detector.
    log.warn('Could not persist the build mission Episode (non-blocking)', {
      missionId: input.missionId,
      error: error instanceof Error ? error.message : String(error),
    });
    result.episode = 'failed';
  }

  // ── Neo4j AgentReflection ─────────────────────────────────────────────────
  // Only when a session actually ran. A build refused before its first launch has
  // nothing to reflect on, and writing a reflection for it would be inventing
  // agent behaviour that never happened.
  if (input.sessions > 0) {
    try {
      const { createReflection } = await import('@/lib/graph/agent-reflections');
      await createReflection({
        agentName: BUILD_RUNTIME_AGENT_NAME,
        missionId: input.missionId,
        learnings: input.summary.slice(0, 1000),
        toolsUsed: [],
        // GRAPH-030: honest for the outcome — never a hardcoded `true`.
        success: input.outcome === 'success' || input.outcome === 'partial',
        outcome: input.outcome,
      });
      result.reflection = 'written';
    } catch (error) {
      log.warn('Could not persist the build mission reflection (non-blocking)', {
        missionId: input.missionId,
        error: error instanceof Error ? error.message : String(error),
      });
      result.reflection = 'failed';
    }
  }

  log.info('Build mission lineage persisted', {
    missionId: input.missionId,
    exit: input.exit,
    outcome: input.outcome,
    ...result,
  });
  return result;
}
