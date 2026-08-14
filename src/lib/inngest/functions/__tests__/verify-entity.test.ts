/**
 * @jest-environment node
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// store-result now reads the minted id (ARUN-022), so the creator must resolve one.
const mockCreateVerificationResult = jest.fn().mockResolvedValue({ id: 'vr-test' });

// Admin-SDK mocks (post-T1.2 migration). `verify-entity.ts` now uses
// `db.collection(...).doc(...).get/update(...)` via firebase-admin. The shared
// helper builds the chainable mock; spies are exposed for assertions.
import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';
const { adminMock } = createFirebaseAdminMock();
const mockDocGet = adminMock.docGet;
const mockDocUpdate = adminMock.update;
mockDocGet.mockResolvedValue({
  exists: true,
  data: () => ({ name: 'TestTech', description: 'A technology' }),
});

// New primitive mocks — default to inconclusive so existing tests keep score=50
const mockVerifyEntityReality = jest.fn().mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
const mockVerifyUrlsReachable = jest.fn().mockResolvedValue({ ok: true });

// Smart scoring mocks
const mockGetObservationsForEntity = jest.fn().mockResolvedValue([]);
const mockAggregateObservationScore = jest.fn().mockReturnValue({ sparse: true, observationCount: 0 });

jest.mock('@/lib/entity-reality-check', () => ({
  __esModule: true,
  verifyEntityReality: (...args: unknown[]) => mockVerifyEntityReality(...args),
}));

jest.mock('@/lib/scout-url-verifier', () => ({
  __esModule: true,
  verifyUrlsReachable: (...args: unknown[]) => mockVerifyUrlsReachable(...args),
}));

jest.mock('@/lib/graph/verification', () => ({
  __esModule: true,
  createVerificationResult: (...args: unknown[]) => mockCreateVerificationResult(...args),
}));

// Admin SDK boundary — verify-entity.ts dynamic-imports `@/lib/firebase-admin`.
// ENTITY_CONFIGS is no longer needed: the function now uses an inline
// ENTITY_COLLECTIONS map (added in T1.2).
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/graph/observations', () => ({
  __esModule: true,
  getObservationsForEntity: (...args: unknown[]) => mockGetObservationsForEntity(...args),
  aggregateObservationScore: (...args: unknown[]) => mockAggregateObservationScore(...args),
}));

// Registry closure pattern — define inside factory to avoid hoisting issues
jest.mock('../../client', () => {
  const reg: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        reg.handlers[id] = handler;
        reg.configs[id] = config;
        reg.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: reg,
  };
});

// Import AFTER mocks
import '../verify-entity';

function getRegistry() {
  return require('../../client')._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function buildMockStep() {
  return {
    run: jest.fn((_name: string, fn: AnyFunction) => fn()),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verify-entity', () => {
  // The verify-entity function early-returns { skipped: true } unless the
  // master gate env var is set (verify-entity.ts:35-41 — defense in depth
  // added in commit 99c47f37). Use beforeEach/afterEach (not beforeAll) so
  // the env doesn't leak across files in the same Jest worker.
  beforeEach(() => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    jest.clearAllMocks();
    // Ensure sparse so tests fall through to pragmatic-v1 logic
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('should register with id verify-entity', () => {
    expect(getRegistry().handlers['verify-entity']).toBeDefined();
  });

  it('does no work when Defense Minister is disabled (GRAPH-048 acceptance: disabled = zero)', async () => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-entity'];

    await expect(handler({ event: { data: { entityId: 'comp-1', entityType: 'company' } }, step })).resolves.toEqual({
      entityId: 'comp-1',
      skipped: true,
      reason: 'DEFENSE_MINISTER_ENABLED!=true',
    });

    expect(step.run).not.toHaveBeenCalled();
  });

  it.each([
    'signal',
    'radarPlacement',
    'strategy',
    'prototype',
    'useCase',
    'initiative',
    'painPoint',
    'orgUnit',
    'document',
    'not-a-real-type',
  ])('fails closed for unsupported type %s before any durable or external work', async (entityType) => {
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-entity'];

    await expect(handler({ event: { data: { entityId: 'internal-1', entityType } }, step })).rejects.toThrow(
      `Unsupported entity verification type: ${entityType}`
    );

    expect(step.run).not.toHaveBeenCalled();
    expect(adminMock.collection).not.toHaveBeenCalled();
    expect(mockGetObservationsForEntity).not.toHaveBeenCalled();
    expect(mockVerifyEntityReality).not.toHaveBeenCalled();
    expect(mockCreateVerificationResult).not.toHaveBeenCalled();
    expect(mockDocUpdate).not.toHaveBeenCalled();
  });

  it('should trigger on app/entity.verification.requested event', () => {
    expect(getRegistry().triggers['verify-entity']).toEqual({
      event: 'app/entity.verification.requested',
    });
  });

  it('should call createVerificationResult with entity data', async () => {
    const handler = getRegistry().handlers['verify-entity'];
    await handler({
      event: {
        data: { entityId: 'tech-1', entityType: 'technology' },
      },
      step: buildMockStep(),
    });

    expect(mockCreateVerificationResult).toHaveBeenCalledTimes(1);
    expect(mockCreateVerificationResult).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'tech-1' }));
    expect(adminMock.collection).toHaveBeenCalledWith('technologies');
  });

  it('should update entity verifiedScore in Firestore', async () => {
    const handler = getRegistry().handlers['verify-entity'];
    await handler({
      event: {
        data: { entityId: 'tech-1', entityType: 'technology' },
      },
      step: buildMockStep(),
    });

    expect(mockDocUpdate).toHaveBeenCalledTimes(1);
  });

  // GRAPH-061: a verdict that could not be anchored in the graph must not leave
  // a verified status behind in Firestore either — the run fails and retries.
  it('does not stamp Firestore verification status when the graph anchor is missing', async () => {
    const missing = new Error('Cannot record a verification result: entity tech-1 is not present in the graph');
    missing.name = 'VerificationTargetMissingError';
    mockCreateVerificationResult.mockRejectedValueOnce(missing);

    const handler = getRegistry().handlers['verify-entity'];
    await expect(
      handler({
        event: { data: { entityId: 'tech-1', entityType: 'technology' } },
        step: buildMockStep(),
      })
    ).rejects.toMatchObject({ name: 'VerificationTargetMissingError' });

    expect(mockDocUpdate).not.toHaveBeenCalled();
  });

  it('loads company entities from the canonical companies collection', async () => {
    const handler = getRegistry().handlers['verify-entity'];
    await handler({
      event: { data: { entityId: 'comp-1', entityType: 'company' } },
      step: buildMockStep(),
    });

    expect(adminMock.collection).toHaveBeenCalledWith('companies');
  });

  it('should execute all steps in order', async () => {
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-entity'];

    await handler({
      event: {
        data: { entityId: 'tech-1', entityType: 'technology' },
      },
      step,
    });

    const stepNames = step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames).toEqual(['load-entity', 'verify', 'store-result', 'update-entity']);
  });

  it('should return verification result', async () => {
    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: {
        data: { entityId: 'tech-1', entityType: 'technology' },
      },
      step: buildMockStep(),
    });

    expect(result.entityId).toBe('tech-1');
    expect(result.status).toBe('unverified');
    expect(result.score).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Real verification logic tests
// ---------------------------------------------------------------------------

describe('verify-entity real verification', () => {
  beforeEach(() => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    jest.clearAllMocks();
    // Default entity with a website field (can be overridden per test)
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ name: 'TestTech', description: 'A technology', website: 'https://testtech.io' }),
    });
    // Ensure sparse so tests fall through to pragmatic-v1 logic
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('marks entity as verified when web presence + reachable website both confirm', async () => {
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: 'real' });
    mockVerifyUrlsReachable.mockResolvedValue({ ok: true });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-2', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.status).toBe('verified');
    expect(result.sourcesConfirming).toBeGreaterThanOrEqual(2);
  });

  it('refuses `verified` on a single unreplicated confirming source (VERIFY-001)', async () => {
    // Entity has NO website, so only the web-presence reality check runs and
    // `sources` holds exactly one confirming entry. Ratio scoring alone gives
    // 1/1 = 100, which the old code turned into 'verified'. 'verified' now
    // requires replication (≥2 independent confirming sources), so a lone
    // source can be 'unverified' at most — the score stays high but the label
    // must not claim corroboration that does not exist.
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ name: 'TestTech', description: 'A technology' }), // no website
    });
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: 'real' });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-solo', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.sourcesChecked).toBe(1);
    expect(result.sourcesConfirming).toBe(1);
    expect(result.sourcesContradicting).toBe(0);
    expect(result.status).not.toBe('verified');
    expect(result.status).toBe('unverified');
  });

  it('marks entity as disputed when neither web presence nor URL confirm', async () => {
    mockVerifyEntityReality.mockResolvedValue({ ok: false, reason: 'no-name-match', summary: '' });
    mockVerifyUrlsReachable.mockResolvedValue({
      ok: false,
      unreachable: [{ url: 'https://testtech.io', reachable: false, reason: '404 Not Found' }],
    });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-3', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.score).toBeLessThan(50);
    expect(result.status).toBe('disputed');
  });

  it('passes inconclusively when reality check infra fails (searchFailed)', async () => {
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
    // No website on this entity
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ name: 'TestTech', description: 'A technology' }),
    });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-4', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.score).toBe(50);
    expect(result.status).toBe('unverified');
    expect(result.sourcesChecked).toBe(1);
    expect(result.sourcesConfirming).toBe(0);
    expect(result.sourcesContradicting).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Smart scoring tests
// ---------------------------------------------------------------------------

describe('verify-entity smart scoring', () => {
  beforeEach(() => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    jest.clearAllMocks();
    // Default: entity with no website
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ name: 'TestTech', description: 'A technology' }),
    });
    // Default: sparse (falls back to pragmatic)
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });
    // Default pragmatic fallback result
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
    mockVerifyUrlsReachable.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('uses observations when ≥1 weight of evidence exists (smart path)', async () => {
    const fakeObservations = [
      {
        id: 'obs-1',
        entityId: 'tech-5',
        sourceUrl: 'https://a.com',
        verdict: 'confirming',
        agentType: 'scout',
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 'obs-2',
        entityId: 'tech-5',
        sourceUrl: 'https://b.com',
        verdict: 'confirming',
        agentType: 'scout',
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        // M13: the smart path requires at least one non-confirming class —
        // an all-confirming monoculture would be indistinguishable from the
        // old hard-coded 'confirming' rubber stamp.
        id: 'obs-3',
        entityId: 'tech-5',
        sourceUrl: 'https://c.com',
        verdict: 'inconclusive',
        agentType: 'scout',
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];
    mockGetObservationsForEntity.mockResolvedValue(fakeObservations);
    mockAggregateObservationScore.mockReturnValue({
      sparse: false,
      smartScore: {
        score: 100,
        status: 'verified',
        weightedConfirming: 2,
        weightedContradicting: 0,
        observationCount: 3,
      },
    });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-5', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.score).toBe(100);
    expect(result.status).toBe('verified');
    expect(result.verifierModel).toBe('defense-minister-smart-v1');
    expect(result.sourcesChecked).toBe(3);
    expect(mockVerifyEntityReality).not.toHaveBeenCalled();
  });

  it('falls back to active recheck when every observation is confirming (M13 rubber-stamp guard)', async () => {
    const allConfirming = ['https://a.com', 'https://b.com', 'https://c.com'].map((url, i) => ({
      id: `obs-${i}`,
      entityId: 'tech-9',
      sourceUrl: url,
      verdict: 'confirming',
      agentType: 'scout',
      observedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }));
    mockGetObservationsForEntity.mockResolvedValue(allConfirming);
    mockAggregateObservationScore.mockReturnValue({
      sparse: false,
      smartScore: {
        score: 100,
        status: 'verified',
        weightedConfirming: 3,
        weightedContradicting: 0,
        observationCount: 3,
      },
    });
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: 'real' });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-9', entityType: 'technology' } },
      step: buildMockStep(),
    });

    // The aggregate alone must NOT be trusted — an observation set with zero
    // non-confirming verdicts always scores 100, so verify against the web.
    expect(mockVerifyEntityReality).toHaveBeenCalled();
    expect(result.verifierModel).toBe('defense-minister-v1-pragmatic');
  });

  it('falls back to active recheck when observations sparse', async () => {
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: 'real' });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-6', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.verifierModel).toBe('defense-minister-v1-pragmatic');
    expect(mockVerifyEntityReality).toHaveBeenCalled();
  });

  it('contradicting observations drop score below 50 (disputed)', async () => {
    const fakeObservations = [
      {
        id: 'obs-4',
        entityId: 'tech-7',
        sourceUrl: 'https://d.com',
        verdict: 'contradicting',
        agentType: 'scout',
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 'obs-5',
        entityId: 'tech-7',
        sourceUrl: 'https://e.com',
        verdict: 'contradicting',
        agentType: 'scout',
        observedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];
    mockGetObservationsForEntity.mockResolvedValue(fakeObservations);
    mockAggregateObservationScore.mockReturnValue({
      sparse: false,
      smartScore: {
        score: 30,
        status: 'disputed',
        weightedConfirming: 0,
        weightedContradicting: 2,
        observationCount: 2,
      },
    });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-7', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.status).toBe('disputed');
    expect(result.verifierModel).toBe('defense-minister-smart-v1');
  });

  it('falls back to active recheck when smart path throws', async () => {
    mockGetObservationsForEntity.mockRejectedValue(new Error('neo4j down'));
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: '' });

    const handler = getRegistry().handlers['verify-entity'];
    const result = await handler({
      event: { data: { entityId: 'tech-8', entityType: 'technology' } },
      step: buildMockStep(),
    });

    expect(result.verifierModel).toBe('defense-minister-v1-pragmatic');
  });
});
