/**
 * @jest-environment node
 *
 * P3-B observability: job-run-tracking Inngest middleware.
 *
 * Wires `recordJobStart` / `recordJobComplete` / `recordJobFailure`
 * (observability.ts — previously 0 callers) into EVERY registered function
 * via a client-level middleware, so job runs land in the `job-runs`
 * Firestore collection without editing 37 function files.
 *
 * Drives the middleware's lifecycle hooks directly (the same shape the
 * Inngest SDK calls them with) — no live Inngest.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('@/lib/inngest/observability', () => ({
  __esModule: true,
  recordJobStart: jest.fn().mockResolvedValue('job-run-doc-id'),
  recordJobComplete: jest.fn().mockResolvedValue(undefined),
  recordJobFailure: jest.fn().mockResolvedValue(undefined),
}));

// The real client pulls env + registers the middleware; keep the logger quiet.
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { recordJobStart, recordJobComplete, recordJobFailure } from '@/lib/inngest/observability';
import { declareDomainOutcome } from '@/lib/inngest/domain-outcome';
import { jobRunTrackingMiddleware } from '../job-run-tracking';

const mockStart = recordJobStart as jest.Mock;
const mockComplete = recordJobComplete as jest.Mock;
const mockFailure = recordJobFailure as jest.Mock;

interface RunHooks {
  beforeExecution?: () => Promise<void>;
  finished?: (arg: { result: { data?: unknown; error?: unknown } }) => Promise<void>;
}

/** Drive init() → onFunctionRun() the way the SDK does and return the run hooks. */
async function getRunHooks({
  steps = [] as unknown[],
  runId = 'RUN-1',
  functionId = 'my-function',
  functionName = 'My Function',
  eventData = undefined as Record<string, unknown> | undefined,
} = {}): Promise<RunHooks> {
  const registered = await jobRunTrackingMiddleware.init();
  const fn = { id: () => functionId, name: functionName };
  const onFunctionRun = registered.onFunctionRun!;
  const hooks = await onFunctionRun({
    ctx: { event: { name: 'app/test.event', data: eventData }, runId },
    fn,
    steps,
    reqArgs: [],
  } as never);
  return hooks as RunHooks;
}

describe('jobRunTrackingMiddleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a job start on the first request of a run (no memoized steps)', async () => {
    const hooks = await getRunHooks({ steps: [], runId: 'RUN-A' });
    await hooks.beforeExecution!();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event' },
      'inngest-RUN-A',
      undefined
    );
  });

  it('threads a string entityId from the event data into the recorded input (CLEANUP-001)', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-E', eventData: { entityId: 'ent-42' } });
    await hooks.beforeExecution!();
    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event', entityId: 'ent-42' },
      'inngest-RUN-E',
      undefined
    );
  });

  // ARUN-023: the cancellation event carries only function_id/run_id and never
  // the original event, so a cancelled run's mission link has no other moment
  // at which it could be established.
  it('threads a bounded missionId from the event data into the recorded input', async () => {
    const hooks = await getRunHooks({
      runId: 'RUN-M',
      eventData: { missionId: 'mission-fixture-job-run-a1b2c3' },
    });
    await hooks.beforeExecution!();
    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event', missionId: 'mission-fixture-job-run-a1b2c3' },
      'inngest-RUN-M',
      undefined
    );
  });

  it('discards an out-of-contract missionId rather than persisting caller text', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-X', eventData: { missionId: '../../etc/passwd' } });
    await hooks.beforeExecution!();
    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event' },
      'inngest-RUN-X',
      undefined
    );
  });

  it('omits entityId when the event data has none or it is not a string', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-F', eventData: { entityId: 123 } });
    await hooks.beforeExecution!();
    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event' },
      'inngest-RUN-F',
      undefined
    );
  });

  it('persists a strict correlation token in bounded input and the queryable field', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    const hooks = await getRunHooks({ runId: 'RUN-CORR', eventData: { correlationId, notes: 'not copied' } });
    await hooks.beforeExecution!();

    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event', correlationId },
      'inngest-RUN-CORR',
      correlationId
    );
  });

  it('does not copy a malformed correlation value into job diagnostics', async () => {
    const hooks = await getRunHooks({
      runId: 'RUN-BAD-CORR',
      eventData: { correlationId: 'customer@example.test secret payload' },
    });
    await hooks.beforeExecution!();

    expect(mockStart).toHaveBeenCalledWith(
      'my-function',
      'My Function',
      { event: 'app/test.event' },
      'inngest-RUN-BAD-CORR',
      undefined
    );
  });

  it('does NOT re-record the start on later requests of the same run (memoized steps present)', async () => {
    const hooks = await getRunHooks({ steps: [{ id: 'step-1', data: {} }] });
    await hooks.beforeExecution!();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('records completion with the function output when the run finishes cleanly', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-B' });
    await hooks.finished!({ result: { data: { synced: 3, success: true } } });
    // OBS-001: an undeclared return passes NO declaration through. Note that a
    // plain `success: true` field is deliberately NOT treated as a declaration —
    // inferring business outcomes from field names is the guessing this row
    // exists to remove.
    expect(mockComplete).toHaveBeenCalledWith('inngest-RUN-B', { synced: 3, success: true }, undefined, undefined);
    expect(mockFailure).not.toHaveBeenCalled();
  });

  it('wraps non-object outputs so the Firestore record stays a map', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-C' });
    await hooks.finished!({ result: { data: 42 } });
    expect(mockComplete).toHaveBeenCalledWith('inngest-RUN-C', { value: 42 }, undefined, undefined);
  });

  it('records a failure when the final result carries an error', async () => {
    const hooks = await getRunHooks({ runId: 'RUN-D' });
    const boom = new Error('neo4j down');
    await hooks.finished!({ result: { error: boom } });
    expect(mockFailure).toHaveBeenCalledTimes(1);
    expect(mockFailure.mock.calls[0][0]).toBe('inngest-RUN-D');
    expect((mockFailure.mock.calls[0][1] as Error).message).toBe('neo4j down');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // OBS-001 — transport completion vs declared business outcome
  // ==========================================================================

  describe('OBS-001 domain-outcome declarations', () => {
    it('passes a declared domain failure through even though the transport completed', async () => {
      // The exact TEST-027 Creator shape: the Inngest run returned cleanly while
      // the canonical Mission/AgentRun failed and no Report existed. Pre-fix the
      // record read `status: 'completed'` with nothing to contradict it.
      const hooks = await getRunHooks({ runId: 'RUN-DOMAIN-FAIL' });
      await hooks.finished!({
        result: {
          data: declareDomainOutcome(
            { missionId: 'mission-1', duration: 1200 },
            { outcome: 'failed', reason: 'no-deliverable' }
          ),
        },
      });
      expect(mockComplete).toHaveBeenCalledWith(
        'inngest-RUN-DOMAIN-FAIL',
        // The reserved key is stripped: `output` keeps the shape existing
        // readers (e.g. the Defense Minister join) already parse by schema.
        { missionId: 'mission-1', duration: 1200 },
        undefined,
        { outcome: 'failed', reason: 'no-deliverable' }
      );
      expect(mockFailure).not.toHaveBeenCalled();
    });

    it('forwards a declaration alongside a transport failure so recovered output survives', async () => {
      const hooks = await getRunHooks({ runId: 'RUN-DOMAIN-PARTIAL' });
      await hooks.finished!({
        result: {
          data: declareDomainOutcome({ missionId: 'mission-2' }, { outcome: 'partial' }),
          error: new Error('final persistence threw'),
        },
      });
      expect(mockFailure).toHaveBeenCalledWith('inngest-RUN-DOMAIN-PARTIAL', expect.any(Error), 0, {
        outcome: 'partial',
      });
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('never fabricates a declaration from a malformed envelope', async () => {
      const hooks = await getRunHooks({ runId: 'RUN-DOMAIN-BAD' });
      await hooks.finished!({ result: { data: { __domainOutcome: { outcome: 'completed' } } } });
      const [, output, , declaration] = mockComplete.mock.calls[0] as [
        string,
        Record<string, unknown>,
        unknown,
        unknown,
      ];
      expect(declaration).toBeUndefined();
      // A malformed envelope is left in the output rather than silently dropped,
      // so the bad producer is diagnosable from the record itself.
      expect(output).toEqual({ __domainOutcome: { outcome: 'completed' } });
    });
  });

  it('never throws into the function run when recording itself fails', async () => {
    mockStart.mockRejectedValueOnce(new Error('firestore offline'));
    const hooks = await getRunHooks();
    await expect(hooks.beforeExecution!()).resolves.toBeUndefined();
  });
});

describe('client wiring', () => {
  it('the shared Inngest client registers the middleware for all functions', async () => {
    const { inngest } = await import('@/lib/inngest/client');
    const options = (inngest as unknown as { options: { middleware?: unknown[] } }).options;
    expect(options.middleware).toBeDefined();
    expect(options.middleware).toContain(jobRunTrackingMiddleware);
    expect(options.middleware?.filter((middleware) => middleware === jobRunTrackingMiddleware)).toHaveLength(1);
  });
});

describe('exclusive tracking ownership for formerly duplicated functions', () => {
  const functions = [
    {
      functionId: 'daily-pipeline',
      functionName: 'Daily Pipeline',
      source: 'src/lib/inngest/functions/daily-pipeline.ts',
    },
    {
      functionId: 'run-evaluation-agent',
      functionName: 'Run Evaluation Agent',
      source: 'src/lib/inngest/functions/run-evaluation-agent.ts',
    },
  ];

  beforeEach(() => jest.clearAllMocks());

  it.each(functions)(
    'records exactly one middleware lifecycle for $functionId',
    async ({ functionId, functionName }) => {
      const runId = `RUN-${functionId}`;
      const hooks = await getRunHooks({ functionId, functionName, runId });

      await hooks.beforeExecution!();
      await hooks.finished!({ result: { data: { success: true } } });

      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledWith(
        functionId,
        functionName,
        { event: 'app/test.event' },
        `inngest-${runId}`,
        undefined
      );
      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(mockComplete).toHaveBeenCalledWith(`inngest-${runId}`, { success: true }, undefined, undefined);
      expect(mockFailure).not.toHaveBeenCalled();
    }
  );

  it.each(functions)('$functionId has no legacy manual job-run tracker', ({ source }) => {
    const implementation = readFileSync(resolve(process.cwd(), source), 'utf8');

    expect(implementation).not.toMatch(/\bcreateObservableJob\b/);
    expect(implementation).not.toMatch(/\brecordJob(?:Start|Complete|Failure)\b/);
  });
});
