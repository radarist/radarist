/**
 * @jest-environment node
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateEdgeVerificationResult = jest.fn().mockResolvedValue({ id: 'evr-1' });

const mockVerifyEntityReality = jest.fn().mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
const mockVerifyUrlsReachable = jest.fn().mockResolvedValue({ ok: true });

const DEFAULT_RELATION = {
  id: 'rel-1',
  relationType: 'uses',
  sourceSnapshot: { id: 'src-1', type: 'technology', name: 'TensorFlow', snapshotAt: Date.now() },
  targetSnapshot: { id: 'tgt-1', type: 'technology', name: 'Python', snapshotAt: Date.now() },
  notes: undefined,
  confidence: 80,
  aiSuggested: false,
  claimStatus: 'curated',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockAdminGetRelationById = jest.fn().mockResolvedValue(DEFAULT_RELATION);
const mockClientGetRelationById = jest.fn().mockResolvedValue(DEFAULT_RELATION);
let mockClientRelationsModuleLoadCount = 0;

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
  createEdgeVerificationResult: (...args: unknown[]) => mockCreateEdgeVerificationResult(...args),
}));

jest.mock('@/lib/relations-admin', () => ({
  __esModule: true,
  adminGetRelationById: (...args: unknown[]) => mockAdminGetRelationById(...args),
}));

// A server-side Inngest function must never load the client Firestore service.
// Keeping this mock loadable makes a regression observable without importing
// Firebase's client runtime into the test process.
jest.mock('@/lib/relations', () => {
  mockClientRelationsModuleLoadCount += 1;
  return {
    __esModule: true,
    getRelationById: (...args: unknown[]) => mockClientGetRelationById(...args),
  };
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Registry closure pattern — matches verify-entity.test.ts
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
import '../verify-edge';

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

const BASE_EVENT = {
  data: {
    relationId: 'rel-1',
    sourceEntityId: 'src-1',
    targetEntityId: 'tgt-1',
  },
};

// ---------------------------------------------------------------------------
// File-level env setup
// ---------------------------------------------------------------------------

// The verify-edge function early-returns { skipped: true } unless the master
// gate env var is set (verify-edge.ts:38-48 — defense in depth added in commit
// 99c47f37). Use beforeEach/afterEach (not beforeAll) so the env doesn't leak
// across files in the same Jest worker.
beforeEach(() => {
  process.env.DEFENSE_MINISTER_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.DEFENSE_MINISTER_ENABLED;
});

// ---------------------------------------------------------------------------
// Firestore runtime boundary
// ---------------------------------------------------------------------------

describe('verify-edge relation reader boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGetRelationById.mockResolvedValue(DEFAULT_RELATION);
  });

  it('does no Firestore work when Defense Minister is disabled', async () => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-edge'];

    await expect(handler({ event: BASE_EVENT, step })).resolves.toEqual({
      relationId: 'rel-1',
      skipped: true,
      reason: 'DEFENSE_MINISTER_ENABLED!=true',
    });

    expect(step.run).not.toHaveBeenCalled();
    expect(mockAdminGetRelationById).not.toHaveBeenCalled();
    expect(mockClientGetRelationById).not.toHaveBeenCalled();
    expect(mockClientRelationsModuleLoadCount).toBe(0);
  });

  it('loads the relation through the narrow Admin reader without importing the client service', async () => {
    const handler = getRegistry().handlers['verify-edge'];

    await handler({ event: BASE_EVENT, step: buildMockStep() });

    expect(mockAdminGetRelationById).toHaveBeenCalledTimes(1);
    expect(mockAdminGetRelationById).toHaveBeenCalledWith('rel-1');
    expect(mockClientGetRelationById).not.toHaveBeenCalled();
    expect(mockClientRelationsModuleLoadCount).toBe(0);
  });

  it('fails before verification when the relation is missing', async () => {
    mockAdminGetRelationById.mockResolvedValueOnce(null);
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-edge'];

    await expect(handler({ event: BASE_EVENT, step })).rejects.toThrow(
      'Relation rel-1 not found in Firestore'
    );

    expect(step.run).toHaveBeenCalledTimes(1);
    expect(mockVerifyEntityReality).not.toHaveBeenCalled();
    expect(mockCreateEdgeVerificationResult).not.toHaveBeenCalled();
    expect(mockClientRelationsModuleLoadCount).toBe(0);
  });

  it('propagates Admin read failures before verification', async () => {
    mockAdminGetRelationById.mockRejectedValueOnce(new Error('admin read unavailable'));
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-edge'];

    await expect(handler({ event: BASE_EVENT, step })).rejects.toThrow('admin read unavailable');

    expect(step.run).toHaveBeenCalledTimes(1);
    expect(mockVerifyEntityReality).not.toHaveBeenCalled();
    expect(mockCreateEdgeVerificationResult).not.toHaveBeenCalled();
    expect(mockClientRelationsModuleLoadCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('verify-edge registration', () => {
  it('registers with id verify-edge', () => {
    expect(getRegistry().handlers['verify-edge']).toBeDefined();
  });

  it('triggers on app/edge.verification.requested', () => {
    expect(getRegistry().triggers['verify-edge']).toEqual({
      event: 'app/edge.verification.requested',
    });
  });

  it('executes steps in order: load-relation, verify, store-result', async () => {
    const step = buildMockStep();
    const handler = getRegistry().handlers['verify-edge'];
    await handler({ event: BASE_EVENT, step });

    const stepNames = step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames).toEqual(['load-relation', 'verify', 'store-result']);
  });
});

// ---------------------------------------------------------------------------
// Verification logic tests
// ---------------------------------------------------------------------------

describe('verify-edge verification logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset relation mock to default (no notes, no sourceUrl)
    mockAdminGetRelationById.mockResolvedValue(DEFAULT_RELATION);
  });

  it('marks edge as verified when both entities + URL + evidence all confirm', async () => {
    // Both entity reality checks pass as verified
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'verified', evidenceText: 'real' });
    // URL is reachable
    mockVerifyUrlsReachable.mockResolvedValue({ ok: true });
    // Evidence text mentions both entity names, with a reachable sourceUrl
    mockAdminGetRelationById.mockResolvedValue({
      id: 'rel-1',
      relationType: 'uses',
      sourceSnapshot: { id: 'src-1', type: 'technology', name: 'TensorFlow', snapshotAt: Date.now() },
      targetSnapshot: { id: 'tgt-1', type: 'technology', name: 'Python', snapshotAt: Date.now() },
      notes: 'TensorFlow uses Python as its primary language.',
      sourceUrl: 'https://tensorflow.org/about',
      confidence: 80,
      aiSuggested: false,
      claimStatus: 'curated',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const handler = getRegistry().handlers['verify-edge'];
    const result = await handler({ event: BASE_EVENT, step: buildMockStep() });

    // 4 confirming sources (source reality, target reality, evidence text, URL), 0 contradicting
    // score = 4/4 * 100 = 100 → verified
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.status).toBe('verified');
    expect(result.sourcesConfirming).toBeGreaterThanOrEqual(2);
    expect(mockCreateEdgeVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        relationId: 'rel-1',
        sourceEntityId: 'src-1',
        targetEntityId: 'tgt-1',
        status: 'verified',
      })
    );
  });

  it('refuses `verified` on a single unreplicated confirming source (VERIFY-001)', async () => {
    // Source entity reality confirms; target is inconclusive (not decisive); no
    // evidence notes and no sourceUrl, so exactly ONE confirming source exists.
    // Ratio scoring alone gives 1/1 = 100 = 'verified'; replication is now
    // required, so a lone source can be 'unverified' at most.
    mockVerifyEntityReality
      .mockResolvedValueOnce({ ok: true, reason: 'verified', evidenceText: 'real' }) // source
      .mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' }); // target
    // Default relation (from beforeEach): notes undefined, no sourceUrl.

    const handler = getRegistry().handlers['verify-edge'];
    const result = await handler({ event: BASE_EVENT, step: buildMockStep() });

    expect(result.sourcesConfirming).toBe(1);
    expect(result.sourcesContradicting).toBe(0);
    expect(result.status).not.toBe('verified');
    expect(result.status).toBe('unverified');
    expect(mockCreateEdgeVerificationResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'unverified' }));
  });

  it('marks edge as disputed when sourceUrl is unreachable AND evidence misses one entity', async () => {
    // Both entity reality checks return inconclusive (don't count either way)
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
    // URL is not reachable → contradicting
    mockVerifyUrlsReachable.mockResolvedValue({ ok: false });
    // Evidence text only mentions source, not target → contradicting
    mockAdminGetRelationById.mockResolvedValue({
      id: 'rel-1',
      relationType: 'uses',
      sourceSnapshot: { id: 'src-1', type: 'technology', name: 'TensorFlow', snapshotAt: Date.now() },
      targetSnapshot: { id: 'tgt-1', type: 'technology', name: 'Python', snapshotAt: Date.now() },
      notes: 'TensorFlow is a great machine learning library.', // mentions TensorFlow but not Python
      sourceUrl: 'https://dead-link.example.com',
      confidence: 50,
      aiSuggested: true,
      claimStatus: 'proposed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const handler = getRegistry().handlers['verify-edge'];
    const result = await handler({ event: BASE_EVENT, step: buildMockStep() });

    // 0 confirming, 2 contradicting (evidence + URL) → score = 0 → disputed
    expect(result.score).toBeLessThan(50);
    expect(result.status).toBe('disputed');
    expect(result.sourcesContradicting).toBeGreaterThanOrEqual(2);
    expect(mockCreateEdgeVerificationResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'disputed' }));
  });

  it('passes inconclusively when verifyEntityReality returns inconclusive for both entities and no URL', async () => {
    // Both reality checks → inconclusive (not counted as decisive)
    mockVerifyEntityReality.mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' });
    // No sourceUrl, no notes → no other checks fire

    const handler = getRegistry().handlers['verify-edge'];
    const result = await handler({ event: BASE_EVENT, step: buildMockStep() });

    // decisive = 0 → score = 50 → unverified
    expect(result.score).toBe(50);
    expect(result.status).toBe('unverified');
    expect(result.sourcesConfirming).toBe(0);
    expect(result.sourcesContradicting).toBe(0);
    // sourcesChecked = 2 (both inconclusive reality checks are still tracked)
    expect(result.sourcesChecked).toBe(2);
    expect(mockCreateEdgeVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unverified', score: 50 })
    );
  });
});
