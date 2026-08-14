/**
 * LOCAL-013 regressions for interrupted job-run recovery.
 *
 * The defect these guard: `recordJobStart` writes `status: 'running'` and only
 * the success/failure hooks write a terminal status, so a runtime that dies
 * mid-run strands the record at `running` forever. The fix must terminalize
 * exactly the runs that can never resume — never a run the persisted queue will
 * pick back up, and never as `completed`.
 */

const mockRunTransaction = jest.fn();
const mockCollection = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    runTransaction: (updateFunction: unknown) => mockRunTransaction(updateFunction),
    collection: (name: string) => mockCollection(name),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  Timestamp: { fromMillis: (millis: number) => ({ millis }) },
}));

import {
  MAX_RECOVERED_RUNS_PER_PASS,
  decideInterruptedRunRecovery,
  recordJobInterrupted,
  recoverInterruptedJobRuns,
  type RuntimeRecoveryContext,
} from '../interrupted-run-recovery';
import { TERMINAL_JOB_STATUSES } from '@/lib/event-retention';

const LOST: RuntimeRecoveryContext = {
  currentEpoch: 'runtime-b',
  queueStateCarriedOver: false,
};
const CARRIED_OVER: RuntimeRecoveryContext = {
  currentEpoch: 'runtime-b',
  queueStateCarriedOver: true,
};

/**
 * Drive the transactional applier against an in-memory document.
 *
 * Returns the update payload the applier committed, or null when it chose not
 * to write — which is the assertion that matters for every non-destructive case.
 */
function withDocument(stored: Record<string, unknown> | null) {
  let written: Record<string, unknown> | null = null;
  const ref = { id: 'run-1' };
  mockCollection.mockReturnValue({ doc: () => ref });
  mockRunTransaction.mockImplementation(async (updateFunction: (t: unknown) => Promise<unknown>) =>
    updateFunction({
      get: async () => ({ exists: stored !== null, data: () => stored }),
      update: (_ref: unknown, payload: Record<string, unknown>) => {
        written = payload;
      },
    })
  );
  return { getWritten: () => written };
}

describe('interrupted job-run recovery (LOCAL-013)', () => {
  beforeEach(() => jest.clearAllMocks());

  // ==========================================================================
  // Decision policy
  // ==========================================================================

  describe('decideInterruptedRunRecovery', () => {
    it('terminalizes prior-epoch work once the queue state is gone', () => {
      expect(
        decideInterruptedRunRecovery({ status: 'running', runtimeEpoch: 'runtime-a' }, LOST)
      ).toBe('interrupted');
      expect(
        decideInterruptedRunRecovery({ status: 'retrying', runtimeEpoch: 'runtime-a' }, LOST)
      ).toBe('interrupted');
    });

    it('leaves prior-epoch work alone when the persisted queue carried over', () => {
      // The whole point of --persist: this run resumes and terminalizes itself.
      expect(
        decideInterruptedRunRecovery({ status: 'running', runtimeEpoch: 'runtime-a' }, CARRIED_OVER)
      ).toBe('resumable');
    });

    it('never touches work the current runtime owns', () => {
      expect(
        decideInterruptedRunRecovery({ status: 'running', runtimeEpoch: 'runtime-b' }, LOST)
      ).toBe('current-epoch');
    });

    it('refuses to act on a run it cannot prove is stale', () => {
      // Hosted deployments stamp no epoch; absence must not read as "old".
      expect(decideInterruptedRunRecovery({ status: 'running' }, LOST)).toBe('unknown-epoch');
    });

    it('preserves every authoritative terminal status', () => {
      for (const status of TERMINAL_JOB_STATUSES) {
        expect(decideInterruptedRunRecovery({ status, runtimeEpoch: 'runtime-a' }, LOST)).toBe(
          'already-terminal'
        );
      }
    });
  });

  // ==========================================================================
  // Applier
  // ==========================================================================

  describe('recordJobInterrupted', () => {
    it('writes a truthful terminal status and never fabricates output', async () => {
      const doc = withDocument({ status: 'running', runtimeEpoch: 'runtime-a' });

      await expect(recordJobInterrupted('run-1', LOST)).resolves.toBe('interrupted');

      const written = doc.getWritten()!;
      expect(written).not.toBeNull();
      expect(written.status).toBe('interrupted');
      expect(written.interruptedReason).toBe('runtime-restarted-without-queue-state');
      expect(written.recoveredByEpoch).toBe('runtime-b');
      expect(written).not.toHaveProperty('output');
    });

    it('never reports interrupted work as completed', async () => {
      const doc = withDocument({ status: 'running', runtimeEpoch: 'runtime-a' });

      await recordJobInterrupted('run-1', LOST);

      expect(doc.getWritten()!.status).not.toBe('completed');
    });

    it('preserves a run that reached a real terminal status first', async () => {
      const doc = withDocument({
        status: 'completed',
        runtimeEpoch: 'runtime-a',
        output: { entitiesSynced: 3 },
      });

      await expect(recordJobInterrupted('run-1', LOST)).resolves.toBe('already-terminal');
      expect(doc.getWritten()).toBeNull();
    });

    it('is idempotent across a replay of the same recovery pass', async () => {
      const doc = withDocument({ status: 'interrupted', runtimeEpoch: 'runtime-a' });

      await expect(recordJobInterrupted('run-1', LOST)).resolves.toBe('already-terminal');
      expect(doc.getWritten()).toBeNull();
    });

    it('re-decides against freshly read state inside the transaction', async () => {
      // The scan saw `running`; by the time the transaction reads, the resumed
      // run had already finished. The authoritative result must survive.
      const doc = withDocument({ status: 'failed', runtimeEpoch: 'runtime-a' });

      await expect(recordJobInterrupted('run-1', LOST)).resolves.toBe('already-terminal');
      expect(doc.getWritten()).toBeNull();
    });

    it('reports a missing record rather than creating one', async () => {
      const doc = withDocument(null);

      await expect(recordJobInterrupted('run-1', LOST)).resolves.toBe('not-found');
      expect(doc.getWritten()).toBeNull();
    });
  });

  // ==========================================================================
  // Bounded pass
  // ==========================================================================

  describe('recoverInterruptedJobRuns', () => {
    function withActiveRuns(ids: string[]) {
      const limits: number[] = [];
      mockCollection.mockReturnValue({
        where: () => ({
          orderBy: () => ({
            limit: (value: number) => {
              limits.push(value);
              return { get: async () => ({ size: ids.length, docs: ids.map((id) => ({ id })) }) };
            },
          }),
        }),
        doc: () => ({ id: 'ignored' }),
      });
      mockRunTransaction.mockImplementation(async (updateFunction: (t: unknown) => Promise<unknown>) =>
        updateFunction({
          get: async () => ({
            exists: true,
            data: () => ({ status: 'running', runtimeEpoch: 'runtime-a' }),
          }),
          update: () => {},
        })
      );
      return { limits };
    }

    it('does not read Firestore at all when the queue carried over', async () => {
      const report = await recoverInterruptedJobRuns(CARRIED_OVER);

      expect(mockCollection).not.toHaveBeenCalled();
      expect(report).toMatchObject({ scanned: 0, interrupted: 0 });
    });

    it('recovers every provably lost run in the pass', async () => {
      withActiveRuns(['run-1', 'run-2', 'run-3']);

      const report = await recoverInterruptedJobRuns(LOST);

      expect(report.scanned).toBe(3);
      expect(report.interrupted).toBe(3);
      expect(report.truncated).toBe(false);
    });

    it('bounds the scan and reports truncation instead of silently dropping work', async () => {
      const { limits } = withActiveRuns(Array.from({ length: 7 }, (_, index) => `run-${index}`));

      const report = await recoverInterruptedJobRuns(LOST, 5);

      // Reads one past the ceiling purely to detect that more remain.
      expect(limits).toEqual([6]);
      expect(report.scanned).toBe(5);
      expect(report.truncated).toBe(true);
    });

    it('clamps a caller-supplied limit to the module ceiling', async () => {
      const { limits } = withActiveRuns([]);

      await recoverInterruptedJobRuns(LOST, 10_000);

      expect(limits).toEqual([MAX_RECOVERED_RUNS_PER_PASS + 1]);
    });

    it('keeps going when a single record fails and bounds the diagnostics', async () => {
      withActiveRuns(Array.from({ length: 60 }, (_, index) => `run-${index}`));
      mockRunTransaction.mockRejectedValue(new Error('firestore unavailable'));

      const report = await recoverInterruptedJobRuns(LOST, 60);

      expect(report.scanned).toBe(60);
      expect(report.interrupted).toBe(0);
      expect(report.errors).toHaveLength(50);
    });
  });

  // ==========================================================================
  // Retention contract
  // ==========================================================================

  it('is reapable rather than a permanently retained anchor', () => {
    // A status absent from TERMINAL_JOB_STATUSES can never be reaped, which
    // would leak one immortal row per interrupted run.
    expect(TERMINAL_JOB_STATUSES).toContain('interrupted');
  });
});
