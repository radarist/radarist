/** STATUS.json / checks.json / qa-report contracts + stall detection. */
import { checksFileSchema, failureFingerprintInput, type CheckResult } from '../src/sandbox/checks.js';
import { StallTracker } from '../src/sandbox/stall.js';
import { INITIAL_STATUS, qaReportSchema, statusSchema, verdictSchema } from '../src/sandbox/status.js';

describe('statusSchema', () => {
  it('accepts the seed status and a realistic mid-mission status', () => {
    expect(statusSchema.parse(INITIAL_STATUS).phase).toBe('00-inception');
    const parsed = statusSchema.parse({
      phase: '06-build',
      readyForQa: false,
      stories: [{ id: 'S1', title: 't', status: 'in-progress', cuttable: false }],
      blocked: null,
      handoff: { reason: 'cap', nextObjective: 'finish S1' },
      notes: ['2026-06-11: note'],
    });
    expect(parsed.handoff?.nextObjective).toBe('finish S1');
  });

  it('rejects unknown phases and missing handoff fields', () => {
    expect(statusSchema.safeParse({ ...INITIAL_STATUS, phase: '99-nope' }).success).toBe(false);
    expect(statusSchema.safeParse({ ...INITIAL_STATUS, handoff: { reason: 'r' } }).success).toBe(false);
  });
});

describe('verdictSchema (E1 — technology evaluation)', () => {
  it('parses a full verdict and defaults arrays', () => {
    const v = verdictSchema.parse({
      trl: 6,
      confidence: 82,
      recommendation: 'trial',
      metrics: [{ name: 'p99 latency', value: '12ms', command: 'npm run bench' }],
      findings: [{ title: '2.1x faster on our workload', kind: 'benchmark', metric: '2.1x', confidence: 80 }],
      summary: 'Solid for our use.',
    });
    expect(v.trl).toBe(6);
    expect(v.recommendation).toBe('trial');
    expect(v.findings[0].kind).toBe('benchmark');
    expect(verdictSchema.parse({}).metrics).toEqual([]); // tolerant of a bare object
  });

  it('rejects an out-of-range TRL and a bad recommendation', () => {
    expect(verdictSchema.safeParse({ trl: 12 }).success).toBe(false);
    expect(verdictSchema.safeParse({ recommendation: 'buy' }).success).toBe(false);
  });
});

describe('qaReportSchema', () => {
  it('parses a real-shaped report and rejects bad verdicts', () => {
    const report = qaReportSchema.parse({
      verdict: 'FAIL',
      checkedAt: '2026-06-11T10:45:00Z',
      summary: 's',
      findings: [{ severity: 'major', title: 't', detail: 'd', story: 'S2' }],
    });
    expect(report.findings[0].severity).toBe('major');
    expect(qaReportSchema.safeParse({ verdict: 'MAYBE', checkedAt: 'x' }).success).toBe(false);
  });
});

describe('checksFileSchema', () => {
  it('parses the phase-04 contract shape', () => {
    const parsed = checksFileSchema.parse({
      checks: [{ id: 'S1-AC1', story: 'S1', files: ['src/**'], command: 'npx vitest run' }],
    });
    expect(parsed.checks[0].files).toEqual(['src/**']);
  });

  it('rejects an empty check contract', () => {
    expect(checksFileSchema.safeParse({ checks: [] }).success).toBe(false);
  });
});

describe('failureFingerprintInput', () => {
  const failing = (output: string): CheckResult => ({ id: 'S1-AC1', story: 'S1', ok: false, output });

  it('is stable across volatile tokens (durations, ports, dates, hashes)', () => {
    const a = failureFingerprintInput([
      failing('failed in 123ms on localhost:4101 at 2026-06-11T10:00:00Z commit ab12cd3'),
    ]);
    const b = failureFingerprintInput([
      failing('failed in 99ms on localhost:4188 at 2026-06-12T08:30:00Z commit ff99aa1'),
    ]);
    expect(a).toBe(b);
  });

  it('is empty when nothing fails and distinct for different failures', () => {
    expect(failureFingerprintInput([{ id: 'x', story: 'S1', ok: true, output: 'ok' }])).toBe('');
    const a = failureFingerprintInput([failing('TypeError: x is not a function')]);
    const b = failureFingerprintInput([failing('AssertionError: expected 4 rows')]);
    expect(a).not.toBe(b);
  });
});

describe('StallTracker', () => {
  it('continues on first failure, escalates on the 2nd identical, pauses on the 3rd', () => {
    const tracker = new StallTracker(2, 3);
    expect(tracker.record('same failure')).toBe('continue');
    expect(tracker.record('same failure')).toBe('escalate');
    expect(tracker.record('same failure')).toBe('pause');
  });

  it('resets the streak on a different failure or on success', () => {
    const tracker = new StallTracker(2, 3);
    tracker.record('failure A');
    expect(tracker.record('failure B')).toBe('continue'); // different → streak restarts
    tracker.record('failure B');
    expect(tracker.record('')).toBe('continue'); // success clears
    expect(tracker.streak).toBe(0);
  });

  it('rehydrates from persisted state (supervisor resume path)', () => {
    const tracker = new StallTracker(2, 3);
    tracker.record('same');
    const resumed = StallTracker.fromPersisted(2, 3, tracker.currentHash, tracker.streak);
    expect(resumed.record('same')).toBe('escalate');
  });
});
