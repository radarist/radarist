/**
 * @file agent-run-duration.ts
 * @description ARUN-010: honest display duration for AgentRun history entries.
 *
 * Pure module (no Firebase/React imports) so both the runs-table row mapping
 * and the AgentLog component can share ONE rule without dragging the
 * useAgentActivity client chain into node-env tests.
 *
 * Mission runs persisted before the ARUN-002 duration fix carry replay-
 * collapsed values (a `Date.now()` re-initialized on every Inngest replay
 * produced 0–4 ms "durations" for runs that really took minutes). We never
 * rewrite user data — the docs keep their stored values — but the UI must not
 * present them as real elapsed time. A MISSION run (missionId set) can never
 * legitimately finish in under a second (its duration spans the whole
 * orchestrator execution), so sub-second mission durations render as
 * unavailable ("—"). Non-mission rows (sweeps — a skipped cycle IS genuinely
 * fast) and ARUN-008 `durationUnknown` fallback rows keep their semantics.
 */

export const LEGACY_COLLAPSED_DURATION_MS = 1000;

export function agentLogDurationMs(entry: {
  duration: number;
  durationUnknown?: boolean;
  missionId?: string;
}): number | undefined {
  if (entry.durationUnknown) return undefined;
  if (entry.missionId && entry.duration < LEGACY_COLLAPSED_DURATION_MS) return undefined;
  return entry.duration;
}
