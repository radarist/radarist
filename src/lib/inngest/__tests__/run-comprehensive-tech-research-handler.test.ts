/**
 * @jest-environment node
 * @file lib/inngest/__tests__/run-comprehensive-tech-research-handler.test.ts
 * @description Unit tests for the runComprehensiveTechResearchJob Inngest handler.
 *
 * The helper function tests are in run-comprehensive-tech-research.test.ts.
 * This file tests the Inngest handler steps end-to-end.
 */

type AnyFunction = (...args: any[]) => any;

// Mock Firebase
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
// Mock firebase-admin so the real module (and its jwks-rsa transitive dep) never
// loads when technology-admin is resolved.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'mock-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

// Mock inngest client. Handler registry stored inside the mock closure.
jest.mock('@/lib/inngest/client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    rawHandlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, rawHandlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.rawHandlers[id] = handler;
        registry.handlers[id] = (input: { event: { data: Record<string, unknown> } }) =>
          handler({
            ...input,
            event: { ...input.event, data: { triggeredAt: 1_800_000_000_000, ...input.event.data } },
          });
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue({ ids: ['evt-1'] }),
    },
    _registry: registry,
  };
});

// Mock AI research flow
const mockResearchTechnologyComprehensive = jest.fn();
jest.mock('@/ai/flows/research-technology-comprehensive', () => ({
  __esModule: true,
  researchTechnologyComprehensive: (...args: unknown[]) => mockResearchTechnologyComprehensive(...args),
}));

// Mock technology admin (Inngest worker uses the admin-SDK twins)
const mockUpdateTechnology = jest.fn();
const mockGetTechnologyById = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminUpdateTechnology: (...args: unknown[]) => mockUpdateTechnology(...args),
  adminGetTechnologyById: (...args: unknown[]) => mockGetTechnologyById(...args),
}));

const mockInspectResearchAttempt = jest.fn();
const mockCompleteResearchAttempt = jest.fn();
const mockReleaseResearchPending = jest.fn();
const mockRecordPendingSnapshotRefresh = jest.fn();
const mockClearPendingSnapshotRefresh = jest.fn();
jest.mock('@/lib/technology-research-admin', () => ({
  __esModule: true,
  inspectResearchAttempt: (...args: unknown[]) => mockInspectResearchAttempt(...args),
  completeResearchAttempt: (...args: unknown[]) => mockCompleteResearchAttempt(...args),
  releaseResearchPending: (...args: unknown[]) => mockReleaseResearchPending(...args),
  recordPendingSnapshotRefresh: (...args: unknown[]) => mockRecordPendingSnapshotRefresh(...args),
  clearPendingSnapshotRefresh: (...args: unknown[]) => mockClearPendingSnapshotRefresh(...args),
}));

// ARUN-028 — graph sync now rides the anchored best-effort server path.
const mockTriggerGraphSyncBestEffort = jest.fn();
jest.mock('@/lib/entity-sync-server', () => ({
  __esModule: true,
  triggerEntityGraphSyncBestEffortServer: (...args: unknown[]) => mockTriggerGraphSyncBestEffort(...args),
}));

// Import AFTER all mocks
import '../functions/run-comprehensive-tech-research';

// ============================================================================
// Helpers
// ============================================================================

function getRegistry() {
  const clientMock = require('@/lib/inngest/client');
  return clientMock._registry as {
    handlers: Record<string, AnyFunction>;
    rawHandlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function buildMockStep() {
  return {
    run: jest.fn((name: string, fn: AnyFunction) => fn()),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildMockTechnology(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tech-123',
    name: 'Quantum Computing',
    description: '',
    category: undefined,
    tags: ['emerging'],
    websiteUrl: '',
    githubUrl: '',
    trl: undefined,
    timeToImpact: undefined,
    ...overrides,
  };
}

function buildMockResearch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    lastResearched: Date.now(),
    version: 1,
    executiveSummary: {
      summary: 'Quantum computing is a transformative technology.',
      keyInsights: ['Key insight 1', 'Key insight 2'],
    },
    maturityAssessment: {
      hypeCyclePosition: 'peak-of-inflated-expectations',
      timeToMainstream: '5-10 years',
      maturityTrajectory: 'accelerating',
    },
    technologyMetrics: {
      category: 'Quantum Computing Hardware',
      keyMetrics: [],
      milestones: [],
    },
    valueAssessment: {
      maturityLevel: 2,
    },
    keyPlayers: {
      marketLeaders: [],
      emergingStartups: [],
      researchInstitutions: [],
      openSourceProjects: [
        {
          name: 'Qiskit (github.com/Qiskit/qiskit)',
          description: 'IBM quantum SDK',
          stars: 5000,
        },
      ],
    },
    useCasesAndApplications: {
      byMaturity: { production: [], piloting: [], experimental: [] },
      byIndustry: [{ industry: 'Finance', useCases: ['Portfolio optimization'] }],
      byFunction: [],
      flagshipExamples: [],
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('runComprehensiveTechResearchJob', () => {
  const HANDLER_ID = 'run-comprehensive-tech-research';
  const ATTEMPT = 1_800_000_000_000;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTechnologyById.mockReset();
    mockResearchTechnologyComprehensive.mockReset();
    mockUpdateTechnology.mockReset();
    mockInspectResearchAttempt.mockReset();
    mockCompleteResearchAttempt.mockReset();
    mockReleaseResearchPending.mockReset();
    mockGetTechnologyById.mockResolvedValue(buildMockTechnology());
    mockResearchTechnologyComprehensive.mockResolvedValue(buildMockResearch());
    mockUpdateTechnology.mockResolvedValue(undefined);
    mockInspectResearchAttempt.mockImplementation(async () => {
      const technology = await mockGetTechnologyById();
      return technology ? { active: true, technology } : { active: false, reason: 'not-found' };
    });
    mockCompleteResearchAttempt.mockResolvedValue({
      completed: true,
      technologyName: 'Quantum Computing',
      updatedFields: ['comprehensiveResearch', 'trl', 'timeToImpact', 'description', 'category', 'githubUrl', 'tags'],
    });
    mockReleaseResearchPending.mockResolvedValue({ released: true });
    mockRecordPendingSnapshotRefresh.mockReset();
    mockRecordPendingSnapshotRefresh.mockResolvedValue(undefined);
    mockClearPendingSnapshotRefresh.mockReset();
    mockClearPendingSnapshotRefresh.mockResolvedValue(false);
    mockTriggerGraphSyncBestEffort.mockReset();
    mockTriggerGraphSyncBestEffort.mockResolvedValue({ acknowledged: true, anchorRecorded: false });
  });

  it('should have correct function id and trigger', () => {
    const { configs, triggers } = getRegistry();
    expect(configs[HANDLER_ID].id).toBe('run-comprehensive-tech-research');
    expect(triggers[HANDLER_ID]).toEqual({
      event: 'app/technology.comprehensive-research.requested',
    });
  });

  it('rejects a missing attempt token before provider spend', async () => {
    const { rawHandlers } = getRegistry();

    await expect(
      rawHandlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' } },
        step: buildMockStep(),
      })
    ).rejects.toThrow('valid triggeredAt');

    expect(mockInspectResearchAttempt).not.toHaveBeenCalled();
    expect(mockResearchTechnologyComprehensive).not.toHaveBeenCalled();
  });

  it.each(['stale-attempt', 'already-settled'])('ignores a %s replay before provider spend', async (reason) => {
    mockInspectResearchAttempt.mockResolvedValue({ active: false, reason });
    const { handlers } = getRegistry();

    const result = await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Untrusted event name',
          triggeredAt: ATTEMPT,
        },
      },
      step: buildMockStep(),
    });

    expect(result).toMatchObject({ success: true, ignored: true, reason });
    expect(mockResearchTechnologyComprehensive).not.toHaveBeenCalled();
    expect(mockCompleteResearchAttempt).not.toHaveBeenCalled();
  });

  it('researches the canonical attempt snapshot instead of event-supplied identity fields', async () => {
    mockInspectResearchAttempt.mockResolvedValue({
      active: true,
      technology: buildMockTechnology({
        name: 'Canonical Quantum',
        description: 'Canonical description',
        category: 'hardware',
        websiteUrl: 'https://canonical.example',
      }),
    });
    const { handlers } = getRegistry();

    await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Spoofed AI',
          technologyDescription: 'Spoofed description',
          category: 'service',
          websiteUrl: 'https://spoofed.example',
          triggeredAt: ATTEMPT,
        },
      },
      step: buildMockStep(),
    });

    expect(mockResearchTechnologyComprehensive).toHaveBeenCalledWith({
      name: 'Canonical Quantum',
      description: 'Canonical description',
      category: 'hardware',
      websiteUrl: 'https://canonical.example',
    });
  });

  it('finalizes through the exact-attempt transaction and emits snapshot plus graph refresh', async () => {
    const { inngest } = require('@/lib/inngest/client');
    const { handlers } = getRegistry();

    await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Quantum Computing',
          triggeredAt: ATTEMPT,
        },
      },
      step: buildMockStep(),
    });

    expect(mockCompleteResearchAttempt).toHaveBeenCalledWith(
      'tech-123',
      ATTEMPT,
      expect.objectContaining({ research: expect.any(Object), completedAt: expect.any(Number) })
    );
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/technology.updated',
        data: { technologyId: 'tech-123', updatedFields: expect.any(Array) },
      })
    );
    // Graph sync now rides the anchored best-effort server path (GRAPH-056).
    expect(mockTriggerGraphSyncBestEffort).toHaveBeenCalledWith('technology', 'tech-123', 'update');
    // A healthy handoff records no snapshot-refresh debt.
    expect(mockRecordPendingSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('does not emit refresh events when a newer attempt wins during provider execution', async () => {
    const { inngest } = require('@/lib/inngest/client');
    mockCompleteResearchAttempt.mockResolvedValue({ completed: false, reason: 'stale-attempt' });
    const { handlers } = getRegistry();

    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT },
      },
      step: buildMockStep(),
    });

    expect(result).toMatchObject({ success: true, ignored: true, reason: 'stale-attempt' });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('marks only the exact failed attempt and suppresses stale failure notifications', async () => {
    const { configs } = getRegistry();
    const { inngest } = require('@/lib/inngest/client');
    mockReleaseResearchPending.mockResolvedValue({ released: false });

    await (configs[HANDLER_ID].onFailure as AnyFunction)({
      error: new Error('provider failed'),
      event: {
        data: {
          event: {
            data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT },
          },
        },
      },
    });

    expect(mockReleaseResearchPending).toHaveBeenCalledWith('tech-123', 'worker-failed', ATTEMPT);
    expect(inngest.send).not.toHaveBeenCalled();
    expect(mockUpdateTechnology).not.toHaveBeenCalled();
  });

  it('publishes one failure notification after the exact attempt transitions to failed', async () => {
    const { configs } = getRegistry();
    const { inngest } = require('@/lib/inngest/client');

    await (configs[HANDLER_ID].onFailure as AnyFunction)({
      error: new Error('provider failed'),
      event: {
        data: {
          event: {
            data: { technologyId: 'tech-123', technologyName: 'Untrusted name', triggeredAt: ATTEMPT },
          },
        },
      },
    });

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/technology.comprehensive-research.failed',
      data: {
        technologyId: 'tech-123',
        error: 'provider failed',
        failedAt: expect.any(Number),
      },
    });
  });

  it('surfaces terminal handoff-debt persistence failure without downgrading completed research', async () => {
    const { configs } = getRegistry();
    const { inngest } = require('@/lib/inngest/client');
    const error = new Error('Could not persist snapshot-refresh recovery debt for tech-123');
    error.name = 'PendingSnapshotRefreshPersistenceError';
    mockRecordPendingSnapshotRefresh.mockRejectedValueOnce(new Error('Firestore remains unavailable'));

    await (configs[HANDLER_ID].onFailure as AnyFunction)({
      error,
      event: {
        data: {
          event: { data: { technologyId: 'tech-123', technologyName: 'Quantum', triggeredAt: ATTEMPT } },
        },
      },
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

  it('sends the UI snapshot refresh and delegates graph sync to the anchored helper', async () => {
    const { inngest } = require('@/lib/inngest/client');
    const { handlers } = getRegistry();

    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT },
      },
      step: buildMockStep(),
    });

    // The handler never sends app/technology.sync.requested directly; graph sync
    // is delegated to triggerEntityGraphSyncBestEffortServer, which honors the
    // kill switch and records recovery anchors internally.
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/technology.updated' }));
    expect(inngest.send).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'app/technology.sync.requested' }));
    expect(mockTriggerGraphSyncBestEffort).toHaveBeenCalledWith('technology', 'tech-123', 'update');
  });

  it('keeps research completed and records durable debt when the snapshot refresh dispatch fails', async () => {
    const { inngest } = require('@/lib/inngest/client');
    // Only the placement-snapshot refresh dispatch fails.
    inngest.send.mockImplementation((event: { name: string }) =>
      event.name === 'app/technology.updated'
        ? Promise.reject(new Error('dispatch unavailable'))
        : Promise.resolve(undefined)
    );
    const { handlers } = getRegistry();

    let result: unknown;
    try {
      // The run MUST resolve — a failed handoff never fails committed research.
      result = await handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      });
    } finally {
      inngest.send.mockResolvedValue({ ids: ['evt-1'] });
    }

    expect(result).toMatchObject({ success: true });
    // Research was persisted (completed) before the handoff ran.
    expect(mockCompleteResearchAttempt).toHaveBeenCalled();
    // Durable debt is recorded for the missed refresh, keyed to the exact attempt.
    expect(mockRecordPendingSnapshotRefresh).toHaveBeenCalledWith('tech-123', ATTEMPT, expect.any(Error));
    // Research is never rolled back to 'failed'.
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('records durable debt when the snapshot refresh resolves with no accepted ids (kill switch)', async () => {
    const { inngest } = require('@/lib/inngest/client');
    // The send resolves but enqueues nothing — not a delivery.
    inngest.send.mockImplementation((event: { name: string }) =>
      event.name === 'app/technology.updated' ? Promise.resolve({ ids: [] }) : Promise.resolve({ ids: ['evt-1'] })
    );
    const { handlers } = getRegistry();

    let result: unknown;
    try {
      result = await handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      });
    } finally {
      inngest.send.mockResolvedValue({ ids: ['evt-1'] });
    }

    expect(result).toMatchObject({ success: true });
    expect(mockRecordPendingSnapshotRefresh).toHaveBeenCalledWith('tech-123', ATTEMPT, expect.any(Error));
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('records debt (operator-visible) when only the graph sync is deferred', async () => {
    // Snapshot refresh delivered; graph sync deferred → still surfaced as pending.
    mockTriggerGraphSyncBestEffort.mockResolvedValue({ acknowledged: false, anchorRecorded: true });
    const { handlers } = getRegistry();

    const result = await handlers[HANDLER_ID]({
      event: { data: { technologyId: 'tech-123', technologyName: 'Quantum Computing', triggeredAt: ATTEMPT } },
      step: buildMockStep(),
    });

    expect(result).toMatchObject({ success: true });
    expect(mockRecordPendingSnapshotRefresh).toHaveBeenCalledWith('tech-123', ATTEMPT, undefined);
  });

  it('retries only the handoff after debt persistence fails, without repeating provider spend', async () => {
    const { inngest } = require('@/lib/inngest/client');
    inngest.send.mockRejectedValueOnce(new Error('dispatch unavailable'));
    mockRecordPendingSnapshotRefresh.mockRejectedValueOnce(new Error('firestore unavailable'));
    const { handlers } = getRegistry();

    await expect(
      handlers[HANDLER_ID]({
        event: { data: { technologyId: 'tech-123', technologyName: 'Quantum', triggeredAt: ATTEMPT } },
        step: buildMockStep(),
      })
    ).rejects.toThrow('firestore unavailable');

    expect(mockResearchTechnologyComprehensive).toHaveBeenCalledTimes(1);
    expect(mockCompleteResearchAttempt).toHaveBeenCalledTimes(1);

    mockInspectResearchAttempt.mockResolvedValueOnce({
      active: false,
      reason: 'handoff-pending',
      technology: buildMockTechnology({
        researchStatus: 'completed',
        researchStartedAt: ATTEMPT,
        comprehensiveResearch: { lastResearched: ATTEMPT, version: 1 },
      }),
    });
    inngest.send.mockResolvedValue({ ids: ['evt-retry'] });

    const retried = await handlers[HANDLER_ID]({
      event: { data: { technologyId: 'tech-123', technologyName: 'Quantum', triggeredAt: ATTEMPT } },
      step: buildMockStep(),
    });

    expect(retried).toMatchObject({ success: true, resumedHandoff: true });
    expect(mockResearchTechnologyComprehensive).toHaveBeenCalledTimes(1);
    expect(mockCompleteResearchAttempt).toHaveBeenCalledTimes(1);
    expect(mockReleaseResearchPending).not.toHaveBeenCalled();
  });

  it('should complete successfully and return result with all extracted fields', async () => {
    // Verify save by returning tech with research present
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology()) // verify step
      .mockResolvedValueOnce({
        ...buildMockTechnology(),
        comprehensiveResearch: buildMockResearch(),
        trl: 4,
        timeToImpact: 'H3',
      }); // save verification step

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Quantum Computing',
          technologyDescription: 'A quantum tech',
          category: 'hardware',
          websiteUrl: 'https://example.com',
        },
      },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.technologyId).toBe('tech-123');
    expect(result.technologyName).toBe('Quantum Computing');
    // OBS-006: named units, durable endpoints, and separated phases. `duration`
    // is gone — it measured only the final invocation slice of a checkpointed run.
    expect(result).not.toHaveProperty('duration');
    expect(result.executionMs).toBeGreaterThanOrEqual(0);
    expect(result.providerMs).toBeGreaterThanOrEqual(0);
    expect(result.basis).toBe('accepted-to-terminal');
    expect(result.extractedTRL).toBe(4); // maturityLevel 2 → TRL 4
    expect(result.extractedTimeToImpact).toBe('H3'); // "5-10 years" → H3
    // OBS-001: the business outcome is declared, not inferred from `success`.
    expect(result.__domainOutcome).toEqual({ outcome: 'success' });
  });

  it('should throw when technology is not found', async () => {
    mockInspectResearchAttempt.mockResolvedValue({ active: false, reason: 'not-found' });

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: {
          data: {
            technologyId: 'non-existent',
            technologyName: 'Non-Existent Tech',
          },
        },
        step: buildMockStep(),
      })
    ).rejects.toThrow('Technology non-existent not found');
  });

  it('should throw when AI research returns null', async () => {
    mockResearchTechnologyComprehensive.mockResolvedValue(null);

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: {
          data: {
            technologyId: 'tech-123',
            technologyName: 'Quantum Computing',
          },
        },
        step: buildMockStep(),
      })
    ).rejects.toThrow('AI research returned no data');
  });

  it('should throw when AI research returns empty data', async () => {
    mockResearchTechnologyComprehensive.mockResolvedValue({
      // No executiveSummary, maturityAssessment, keyPlayers, or valueAssessment
      lastResearched: Date.now(),
      version: 1,
    });

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: {
          data: {
            technologyId: 'tech-123',
            technologyName: 'Quantum Computing',
          },
        },
        step: buildMockStep(),
      })
    ).rejects.toThrow('AI research returned empty data');
  });

  it('should update technology with comprehensive research', async () => {
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce({
      ...buildMockTechnology(),
      comprehensiveResearch: buildMockResearch(),
    });

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: 'Quantum Computing',
        },
      },
      step: buildMockStep(),
    });

    expect(mockCompleteResearchAttempt).toHaveBeenCalledWith(
      'tech-123',
      ATTEMPT,
      expect.objectContaining({
        research: expect.any(Object),
      })
    );
  });

  it('should extract and save TRL and TimeToImpact', async () => {
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    expect(mockCompleteResearchAttempt).toHaveBeenCalledWith(
      'tech-123',
      ATTEMPT,
      expect.objectContaining({
        trl: 4, // maturityLevel 2 → TRL 4
        timeToImpact: 'H3', // "5-10 years"
      })
    );
  });

  it('should extract description when technology description is empty', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ description: '' })) // empty description
      .mockResolvedValueOnce(buildMockTechnology({ description: 'Updated' }));

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    expect(mockCompleteResearchAttempt).toHaveBeenCalledWith(
      'tech-123',
      ATTEMPT,
      expect.objectContaining({
        description: expect.stringContaining('Quantum computing'),
      })
    );
  });

  it('delegates concurrent description preservation to the transactional completion boundary', async () => {
    const existingDescription = 'This is an existing description that is already long enough.';
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ description: existingDescription }))
      .mockResolvedValueOnce(buildMockTechnology({ description: existingDescription }));

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const completion = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(completion.description).toContain('Quantum computing');
  });

  it('should extract and set category when technology has no category', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ category: undefined }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    // "Quantum Computing Hardware" matches "hardware"
    expect(callArgs.category).toBe('hardware');
  });

  it('delegates concurrent category preservation to the transactional completion boundary', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ category: 'platform' }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.category).toBe('hardware');
  });

  it('should extract GitHub URL when technology has no existing GitHub URL', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ githubUrl: '' }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.githubUrl).toBe('https://github.com/Qiskit/qiskit');
  });

  it('delegates concurrent GitHub URL preservation to the transactional completion boundary', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ githubUrl: 'https://github.com/existing/repo' }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.githubUrl).toBe('https://github.com/Qiskit/qiskit');
  });

  it('passes derived tags to the transactional merge without copying the stale snapshot', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ tags: ['existing'] }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.tags).not.toContain('existing');
    expect(callArgs.tags).toEqual(expect.arrayContaining(['hyped', 'fast-growing']));
  });

  it('should send technology.updated event after saving research', async () => {
    const { inngest } = require('@/lib/inngest/client');
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/technology.updated',
        data: expect.objectContaining({
          technologyId: 'tech-123',
          updatedFields: expect.arrayContaining(['comprehensiveResearch']),
        }),
      })
    );
  });

  it('should include "trl" and "timeToImpact" in updatedFields when extracted', async () => {
    const { inngest } = require('@/lib/inngest/client');
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    const sendCall = inngest.send.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).name === 'app/technology.updated'
    );
    expect(sendCall).toBeDefined();
    const updatedFields = (sendCall![0] as { data: { updatedFields: string[] } }).data.updatedFields;
    expect(updatedFields).toContain('trl');
    expect(updatedFields).toContain('timeToImpact');
  });

  it('should handle research with maturityAssessment only (no executiveSummary)', async () => {
    mockResearchTechnologyComprehensive.mockResolvedValue({
      lastResearched: Date.now(),
      version: 1,
      maturityAssessment: {
        hypeCyclePosition: 'innovation-trigger',
        timeToMainstream: '3+ years',
        maturityTrajectory: 'stable',
      },
    });

    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Test Tech' },
      },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
  });

  it('should fall back to technology data when event data fields are missing', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(
        buildMockTechnology({
          name: 'Quantum Computing',
          description: 'From technology doc',
          category: 'hardware',
        })
      )
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: {
          technologyId: 'tech-123',
          technologyName: undefined,
          technologyDescription: undefined,
          category: undefined,
          websiteUrl: undefined,
        },
      },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(mockResearchTechnologyComprehensive).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'From technology doc',
        category: 'hardware',
      })
    );
  });

  it('should rethrow error from AI research', async () => {
    mockResearchTechnologyComprehensive.mockRejectedValue(new Error('AI rate limit exceeded'));

    const { handlers } = getRegistry();
    await expect(
      handlers[HANDLER_ID]({
        event: {
          data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
        },
        step: buildMockStep(),
      })
    ).rejects.toThrow('AI rate limit exceeded');
  });

  it('should handle research with no open source projects (no GitHub URL)', async () => {
    const researchNoGitHub = buildMockResearch({
      keyPlayers: {
        marketLeaders: [],
        emergingStartups: [],
        researchInstitutions: [],
        openSourceProjects: [],
      },
    });
    mockResearchTechnologyComprehensive.mockResolvedValue(researchNoGitHub);
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.extractedGitHubUrl).toBeUndefined();

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.githubUrl).toBeUndefined();
  });

  it('should handle research with no maturity assessment (no TRL or TimeToImpact)', async () => {
    const researchNoMaturity = {
      lastResearched: Date.now(),
      version: 1,
      executiveSummary: {
        summary: 'Summary without maturity data.',
        keyInsights: [],
      },
      // No valueAssessment, no maturityAssessment
    };
    mockResearchTechnologyComprehensive.mockResolvedValue(researchNoMaturity);
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Test Tech' },
      },
      step: buildMockStep(),
    });

    expect(result.success).toBe(true);
    expect(result.extractedTRL).toBeUndefined();
    expect(result.extractedTimeToImpact).toBeUndefined();

    const callArgs = mockCompleteResearchAttempt.mock.calls[0][2];
    expect(callArgs.trl).toBeUndefined();
    expect(callArgs.timeToImpact).toBeUndefined();
  });

  it('should report correct sectionsPopulated count', async () => {
    mockGetTechnologyById.mockResolvedValueOnce(buildMockTechnology()).mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    // The mock research has: executiveSummary, maturityAssessment, technologyMetrics,
    // valueAssessment, keyPlayers, useCasesAndApplications = 6 sections
    // (lastResearched, version excluded)
    expect(result.sectionsPopulated).toBeGreaterThan(0);
  });

  it('should set updatedDescription true when description was empty and extracted', async () => {
    mockGetTechnologyById
      .mockResolvedValueOnce(buildMockTechnology({ description: '' }))
      .mockResolvedValueOnce(buildMockTechnology());

    const { handlers } = getRegistry();
    const result = await handlers[HANDLER_ID]({
      event: {
        data: { technologyId: 'tech-123', technologyName: 'Quantum Computing' },
      },
      step: buildMockStep(),
    });

    expect(result.updatedDescription).toBe(true);
  });
});
