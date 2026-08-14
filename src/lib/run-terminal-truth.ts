/**
 * @file lib/run-terminal-truth.ts
 * @description ARUN-029 — the ONE derivation of a run's terminal truth: why it
 * ended, what it produced, and whether its accounting agrees with the Mission
 * doc it came from.
 *
 * A Creator (kind `mission`) run resolves on `/agents/runs/[id]` from its
 * `AgentRun` history entry alone. Everything the mission itself recorded about
 * how it ended — the structured `failureCode`, the `outcome` classification,
 * the canonical `reportId` pointer, the `partial` flag — lives on the `missions`
 * doc and was never read there. A failed Creator therefore showed a red pill and
 * nothing else, a draft/partial Creator that DID publish a report offered no way
 * to reach it, and the row's token/cost fields could disagree with the mission's
 * stored usage with no indication that two records existed at all.
 *
 * The governing rule is that missing authority is never rounded up. An absent
 * `outcome` does not become "delivered"; an unreadable report pointer does not
 * become "no report"; an unrecorded reason does not become a generic
 * reassurance. Each of those is its own explicit state.
 *
 * Pure module — no Firebase/React imports.
 */

import { missionUsageSnapshot } from '@/lib/mission-usage';
import { selectCanonicalMissionReport } from '@/lib/reports/select-canonical-report';
import type { Mission } from '@/lib/schemas/mission';
import type { Report } from '@/lib/schemas/report';

/**
 * What the run ended up doing, in the mission's own vocabulary where it stated
 * one.
 *
 * `completed-unclassified` is deliberately distinct from `delivered`: a mission
 * doc that reached `completed` without recording an `outcome` (a legacy row, or
 * a terminal write that landed before the classification did) proves the run
 * stopped, not that it produced what it promised.
 */
export type RunDisposition =
  'in-flight' | 'delivered' | 'needs-review' | 'no-deliverable' | 'failed' | 'completed-unclassified' | 'unknown';

/** Where a stated reason came from, so the reader can weigh it. */
export type RunReasonSource =
  | 'mission-failure-code'
  | 'run-failure-code'
  | 'mission-errors'
  | 'run-errors'
  | 'mission-progress-message'
  | 'quality-verdict';

export interface RunTerminalReason {
  text: string;
  source: RunReasonSource;
}

/**
 * The state of the run's report pointer.
 *
 * `referenced-unresolved` is the honest answer when the mission names a report
 * the reader's own report list does not contain — deleted, still syncing, or
 * owned by someone else. Collapsing it into `none` would tell the owner their
 * paid run produced nothing.
 */
export type RunReportState = 'canonical' | 'referenced-unresolved' | 'none' | 'unknown';

export interface RunReportPointer {
  id: string;
  title: string;
  href: string;
}

/** One accounting field on which the AgentRun row and the Mission doc differ. */
export interface AccountingDisagreement {
  field: 'tokens' | 'cost';
  runValue: string;
  missionValue: string;
}

export interface RunTerminalTruth {
  disposition: RunDisposition;
  /** The single durable reason to show, or undefined when none was recorded. */
  reason: RunTerminalReason | undefined;
  /**
   * True when the run ended in a non-success state and NOTHING durable states
   * why. The surface must say that explicitly rather than render an empty slot.
   */
  reasonUnavailable: boolean;
  reportState: RunReportState;
  report: RunReportPointer | undefined;
  /** Report ids the mission points at, when the pointer could not be resolved. */
  referencedReportIds: string[];
  /** True when the run recovered a partial result from a mid-run checkpoint. */
  partial: boolean;
  /**
   * Non-empty when the AgentRun row and the Mission doc state different
   * accounting. Two records exist; the reader is entitled to know they disagree
   * rather than be shown whichever one the surface happened to read.
   */
  accountingDisagreements: AccountingDisagreement[];
  /**
   * Set when the run's own EVENT TRAIL contradicts its recorded status. The
   * step log, the status pill and the terminal reason are three views of one
   * run; if they disagree, saying so beats silently showing whichever one this
   * surface happens to read.
   */
  eventTrailContradiction?: string;
}

export interface RunTerminalTruthInput {
  /** The run as resolved for the detail page. */
  run: {
    kind: string;
    status: string;
    isLive: boolean;
    tokens: number | undefined;
    costUsd?: number;
    errors?: string[];
    failureCode?: string;
  };
  /** The durable Mission doc, when this run has one AND it loaded. */
  mission: Mission | undefined;
  /** The mission id this run answers to, when it has one. */
  missionId: string | undefined;
  /** The reader's own report list (already owner-scoped by the API). */
  reports: readonly Report[];
  ownerId?: string;
  /**
   * The run's scoped event trail, when one was fetched. Only the terminal event
   * types are read. Absent/empty means the trail is unknown (a run type that
   * emits no scoped events, or a 24h-expired history) — which is NOT a
   * contradiction and must never be reported as one.
   */
  events?: ReadonlyArray<{ type: string }>;
}

const FAILURE_CODE_TEXT: Record<string, string> = {
  'mcp-preflight-failed': 'Internal tool server preflight failed — the run never reached the model.',
  'mcp-base-url-missing': 'Internal tool server base URL is not configured — the run never reached the model.',
  'mcp-internal-key-missing': 'Internal tool server key is not configured — the run never reached the model.',
  'mcp-credential-containment-failed':
    'A configured tool-server credential would have been exposed on the command line — the run never reached the model.',
};

function describeFailureCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return FAILURE_CODE_TEXT[code] ?? code;
}

function firstNonEmpty(values: readonly string[] | undefined): string | undefined {
  return values?.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

/**
 * The durable reason, in descending order of authority: a machine-readable
 * failure code beats prose, the mission's own record beats the run row's copy,
 * and the mission's terminal progress message beats an inferred quality verdict.
 * Never synthesised — if none of these exist, the caller reports that.
 */
function resolveReason(input: RunTerminalTruthInput): RunTerminalReason | undefined {
  const { run, mission } = input;

  const missionCode = describeFailureCode(mission?.failureCode);
  if (missionCode) return { text: missionCode, source: 'mission-failure-code' };

  const runCode = describeFailureCode(run.failureCode);
  if (runCode) return { text: runCode, source: 'run-failure-code' };

  const missionError = firstNonEmpty(mission?.errors);
  if (missionError) return { text: missionError, source: 'mission-errors' };

  const runError = firstNonEmpty(run.errors);
  if (runError) return { text: runError, source: 'run-errors' };

  const progressMessage = mission?.progressMessage?.trim();
  if (progressMessage) return { text: progressMessage, source: 'mission-progress-message' };

  const verdict = mission?.qualityReport?.verdict;
  if (verdict === 'FAIL' || verdict === 'REVISE') {
    const failing = (mission?.qualityReport?.checks ?? []).filter((check) => !check.pass).map((check) => check.name);
    return {
      text: failing.length > 0 ? `Quality gate ${verdict}: ${failing.join(', ')}` : `Quality gate ${verdict}`,
      source: 'quality-verdict',
    };
  }

  return undefined;
}

function resolveDisposition(input: RunTerminalTruthInput): RunDisposition {
  const { run, mission } = input;
  if (run.isLive || run.status === 'live' || run.status === 'blocked') return 'in-flight';
  if (mission?.outcome) return mission.outcome;
  // No mission authority to read. The run row states only whether it ended
  // badly; a clean end is NOT evidence that the promised artifact exists.
  if (run.status === 'failure') return 'failed';
  if (run.status === 'success') return mission ? 'completed-unclassified' : 'unknown';
  return 'unknown';
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? 'unavailable' : String(value);
}

function formatCost(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `$${value.toFixed(4)}`;
}

/**
 * Compare the run row's accounting with the Mission doc's. Only a genuine
 * contradiction counts: two stated values that differ, or one surface stating a
 * value where the other proves it unavailable. Both-unavailable is agreement.
 */
function resolveAccountingDisagreements(input: RunTerminalTruthInput): AccountingDisagreement[] {
  const { run, mission } = input;
  if (!mission) return [];
  const usage = missionUsageSnapshot(mission);
  const disagreements: AccountingDisagreement[] = [];

  if (run.tokens !== usage.tokens) {
    disagreements.push({
      field: 'tokens',
      runValue: formatTokens(run.tokens),
      missionValue: formatTokens(usage.tokens),
    });
  }

  // Compare at cent-of-a-cent resolution: both records are derived from the
  // same accumulators, so a genuine split is orders of magnitude larger than
  // float noise, and flagging the noise would train the reader to ignore this.
  const runCost = run.costUsd;
  const missionCost = usage.costUsd;
  const bothStated = runCost !== undefined && missionCost !== undefined;
  const costDiffers = bothStated
    ? Math.abs(runCost - missionCost) > 0.000005
    : runCost !== undefined || missionCost !== undefined;
  if (costDiffers) {
    disagreements.push({ field: 'cost', runValue: formatCost(runCost), missionValue: formatCost(missionCost) });
  }

  return disagreements;
}

function resolveReport(input: RunTerminalTruthInput): {
  reportState: RunReportState;
  report: RunReportPointer | undefined;
  referencedReportIds: string[];
} {
  const { mission, missionId, reports, ownerId } = input;
  // REPORT-002: the shared canonical selector — the same deterministic rule
  // AgentLog and the server's owner-scoped reader use, so this surface can
  // never link to a different Report than Activity does.
  const canonical = selectCanonicalMissionReport(reports, missionId, ownerId);
  if (canonical) {
    return {
      reportState: 'canonical',
      report: { id: canonical.id, title: canonical.title, href: `/reports/${canonical.id}` },
      referencedReportIds: [],
    };
  }

  if (!mission) return { reportState: 'unknown', report: undefined, referencedReportIds: [] };

  const referenced = [...new Set([...(mission.reportIds ?? []), ...(mission.reportId ? [mission.reportId] : [])])];
  if (referenced.length > 0) {
    // The mission names a report this reader's list does not contain. That is
    // not "no report" — it is a pointer that could not be resolved.
    return { reportState: 'referenced-unresolved', report: undefined, referencedReportIds: referenced };
  }

  return { reportState: 'none', report: undefined, referencedReportIds: [] };
}

/**
 * The one contradiction worth flagging between the step log and the record.
 *
 * An `agent.error` in the trail against a run recorded as SUCCESS is
 * unambiguous: the trail says the run errored and the record says it did not.
 * The converse is deliberately NOT flagged — a Creator legitimately emits
 * `agent.completed` from the SDK and is then marked failed by the report-truth
 * resolver (that is exactly the `needs-review` draft case), so treating it as a
 * contradiction would cry wolf on a correct outcome.
 */
function resolveEventTrailContradiction(input: RunTerminalTruthInput): string | undefined {
  const events = input.events ?? [];
  if (events.length === 0) return undefined;
  const errored = events.some((event) => event.type === 'agent.error');
  if (errored && input.run.status === 'success') {
    return 'The step log records an error for this run, but the run was recorded as successful.';
  }
  return undefined;
}

export function resolveRunTerminalTruth(input: RunTerminalTruthInput): RunTerminalTruth {
  const disposition = resolveDisposition(input);
  const reason = resolveReason(input);
  const { reportState, report, referencedReportIds } = resolveReport(input);
  const endedBadly = disposition === 'failed' || disposition === 'needs-review' || disposition === 'no-deliverable';
  const contradiction = resolveEventTrailContradiction(input);

  return {
    disposition,
    reason,
    reasonUnavailable: endedBadly && reason === undefined,
    reportState,
    report,
    referencedReportIds,
    partial: input.mission?.partial === true,
    accountingDisagreements: resolveAccountingDisagreements(input),
    ...(contradiction ? { eventTrailContradiction: contradiction } : {}),
  };
}

/** Owner-facing label for a disposition. */
export const RUN_DISPOSITION_LABEL: Record<RunDisposition, string> = {
  'in-flight': 'In flight',
  delivered: 'Delivered',
  'needs-review': 'Needs review',
  'no-deliverable': 'No deliverable',
  failed: 'Failed',
  'completed-unclassified': 'Ended without a recorded outcome',
  unknown: 'Outcome not recorded',
};
