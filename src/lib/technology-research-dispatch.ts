/**
 * @file lib/technology-research-dispatch.ts
 * @description TEST-022 — the single dispatch contract for technology research.
 *
 * Two independent callers trigger the same background job: the authenticated
 * HTTP route (`/api/technologies/research`, used by both UI entry points) and
 * the Assistant tool (`researchTechnologyComprehensive`). They each carried
 * their own copy of the duplicate guard, which meant two places to keep in
 * sync and two chances to drift. This module owns the decision; the callers own
 * only how they report it.
 *
 * ## The stale-window bug this closes
 *
 * Both copies used a 10-minute staleness window, while the comprehensive job
 * documents a 15-minute budget. A perfectly healthy run therefore became
 * "stale" and re-triggerable five minutes BEFORE it was expected to finish —
 * the duplicate-job case the guard exists to prevent. The window is now derived
 * from the job budget plus a margin, so it can only ever expire after the job
 * itself has given up.
 *
 * ## What this decision is, and is not
 *
 * This pure function only evaluates a snapshot. The server-owned
 * `claimTechnologyResearchAttempt` boundary applies it inside a Firestore
 * transaction, so competing callers cannot both acquire the dispatch slot.
 * Workers independently validate the exact persisted attempt token before
 * provider spend and again at commit, which also closes stale delivery.
 *
 * Pure module (type-only imports) so route, tool and tests share one definition.
 */

import type { Technology } from '@/lib/types';

/**
 * The comprehensive research job's own budget. Keep in sync with the timeout
 * documented on `runComprehensiveTechResearchJob`.
 */
export const RESEARCH_JOB_BUDGET_MS = 15 * 60 * 1000;

/**
 * Margin over the job budget before a pending run is treated as abandoned.
 * MUST keep the total above {@link RESEARCH_JOB_BUDGET_MS}: a window shorter
 * than the budget declares live work dead and re-dispatches it.
 */
export const RESEARCH_STALE_MARGIN_MS = 5 * 60 * 1000;

/** A pending run older than this is presumed abandoned and may be retried. */
export const RESEARCH_STALE_AFTER_MS = RESEARCH_JOB_BUDGET_MS + RESEARCH_STALE_MARGIN_MS;

export type ResearchDispatchRefusal = 'already-running';

export type ResearchDispatchDecision =
  | { allowed: true; reason: 'idle' | 'previous-run-stale' | 'previous-run-settled' }
  | { allowed: false; reason: ResearchDispatchRefusal; startedAt?: number };

/** The fields the decision reads — keeps the helper usable from tests. */
export type ResearchDispatchState = Pick<Technology, 'researchStatus' | 'researchStartedAt'>;

/**
 * Decide whether a research dispatch may proceed.
 *
 * `idle` covers the absent-field case deliberately: `researchStatus: 'idle'` is
 * declared in the type but never written by any path, so an un-researched
 * technology has no status at all.
 */
export function decideResearchDispatch(state: ResearchDispatchState, now: number): ResearchDispatchDecision {
  if (state.researchStatus !== 'pending') {
    return { allowed: true, reason: state.researchStatus ? 'previous-run-settled' : 'idle' };
  }

  const startedAt = state.researchStartedAt;
  // A pending row with no start time cannot be aged, so treat it as abandoned
  // rather than wedging the technology forever.
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return { allowed: true, reason: 'previous-run-stale' };
  }
  if (now - startedAt > RESEARCH_STALE_AFTER_MS) {
    return { allowed: true, reason: 'previous-run-stale' };
  }
  return { allowed: false, reason: 'already-running', startedAt };
}
