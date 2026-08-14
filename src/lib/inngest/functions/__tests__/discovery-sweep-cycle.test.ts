export {};
/**
 * @jest-environment node
 *
 * The sweep handler, with the DISC-016 mode boundary:
 * - AMBIENT (cron leg, `inngest/scheduled.timer`): full select → contain →
 *   dispatch pipeline under the system discovery principal.
 * - ON-DEMAND (`app/discovery.sweep.requested`, the Graph Discovery click):
 *   STAGE-ONLY — requires a usable view context (fail closed), stages bounded
 *   net-new proposals scoped to it, and can never reach selection/dispatch.
 *
 * With createFunction mocked to return the handler, we drive it directly with a
 * fake step. Containment helpers are REAL (pure) so source-cap + dedup behavior
 * is genuinely exercised; the quotas helper is wrapped so one test can force it
 * to throw and prove the sweep fails-open.
 */
const mockGetDiscoveryConfig = jest.fn();
const mockGetProposedAssessments = jest.fn();
const mockSelectBenchmarkCandidates = jest.fn();
const mockSelectDiscoveryEntities = jest.fn();
const mockDispatchBenchmarkEvaluation = jest.fn();
const mockDiscoverNetNew = jest.fn();
const mockSystemConfigGet = jest.fn();

jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, handler: unknown) => handler, send: jest.fn() },
}));
jest.mock('@/lib/discovery/discovery-config', () => ({
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: (...args: unknown[]) => mockSystemConfigGet(...args) })),
    })),
  },
}));
jest.mock('@/lib/proposed-assessments-admin', () => ({
  getProposedAssessments: (...a: unknown[]) => mockGetProposedAssessments(...a),
}));
jest.mock('@/lib/discovery/discovery-entity-selector', () => ({
  selectBenchmarkCandidates: (...a: unknown[]) => mockSelectBenchmarkCandidates(...a),
  selectDiscoveryEntities: (...a: unknown[]) => mockSelectDiscoveryEntities(...a),
}));
jest.mock('@/lib/discovery/discovery-dispatch', () => ({
  dispatchBenchmarkEvaluation: (...a: unknown[]) => mockDispatchBenchmarkEvaluation(...a),
}));
jest.mock('@/lib/discovery/net-new-discovery', () => ({
  discoverNetNewEntities: (...a: unknown[]) => mockDiscoverNetNew(...a),
  DISCOVERABLE_TYPES: ['technology', 'useCase', 'painPoint', 'company'],
}));
jest.mock('@/lib/discovery/diversity-quotas', () => {
  const real = jest.requireActual('@/lib/discovery/diversity-quotas');
  return { applyQuotasAndMMR: jest.fn((...a: unknown[]) => real.applyQuotasAndMMR(...a)) };
});
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
const mockGetAllRadars = jest.fn();
jest.mock('@/lib/config', () => ({ config: { build: { defaultRadarId: undefined } } }));
jest.mock('@/lib/radars-admin', () => ({ adminGetAllRadars: (...a: unknown[]) => mockGetAllRadars(...a) }));

const { discoverySweepCycle } = require('../discovery-sweep-cycle');
const { applyQuotasAndMMR: mockQuotas } = jest.requireMock('@/lib/discovery/diversity-quotas');

const fakeStep = {
  run: (_name: string, fn: () => unknown) => fn(),
  sendEvent: jest.fn(),
};

const cand = (entityId: string, source = 'interest-selector', entityName = entityId) => ({
  entityId,
  entityName,
  entityType: 'technology',
  topic: 't',
  baseScore: 0.5,
  explorationDelta: 0.1,
  score: 0.6,
  source,
});

/** The Graph Discovery click: a direct sweep event (STAGE-ONLY mode). */
function runOnDemand(eventData: Record<string, unknown> = {}) {
  return discoverySweepCycle({
    event: { name: 'app/discovery.sweep.requested', data: eventData },
    step: fakeStep,
  });
}

/** The ambient cron leg (full paid pipeline, system principal). */
function runCron() {
  return discoverySweepCycle({ event: { name: 'inngest/scheduled.timer', data: {} }, step: fakeStep });
}

const VALID_CONTEXT = { focusEntityIds: ['tech-1'], focusTopics: ['graph-db'] };

const enabledConfig = {
  enabled: true,
  radarId: 'r1', // resolve-radar short-circuits on config.radarId (no app-config/radars import)
  maxDispatchPerCycle: 2,
  maxUseCaseDispatchPerCycle: 1,
  pendingProposalsCap: 30,
  maxSourceShare: 0.4,
  maxEntityTypeShare: 0.4,
  mmrLambda: 0.7,
};

describe('discoverySweepCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSystemConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 10 } }),
    });
    mockDiscoverNetNew.mockResolvedValue({ proposed: 0, proposedNames: [], topics: [] });
    mockGetDiscoveryConfig.mockReturnValue(enabledConfig);
    mockGetProposedAssessments.mockResolvedValue([]);
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    mockDispatchBenchmarkEvaluation.mockResolvedValue({ missionId: 'm' });
  });

  it('is disabled-and-dispatches-nothing when the flag is off', async () => {
    mockGetDiscoveryConfig.mockReturnValue({ ...enabledConfig, enabled: false });
    const res = await runCron();
    expect(res).toMatchObject({ action: 'disabled', dispatched: 0 });
    expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
  });

  it('is paused when the background automation master switch is off or unreadable', async () => {
    mockSystemConfigGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ sweep: { enabled: false, maxActionsPerSweep: 10 } }),
    });
    expect(await runCron()).toMatchObject({ action: 'paused', dispatched: 0 });

    mockSystemConfigGet.mockRejectedValueOnce(new Error('Firestore unavailable'));
    expect(await runCron()).toMatchObject({ action: 'paused', dispatched: 0 });
    expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
  });

  it('skips outright on the MAINTENANCE_PAUSED environment guard (scoped env, restored after)', async () => {
    // Scoped set/restore — never flip the guard globally, which would silently
    // gate every other ambient-handler suite in this Jest process.
    const previous = process.env.MAINTENANCE_PAUSED;
    process.env.MAINTENANCE_PAUSED = '1';
    try {
      const res = await runCron();
      expect(res).toMatchObject({ skipped: true, reason: 'maintenance-paused' });
      expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MAINTENANCE_PAUSED;
      else process.env.MAINTENANCE_PAUSED = previous;
    }
  });

  describe('on-demand mode is STAGE-ONLY (DISC-016)', () => {
    it('rejects an event without usable context before any staging (fail closed)', async () => {
      const res = await runOnDemand({ userId: 'u1' });
      expect(res).toMatchObject({ action: 'rejected-unscoped', mode: 'staged', dispatched: 0 });
      expect(mockDiscoverNetNew).not.toHaveBeenCalled();
      expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
      expect(fakeStep.sendEvent).not.toHaveBeenCalled();
      // Rejection precedes even the pending-cap read — zero Firestore work.
      expect(mockGetProposedAssessments).not.toHaveBeenCalled();
    });

    it('rejects a forged event whose context clamps to nothing', async () => {
      const res = await runOnDemand({ userId: 'u1', context: { focusEntityIds: [42], focusTopics: ['  '] } });
      expect(res).toMatchObject({ action: 'rejected-unscoped', mode: 'staged', dispatched: 0 });
      expect(mockDiscoverNetNew).not.toHaveBeenCalled();
    });

    it('rejects an ids-only context (no topics) — staging must be view-topic-scoped, never profile-generic', async () => {
      const res = await runOnDemand({ userId: 'u1', context: { focusEntityIds: ['tech-1'] } });
      expect(res).toMatchObject({ action: 'rejected-unscoped', mode: 'staged', dispatched: 0 });
      expect(mockDiscoverNetNew).not.toHaveBeenCalled();
      expect(mockGetProposedAssessments).not.toHaveBeenCalled();
    });

    it('stages context-scoped net-new proposals and NEVER selects or dispatches', async () => {
      mockGetDiscoveryConfig.mockReturnValue({
        ...enabledConfig,
        netNewEnabled: true,
        maxNetNewPerCycle: 3,
        netNewDimensions: ['technology', 'useCase'],
      });
      mockDiscoverNetNew.mockResolvedValue({
        entityType: 'technology',
        topics: ['graph-db'],
        considered: 4,
        proposed: 2,
        proposedNames: ['A', 'B'],
        failed: 0,
        ok: true,
      });
      // Even with dispatchable candidates available, staged mode must not look at them.
      mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);

      const res = await runOnDemand({ userId: 'u1', context: VALID_CONTEXT });

      expect(res).toMatchObject({ action: 'staged', mode: 'staged', dispatched: 0, netNewProposed: 4 });
      // Context topics reach the stager so proposals are scoped, not generic.
      expect(mockDiscoverNetNew).toHaveBeenCalledWith('u1', {
        entityType: 'technology',
        limit: 3,
        focusTopics: ['graph-db'],
      });
      expect(mockDiscoverNetNew).toHaveBeenCalledWith('u1', {
        entityType: 'useCase',
        limit: 3,
        focusTopics: ['graph-db'],
      });
      // ZERO missions or reservations: no selection, no containment, no dispatch.
      expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
      expect(mockSelectDiscoveryEntities).not.toHaveBeenCalled();
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
      expect(mockQuotas).not.toHaveBeenCalled();
      // Completion event is stamped as a staged run.
      expect(fakeStep.sendEvent).toHaveBeenCalledWith(
        'emit-completion',
        expect.objectContaining({
          name: 'app/discovery.sweep.completed',
          data: expect.objectContaining({ mode: 'staged', dispatched: 0 }),
        })
      );
    });

    it('stages nothing (but still never dispatches) when net-new discovery is off', async () => {
      mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
      const res = await runOnDemand({ userId: 'u1', context: VALID_CONTEXT });
      expect(res).toMatchObject({ action: 'staged', mode: 'staged', dispatched: 0, netNewProposed: 0 });
      expect(mockDiscoverNetNew).not.toHaveBeenCalled();
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
    });

    it('is bounded by the pending-proposals cap like the ambient leg', async () => {
      mockGetProposedAssessments.mockResolvedValue(new Array(30).fill({ id: 'x' }));
      const res = await runOnDemand({ userId: 'u1', context: VALID_CONTEXT });
      expect(res).toMatchObject({ action: 'cap-reached', mode: 'staged', dispatched: 0 });
      expect(mockDiscoverNetNew).not.toHaveBeenCalled();
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
    });

    it('a hand-crafted event with a radarId still cannot reach the paid pipeline', async () => {
      mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1'), cand('t2')]);
      const res = await runOnDemand({ userId: 'u1', radarId: 'r1', context: VALID_CONTEXT });
      expect(res).toMatchObject({ action: 'staged', dispatched: 0 });
      expect(mockDispatchBenchmarkEvaluation).not.toHaveBeenCalled();
    });
  });

  it('cron leg falls back to the config radar for selection scope', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    await runCron();
    expect(mockSelectBenchmarkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ radarId: 'r1', userId: 'system-discovery' })
    );
  });

  it('ALSO selects a useCase pool (secondary dimension) — un-radar-scoped, tiny budget', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    await runCron();
    expect(mockSelectDiscoveryEntities).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'useCase', userId: 'system-discovery' })
    );
    // useCase select must NOT be radar-scoped (whole use-cases collection).
    expect(mockSelectDiscoveryEntities.mock.calls[0][0]).not.toHaveProperty('radarId');
  });

  it('dispatches a selected useCase candidate with its own entityType', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    mockSelectDiscoveryEntities.mockResolvedValue([
      {
        entityId: 'uc-1',
        entityName: 'UC',
        entityType: 'useCase',
        topic: 'x',
        baseScore: 1,
        explorationDelta: 0,
        score: 1,
        source: 'interest-selector',
      },
    ]);
    await runCron();
    expect(mockDispatchBenchmarkEvaluation).toHaveBeenCalledWith('uc-1', 'system-discovery', 'useCase');
  });

  it('per-dimension budgets: a useCase candidate does NOT starve the technology budget', async () => {
    const dimCand = (id: string, type: string, topic: string) => ({
      entityId: id,
      entityName: id,
      entityType: type,
      topic,
      baseScore: 1,
      explorationDelta: 0,
      score: 1,
      source: 'interest-selector',
    });
    mockSelectBenchmarkCandidates.mockResolvedValue([
      dimCand('t1', 'technology', 'a'),
      dimCand('t2', 'technology', 'b'),
      dimCand('t3', 'technology', 'c'),
    ]);
    mockSelectDiscoveryEntities.mockResolvedValue([dimCand('uc1', 'useCase', 'x'), dimCand('uc2', 'useCase', 'y')]);
    await runCron();
    const dispatchedTypes = mockDispatchBenchmarkEvaluation.mock.calls.map((c) => c[2]); // entityType arg
    expect(dispatchedTypes.filter((t) => t === 'technology')).toHaveLength(2); // full maxDispatchPerCycle, NOT halved
    expect(dispatchedTypes.filter((t) => t === 'useCase')).toHaveLength(1); // maxUseCaseDispatchPerCycle
  });

  it('does NOT run net-new discovery when netNewEnabled is off (default)', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    await runCron();
    expect(mockDiscoverNetNew).not.toHaveBeenCalled();
  });

  it('cron leg runs net-new per configured dimension WITHOUT focus topics (no view context)', async () => {
    mockGetDiscoveryConfig.mockReturnValue({
      ...enabledConfig,
      netNewEnabled: true,
      maxNetNewPerCycle: 3,
      netNewDimensions: ['technology', 'useCase'],
    });
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    await runCron();
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('system-discovery', { entityType: 'technology', limit: 3 });
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('system-discovery', { entityType: 'useCase', limit: 3 });
  });

  it('skips unknown dimensions (only DISCOVERABLE_TYPES run)', async () => {
    mockGetDiscoveryConfig.mockReturnValue({
      ...enabledConfig,
      netNewEnabled: true,
      maxNetNewPerCycle: 2,
      netNewDimensions: ['technology', 'bogus'],
    });
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    await runCron();
    expect(mockDiscoverNetNew).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('system-discovery', { entityType: 'technology', limit: 2 });
  });

  it('runs net-new EVEN when there are no dispatch candidates (independent discovery)', async () => {
    mockGetDiscoveryConfig.mockReturnValue({
      ...enabledConfig,
      netNewEnabled: true,
      maxNetNewPerCycle: 2,
      netNewDimensions: ['technology'],
    });
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    const res = await runCron();
    expect(mockDiscoverNetNew).toHaveBeenCalledWith('system-discovery', { entityType: 'technology', limit: 2 });
    expect(res.action).toBe('no-candidates'); // no dispatch, but net-new still ran
  });

  it('a net-new failure in one dimension does NOT fail the sweep', async () => {
    mockGetDiscoveryConfig.mockReturnValue({
      ...enabledConfig,
      netNewEnabled: true,
      maxNetNewPerCycle: 3,
      netNewDimensions: ['technology'],
    });
    mockDiscoverNetNew.mockRejectedValue(new Error('gemini down'));
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);
    const res = await runCron();
    expect(res.action).toBe('dispatched'); // sweep completed despite net-new failure
  });

  it('DISC-015: preserves a successful dimension and reports the failed one as a diagnostic', async () => {
    mockGetDiscoveryConfig.mockReturnValue({
      ...enabledConfig,
      netNewEnabled: true,
      maxNetNewPerCycle: 3,
      netNewDimensions: ['technology', 'useCase'],
    });
    mockDiscoverNetNew.mockImplementation((_userId: string, opts: { entityType: string }) =>
      opts.entityType === 'technology'
        ? Promise.resolve({
            entityType: 'technology',
            topics: [],
            considered: 4,
            proposed: 2,
            proposedNames: ['A', 'B'],
            failed: 0,
            ok: true,
          })
        : Promise.resolve({
            entityType: 'useCase',
            topics: [],
            considered: 0,
            proposed: 0,
            proposedNames: [],
            failed: 0,
            ok: false,
            error: 'Schema validation failed: candidates: Required',
          })
    );
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1')]);
    mockSelectDiscoveryEntities.mockResolvedValue([]);

    const res = await runCron();

    // The successful dimension's proposals survive the other dimension's failure.
    expect(res.netNewProposed).toBe(2);
    const diagnostics = res.netNewDiagnostics as Array<{ entityType: string; ok: boolean; error?: string }>;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.find((d) => d.entityType === 'technology')).toMatchObject({ ok: true, proposed: 2 });
    const useCase = diagnostics.find((d) => d.entityType === 'useCase');
    expect(useCase).toMatchObject({ ok: false });
    expect(useCase?.error).toContain('Schema validation failed');
  });

  it('runs UNSCOPED and surfaces scope:"unscoped" when no radar resolves (multi-radar, no config)', async () => {
    mockGetDiscoveryConfig.mockReturnValue({ ...enabledConfig, radarId: '' });
    mockGetAllRadars.mockResolvedValue([{ id: 'a' }, { id: 'b' }]); // 2+ radars, none configured → ''
    mockSelectBenchmarkCandidates.mockResolvedValue([
      {
        entityId: 't1',
        entityName: 'T1',
        entityType: 'technology',
        topic: 'x',
        baseScore: 1,
        explorationDelta: 0,
        score: 1,
        source: 'interest-selector',
      },
    ]);
    const res = await runCron();
    expect(mockSelectBenchmarkCandidates).toHaveBeenCalledWith(expect.objectContaining({ radarId: undefined }));
    expect(res).toMatchObject({ scope: 'unscoped', radarId: null });
  });

  it('short-circuits as cap-reached when pending proposals exceed the cap', async () => {
    mockGetProposedAssessments.mockResolvedValue(new Array(30).fill({ id: 'x' }));
    const res = await runCron();
    expect(res).toMatchObject({ action: 'cap-reached', dispatched: 0 });
    expect(mockSelectBenchmarkCandidates).not.toHaveBeenCalled();
  });

  it('dispatches exactly maxDispatchPerCycle from an over-fetched pool', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([
      cand('t1', 'a'),
      cand('t2', 'b'),
      cand('t3', 'a'),
      cand('t4', 'b'),
      cand('t5', 'a'),
      cand('t6', 'b'),
    ]);
    const res = await runCron();
    expect(res.dispatched).toBe(2);
    expect(mockDispatchBenchmarkEvaluation).toHaveBeenCalledTimes(2);
  });

  it('collapses seeded duplicates before triage (collapsed > 0)', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1', 'a', 'Same Name'), cand('t2', 'b', 'same  name')]);
    const res = await runCron();
    expect(res.collapsed).toBeGreaterThan(0);
  });

  it('continues + decrements dispatched when one dispatch rejects', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1', 'a'), cand('t2', 'b')]);
    mockDispatchBenchmarkEvaluation.mockRejectedValueOnce(new Error('dispatch boom'));
    const res = await runCron();
    expect(res.dispatched).toBe(1);
  });

  it('fails OPEN — a containment-helper throw still completes + flags the cycle degraded', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1', 'a'), cand('t2', 'b')]);
    mockQuotas.mockImplementationOnce(() => {
      throw new Error('containment boom');
    });
    const res = await runCron();
    expect(res.dispatched).toBeGreaterThanOrEqual(1);
    expect(res.degraded).toBe(true);
    expect(mockDispatchBenchmarkEvaluation).toHaveBeenCalled();
  });

  it('reports attempted>0 with dispatched 0 when every dispatch fails (broken dispatch path)', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1', 'a'), cand('t2', 'b')]);
    mockDispatchBenchmarkEvaluation.mockRejectedValue(new Error('dispatch always fails'));
    const res = await runCron();
    expect(res.dispatched).toBe(0);
    expect(res.attempted).toBeGreaterThan(0);
  });

  it('emits a mode-stamped completed event and reports no-candidates on an empty pool', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([]);
    const res = await runCron();
    expect(res).toMatchObject({ action: 'no-candidates', dispatched: 0 });
    expect(fakeStep.sendEvent).toHaveBeenCalled();
  });

  it('cron completion event carries mode:"ambient"', async () => {
    mockSelectBenchmarkCandidates.mockResolvedValue([cand('t1', 'a')]);
    await runCron();
    expect(fakeStep.sendEvent).toHaveBeenCalledWith(
      'emit-completion',
      expect.objectContaining({ data: expect.objectContaining({ mode: 'ambient' }) })
    );
  });
});
