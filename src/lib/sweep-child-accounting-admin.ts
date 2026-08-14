/**
 * @file lib/sweep-child-accounting-admin.ts
 * @description OBS-004 — durable persistence for sweep child accounting.
 *
 * Two writes, deliberately decoupled:
 *
 * 1. `recordSweepChildSettlement` — a terminal child reports itself into
 *    `sweep-child-settlements`, at the deterministic doc id
 *    `<sweepId>__<missionId>`. Doc-id identity IS the idempotency: a replayed or
 *    retried report overwrites its own document with the same values, so no
 *    dedup pass or sequence number is needed and the derived counters cannot
 *    drift.
 *
 * 2. `refreshSweepChildAggregate` — recompute the aggregate from ALL of a sweep's
 *    settlements and stamp it onto the sweep's summary AgentRun.
 *
 * ## Why two writes rather than one incremental update
 *
 * Children outlive the sweep that dispatched them, and the sweep writes its
 * summary AgentRun at the very END of its cycle. A fast child can therefore
 * terminalise BEFORE the row it needs to update exists. An incremental
 * `FieldValue.increment` would silently drop that child's accounting.
 *
 * Recomputing from the settlement collection makes the order irrelevant: a
 * settlement recorded before the sweep row is picked up when the sweep computes
 * its own row (same source of truth), and one recorded after triggers a refresh.
 * The settlement documents are the durable evidence; the AgentRun block is a
 * derived projection of them.
 *
 * Uses the narrow admin-helper pattern: `import 'server-only'` plus
 * admin-SDK implementations, so an Inngest worker never reaches the Firebase
 * client SDK.
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { isDomainOutcome } from '@/lib/observability/terminal-outcome';
import {
  aggregateSweepChildren,
  resolveSweepStatusWithChildren,
  type SweepChildAggregate,
  type SweepChildSettlement,
} from '@/lib/sweep-child-accounting';
import { agentRunStatusForDomainOutcome } from '@/lib/observability/terminal-outcome';

const log = createLogger('sweep-child-accounting-admin');

const SETTLEMENTS_COLLECTION = 'sweep-child-settlements';
/** Must match `COLLECTION` in `@/lib/agent-runs` — the summary row lives there. */
const AGENT_RUNS_COLLECTION = 'agentRuns';

/**
 * Hard ceiling on settlements read for one aggregate.
 *
 * A cycle's dispatch is capped in single digits (`MAX_MISSIONS_PER_SWEEP` ∧ the
 * operator's `maxActionsPerSweep`), so this bound is far above any real sweep. It
 * exists so a corrupted or maliciously-seeded sweepId cannot turn one refresh
 * into an unbounded read. Truncation is REPORTED, never silent.
 */
export const MAX_SETTLEMENTS_PER_SWEEP = 200;

/** Deterministic settlement identity — the whole idempotency mechanism. */
export function sweepChildSettlementId(sweepId: string, missionId: string): string {
  return `${sweepId}__${missionId}`;
}

/**
 * Record one child's terminal report.
 *
 * Throws on infrastructure failure so an Inngest caller retries, rather than
 * silently losing a paid child's cost from its sweep's accounting.
 */
export async function recordSweepChildSettlement(
  sweepId: string,
  settlement: SweepChildSettlement
): Promise<{ settlementId: string }> {
  const settlementId = sweepChildSettlementId(sweepId, settlement.missionId);
  await db
    .collection(SETTLEMENTS_COLLECTION)
    .doc(settlementId)
    .set(
      {
        sweepId,
        missionId: settlement.missionId,
        outcome: settlement.outcome,
        ...(settlement.costUsd !== undefined ? { costUsd: settlement.costUsd } : {}),
        ...(settlement.costUnavailableReason ? { costUnavailableReason: settlement.costUnavailableReason } : {}),
        ...(settlement.tokensIn !== undefined ? { tokensIn: settlement.tokensIn } : {}),
        ...(settlement.tokensOut !== undefined ? { tokensOut: settlement.tokensOut } : {}),
        ...(settlement.durationMs !== undefined ? { durationMs: settlement.durationMs } : {}),
        ...(settlement.outputs ? { outputs: settlement.outputs } : {}),
        settledAt: Timestamp.now(),
      },
      // Full overwrite, not a merge: a re-report is the SAME observation, and
      // merging could leave a stale field from a superseded read alongside it.
      { merge: false }
    );
  log.info('Sweep child settlement recorded', {
    sweepId,
    missionId: settlement.missionId,
    outcome: settlement.outcome,
  });
  return { settlementId };
}

/** Read a sweep's settlements back into the pure aggregation input. */
export async function readSweepChildSettlements(
  sweepId: string
): Promise<{ settlements: SweepChildSettlement[]; truncated: boolean }> {
  const snapshot = await db
    .collection(SETTLEMENTS_COLLECTION)
    .where('sweepId', '==', sweepId)
    .limit(MAX_SETTLEMENTS_PER_SWEEP + 1)
    .get();

  const truncated = snapshot.docs.length > MAX_SETTLEMENTS_PER_SWEEP;
  const settlements: SweepChildSettlement[] = [];
  for (const doc of snapshot.docs.slice(0, MAX_SETTLEMENTS_PER_SWEEP)) {
    const data = doc.data();
    const missionId = typeof data.missionId === 'string' ? data.missionId : undefined;
    // Fail closed per row: a settlement without an identity or a recognised
    // outcome cannot be aggregated, and guessing one would put a fabricated
    // outcome into an operator's accounting.
    if (!missionId || !isDomainOutcome(data.outcome)) {
      log.warn('Skipped an unusable sweep child settlement', { sweepId, docId: doc.id });
      continue;
    }
    settlements.push({
      missionId,
      outcome: data.outcome,
      ...(typeof data.costUsd === 'number' ? { costUsd: data.costUsd } : {}),
      ...(data.costUnavailableReason === 'unknown-pricing' || data.costUnavailableReason === 'accounting-incomplete'
        ? { costUnavailableReason: data.costUnavailableReason }
        : {}),
      ...(typeof data.tokensIn === 'number' ? { tokensIn: data.tokensIn } : {}),
      ...(typeof data.tokensOut === 'number' ? { tokensOut: data.tokensOut } : {}),
      ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
      ...(data.outputs && typeof data.outputs === 'object' ? { outputs: data.outputs } : {}),
    });
  }

  if (truncated) {
    log.warn('Sweep child settlements truncated at the read ceiling', {
      sweepId,
      ceiling: MAX_SETTLEMENTS_PER_SWEEP,
    });
  }
  return { settlements, truncated };
}

/** Compute a sweep's child aggregate from its durable settlements. */
export async function computeSweepChildAggregate(
  sweepId: string,
  dispatched: number
): Promise<SweepChildAggregate & { truncated: boolean }> {
  const { settlements, truncated } = await readSweepChildSettlements(sweepId);
  return { ...aggregateSweepChildren({ dispatched, settlements }), truncated };
}

/** What a refresh concluded — reported, never guessed. */
export type SweepAggregateRefresh =
  | { updated: true; aggregate: SweepChildAggregate; status: 'success' | 'failure' | 'skipped' }
  | { updated: false; reason: 'no-summary-row' | 'no-dispatch-record' };

/**
 * Recompute a sweep's child aggregate and stamp it onto its summary AgentRun.
 *
 * Reports `no-summary-row` when the sweep has not written its row yet. That is
 * the expected race, not an error: the sweep's own write recomputes from the same
 * settlement collection, so nothing is lost — the accounting simply lands with
 * the row instead of after it.
 *
 * The AgentRun's `status`, `costUsd` and `tokenUsage` are re-derived alongside the
 * block, because those are the fields the operator actually reads. Leaving them
 * at the dispatch-time values is what let a sweep with two failed paid children
 * keep `status: success` and `costUsd: 0`.
 */
export async function refreshSweepChildAggregate(sweepId: string): Promise<SweepAggregateRefresh> {
  const snapshot = await db.collection(AGENT_RUNS_COLLECTION).where('sweepId', '==', sweepId).limit(5).get();

  // The sweep writes exactly one summary row per cycle (a single shared step id),
  // so the newest row carrying sweepStats is the one to update.
  const summary = snapshot.docs
    .filter((doc) => doc.data()?.sweepStats !== undefined)
    .sort((a, b) => String(b.data()?.createdAt ?? '').localeCompare(String(a.data()?.createdAt ?? '')))[0];

  if (!summary) return { updated: false, reason: 'no-summary-row' };

  const stats = summary.data()?.sweepStats as Record<string, unknown> | undefined;
  const dispatchedRaw = (stats?.children as { dispatched?: unknown } | undefined)?.dispatched;
  const dispatched =
    typeof dispatchedRaw === 'number' && Number.isFinite(dispatchedRaw) && dispatchedRaw >= 0
      ? dispatchedRaw
      : undefined;
  if (dispatched === undefined) {
    // The row predates child accounting. Inventing a denominator would let a
    // settled count exceed a dispatch count that was never recorded.
    return { updated: false, reason: 'no-dispatch-record' };
  }

  const { truncated, ...aggregate } = await computeSweepChildAggregate(sweepId, dispatched);
  const insightsStatus = (stats?.insightsStatus as 'ok' | 'quiet' | 'failed' | 'not-run' | undefined) ?? 'not-run';
  const status = resolveSweepStatusWithChildren({ insightsStatus, children: aggregate });

  await summary.ref.update({
    status,
    'sweepStats.children': aggregate,
    // The sweep's OWN spend stays 0 (it makes no provider calls); the children's
    // cost is reported through the block above and rolled into the row's
    // headline so paid child work is visible on the sweep.
    costUsd: aggregate.costUsd,
    ...(aggregate.costUnavailableChildren > 0 ? { costState: 'estimated' as const } : {}),
    tokenUsage: { input: aggregate.tokensIn, output: aggregate.tokensOut },
    ...(truncated ? { 'sweepStats.childrenTruncated': true } : {}),
  });

  log.info('Sweep child aggregate refreshed', {
    sweepId,
    status,
    childrenStatus: aggregate.childrenStatus,
    failedChildren: aggregate.failedChildren,
    costUsd: aggregate.costUsd,
  });
  return { updated: true, aggregate, status };
}

/**
 * Map a settled child aggregate onto the AgentRun status vocabulary.
 *
 * Exported for the UI/detail surfaces, so the list pill and the sweep detail can
 * never disagree about what a child batch means.
 */
export function sweepChildAgentRunStatus(
  aggregate: SweepChildAggregate
): 'success' | 'failure' | 'skipped' | undefined {
  return aggregate.outcome ? agentRunStatusForDomainOutcome(aggregate.outcome) : undefined;
}
