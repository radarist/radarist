/**
 * Unit tests for event-retention (CLEANUP-001).
 *
 * The safety-critical assertion: active/retry anchors (`running`/`retrying`) are
 * NEVER retention-eligible, no matter how old — only terminal rows past the age
 * window are. Plus preview counts and bounded batching.
 */
import {
  isJobRunRetentionEligible,
  isAgentEventRetentionEligible,
  summarizeJobRunRetention,
  summarizeAgentEventRetention,
  planRetentionBatches,
  RETENTION_BATCH_SIZE,
  TERMINAL_JOB_STATUSES,
  ACTIVE_JOB_STATUSES,
  type JobRunRecord,
  type RetentionPolicy,
} from '../event-retention';

const NOW = 10_000_000_000; // fixed ms epoch
const DAY = 24 * 60 * 60 * 1000;
const policy: RetentionPolicy = { olderThanMs: 30 * DAY, now: NOW };

function job(over: Partial<JobRunRecord>): JobRunRecord {
  return { id: 'j', status: 'completed', startedAt: NOW - 100 * DAY, ...over };
}

describe('isJobRunRetentionEligible — active anchors are protected', () => {
  it.each(['running', 'retrying'])('never deletes a %s anchor even when ancient', (status) => {
    expect(isJobRunRetentionEligible(job({ status, startedAt: NOW - 999 * DAY }), policy)).toBe(false);
  });

  it('treats any unknown non-terminal status as protected', () => {
    expect(isJobRunRetentionEligible(job({ status: 'paused', startedAt: NOW - 999 * DAY }), policy)).toBe(false);
  });

  it('deletes a terminal row past the age window', () => {
    expect(isJobRunRetentionEligible(job({ status: 'completed', completedAt: NOW - 40 * DAY }), policy)).toBe(true);
    expect(isJobRunRetentionEligible(job({ status: 'failed', completedAt: NOW - 40 * DAY }), policy)).toBe(true);
  });

  it('keeps a terminal row still inside the age window', () => {
    expect(isJobRunRetentionEligible(job({ status: 'completed', completedAt: NOW - 10 * DAY }), policy)).toBe(false);
  });

  it('falls back to startedAt when completedAt is absent', () => {
    expect(
      isJobRunRetentionEligible(job({ status: 'failed', startedAt: NOW - 40 * DAY, completedAt: undefined }), policy)
    ).toBe(true);
  });
});

describe('summarizeJobRunRetention — preview counts', () => {
  it('counts eligible, retained anchors, and byStatus without deleting anything', () => {
    const records: JobRunRecord[] = [
      job({ id: 'a', status: 'completed', completedAt: NOW - 40 * DAY }), // eligible
      job({ id: 'b', status: 'failed', completedAt: NOW - 40 * DAY }), // eligible
      job({ id: 'c', status: 'completed', completedAt: NOW - 5 * DAY }), // too recent
      job({ id: 'd', status: 'running', startedAt: NOW - 200 * DAY }), // anchor
      job({ id: 'e', status: 'retrying', startedAt: NOW - 200 * DAY }), // anchor
    ];
    const s = summarizeJobRunRetention(records, policy);
    expect(s.total).toBe(5);
    expect(s.eligible).toBe(2);
    expect(s.eligibleIds.sort()).toEqual(['a', 'b']);
    expect(s.retainedActiveAnchors).toBe(2);
    expect(s.byStatus).toEqual({ completed: 2, failed: 1, running: 1, retrying: 1 });
  });
});

describe('summarizeAgentEventRetention', () => {
  it('selects only events older than the window', () => {
    const s = summarizeAgentEventRetention(
      [
        { id: 'old', createdAtMs: NOW - 40 * DAY },
        { id: 'new', createdAtMs: NOW - 1 * DAY },
      ],
      policy
    );
    expect(s.eligible).toBe(1);
    expect(s.eligibleIds).toEqual(['old']);
  });

  it('respects the eligibility predicate directly', () => {
    expect(isAgentEventRetentionEligible({ id: 'x', createdAtMs: NOW - 40 * DAY }, policy)).toBe(true);
    expect(isAgentEventRetentionEligible({ id: 'y', createdAtMs: NOW - 2 * DAY }, policy)).toBe(false);
  });

  it('FAILS SAFE on a missing/invalid timestamp (0 or NaN is never eligible)', () => {
    expect(isAgentEventRetentionEligible({ id: 'z0', createdAtMs: 0 }, policy)).toBe(false);
    expect(isAgentEventRetentionEligible({ id: 'zn', createdAtMs: Number.NaN }, policy)).toBe(false);
    const s = summarizeAgentEventRetention(
      [
        { id: 'missing', createdAtMs: 0 },
        { id: 'old', createdAtMs: NOW - 40 * DAY },
      ],
      policy
    );
    expect(s.eligibleIds).toEqual(['old']); // the 0-timestamp event is protected
  });
});

describe('planRetentionBatches — bounded idempotent batches', () => {
  it('defaults to the Firestore-safe batch size', () => {
    expect(RETENTION_BATCH_SIZE).toBeLessThanOrEqual(450);
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const batches = planRetentionBatches(ids);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(450);
    expect(batches[2]).toHaveLength(100);
    expect(batches.flat()).toHaveLength(1000);
  });

  it('rejects a non-positive batch size', () => {
    expect(() => planRetentionBatches(['a'], 0)).toThrow();
  });
});

describe('ARUN-023 cancelled job-runs are reapable', () => {
  const policy = { olderThanMs: 1_000, now: 10_000 };

  it('treats cancelled as terminal', () => {
    expect(TERMINAL_JOB_STATUSES).toContain('cancelled');
  });

  // A status missing from TERMINAL_JOB_STATUSES is a protected anchor and can
  // NEVER be reaped, so omitting it would leak one permanent row per cancel.
  it('reaps an aged cancelled run', () => {
    expect(
      isJobRunRetentionEligible({ id: 'r', status: 'cancelled', startedAt: 0, completedAt: 100 }, policy)
    ).toBe(true);
  });

  it('still protects a cancelled run inside the age window', () => {
    expect(
      isJobRunRetentionEligible({ id: 'r', status: 'cancelled', startedAt: 0, completedAt: 9_500 }, policy)
    ).toBe(false);
  });

  it('still protects in-flight runs', () => {
    for (const status of ACTIVE_JOB_STATUSES) {
      expect(isJobRunRetentionEligible({ id: 'r', status, startedAt: 0, completedAt: 100 }, policy)).toBe(false);
    }
  });
});
