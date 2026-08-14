/**
 * @jest-environment node
 *
 * P3-B failure digest: daily cron that reads the `job-runs` records written
 * by the job-run-tracking middleware and surfaces (a) functions with failed
 * runs and (b) functions whose runs were 100% skipped in the last 24h, as a
 * structured log line + structured return (itself recorded to job-runs).
 */

jest.mock('@/lib/logger', () => {
  const _mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => _mockLogger) };
});

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({ config, trigger, handler })),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

// job-run docs returned by the Firestore query
const jobRunsFixture: { current: Array<Record<string, unknown>> } = { current: [] };
// GRAPH-059: terminal relation delete markers, read straight from the outbox
// (they never appear in job-runs — the replayer succeeds when it gives up).
const exhaustedOutboxFixture: { current: Array<{ id: string; data: Record<string, unknown> }> } = { current: [] };
const mockGet = jest.fn(async () => ({
  size: jobRunsFixture.current.length,
  docs: jobRunsFixture.current.map((d) => ({ data: () => d })),
}));
const mockOutboxGet = jest.fn(async () => ({
  size: exhaustedOutboxFixture.current.length,
  docs: exhaustedOutboxFixture.current.map((d) => ({ id: d.id, data: () => d.data })),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((name: string) => ({
      where: jest.fn(() => ({
        get: name === 'relationSyncOutbox' ? mockOutboxGet : mockGet,
      })),
    })),
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })) },
}));

import { graphFailureDigestJob } from '../graph-failure-digest';

const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

type HandlerJob = {
  config: { id: string };
  trigger: unknown;
  handler: (args: {
    step: { run: <T>(name: string, fn: () => Promise<T>) => Promise<T> };
  }) => Promise<Record<string, unknown>>;
};

const step = { run: async <T>(_name: string, fn: () => Promise<T>) => fn() };

function run(): Promise<Record<string, unknown>> {
  return (graphFailureDigestJob as unknown as HandlerJob).handler({ step });
}

describe('graph-failure-digest (P3-B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jobRunsFixture.current = [];
    exhaustedOutboxFixture.current = [];
  });

  it('registers as a daily cron', () => {
    const job = graphFailureDigestJob as unknown as HandlerJob;
    expect(job.config.id).toBe('graph-failure-digest');
    expect(JSON.stringify(job.trigger)).toContain('cron');
  });

  it('reports a clean window when no runs failed or skipped', async () => {
    jobRunsFixture.current = [
      { functionId: 'sync-entity-to-neo4j', status: 'completed', output: { success: true } },
      { functionId: 'sync-entity-to-neo4j', status: 'completed', output: { success: true } },
    ];
    const result = await run();
    expect(result.totalRuns).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.fullySkipped).toEqual([]);
    expect(result.clean).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('surfaces functions with failed runs, including sample error messages', async () => {
    jobRunsFixture.current = [
      { functionId: 'sync-relation-to-neo4j', status: 'completed' },
      {
        functionId: 'sync-relation-to-neo4j',
        status: 'failed',
        error: { message: 'Neo4j not healthy: connection refused' },
      },
      { functionId: 'sync-relation-to-neo4j', status: 'retrying', error: { message: 'timeout' } },
    ];
    const result = await run();
    expect(result.clean).toBe(false);
    const failures = result.failures as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(failures[0].functionId).toBe('sync-relation-to-neo4j');
    expect(failures[0].failedRuns).toBe(2);
    expect(failures[0].totalRuns).toBe(3);
    expect(failures[0].sampleErrors).toContain('Neo4j not healthy: connection refused');
    // The digest itself must be loud in the logs.
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('surfaces functions whose runs were 100% skipped (silent-skip visibility)', async () => {
    jobRunsFixture.current = [
      { functionId: 'verify-entity', status: 'completed', output: { skipped: true, reason: 'x' } },
      { functionId: 'verify-entity', status: 'completed', output: { skipped: true, reason: 'x' } },
      { functionId: 'fetch-signals', status: 'completed', output: { skipped: false } },
    ];
    const result = await run();
    expect(result.clean).toBe(false);
    const fullySkipped = result.fullySkipped as Array<Record<string, unknown>>;
    expect(fullySkipped).toHaveLength(1);
    expect(fullySkipped[0].functionId).toBe('verify-entity');
    expect(fullySkipped[0].totalRuns).toBe(2);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('a partially-skipped function is not flagged as fully skipped', async () => {
    jobRunsFixture.current = [
      { functionId: 'verify-entity', status: 'completed', output: { skipped: true, reason: 'x' } },
      { functionId: 'verify-entity', status: 'completed', output: { verified: true } },
    ];
    const result = await run();
    expect(result.fullySkipped).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it('a wholly maintenance-paused function is surfaced separately and stays clean (OPS-001)', async () => {
    jobRunsFixture.current = [
      {
        functionId: 'reconcile-firestore-neo4j',
        status: 'completed',
        output: { skipped: true, reason: 'maintenance-paused' },
      },
      {
        functionId: 'reconcile-firestore-neo4j',
        status: 'completed',
        output: { skipped: true, reason: 'maintenance-paused' },
      },
    ];
    const result = await run();
    expect(result.fullySkipped).toEqual([]);
    const paused = result.maintenancePaused as Array<Record<string, unknown>>;
    expect(paused).toHaveLength(1);
    expect(paused[0].functionId).toBe('reconcile-firestore-neo4j');
    expect(paused[0].totalRuns).toBe(2);
    // An intentional pause is not an anomaly — no warn.
    expect(result.clean).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('a 100%-skipped function is still flagged when the skips are not all maintenance pauses', async () => {
    jobRunsFixture.current = [
      {
        functionId: 'detect-emergence',
        status: 'completed',
        output: { skipped: true, reason: 'maintenance-paused' },
      },
      { functionId: 'detect-emergence', status: 'completed', output: { skipped: true, reason: 'no-op' } },
    ];
    const result = await run();
    const fullySkipped = result.fullySkipped as Array<Record<string, unknown>>;
    expect(fullySkipped).toHaveLength(1);
    expect(fullySkipped[0].functionId).toBe('detect-emergence');
    expect(result.maintenancePaused).toEqual([]);
    expect(result.clean).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ==========================================================================
  // GRAPH-059 — a terminal delete marker is the operator-visible signal
  // ==========================================================================

  function exhaustedMarker(relationId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: relationId,
      data: {
        relationId,
        deleteToken: `${relationId}:1:token`,
        operation: 'delete',
        status: 'exhausted',
        attempt: 12,
        nextAttemptAt: 5_000,
        lastError: 'Neo4j refused the connection',
        exhaustedAt: 9_000,
        createdAt: 1,
        updatedAt: 9_000,
        ...overrides,
      },
    };
  }

  it('keeps a green job window unclean while a relation delete is terminally stuck', async () => {
    jobRunsFixture.current = [{ functionId: 'sync-relation-to-neo4j', status: 'completed', output: { success: true } }];
    exhaustedOutboxFixture.current = [exhaustedMarker('rel-stuck')];

    const result = await run();

    expect(result.failures).toEqual([]);
    expect(result.fullySkipped).toEqual([]);
    expect(result.exhaustedRelationDeleteCount).toBe(1);
    expect(result.exhaustedRelationDeletes).toEqual([
      { relationId: 'rel-stuck', attempt: 12, exhaustedAt: 9_000, lastError: 'Neo4j refused the connection' },
    ]);
    expect(result.clean).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exhausted graph deletes'),
      expect.objectContaining({ exhaustedRelationDeleteCount: 1 })
    );
  });

  it('reports the newest terminal transition first and bounds the sample', async () => {
    exhaustedOutboxFixture.current = Array.from({ length: 12 }, (_unused, index) =>
      exhaustedMarker(`rel-${index}`, { exhaustedAt: 1_000 + index })
    );

    const result = await run();

    expect(result.exhaustedRelationDeleteCount).toBe(12);
    const sample = result.exhaustedRelationDeletes as Array<Record<string, unknown>>;
    expect(sample).toHaveLength(10);
    expect(sample[0].relationId).toBe('rel-11');
  });

  it('counts a malformed terminal marker even though it cannot be sampled', async () => {
    exhaustedOutboxFixture.current = [exhaustedMarker('rel-bad', { deleteToken: '' })];

    const result = await run();

    // Silently shrinking the census would report "nothing stuck" while a
    // corrupt marker sits there forever.
    expect(result.exhaustedRelationDeleteCount).toBe(1);
    expect(result.exhaustedRelationDeletes).toEqual([]);
    expect(result.clean).toBe(false);
  });

  it('stays clean when the outbox holds no terminal markers', async () => {
    jobRunsFixture.current = [{ functionId: 'sync-relation-to-neo4j', status: 'completed', output: { success: true } }];

    const result = await run();

    expect(result.exhaustedRelationDeleteCount).toBe(0);
    expect(result.exhaustedRelationDeletes).toEqual([]);
    expect(result.clean).toBe(true);
  });
});
