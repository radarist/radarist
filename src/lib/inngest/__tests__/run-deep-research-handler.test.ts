/**
 * @jest-environment node
 * @file lib/inngest/__tests__/run-deep-research-handler.test.ts
 * @description Attempt-token contract for the basic paid research worker.
 */

type HandlerInput = {
  event: { data: Record<string, unknown> };
  step: ReturnType<typeof buildMockStep>;
};
type Handler = (input: HandlerInput) => Promise<Record<string, unknown>>;
type OnFailure = (input: { error: Error; event: { data: Record<string, unknown> } }) => Promise<void>;

jest.mock('@/lib/inngest/client', () => {
  const registry: {
    handlers: Record<string, Handler>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: Handler) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue({ ids: ['evt-1'] }),
    },
    _registry: registry,
  };
});

const mockDeepResearchStructured = jest.fn();
jest.mock('@/ai/flows/deep-research', () => ({
  __esModule: true,
  deepResearchStructured: (...args: unknown[]) => mockDeepResearchStructured(...args),
}));

const mockInspectResearchAttempt = jest.fn();
const mockCompleteDeepResearchAttempt = jest.fn();
const mockReleaseResearchPending = jest.fn();
const mockRecordPendingSnapshotRefresh = jest.fn();
const mockClearPendingSnapshotRefresh = jest.fn();
jest.mock('@/lib/technology-research-admin', () => ({
  __esModule: true,
  inspectResearchAttempt: (...args: unknown[]) => mockInspectResearchAttempt(...args),
  completeDeepResearchAttempt: (...args: unknown[]) => mockCompleteDeepResearchAttempt(...args),
  releaseResearchPending: (...args: unknown[]) => mockReleaseResearchPending(...args),
  recordPendingSnapshotRefresh: (...args: unknown[]) => mockRecordPendingSnapshotRefresh(...args),
  clearPendingSnapshotRefresh: (...args: unknown[]) => mockClearPendingSnapshotRefresh(...args),
}));

import '../functions/run-deep-research';

const mockRegistry = jest.requireMock('@/lib/inngest/client')._registry as {
  handlers: Record<string, Handler>;
  configs: Record<string, Record<string, unknown>>;
  triggers: Record<string, unknown>;
};

function buildMockStep() {
  return {
    run: jest.fn((_name: string, operation: () => unknown) => operation()),
  };
}

const HANDLER_ID = 'run-deep-research';
const ATTEMPT = 1_800_000_000_000;
const canonicalTechnology = {
  id: 'tech-123',
  name: 'Canonical Quantum',
  description: 'Canonical description from the active Firestore attempt.',
  researchStatus: 'pending',
  researchStartedAt: ATTEMPT,
};
const research = {
  summary: 'A sufficiently detailed basic research summary.',
  keyInsights: ['One insight'],
  lastResearched: ATTEMPT + 100,
  sources: ['https://example.com/source'],
};

describe('runDeepResearchJob attempt authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInspectResearchAttempt.mockResolvedValue({ active: true, technology: canonicalTechnology });
    mockDeepResearchStructured.mockResolvedValue(research);
    mockCompleteDeepResearchAttempt.mockResolvedValue({
      completed: true,
      technologyName: canonicalTechnology.name,
      updatedFields: ['deepResearch'],
    });
    mockReleaseResearchPending.mockResolvedValue({ released: true });
    mockRecordPendingSnapshotRefresh.mockResolvedValue(undefined);
    mockClearPendingSnapshotRefresh.mockResolvedValue(false);
  });

  it('registers the basic research trigger', () => {
    expect(mockRegistry.configs[HANDLER_ID].id).toBe(HANDLER_ID);
    expect(mockRegistry.triggers[HANDLER_ID]).toEqual({ event: 'app/technology.research.requested' });
  });

  it('rejects a missing attempt token before inspection or provider spend', async () => {
    await expect(
      mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', technologyName: 'Spoofed' } },
        step: buildMockStep(),
      })
    ).rejects.toThrow('valid triggeredAt');

    expect(mockInspectResearchAttempt).not.toHaveBeenCalled();
    expect(mockDeepResearchStructured).not.toHaveBeenCalled();
  });

  it.each(['stale-attempt', 'already-settled'])(
    'ignores an inactive %s event before provider spend',
    async (reason) => {
      const { inngest } = jest.requireMock('@/lib/inngest/client');
      mockInspectResearchAttempt.mockResolvedValue({ active: false, reason });

      const result = await mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      });

      expect(result).toMatchObject({ success: true, ignored: true, reason });
      expect(mockInspectResearchAttempt).toHaveBeenCalledWith('tech-123', ATTEMPT, 'deep');
      expect(mockDeepResearchStructured).not.toHaveBeenCalled();
      expect(mockCompleteDeepResearchAttempt).not.toHaveBeenCalled();
      expect(inngest.send).not.toHaveBeenCalled();
    }
  );

  it('fails a missing canonical technology before provider spend or refresh', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    mockInspectResearchAttempt.mockResolvedValue({ active: false, reason: 'not-found' });

    await expect(
      mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'missing-tech', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      })
    ).rejects.toThrow('Technology missing-tech not found');

    expect(mockDeepResearchStructured).not.toHaveBeenCalled();
    expect(mockCompleteDeepResearchAttempt).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('uses the canonical active name and description instead of event fields', async () => {
    await mockRegistry.handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Spoofed name',
          technologyDescription: 'Spoofed description',
          triggeredAt: ATTEMPT,
        },
      },
      step: buildMockStep(),
    });

    expect(mockDeepResearchStructured).toHaveBeenCalledWith({
      technologyName: canonicalTechnology.name,
      technologyDescription: canonicalTechnology.description,
    });
  });

  it('completes through the exact-attempt transaction and refreshes that result', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');

    const result = await mockRegistry.handlers[HANDLER_ID]({
      event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
      step: buildMockStep(),
    });

    expect(mockCompleteDeepResearchAttempt).toHaveBeenCalledWith('tech-123', ATTEMPT, {
      completedAt: expect.any(Number),
      research,
    });
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/technology.updated',
      data: { technologyId: 'tech-123', updatedFields: ['deepResearch'] },
    });
    expect(result).toMatchObject({ success: true, technologyName: canonicalTechnology.name });
  });

  it('keeps research completed and records durable debt when the snapshot refresh dispatch fails', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    inngest.send.mockImplementation((event: { name: string }) =>
      event.name === 'app/technology.updated'
        ? Promise.reject(new Error('dispatch unavailable'))
        : Promise.resolve(undefined)
    );

    let result: unknown;
    try {
      // The run MUST resolve — a failed handoff never fails committed research.
      result = await mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      });
    } finally {
      inngest.send.mockResolvedValue({ ids: ['evt-1'] });
    }

    expect(result).toMatchObject({ success: true });
    expect(mockCompleteDeepResearchAttempt).toHaveBeenCalled();
    expect(mockRecordPendingSnapshotRefresh).toHaveBeenCalledWith('tech-123', ATTEMPT, expect.any(Error));
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('records durable debt when the refresh resolves with no accepted ids (kill switch)', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    inngest.send.mockImplementation((event: { name: string }) =>
      event.name === 'app/technology.updated' ? Promise.resolve({ ids: [] }) : Promise.resolve({ ids: ['evt-1'] })
    );

    let result: unknown;
    try {
      result = await mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      });
    } finally {
      inngest.send.mockResolvedValue({ ids: ['evt-1'] });
    }

    expect(result).toMatchObject({ success: true });
    expect(mockRecordPendingSnapshotRefresh).toHaveBeenCalledWith('tech-123', ATTEMPT, expect.any(Error));
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('retries only the handoff after debt persistence fails, without repeating provider spend', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    inngest.send.mockRejectedValueOnce(new Error('dispatch unavailable'));
    mockRecordPendingSnapshotRefresh.mockRejectedValueOnce(new Error('firestore unavailable'));

    await expect(
      mockRegistry.handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      })
    ).rejects.toThrow('firestore unavailable');

    expect(mockDeepResearchStructured).toHaveBeenCalledTimes(1);
    expect(mockCompleteDeepResearchAttempt).toHaveBeenCalledTimes(1);

    mockInspectResearchAttempt.mockResolvedValueOnce({
      active: false,
      reason: 'handoff-pending',
      technology: { ...canonicalTechnology, researchStatus: 'completed', researchStartedAt: ATTEMPT },
    });
    inngest.send.mockResolvedValue({ ids: ['evt-retry'] });

    const retried = await mockRegistry.handlers[HANDLER_ID]({
      event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
      step: buildMockStep(),
    });

    expect(retried).toMatchObject({ success: true, resumedHandoff: true });
    expect(mockDeepResearchStructured).toHaveBeenCalledTimes(1);
    expect(mockCompleteDeepResearchAttempt).toHaveBeenCalledTimes(1);
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('does not refresh when a newer attempt wins during provider execution', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    mockCompleteDeepResearchAttempt.mockResolvedValue({ completed: false, reason: 'stale-attempt' });

    const result = await mockRegistry.handlers[HANDLER_ID]({
      event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
      step: buildMockStep(),
    });

    expect(result).toMatchObject({ success: true, ignored: true, reason: 'stale-attempt' });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('releases only the exact failed attempt and suppresses a stale failure notification', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    mockReleaseResearchPending.mockResolvedValue({ released: false });
    const onFailure = mockRegistry.configs[HANDLER_ID].onFailure as OnFailure;

    await onFailure({
      error: new Error('provider failed'),
      event: {
        data: {
          event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } },
        },
      },
    });

    expect(mockReleaseResearchPending).toHaveBeenCalledWith('tech-123', 'worker-failed', ATTEMPT);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('emits one failure event only after the exact attempt is released', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    const onFailure = mockRegistry.configs[HANDLER_ID].onFailure as OnFailure;

    await onFailure({
      error: new Error('provider failed'),
      event: {
        data: {
          event: {
            data: {
              technologyId: 'tech-123',
              technologyName: 'Untrusted event name',
              triggeredAt: ATTEMPT,
            },
          },
        },
      },
    });

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/technology.research.failed',
      data: {
        technologyId: 'tech-123',
        error: 'provider failed',
        failedAt: expect.any(Number),
      },
    });
  });

  it('surfaces terminal handoff-debt persistence failure without downgrading completed research', async () => {
    const { inngest } = jest.requireMock('@/lib/inngest/client');
    const onFailure = mockRegistry.configs[HANDLER_ID].onFailure as OnFailure;
    const error = new Error('Could not persist snapshot-refresh recovery debt for tech-123');
    error.name = 'PendingSnapshotRefreshPersistenceError';
    mockRecordPendingSnapshotRefresh.mockRejectedValueOnce(new Error('Firestore remains unavailable'));

    await onFailure({
      error,
      event: { data: { event: { data: { technologyId: 'tech-123', triggeredAt: ATTEMPT } } } },
    });

    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/placement.snapshot-refresh.failed',
      data: {
        technologyId: 'tech-123',
        error: error.message,
        failedAt: expect.any(Number),
        severity: 'low',
      },
    });
  });
});
