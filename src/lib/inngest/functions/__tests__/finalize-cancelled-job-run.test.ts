/**
 * @file finalize-cancelled-job-run.test.ts
 * @description ARUN-023 — a server-cancelled Inngest run must reach exactly one
 * terminal job-run record, correlated to its mission, without fabricating
 * provider usage or overwriting an authoritative result.
 *
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, createLogger: () => mockLogger, __mockLogger: mockLogger };
});

type AnyFunction = (...args: unknown[]) => Promise<unknown>;

interface Registry {
  handlers: Record<string, AnyFunction>;
  configs: Record<string, Record<string, unknown>>;
  triggers: Record<string, unknown>;
}

// The registry must be created INSIDE the factory: jest hoists jest.mock above
// module-scope consts, so referencing an outer binding here throws
// "Cannot access before initialization" at import time.
jest.mock('@/lib/inngest/client', () => {
  const registry: Registry = { handlers: {}, configs: {}, triggers: {} };
  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return handler;
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: registry,
  };
});

const mockRecordJobCancelled = jest.fn();
jest.mock('@/lib/inngest/observability', () => ({
  __esModule: true,
  recordJobCancelled: (...args: unknown[]) => mockRecordJobCancelled(...args),
}));

import { jobRunDocIdForRun } from '../finalize-cancelled-job-run';

const HANDLER_ID = 'finalize-cancelled-job-run';

function getRegistry(): Registry {
  return (require('@/lib/inngest/client') as { _registry: Registry })._registry;
}

function buildStep() {
  return { run: jest.fn((_name: string, fn: AnyFunction) => fn()) };
}

async function invoke(data: Record<string, unknown>, step: unknown = buildStep()) {
  return getRegistry().handlers[HANDLER_ID]({ event: { name: 'inngest/function.cancelled', data }, step });
}

describe('ARUN-023 finalizeCancelledJobRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordJobCancelled.mockResolvedValue('cancelled');
  });

  describe('registration', () => {
    it('subscribes to the SDK cancellation event', () => {
      // cancelOn is enforced Inngest-side and never re-enters the SDK, so an
      // event trigger is the only path that fires on cancellation.
      expect(getRegistry().triggers[HANDLER_ID]).toEqual({ event: 'inngest/function.cancelled' });
    });

    it('retries, because the write throws on infrastructure failure', () => {
      expect(getRegistry().configs[HANDLER_ID].retries).toBe(3);
    });
  });

  describe('doc id derivation', () => {
    // A mismatch here would create an orphan document instead of terminalizing
    // the record the middleware actually started.
    it('matches the middleware derivation exactly', () => {
      expect(jobRunDocIdForRun('01HRUN')).toBe('inngest-01HRUN');
    });
  });

  describe('terminalization', () => {
    it('terminalizes the run addressed by the cancellation payload', async () => {
      const result = await invoke({ run_id: '01HRUN', function_id: 'run-build-mission' });

      expect(mockRecordJobCancelled).toHaveBeenCalledWith('inngest-01HRUN');
      expect(result).toMatchObject({
        finalized: true,
        runDocId: 'inngest-01HRUN',
        functionId: 'run-build-mission',
        outcome: 'cancelled',
      });
    });

    // Replay must converge on ONE terminal record, not a second write.
    it('reports an already-cancelled replay without claiming new work', async () => {
      mockRecordJobCancelled.mockResolvedValue('already-cancelled');

      const result = await invoke({ run_id: '01HRUN', function_id: 'run-build-mission' });

      expect(result).toMatchObject({ finalized: false, outcome: 'already-cancelled' });
    });

    // The mission result written by /api/missions/[id]/cancel stays authoritative.
    it('preserves a run that had already completed or failed', async () => {
      mockRecordJobCancelled.mockResolvedValue('already-terminal');

      expect(await invoke({ run_id: '01HRUN' })).toMatchObject({
        finalized: false,
        outcome: 'already-terminal',
      });
    });

    it('reports a missing record honestly rather than creating one', async () => {
      mockRecordJobCancelled.mockResolvedValue('not-found');

      expect(await invoke({ run_id: '01HGONE' })).toMatchObject({ finalized: false, outcome: 'not-found' });
    });

    it('never invents tokens, provider or cost', async () => {
      const result = (await invoke({ run_id: '01HRUN' })) as Record<string, unknown>;

      for (const forbidden of ['tokens', 'tokenUsage', 'provider', 'cost', 'costUsd']) {
        expect(result).not.toHaveProperty(forbidden);
      }
      // The writer is called with the doc id ALONE — no usage payload exists to
      // pass, and none may be synthesized.
      expect(mockRecordJobCancelled).toHaveBeenCalledWith('inngest-01HRUN');
      expect(mockRecordJobCancelled.mock.calls[0]).toHaveLength(1);
    });
  });

  describe('malformed payloads', () => {
    it('reports a missing run_id instead of terminalizing something arbitrary', async () => {
      const result = await invoke({ function_id: 'run-build-mission' });

      expect(result).toEqual({ finalized: false, reason: 'missing-run-id' });
      expect(mockRecordJobCancelled).not.toHaveBeenCalled();
    });

    it('ignores a non-string run_id', async () => {
      expect(await invoke({ run_id: 42 })).toEqual({ finalized: false, reason: 'missing-run-id' });
      expect(mockRecordJobCancelled).not.toHaveBeenCalled();
    });
  });

  describe('propagation', () => {
    it('rethrows an infrastructure failure so Inngest retries', async () => {
      mockRecordJobCancelled.mockRejectedValue(new Error('firestore unavailable'));

      await expect(invoke({ run_id: '01HRUN' })).rejects.toThrow('firestore unavailable');
    });

    it('does not re-execute the write on a memoized replay', async () => {
      const replayStep = { run: jest.fn(() => Promise.resolve({ finalized: true, outcome: 'cancelled' })) };

      const result = await invoke({ run_id: '01HRUN' }, replayStep);

      expect(result).toMatchObject({ outcome: 'cancelled' });
      expect(mockRecordJobCancelled).not.toHaveBeenCalled();
    });
  });
});
