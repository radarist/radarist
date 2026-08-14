/**
 * Pure recovery policy for failed Limitless build missions.
 *
 * Runtime code, API routes, and UI all consume this module so eligibility and
 * terminal-cause wording cannot drift. No Firebase or browser dependencies.
 */
import type { Mission } from '@/lib/schemas/mission';
import type { BuildRecovery, BuildTerminalReason } from '@/lib/schemas/mission-build';

export const DEFAULT_RECOVERY_ADDITIONAL_TURNS = 40;
export const MAX_RECOVERY_ADDITIONAL_TURNS = 160;

export type BuildRecoveryIneligibleCode =
  | 'not-build'
  | 'not-limitless'
  | 'running'
  | 'not-failed'
  | 'published'
  | 'no-sandbox'
  | 'sandbox-reclaimed';

export type BuildRecoveryEligibility =
  | {
      eligible: true;
      terminal: BuildRecovery['terminal'];
      previousMaxTurns: number;
    }
  | { eligible: false; code: BuildRecoveryIneligibleCode; error: string };

function latestCompletedSession(mission: Pick<Mission, 'sessions'>) {
  return [...(mission.sessions ?? [])]
    .filter((session) => session.endedAt)
    .sort((left, right) => right.index - left.index)[0];
}

function inferTerminalReason(mission: Pick<Mission, 'sessions' | 'errors' | 'qaGate'>): BuildTerminalReason {
  const latest = latestCompletedSession(mission);
  if (latest?.exitReason === 'max-turns') return 'turns-exhausted';
  if (latest?.exitReason === 'budget') return 'budget-exhausted';

  const detail = (mission.errors ?? []).join(' ').toLowerCase();
  if (/budget|spend ceiling|headroom/.test(detail)) return 'budget-exhausted';
  if (/cancelled by user/.test(detail)) return 'cancelled';
  if (mission.qaGate?.verdict === 'FAIL' || /review|qa fail|verdict/.test(detail)) return 'review-failure';
  return 'runtime-failure';
}

/** Infer a bounded recovery record for legacy failures that predate BUILD-038. */
export function terminalRecoveryFromMission(mission: Mission, now = new Date().toISOString()): BuildRecovery['terminal'] {
  if (mission.recovery?.terminal) return mission.recovery.terminal;
  const latest = latestCompletedSession(mission);
  return {
    reason: inferTerminalReason(mission),
    recordedAt: mission.completedAt ?? now,
    phase: mission.buildPhase ?? '00-inception',
    ...(mission.buildStatusObservedAt ? { statusObservedAt: mission.buildStatusObservedAt } : {}),
    ...(latest ? { sessionIndex: latest.index } : {}),
    ...(latest?.turns !== undefined ? { turnsUsed: latest.turns } : {}),
    ...(latest?.turns !== undefined && latest.turns > 0 ? { maxTurns: latest.turns } : {}),
  };
}

export function buildRecoveryEligibility(mission: Mission): BuildRecoveryEligibility {
  if (mission.kind !== 'build') return { eligible: false, code: 'not-build', error: 'Only build missions can resume' };
  if (mission.buildMode !== 'limitless') {
    return { eligible: false, code: 'not-limitless', error: 'Recovery is available only for Limitless builds' };
  }
  if (mission.status === 'running' || mission.status === 'pending') {
    return { eligible: false, code: 'running', error: 'The build is already running or queued' };
  }
  if (mission.status !== 'failed') {
    return { eligible: false, code: 'not-failed', error: 'Only a failed unfinished build can resume' };
  }
  if (mission.buildPhase === 'published' || mission.artifact) {
    return { eligible: false, code: 'published', error: 'Published builds cannot use failure recovery' };
  }
  if (!mission.sandbox) {
    return { eligible: false, code: 'no-sandbox', error: 'Mission has no retained sandbox to resume' };
  }
  if (mission.sandbox.state === 'destroyed') {
    return {
      eligible: false,
      code: 'sandbox-reclaimed',
      error: 'The retained workspace was reclaimed; start a new build instead',
    };
  }

  const terminal = terminalRecoveryFromMission(mission);
  return {
    eligible: true,
    terminal,
    previousMaxTurns: terminal.maxTurns ?? DEFAULT_RECOVERY_ADDITIONAL_TURNS,
  };
}

/**
 * Validate the NEW builder session's turn allowance. Recovery is a bounded
 * continuation, not an expansion of a previous session's absolute ceiling:
 * "add 40 turns" launches one builder with `--max-turns 40`.
 */
export function resolveRecoveryTurnLimit(additionalTurns: number): number | null {
  if (
    !Number.isSafeInteger(additionalTurns) ||
    additionalTurns <= 0 ||
    additionalTurns > MAX_RECOVERY_ADDITIONAL_TURNS
  ) {
    return null;
  }
  return additionalTurns;
}
