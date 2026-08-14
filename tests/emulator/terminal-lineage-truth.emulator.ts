/**
 * OBS-001 / OBS-004 / ARUN-030 — live Admin-SDK acceptance for this lane's
 * cross-store terminal truth, against a REAL Firestore emulator (no mocks).
 *
 * What it proves across the terminal-state contracts exercised by this lane:
 *
 *   1. **OBS-001 transport ≠ domain.** A run that transport-completes while its
 *      business work failed is recorded with `status: 'completed'` AND
 *      `domainOutcome: 'failed'`, and a run that declares nothing is recorded
 *      `undeclared` — never as a success.
 *   2. **Retry then recovery.** A run that failed and later succeeded must not
 *      keep the earlier entailed `failed` domain outcome.
 *   3. **Lost acknowledgement / terminal replay.** Re-recording the same terminal
 *      state is idempotent, and a post-hoc reconciliation can refine a coarse
 *      transport entailment but can never outrank the function's own declaration.
 *   4. **Cancellation.** A server-side cancellation records `cancelled` on both
 *      axes without inventing usage, and never overwrites an authoritative result.
 *   5. **OBS-004 partial child batches.** Settlements are idempotent by
 *      `(sweepId, missionId)`, an unsettled batch reports `pending`/`partial`, and
 *      a fully-failed paid batch drives the sweep row to `failure` with its
 *      settled cost.
 *   6. **ARUN-030 build lineage.** A terminal build persists an AgentRun under
 *      `build-runtime`, never `scout`.
 *
 * Every fixture is namespaced, and teardown proves ZERO owned residue.
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle) or standalone
 * through `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

export {};

import { randomUUID } from 'node:crypto';
import { db as adminDb } from '@/lib/firebase-admin';
import {
  recordJobCancelled,
  recordJobComplete,
  recordJobDomainOutcome,
  recordJobFailure,
  recordJobStart,
} from '@/lib/inngest/observability';
import { declareDomainOutcome, splitDomainOutcome } from '@/lib/inngest/domain-outcome';
import {
  computeSweepChildAggregate,
  recordSweepChildSettlement,
  refreshSweepChildAggregate,
  sweepChildSettlementId,
} from '@/lib/sweep-child-accounting-admin';
import { BUILD_RUNTIME_AGENT_NAME } from '@/lib/build-runtime-identity';
import { persistBuildMissionLineage } from '@/lib/build-mission-lineage';

const RUN_NS = `tl-${randomUUID()}`;
const OWNER = `user-${RUN_NS}`;

/** Every document this suite creates, so teardown can prove zero residue. */
const owned: Array<{ collection: string; id: string }> = [];

function ownJobRun(id: string): string {
  owned.push({ collection: 'job-runs', id });
  return id;
}

async function readJobRun(id: string): Promise<Record<string, unknown>> {
  const snapshot = await adminDb.collection('job-runs').doc(id).get();
  expect(snapshot.exists).toBe(true);
  return snapshot.data() as Record<string, unknown>;
}

async function seedSweepSummaryRow(sweepId: string, dispatched: number, insightsStatus = 'ok'): Promise<string> {
  const id = `agentrun-${sweepId}`;
  owned.push({ collection: 'agentRuns', id });
  await adminDb
    .collection('agentRuns')
    .doc(id)
    .set({
      id,
      userId: OWNER,
      agentName: 'sweep-cycle',
      action: 'Sweep summary',
      status: 'success',
      sweepId,
      kind: 'sweep',
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      duration: 31_100,
      createdAt: new Date('2026-07-22T06:00:00.000Z').toISOString(),
      sweepStats: {
        gapsFound: 2,
        missionsSpawned: dispatched,
        usersProcessed: 1,
        observationsWritten: 2,
        watchedInsights: 1,
        narrativeInsights: 0,
        insightsTotal: 1,
        insightsStatus,
        children: {
          dispatched,
          settled: 0,
          byOutcome: {},
          childrenStatus: dispatched > 0 ? 'pending' : 'none',
          costUsd: 0,
          costUnavailableChildren: 0,
          tokensIn: 0,
          tokensOut: 0,
          childDurationMs: 0,
          outputs: { proposals: 0, reports: 0, entities: 0 },
          failedChildren: 0,
        },
      },
    });
  return id;
}

function ownSettlement(sweepId: string, missionId: string): void {
  owned.push({ collection: 'sweep-child-settlements', id: sweepChildSettlementId(sweepId, missionId) });
}

afterAll(async () => {
  for (const doc of owned) {
    // eslint-disable-next-line no-await-in-loop
    await adminDb
      .collection(doc.collection)
      .doc(doc.id)
      .delete()
      .catch(() => undefined);
  }
  // Zero owned residue: every namespaced document is gone.
  for (const doc of owned) {
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await adminDb.collection(doc.collection).doc(doc.id).get();
    expect(snapshot.exists).toBe(false);
  }
});

// ============================================================================
// OBS-001 — transport completion vs declared business outcome
// ============================================================================

describe('OBS-001 — a transport-completed run whose work failed', () => {
  it('persists BOTH axes, so nothing can read the completion as a delivery', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-creator`);
    await recordJobStart('run-agent-mission', 'Run Agent Mission', { event: 'app/mission.run.requested' }, runId);

    // The exact TEST-027 Creator shape: the Inngest run returns cleanly while the
    // canonical Mission and AgentRun are failed and no Report exists.
    const returned = declareDomainOutcome(
      { missionId: `mission-${RUN_NS}`, success: false, duration: 41_000 },
      { outcome: 'failed', reason: 'no-deliverable' }
    );
    const { declaration, output } = splitDomainOutcome(returned);
    await recordJobComplete(runId, output as Record<string, unknown>, undefined, declaration);

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('completed');
    expect(stored.domainOutcome).toBe('failed');
    expect(stored.domainOutcomeSource).toBe('declared');
    expect(stored.domainOutcomeReason).toBe('no-deliverable');
    // The reserved key never reaches the persisted output, so readers that parse
    // `output` by schema see the same shape they always did.
    expect(stored.output).toEqual({ missionId: `mission-${RUN_NS}`, success: false, duration: 41_000 });
  });

  it('records an undeclared clean run as undeclared, not as a success', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-undeclared`);
    await recordJobStart('sync-entity-to-neo4j', 'Sync Entity', undefined, runId);
    await recordJobComplete(runId, { synced: 3 });

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('completed');
    expect(stored.domainOutcome).toBeUndefined();
    expect(stored.domainOutcomeSource).toBe('undeclared');
  });

  it('entails a domain failure from an exhausted transport failure', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-failed`);
    await recordJobStart('run-deep-research', 'Deep Research', undefined, runId);
    await recordJobFailure(runId, new Error('provider unavailable'));

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('failed');
    expect(stored.domainOutcome).toBe('failed');
    expect(stored.domainOutcomeSource).toBe('transport-failure');
  });

  it('leaves a non-terminal retry without a domain outcome', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-retrying`);
    await recordJobStart('run-deep-research', 'Deep Research', undefined, runId);
    await recordJobFailure(runId, new Error('transient'), 1);

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('retrying');
    // The run may still succeed; stamping `failed` here would have to be un-stamped.
    expect(stored.domainOutcome).toBeUndefined();
    expect(stored.domainOutcomeSource).toBeUndefined();
  });
});

describe('OBS-001 — retry, recovery, replay and reconciliation precedence', () => {
  it('clears the entailed failure when a retried run later succeeds', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-recovered`);
    await recordJobStart('refresh-url-document', 'Refresh URL Document', undefined, runId);
    await recordJobFailure(runId, new Error('first attempt failed'));
    expect((await readJobRun(runId)).domainOutcome).toBe('failed');

    await recordJobComplete(runId, { refreshed: true }, undefined, { outcome: 'success' });

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('completed');
    expect(stored.domainOutcome).toBe('success');
    expect(stored.domainOutcomeSource).toBe('declared');
    expect(stored.error).toBeUndefined();
  });

  it('refines a coarse transport entailment into a preflight refusal', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-preflight`);
    await recordJobStart('run-agent-mission', 'Run Agent Mission', undefined, runId);
    // The middleware could only see the throw.
    await recordJobFailure(runId, new Error('mcp-preflight-failed: platform MCP unreachable'));
    expect((await readJobRun(runId)).domainOutcome).toBe('failed');

    // `onFailure` read the persisted Mission and knows nothing was spent.
    const first = await recordJobDomainOutcome(runId, {
      outcome: 'preflight-failed',
      reason: 'mcp-preflight-failed',
    });
    expect(first).toBe('recorded');

    const stored = await readJobRun(runId);
    expect(stored.status).toBe('failed');
    expect(stored.domainOutcome).toBe('preflight-failed');
    expect(stored.domainOutcomeSource).toBe('reconciled');

    // Terminal replay: a retried onFailure performs no second write.
    expect(await recordJobDomainOutcome(runId, { outcome: 'preflight-failed', reason: 'mcp-preflight-failed' })).toBe(
      'unchanged'
    );
  });

  it('never lets a reconciliation outrank the function own declaration', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-declared-wins`);
    await recordJobStart('run-agent-mission', 'Run Agent Mission', undefined, runId);
    // A checkpoint-recovered mission declares `partial` and then throws during
    // final persistence. The recovered output is real.
    await recordJobFailure(runId, new Error('persistence failed'), 0, { outcome: 'partial' });
    expect((await readJobRun(runId)).domainOutcomeSource).toBe('declared');

    expect(await recordJobDomainOutcome(runId, { outcome: 'failed' })).toBe('preserved-declaration');
    expect((await readJobRun(runId)).domainOutcome).toBe('partial');
  });

  it('reports a missing record rather than creating one', async () => {
    expect(await recordJobDomainOutcome(`inngest-${RUN_NS}-absent`, { outcome: 'failed' })).toBe('not-found');
    const snapshot = await adminDb.collection('job-runs').doc(`inngest-${RUN_NS}-absent`).get();
    expect(snapshot.exists).toBe(false);
  });
});

describe('OBS-001 — cancellation', () => {
  it('records cancelled on both axes without inventing usage', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-cancelled`);
    await recordJobStart('run-build-mission', 'Run Build Mission', undefined, runId);

    expect(await recordJobCancelled(runId)).toBe('cancelled');
    const stored = await readJobRun(runId);
    expect(stored.status).toBe('cancelled');
    expect(stored.domainOutcome).toBe('cancelled');
    expect(stored.domainOutcomeSource).toBe('transport-cancellation');
    expect(stored.output).toBeUndefined();

    // Idempotent on replay.
    expect(await recordJobCancelled(runId)).toBe('already-cancelled');
  });

  it('preserves an authoritative result against a late cancellation signal', async () => {
    const runId = ownJobRun(`inngest-${RUN_NS}-late-cancel`);
    await recordJobStart('run-build-mission', 'Run Build Mission', undefined, runId);
    await recordJobComplete(runId, { outputId: 'proto-1' }, undefined, { outcome: 'success' });

    expect(await recordJobCancelled(runId)).toBe('already-terminal');
    const stored = await readJobRun(runId);
    expect(stored.status).toBe('completed');
    expect(stored.domainOutcome).toBe('success');
  });
});

// ============================================================================
// OBS-004 — sweep child accounting
// ============================================================================

describe('OBS-004 — the reported sweep, settled durably', () => {
  it('drives the summary row to failure with the children real cost', async () => {
    const sweepId = `sweep-${RUN_NS}-failed-children`;
    const runId = await seedSweepSummaryRow(sweepId, 2);
    const children = [`mission-${RUN_NS}-c1`, `mission-${RUN_NS}-c2`];
    for (const missionId of children) ownSettlement(sweepId, missionId);

    // Both paid linker children failed, produced zero proposals, spent ~$11.2458.
    await recordSweepChildSettlement(sweepId, {
      missionId: children[0],
      outcome: 'failed',
      costUsd: 5.6229,
      tokensIn: 60_000,
      tokensOut: 4_000,
      durationMs: 15_600,
      outputs: { proposals: 0 },
    });
    await recordSweepChildSettlement(sweepId, {
      missionId: children[1],
      outcome: 'failed',
      costUsd: 5.6229,
      tokensIn: 60_000,
      tokensOut: 4_000,
      durationMs: 15_500,
      outputs: { proposals: 0 },
    });

    const refresh = await refreshSweepChildAggregate(sweepId);
    expect(refresh.updated).toBe(true);
    if (!refresh.updated) throw new Error('unreachable');
    expect(refresh.status).toBe('failure');

    const stored = (await adminDb.collection('agentRuns').doc(runId).get()).data() as Record<string, unknown>;
    // The row's own status now reflects the paid children, not just the insight lane.
    expect(stored.status).toBe('failure');
    expect(stored.costUsd).toBeCloseTo(11.2458, 4);
    expect(stored.tokenUsage).toEqual({ input: 120_000, output: 8_000 });
    const aggregate = (stored.sweepStats as { children: Record<string, unknown> }).children;
    expect(aggregate.childrenStatus).toBe('settled');
    expect(aggregate.failedChildren).toBe(2);
    expect(aggregate.outcome).toBe('failed');
    expect(aggregate.childDurationMs).toBe(31_100);
    expect(aggregate.outputs).toEqual({ proposals: 0, reports: 0, entities: 0 });
  });

  it('is idempotent — a replayed settlement cannot double-count spend', async () => {
    const sweepId = `sweep-${RUN_NS}-replay`;
    await seedSweepSummaryRow(sweepId, 1);
    const missionId = `mission-${RUN_NS}-replayed`;
    ownSettlement(sweepId, missionId);

    const settlement = { missionId, outcome: 'success' as const, costUsd: 3.5, tokensIn: 10, tokensOut: 5 };
    await recordSweepChildSettlement(sweepId, settlement);
    await recordSweepChildSettlement(sweepId, settlement);

    const aggregate = await computeSweepChildAggregate(sweepId, 1);
    expect(aggregate.settled).toBe(1);
    expect(aggregate.costUsd).toBe(3.5);
    expect(aggregate.childrenStatus).toBe('settled');
  });

  it('reports a partial batch as partial and refuses to call it a success', async () => {
    const sweepId = `sweep-${RUN_NS}-partial`;
    await seedSweepSummaryRow(sweepId, 3);
    const missionId = `mission-${RUN_NS}-first`;
    ownSettlement(sweepId, missionId);
    await recordSweepChildSettlement(sweepId, { missionId, outcome: 'success', costUsd: 1 });

    const refresh = await refreshSweepChildAggregate(sweepId);
    if (!refresh.updated) throw new Error('expected an update');
    expect(refresh.aggregate.childrenStatus).toBe('partial');
    // One success out of three dispatched is not a successful batch.
    expect(refresh.aggregate.outcome).toBe('partial');
    // But nothing has gone wrong, so the row is not failed either.
    expect(refresh.status).toBe('success');
  });

  it('excludes an unprovable child cost from the total and counts it', async () => {
    const sweepId = `sweep-${RUN_NS}-unpriced`;
    const runId = await seedSweepSummaryRow(sweepId, 2);
    for (const suffix of ['priced', 'unpriced']) ownSettlement(sweepId, `mission-${RUN_NS}-${suffix}`);

    await recordSweepChildSettlement(sweepId, {
      missionId: `mission-${RUN_NS}-priced`,
      outcome: 'success',
      costUsd: 2.25,
    });
    await recordSweepChildSettlement(sweepId, {
      missionId: `mission-${RUN_NS}-unpriced`,
      outcome: 'success',
      costUnavailableReason: 'unknown-pricing',
    });

    const refresh = await refreshSweepChildAggregate(sweepId);
    if (!refresh.updated) throw new Error('expected an update');
    expect(refresh.aggregate.costUsd).toBe(2.25);
    expect(refresh.aggregate.costUnavailableChildren).toBe(1);

    const stored = (await adminDb.collection('agentRuns').doc(runId).get()).data() as Record<string, unknown>;
    // A partly-priced batch is marked as an estimate rather than presented as exact.
    expect(stored.costState).toBe('estimated');
  });

  it('reports no-summary-row when a fast child settles before the sweep writes its row', async () => {
    const sweepId = `sweep-${RUN_NS}-early`;
    const missionId = `mission-${RUN_NS}-early`;
    ownSettlement(sweepId, missionId);
    await recordSweepChildSettlement(sweepId, { missionId, outcome: 'success', costUsd: 1 });

    // The expected race, not an error.
    expect(await refreshSweepChildAggregate(sweepId)).toEqual({ updated: false, reason: 'no-summary-row' });

    // And the settlement is NOT lost — the sweep's own write reads the same source.
    const aggregate = await computeSweepChildAggregate(sweepId, 1);
    expect(aggregate.settled).toBe(1);
    expect(aggregate.costUsd).toBe(1);
  });
});

// ============================================================================
// ARUN-030 — build lineage under the real runtime identity
// ============================================================================

describe('ARUN-030 — build lineage', () => {
  it('persists a terminal build AgentRun under build-runtime, never scout', async () => {
    const missionId = `mission-${RUN_NS}-build`;
    const result = await persistBuildMissionLineage({
      missionId,
      userId: OWNER,
      exit: 'published',
      outcome: 'success',
      sessions: 2,
      spentUsd: 12.5,
      durationMs: 900_000,
      summary: 'Prototype published; $12.50 spent across 2 session(s).',
    });
    expect(result.agentRun).toBe('written');

    const snapshot = await adminDb.collection('agentRuns').where('missionId', '==', missionId).get();
    expect(snapshot.docs).toHaveLength(1);
    for (const doc of snapshot.docs) owned.push({ collection: 'agentRuns', id: doc.id });
    const stored = snapshot.docs[0].data();
    expect(stored.agentName).toBe(BUILD_RUNTIME_AGENT_NAME);
    expect(stored.agentName).not.toBe('scout');
    expect(stored.status).toBe('success');
    expect(stored.costUsd).toBe(12.5);
    expect(stored.duration).toBe(900_000);
  });

  it('marks an unknowable build duration as unknown rather than 0ms', async () => {
    const missionId = `mission-${RUN_NS}-build-nodur`;
    await persistBuildMissionLineage({
      missionId,
      userId: OWNER,
      exit: 'supervisor-failure',
      outcome: 'preflight-failed',
      sessions: 0,
      summary: 'Build refused before its first session.',
    });

    const snapshot = await adminDb.collection('agentRuns').where('missionId', '==', missionId).get();
    for (const doc of snapshot.docs) owned.push({ collection: 'agentRuns', id: doc.id });
    const stored = snapshot.docs[0].data();
    expect(stored.durationUnknown).toBe(true);
    expect(stored.status).toBe('failure');
    // No cost was proven, so none is claimed.
    expect(stored.costUsd).toBeUndefined();
    expect(stored.costUnavailableReason).toBe('accounting-incomplete');
  });
});
