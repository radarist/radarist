/**
 * @file lib/inngest/__tests__/observability.test.ts
 * @description Unit tests for Inngest observability utilities
 */

const mockPersistedJobRuns = new Map<string, Record<string, unknown>>();
const mockFieldDelete = Symbol('FieldValue.delete');
const mockSetJobRun = jest.fn(async (_runId: string, _data: Record<string, unknown>): Promise<void> => {});
const mockUpdateJobRun = jest.fn(async (_runId: string, _data: Record<string, unknown>): Promise<void> => {});

function assertNoUndefined(value: unknown, path = 'root'): void {
  if (value === undefined) throw new Error(`Firestore rejected undefined at ${path}`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoUndefined(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => assertNoUndefined(item, `${path}.${key}`));
  }
}

import {
  createJobLogger,
  recordJobStart,
  recordJobComplete,
  recordJobFailure,
  recordJobCancelled,
  INNGEST_FUNCTIONS,
  type JobStatus,
  type JobMetrics,
  type JobRun,
} from '../observability';

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn((runId: string) => ({
        // `id` lets the transaction mock below resolve which document a ref
        // addresses, the way a real DocumentReference does.
        id: runId,
        set: (data: Record<string, unknown>) => mockSetJobRun(runId, data),
        update: (data: Record<string, unknown>) => mockUpdateJobRun(runId, data),
      })),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [] }),
    })),
    // ARUN-023: recordJobCancelled reads-then-writes inside a transaction so a
    // replay cannot produce a second terminal write.
    runTransaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback({
        get: async (ref: { id: string }) => {
          const existing = mockPersistedJobRuns.get(ref.id);
          return { exists: existing !== undefined, data: () => existing };
        },
        update: (ref: { id: string }, data: Record<string, unknown>) => mockUpdateJobRun(ref.id, data),
      })
    ),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: jest.fn(() => mockFieldDelete),
  },
  Timestamp: {
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
    now: jest.fn(() => ({ toDate: () => new Date() })),
  },
}));

describe('Inngest Observability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPersistedJobRuns.clear();
    mockSetJobRun.mockImplementation(async (runId, data) => {
      assertNoUndefined(data);
      mockPersistedJobRuns.set(runId, { ...data });
    });
    mockUpdateJobRun.mockImplementation(async (runId, data) => {
      assertNoUndefined(data);
      const existing = mockPersistedJobRuns.get(runId);
      if (!existing) throw new Error(`Job run does not exist: ${runId}`);
      const merged = { ...existing, ...data };
      Object.entries(merged).forEach(([key, value]) => {
        if (value === mockFieldDelete) delete merged[key];
      });
      mockPersistedJobRuns.set(runId, merged);
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('INNGEST_FUNCTIONS', () => {
    it('should have defined functions', () => {
      expect(Array.isArray(INNGEST_FUNCTIONS)).toBe(true);
      expect(INNGEST_FUNCTIONS.length).toBeGreaterThan(0);
    });

    it('should have id and name for each function', () => {
      INNGEST_FUNCTIONS.forEach((fn) => {
        expect(fn.id).toBeDefined();
        expect(typeof fn.id).toBe('string');
        expect(fn.name).toBeDefined();
        expect(typeof fn.name).toBe('string');
      });
    });

    it('should include impulse-sweep-cycle', () => {
      const sweepCycle = INNGEST_FUNCTIONS.find((fn) => fn.id === 'impulse-sweep-cycle');
      expect(sweepCycle).toBeDefined();
      expect(sweepCycle?.name).toBe('Impulse Sweep Cycle');
    });
  });

  describe('createJobLogger()', () => {
    const functionId = 'test-function';
    const executionId = 'exec-123';

    it('should create a logger with all methods', () => {
      const logger = createJobLogger(functionId, executionId);

      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.stepStart).toBeDefined();
      expect(logger.stepComplete).toBeDefined();
      expect(logger.stepFailed).toBeDefined();
    });

    it('should log debug messages', () => {
      const logger = createJobLogger(functionId, executionId);

      logger.debug('Test debug message', { key: 'value' });

      expect(console.debug).toHaveBeenCalled();
    });

    it('should log info messages', () => {
      const logger = createJobLogger(functionId, executionId);

      logger.info('Test info message');

      expect(console.info).toHaveBeenCalled();
    });

    it('should log warn messages', () => {
      const logger = createJobLogger(functionId, executionId);

      logger.warn('Test warning');

      expect(console.warn).toHaveBeenCalled();
    });

    it('should log error messages with Error object', () => {
      const logger = createJobLogger(functionId, executionId);
      const error = new Error('Test error');

      logger.error('Error occurred', error);

      expect(console.error).toHaveBeenCalled();
    });

    it('should log step start', () => {
      const logger = createJobLogger(functionId, executionId);

      logger.stepStart('process-data');

      expect(console.info).toHaveBeenCalled();
    });

    it('should log step complete with duration', () => {
      const logger = createJobLogger(functionId, executionId);

      logger.stepComplete('process-data', 1500);

      expect(console.info).toHaveBeenCalled();
    });

    it('should log step failure', () => {
      const logger = createJobLogger(functionId, executionId);
      const error = new Error('Step failed');

      logger.stepFailed('process-data', error);

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('ARUN-023 cancellation terminalization', () => {
    async function startRun(runId: string, input?: Record<string, unknown>) {
      await recordJobStart('run-build-mission', 'Run Build Mission', input, runId);
    }

    it('lifts a bounded mission id to a queryable top-level field', async () => {
      await startRun('run-mission', {
        event: 'app/build-mission.requested',
        missionId: 'mission-fixture-observability-a1b2c3',
      });

      expect(mockPersistedJobRuns.get('run-mission')).toEqual(
        expect.objectContaining({ missionId: 'mission-fixture-observability-a1b2c3' })
      );
    });

    it('refuses arbitrary caller text as a mission id', async () => {
      await startRun('run-hostile', { event: 'app/build-mission.requested', missionId: '../../etc/passwd' });

      expect(mockPersistedJobRuns.get('run-hostile')).not.toHaveProperty('missionId');
    });

    // The stranded-at-running defect: cancelOn never re-enters the SDK, so the
    // middleware's finished hook cannot terminalize the record.
    it('moves a running record to cancelled with a completedAt', async () => {
      await startRun('run-cancel');
      expect(mockPersistedJobRuns.get('run-cancel')).toEqual(expect.objectContaining({ status: 'running' }));

      const outcome = await recordJobCancelled('run-cancel');

      expect(outcome).toBe('cancelled');
      const persisted = mockPersistedJobRuns.get('run-cancel')!;
      expect(persisted.status).toBe('cancelled');
      expect(persisted.completedAt).toBeDefined();
    });

    it('terminalizes a retrying record too', async () => {
      await startRun('run-retrying');
      await recordJobFailure('run-retrying', new Error('transient'), 1);
      expect(mockPersistedJobRuns.get('run-retrying')).toEqual(expect.objectContaining({ status: 'retrying' }));

      expect(await recordJobCancelled('run-retrying')).toBe('cancelled');
    });

    // Replay must converge on ONE terminal record.
    it('is idempotent — a replay writes nothing further', async () => {
      await startRun('run-twice');
      await recordJobCancelled('run-twice');
      const afterFirst = { ...mockPersistedJobRuns.get('run-twice')! };
      mockUpdateJobRun.mockClear();

      expect(await recordJobCancelled('run-twice')).toBe('already-cancelled');
      expect(mockUpdateJobRun).not.toHaveBeenCalled();
      expect(mockPersistedJobRuns.get('run-twice')).toEqual(afterFirst);
    });

    it('preserves an authoritative completed result', async () => {
      await startRun('run-done');
      await recordJobComplete('run-done', { published: true });
      mockUpdateJobRun.mockClear();

      expect(await recordJobCancelled('run-done')).toBe('already-terminal');
      expect(mockUpdateJobRun).not.toHaveBeenCalled();
      expect(mockPersistedJobRuns.get('run-done')).toEqual(
        expect.objectContaining({ status: 'completed', output: { published: true } })
      );
    });

    it('preserves an authoritative failed result', async () => {
      await startRun('run-failed');
      await recordJobFailure('run-failed', new Error('boom'));
      mockUpdateJobRun.mockClear();

      expect(await recordJobCancelled('run-failed')).toBe('already-terminal');
      expect(mockUpdateJobRun).not.toHaveBeenCalled();
    });

    it('reports a missing record rather than creating one', async () => {
      expect(await recordJobCancelled('run-never-started')).toBe('not-found');
      expect(mockPersistedJobRuns.has('run-never-started')).toBe(false);
    });

    it('writes only the terminal status, timestamp and cancellation outcome — no invented usage', async () => {
      await startRun('run-bounded', {
        event: 'app/build-mission.requested',
        missionId: 'mission-fixture-observability-a1b2c3',
      });
      mockUpdateJobRun.mockClear();

      await recordJobCancelled('run-bounded');

      const [, written] = mockUpdateJobRun.mock.calls[0] as [string, Record<string, unknown>];
      // OBS-001 adds exactly two fields, and both are entailed rather than
      // guessed: a server-side cancellation never re-enters the SDK, so
      // `cancelled` is the only honest business outcome and the provenance says
      // why no declaration exists. Tokens, provider, and cost remain absent.
      expect(Object.keys(written).sort()).toEqual(['completedAt', 'domainOutcome', 'domainOutcomeSource', 'status']);
      expect(written.domainOutcome).toBe('cancelled');
      expect(written.domainOutcomeSource).toBe('transport-cancellation');
      // Correlation survives because it was established at START, not invented here.
      expect(mockPersistedJobRuns.get('run-bounded')).toEqual(
        expect.objectContaining({ missionId: 'mission-fixture-observability-a1b2c3', status: 'cancelled' })
      );
    });
  });

  describe('Firestore job-run writes', () => {
    it('persists a validated correlation token as a queryable field and bounded input', async () => {
      const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
      await recordJobStart(
        'sync-relation-to-neo4j',
        'Sync Relation to Neo4j',
        { event: 'app/relation.sync.requested', correlationId },
        'run-correlated',
        correlationId
      );

      expect(mockPersistedJobRuns.get('run-correlated')).toEqual(
        expect.objectContaining({
          correlationId,
          input: { event: 'app/relation.sync.requested', correlationId },
        })
      );
    });

    it('discards malformed correlation text from both job-run locations', async () => {
      await recordJobStart(
        'sync-relation-to-neo4j',
        'Sync Relation to Neo4j',
        { event: 'app/relation.sync.requested', correlationId: 'private arbitrary text' },
        'run-invalid-correlation',
        'private arbitrary text'
      );

      const run = mockPersistedJobRuns.get('run-invalid-correlation');
      expect(run).not.toHaveProperty('correlationId');
      expect(run?.input).toEqual({ event: 'app/relation.sync.requested' });
    });

    it('persists completion without undefined fields, including nested output', async () => {
      class SdkValue {
        constructor(readonly id: string) {}
      }
      const sdkValue = new SdkValue('timestamp-like-value');
      const sparseItems: unknown[] = [];
      sparseItems.length = 2;
      sparseItems[1] = 'second';

      await recordJobStart('test-function', 'Test Function', undefined, 'run-completed');
      await recordJobComplete(
        'run-completed',
        {
          nested: { keep: 'value', omit: undefined },
          items: ['first', undefined, { keep: 'last', omit: undefined }],
          sparseItems,
          sdkValue,
        },
        { trace: { id: 'trace-1', optional: undefined } }
      );

      const completed = mockPersistedJobRuns.get('run-completed');
      expect(completed).toEqual(expect.objectContaining({ status: 'completed', retryCount: 0 }));
      expect(completed).not.toHaveProperty('input');
      expect(completed?.output).toEqual({
        nested: { keep: 'value' },
        items: ['first', null, { keep: 'last' }],
        sparseItems: [null, 'second'],
        sdkValue,
      });
      expect((completed?.output as Record<string, unknown>).sdkValue).toBe(sdkValue);
      expect(completed?.metadata).toEqual({ trace: { id: 'trace-1' } });
    });

    it('persists terminal completion when output and metadata are absent', async () => {
      await recordJobStart('test-function', 'Test Function', undefined, 'run-empty-completion');
      await recordJobComplete('run-empty-completion');

      const completed = mockPersistedJobRuns.get('run-empty-completion');
      expect(completed?.status).toBe('completed');
      expect(completed).not.toHaveProperty('output');
      expect(completed).not.toHaveProperty('metadata');
    });

    it('persists terminal failure when Error stack and code are absent', async () => {
      const error = new Error('job failed') as Error & { code?: string };
      Object.defineProperty(error, 'stack', { value: undefined, writable: true });
      error.code = undefined;

      await recordJobStart('test-function', 'Test Function', undefined, 'run-failed');
      await recordJobFailure('run-failed', error);

      const failed = mockPersistedJobRuns.get('run-failed');
      expect(failed).toEqual(expect.objectContaining({ status: 'failed', retryCount: 0 }));
      expect(failed?.error).toEqual({ message: 'job failed' });
    });

    it('clears a prior failure when a retried run later completes', async () => {
      await recordJobStart('test-function', 'Test Function', undefined, 'run-recovered');
      await recordJobFailure('run-recovered', new Error('first attempt failed'));
      expect(mockPersistedJobRuns.get('run-recovered')).toHaveProperty('error');

      await recordJobComplete('run-recovered', { result: 'recovered' });

      const recovered = mockPersistedJobRuns.get('run-recovered');
      expect(recovered?.status).toBe('completed');
      expect(recovered).not.toHaveProperty('error');
    });
  });

  describe('Type definitions', () => {
    it('should have valid JobStatus type', () => {
      const validStatuses: JobStatus[] = ['running', 'completed', 'failed', 'retrying'];
      expect(validStatuses).toHaveLength(4);
    });

    it('should have valid JobMetrics interface shape', () => {
      const metrics: JobMetrics = {
        functionId: 'test',
        totalRuns: 10,
        successCount: 8,
        failureCount: 2,
        // OBS-001: the domain tallies are required, so a dashboard cannot be
        // written against transport counts while believing it reports delivery.
        domainSuccessCount: 5,
        domainFailureCount: 2,
        domainUndeclaredCount: 3,
        avgDuration: 5000,
        lastRunAt: Date.now(),
        lastStatus: 'completed',
      };

      expect(metrics.functionId).toBe('test');
      expect(metrics.totalRuns).toBe(10);
      expect(metrics.domainSuccessCount + metrics.domainFailureCount + metrics.domainUndeclaredCount).toBe(10);
    });

    it('should have valid JobRun interface shape', () => {
      const run: JobRun = {
        id: 'run-123',
        correlationId: 'corr_123e4567-e89b-42d3-a456-426614174000',
        functionId: 'test',
        functionName: 'Test Function',
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        duration: 1000,
        retryCount: 0,
        input: { key: 'value' },
        output: { result: 'success' },
      };

      expect(run.id).toBe('run-123');
      expect(run.status).toBe('completed');
    });

    it('should allow optional fields in JobRun', () => {
      const minimalRun: JobRun = {
        id: 'run-456',
        functionId: 'test',
        functionName: 'Test',
        status: 'running',
        startedAt: Date.now(),
        retryCount: 0,
      };

      expect(minimalRun.completedAt).toBeUndefined();
      expect(minimalRun.duration).toBeUndefined();
      expect(minimalRun.error).toBeUndefined();
    });
  });
});
