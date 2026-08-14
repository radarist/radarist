/**
 * @file lib/__tests__/run-terminal-truth.test.ts
 * @description ARUN-029 — one durable terminal reason, one canonical Report
 * pointer, and an explicit statement when the AgentRun row and the Mission doc
 * disagree. The governing rule under test throughout: missing authority is
 * never rounded up to success or to "nothing was produced".
 */

import { resolveRunTerminalTruth, type RunTerminalTruthInput } from '@/lib/run-terminal-truth';
import type { Mission } from '@/lib/schemas/mission';
import type { Report } from '@/lib/schemas/report';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    userId: 'u1',
    prompt: 'Landscape report on agentic retrieval',
    agent: 'creator',
    kind: 'report',
    status: 'completed',
    progress: 100,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-07-29T09:00:00.000Z',
    ...overrides,
  } as Mission;
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    ownerId: 'u1',
    missionId: 'mission-1',
    title: 'Agentic retrieval landscape',
    createdAt: '2026-07-29T09:30:00.000Z',
    ...overrides,
  } as Report;
}

function input(overrides: Partial<RunTerminalTruthInput> = {}): RunTerminalTruthInput {
  return {
    run: { kind: 'mission', status: 'success', isLive: false, tokens: 1000, costUsd: 0.5 },
    mission: undefined,
    missionId: 'mission-1',
    reports: [],
    ownerId: 'u1',
    ...overrides,
  };
}

describe('disposition — missing authority is never rounded up', () => {
  it('uses the mission outcome when the mission recorded one', () => {
    const truth = resolveRunTerminalTruth(input({ mission: mission({ outcome: 'delivered' }) }));
    expect(truth.disposition).toBe('delivered');
  });

  it('does NOT call a completed mission with no recorded outcome "delivered"', () => {
    const truth = resolveRunTerminalTruth(input({ mission: mission({ outcome: undefined }) }));
    expect(truth.disposition).toBe('completed-unclassified');
  });

  it('reports an unknown disposition when no mission record could be read at all', () => {
    const truth = resolveRunTerminalTruth(input({ mission: undefined }));
    expect(truth.disposition).toBe('unknown');
  });

  it('classifies a failed run as failed even with no mission record', () => {
    const truth = resolveRunTerminalTruth(
      input({ run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined } })
    );
    expect(truth.disposition).toBe('failed');
  });

  it('keeps an in-flight run out of every terminal classification', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'live', isLive: true, tokens: 10 },
        mission: mission({ status: 'running', outcome: undefined }),
      })
    );
    expect(truth.disposition).toBe('in-flight');
    expect(truth.reasonUnavailable).toBe(false);
  });

  it('carries the mission outcome through for a needs-review draft', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: 1000, costUsd: 0.5 },
        mission: mission({ status: 'failed', outcome: 'needs-review', partial: true }),
      })
    );
    expect(truth.disposition).toBe('needs-review');
    expect(truth.partial).toBe(true);
  });
});

describe('terminal reason — one durable reason, in authority order', () => {
  it('prefers the mission failure code over prose', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined, errors: ['something broke'] },
        mission: mission({ status: 'failed', failureCode: 'mcp-preflight-failed', errors: ['something broke'] }),
      })
    );
    expect(truth.reason?.source).toBe('mission-failure-code');
    expect(truth.reason?.text).toContain('preflight failed');
  });

  it('falls back to the run row failure code when the mission record is unreadable', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: {
          kind: 'mission',
          status: 'failure',
          isLive: false,
          tokens: undefined,
          failureCode: 'mcp-internal-key-missing',
        },
        mission: undefined,
      })
    );
    expect(truth.reason?.source).toBe('run-failure-code');
  });

  it('renders an unmapped future failure code verbatim rather than dropping it', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined, failureCode: 'some-new-code' },
      })
    );
    expect(truth.reason).toEqual({ text: 'some-new-code', source: 'run-failure-code' });
  });

  it('prefers the mission errors over the run row copy', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined, errors: ['run-side copy'] },
        mission: mission({ status: 'failed', errors: ['mission-side reason'] }),
      })
    );
    expect(truth.reason).toEqual({ text: 'mission-side reason', source: 'mission-errors' });
  });

  it('ignores blank error strings instead of showing an empty reason', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined, errors: ['   '] },
        mission: mission({ status: 'failed', errors: ['', '  '], progressMessage: 'Mission failed' }),
      })
    );
    expect(truth.reason).toEqual({ text: 'Mission failed', source: 'mission-progress-message' });
  });

  it('states plainly that no reason was recorded rather than inventing one', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined },
        mission: mission({ status: 'failed', progressMessage: undefined, errors: [] }),
      })
    );
    expect(truth.reason).toBeUndefined();
    expect(truth.reasonUnavailable).toBe(true);
  });

  it('does not demand a reason from a successfully delivered run', () => {
    const truth = resolveRunTerminalTruth(
      input({ mission: mission({ outcome: 'delivered', progressMessage: undefined }) })
    );
    expect(truth.reasonUnavailable).toBe(false);
  });

  it('uses the failing quality checks when nothing else stated a reason', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: 10 },
        mission: mission({
          status: 'failed',
          progressMessage: undefined,
          qualityReport: {
            evaluatedAt: '2026-07-29T09:40:00.000Z',
            overallScore: 0.4,
            verdict: 'FAIL',
            checks: [
              { name: 'citations', pass: false, critical: true, detail: 'no sources' },
              { name: 'length', pass: true, critical: false, detail: 'ok' },
            ],
          },
        }),
      })
    );
    expect(truth.reason).toEqual({ text: 'Quality gate FAIL: citations', source: 'quality-verdict' });
  });
});

describe('report pointer — an unresolvable pointer is not "no report"', () => {
  it('exposes the canonical report for a delivered run', () => {
    const truth = resolveRunTerminalTruth(
      input({ mission: mission({ outcome: 'delivered', reportId: 'report-1' }), reports: [report()] })
    );
    expect(truth.reportState).toBe('canonical');
    expect(truth.report).toEqual({
      id: 'report-1',
      title: 'Agentic retrieval landscape',
      href: '/reports/report-1',
    });
  });

  it('exposes the canonical report for a FAILED run that still published one', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: 1000, costUsd: 0.5 },
        mission: mission({ status: 'failed', outcome: 'needs-review', partial: true, reportIds: ['report-1'] }),
        reports: [report()],
      })
    );
    expect(truth.disposition).toBe('needs-review');
    expect(truth.reportState).toBe('canonical');
    expect(truth.report?.href).toBe('/reports/report-1');
  });

  it('says a recorded pointer could not be resolved rather than claiming no report exists', () => {
    const truth = resolveRunTerminalTruth(
      input({ mission: mission({ outcome: 'delivered', reportIds: ['report-9'] }), reports: [] })
    );
    expect(truth.reportState).toBe('referenced-unresolved');
    expect(truth.referencedReportIds).toEqual(['report-9']);
    expect(truth.report).toBeUndefined();
  });

  it('deduplicates reportId against reportIds when listing an unresolved pointer', () => {
    const truth = resolveRunTerminalTruth(
      input({ mission: mission({ reportId: 'report-9', reportIds: ['report-9'] }), reports: [] })
    );
    expect(truth.referencedReportIds).toEqual(['report-9']);
  });

  it('says "none" only when the mission itself recorded no pointer', () => {
    const truth = resolveRunTerminalTruth(
      input({ mission: mission({ outcome: 'no-deliverable', reportIds: [] }), reports: [] })
    );
    expect(truth.reportState).toBe('none');
  });

  it('says "unknown" when no mission record could be read', () => {
    const truth = resolveRunTerminalTruth(input({ mission: undefined, reports: [] }));
    expect(truth.reportState).toBe('unknown');
  });

  it('does not link another owner’s report', () => {
    const truth = resolveRunTerminalTruth(
      input({
        mission: mission({ reportIds: ['report-1'] }),
        reports: [report({ ownerId: 'someone-else' })],
        ownerId: 'u1',
      })
    );
    expect(truth.reportState).toBe('referenced-unresolved');
    expect(truth.report).toBeUndefined();
  });
});

describe('accounting agreement between the run row and the mission doc', () => {
  it('is silent when both records state the same usage and cost', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 1000, costUsd: 0.5 },
        mission: mission({ tokenUsage: { input: 700, output: 300 }, costUsd: 0.5 }),
      })
    );
    expect(truth.accountingDisagreements).toEqual([]);
  });

  it('flags a token split between the two records', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 115, costUsd: 0.5 },
        mission: mission({ tokenUsage: { input: 100, output: 9 }, costUsd: 0.5 }),
      })
    );
    expect(truth.accountingDisagreements).toEqual([{ field: 'tokens', runValue: '115', missionValue: '109' }]);
  });

  it('flags a run row that states a cost the mission proves unavailable', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 1000, costUsd: 0.5 },
        mission: mission({ tokenUsage: { input: 700, output: 300 }, costUsd: undefined }),
      })
    );
    expect(truth.accountingDisagreements).toEqual([
      { field: 'cost', runValue: '$0.5000', missionValue: 'unavailable' },
    ]);
  });

  it('treats both-unavailable as agreement, not as a split', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: undefined, costUsd: undefined },
        mission: mission({ status: 'failed', tokenUsage: undefined, costUsd: undefined }),
      })
    );
    expect(truth.accountingDisagreements).toEqual([]);
  });

  it('does not flag float noise between two records derived from the same accumulators', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 1000, costUsd: 0.1 + 0.2 },
        mission: mission({ tokenUsage: { input: 700, output: 300 }, costUsd: 0.3 }),
      })
    );
    expect(truth.accountingDisagreements).toEqual([]);
  });

  it('claims no agreement at all when the mission record could not be read', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 1000, costUsd: 0.5 },
        mission: undefined,
      })
    );
    expect(truth.accountingDisagreements).toEqual([]);
    expect(truth.reportState).toBe('unknown');
  });
});

describe('event trail agreement', () => {
  it('is silent when the trail and the record agree', () => {
    const truth = resolveRunTerminalTruth(
      input({
        mission: mission({ outcome: 'delivered' }),
        events: [{ type: 'agent.started' }, { type: 'agent.completed' }],
      })
    );
    expect(truth.eventTrailContradiction).toBeUndefined();
  });

  it('says so when the step log records an error against a successful run', () => {
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'success', isLive: false, tokens: 10 },
        mission: mission({ outcome: 'delivered' }),
        events: [{ type: 'agent.started' }, { type: 'agent.error' }],
      })
    );
    expect(truth.eventTrailContradiction).toContain('records an error');
  });

  it('does not treat a completed SDK event on a needs-review draft as a contradiction', () => {
    // The SDK legitimately completes and the report-truth resolver then marks
    // the mission failed-with-a-retained-draft. Flagging that would cry wolf.
    const truth = resolveRunTerminalTruth(
      input({
        run: { kind: 'mission', status: 'failure', isLive: false, tokens: 10 },
        mission: mission({ status: 'failed', outcome: 'needs-review', partial: true }),
        events: [{ type: 'agent.completed' }],
      })
    );
    expect(truth.eventTrailContradiction).toBeUndefined();
  });

  it('treats an absent or expired trail as unknown, never as a contradiction', () => {
    expect(resolveRunTerminalTruth(input({ events: [] })).eventTrailContradiction).toBeUndefined();
    expect(resolveRunTerminalTruth(input({})).eventTrailContradiction).toBeUndefined();
  });
});
