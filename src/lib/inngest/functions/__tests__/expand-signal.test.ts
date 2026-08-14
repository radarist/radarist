/**
 * @jest-environment node
 *
 * @file Tests for expand-signal Inngest function
 *
 * Closes US-16 AC #3 — pins the four-phase orchestration that fires after a
 * curator approves a signal in triage:
 *   load-signal-context → ai-analyze-signal → score-signal-expansion →
 *   persist-signal-expansion → send-completion (+ optional auto-apply, or
 *   mark-expansion-failed + send-failure on the error branch).
 *
 * Mocks follow the canonical patterns from sibling tests:
 *   - run-agent-mission.test.ts (registry-closure on '../../client')
 *   - verify-entity.test.ts      (beforeEach/afterEach env-var hygiene)
 *
 * The four phase exports of '@/lib/signals/expand-signal' are stubbed at the
 * module boundary so no real Gemini call is attempted (Anti-pattern D).
 * '@/lib/signals-approval' is stubbed so the dynamic `await import(...)` in
 * the auto-apply branch is intercepted (Jest mocks dynamic imports too).
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks — registry pattern verbatim from run-agent-mission.test.ts
// ---------------------------------------------------------------------------

jest.mock('../../client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: registry,
  };
});

// Phase exports — keep simple jest.fn refs we can configure per test.
const mockLoadSignalContext = jest.fn();
const mockGenerateSignalExpansion = jest.fn();
const mockScoreSignalExpansion = jest.fn();
const mockPersistSignalExpansion = jest.fn();
// GRAPH-063 — endpoint reconciliation runs between generation and scoring.
// Default: everything the model produced is already canonical.
const mockResolveSignalExpansionEndpoints = jest.fn(async (_signalId: string, content: { relatedItems?: unknown }) => ({
  relatedItems: content?.relatedItems,
  decisions: [],
  keptCount: 0,
  resolvedCount: 0,
  rejectedCount: 0,
}));

jest.mock('@/lib/signals/expand-signal', () => ({
  __esModule: true,
  loadSignalContext: (...args: unknown[]) => mockLoadSignalContext(...args),
  generateSignalExpansion: (...args: unknown[]) => mockGenerateSignalExpansion(...args),
  resolveSignalExpansionEndpoints: (...args: [string, { relatedItems?: unknown }]) =>
    mockResolveSignalExpansionEndpoints(...args),
  scoreSignalExpansion: (...args: unknown[]) => mockScoreSignalExpansion(...args),
  persistSignalExpansion: (...args: unknown[]) => mockPersistSignalExpansion(...args),
}));

// signals-autopilot-admin — auto-apply branch uses dynamic import; jest.mock
// intercepts. Post-T1.3 the Inngest function uses the narrow admin helper
// (one function, technology-only) instead of `@/lib/signals-approval`.
const mockAutoApproveAndImportTechnology = jest
  .fn()
  .mockResolvedValue({ entityId: 'tech-99', entityType: 'technology' });

jest.mock('@/lib/signals-autopilot-admin', () => ({
  __esModule: true,
  autoApproveAndImportTechnology: (...args: unknown[]) => mockAutoApproveAndImportTechnology(...args),
}));

// Firestore — failure marking plus the post-mutation commit-state reread.
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockFirestoreGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: (collectionName: string) => ({
      doc: (documentId: string) => ({
        update: (...args: unknown[]) => mockUpdate(...args),
        get: (...args: unknown[]) => mockFirestoreGet(collectionName, documentId, ...args),
      }),
    }),
  },
}));
// Defensive no-op mock for any transitive client-SDK import that still
// resolves to '@/lib/firebase'.
jest.mock('@/lib/firebase', () => ({ __esModule: true, db: {} }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Import AFTER mocks — populates the registry with the 'expand-signal' handler.
import '../expand-signal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTION_ID = 'expand-signal';

function getRegistry() {
  return require('../../client')._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function getHandler(): AnyFunction {
  const handler = getRegistry().handlers[FUNCTION_ID];
  if (!handler) throw new Error(`Handler for '${FUNCTION_ID}' not found in registry`);
  return handler;
}

function buildMockStep(runMemo?: Map<string, unknown>) {
  return {
    run: jest.fn(async (name: string, fn: AnyFunction) => {
      if (runMemo?.has(name)) return runMemo.get(name);
      const result = await fn();
      runMemo?.set(name, result);
      return result;
    }),
    invoke: jest.fn(async (_name: string, _options: unknown) => ({ success: true })),
    sendEvent: jest.fn(async (_name: string, _payload: unknown) => undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
  };
}

function buildEventContext(overrides: Record<string, unknown> = {}, runMemo?: Map<string, unknown>) {
  return {
    event: {
      data: {
        signalId: 'sig-1',
        ...overrides,
      },
    },
    step: buildMockStep(runMemo),
  };
}

// Minimal valid fixtures — match the shape expand-signal.ts actually consumes.
const FAKE_SIGNAL = {
  id: 'sig-1',
  title: 'New AI breakthrough',
  description: 'A novel approach to retrieval-augmented generation.',
  type: 'technology',
  source: 'arxiv',
  url: 'https://original.example/signal',
  status: 'Validated',
} as const;

const FAKE_CONTEXT = {
  signal: FAKE_SIGNAL,
  strategies: [],
  startTime: 1_700_000_000_000,
};

const FAKE_EXPANDED_CONTENT = {
  summary: 'A novel RAG technique improving retrieval precision by 22%.',
  entityProfile: {
    type: 'technology' as const,
    summary: 'A retrieval technology profile.',
    keyFacts: ['Improves retrieval precision'],
    recentDevelopments: ['Published benchmark results'],
  },
  entities: [],
  sources: [
    {
      title: 'Independent confirmation',
      url: 'https://independent.example/confirmation',
      verdict: 'confirming' as const,
    },
  ],
  expandedAt: 1_700_000_000_500,
  expansionModel: 'gemini-3-flash-preview',
  expansionDuration: 500,
};

const HIGH_TRUST_SCORE = {
  overall: 90,
  breakdown: { sourceReliability: 95, dataCompleteness: 88, corroboration: 70, aiConfidence: 90 },
  factors: ['Multiple source corroboration'],
};

const LOW_TRUST_SCORE = {
  overall: 60,
  breakdown: { sourceReliability: 70, dataCompleteness: 55, corroboration: 40, aiConfidence: 60 },
  factors: ['Single source (no corroboration)'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('expandSignal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAutoApproveAndImportTechnology.mockReset().mockResolvedValue({
      entityId: 'tech-99',
      entityType: 'technology',
    });
    mockUpdate.mockReset().mockResolvedValue(undefined);
    mockFirestoreGet
      .mockReset()
      .mockImplementation(async (collectionName: string) =>
        collectionName === 'signals'
          ? { exists: true, data: () => FAKE_SIGNAL }
          : { exists: false, data: () => undefined }
      );
    // Default phase resolutions — happy path with sub-threshold trust.
    mockLoadSignalContext.mockResolvedValue(FAKE_CONTEXT);
    mockGenerateSignalExpansion.mockResolvedValue(FAKE_EXPANDED_CONTENT);
    mockScoreSignalExpansion.mockReturnValue(LOW_TRUST_SCORE);
    mockPersistSignalExpansion.mockResolvedValue(undefined);

    // Anti-pattern C guard: env vars MUST be unset by default. Tests that
    // need autopilot opt in explicitly via process.env.SIGNAL_AUTOPILOT_ENABLED.
    delete process.env.SIGNAL_AUTOPILOT_ENABLED;
    delete process.env.IMPULSE_SIGNAL_AUTOPILOT_ENABLED;
    delete process.env.SIGNAL_AUTO_APPROVE_THRESHOLD;
    delete process.env.IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD;
  });

  afterEach(() => {
    delete process.env.SIGNAL_AUTOPILOT_ENABLED;
    delete process.env.IMPULSE_SIGNAL_AUTOPILOT_ENABLED;
    delete process.env.SIGNAL_AUTO_APPROVE_THRESHOLD;
    delete process.env.IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD;
  });

  it('expands the signal when triage approves', async () => {
    // Pin: all four phase functions fire, in order, exactly once.
    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    expect(mockLoadSignalContext).toHaveBeenCalledTimes(1);
    expect(mockLoadSignalContext).toHaveBeenCalledWith('sig-1');
    expect(mockGenerateSignalExpansion).toHaveBeenCalledTimes(1);
    expect(mockResolveSignalExpansionEndpoints).toHaveBeenCalledTimes(1);
    expect(mockScoreSignalExpansion).toHaveBeenCalledTimes(1);
    expect(mockPersistSignalExpansion).toHaveBeenCalledTimes(1);

    // Step ordering — the phase steps run before send-completion, and no
    // failure-branch steps execute on the happy path. GRAPH-063: endpoint
    // reconciliation sits between generation and scoring, so nothing
    // downstream ever sees an endpoint the workspace does not have.
    const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames.slice(0, 7)).toEqual([
      'load-signal-context',
      'ai-analyze-signal',
      'resolve-expansion-endpoints',
      'score-signal-expansion',
      'persist-signal-expansion',
      'resync-signal-to-graph',
      'send-completion',
    ]);
    expect(stepNames).not.toContain('mark-expansion-failed');
    expect(stepNames).not.toContain('send-failure');

    // Phase invocation order is preserved (load < generate < resolve < score < persist).
    const loadOrder = mockLoadSignalContext.mock.invocationCallOrder[0];
    const generateOrder = mockGenerateSignalExpansion.mock.invocationCallOrder[0];
    const resolveOrder = mockResolveSignalExpansionEndpoints.mock.invocationCallOrder[0];
    const scoreOrder = mockScoreSignalExpansion.mock.invocationCallOrder[0];
    const persistOrder = mockPersistSignalExpansion.mock.invocationCallOrder[0];
    expect(loadOrder).toBeLessThan(generateOrder);
    expect(generateOrder).toBeLessThan(resolveOrder);
    expect(resolveOrder).toBeLessThan(scoreOrder);
    expect(scoreOrder).toBeLessThan(persistOrder);

    // Result envelope carries the trust score the handler computed.
    expect(result).toMatchObject({
      success: true,
      signalId: 'sig-1',
      trustScore: LOW_TRUST_SCORE,
      autoApplied: false,
    });
  });

  it('emits app/signal.expand.completed with the expanded payload', async () => {
    const ctx = buildEventContext();
    await getHandler()(ctx);

    const { inngest: inngestMock } = require('../../client');
    const sendCalls = (inngestMock.send as jest.Mock).mock.calls;

    // Anti-pattern B guard: pin the event NAME and key fields, not just shape.
    const completionCall = sendCalls.find((call: [{ name: string }]) => call[0].name === 'app/signal.expand.completed');
    expect(completionCall).toBeDefined();
    expect(completionCall![0]).toMatchObject({
      name: 'app/signal.expand.completed',
      data: expect.objectContaining({
        signalId: 'sig-1',
        success: true,
        trustScore: LOW_TRUST_SCORE.overall, // 60 — flat number, not the object
      }),
    });
    // expansionDuration is wall-clock so we just assert it's numeric.
    expect(typeof completionCall![0].data.expansionDuration).toBe('number');

    // Failure event must not have been emitted on the happy path.
    const failureCall = sendCalls.find((call: [{ name: string }]) => call[0].name === 'app/signal.expand.failed');
    expect(failureCall).toBeUndefined();
  });

  it('re-syncs the signal to the graph after persisting expansion (0.2 fix)', async () => {
    // persistSignalExpansion writes Firestore directly and fires no sync event;
    // without the re-sync the expandedContent edges never reach Neo4j. Pin the
    // exact event + payload, and that it fires AFTER persist.
    const ctx = buildEventContext();
    await getHandler()(ctx);

    const { inngest: inngestMock } = require('../../client');
    const sendCalls = (inngestMock.send as jest.Mock).mock.calls;
    const resyncCall = sendCalls.find(
      (call: [{ name: string }]) => call[0].name === 'app/unified-entity.sync.requested'
    );
    expect(resyncCall).toBeDefined();
    expect(resyncCall![0]).toEqual({
      name: 'app/unified-entity.sync.requested',
      data: { entityId: 'sig-1', entityType: 'signal', operation: 'update' },
    });

    const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames.indexOf('resync-signal-to-graph')).toBeGreaterThan(stepNames.indexOf('persist-signal-expansion'));
  });

  it('persists expanded content via persistSignalExpansion', async () => {
    // Anti-pattern A guard: inspect the actual payload, not just call count.
    const ctx = buildEventContext();
    await getHandler()(ctx);

    expect(mockPersistSignalExpansion).toHaveBeenCalledTimes(1);
    const [signalIdArg, expandedContentArg, trustScoreArg] = mockPersistSignalExpansion.mock.calls[0];
    expect(signalIdArg).toBe('sig-1');
    expect(expandedContentArg).toEqual(FAKE_EXPANDED_CONTENT);
    expect(trustScoreArg).toEqual(LOW_TRUST_SCORE);
  });

  // GRAPH-063: an endpoint the workspace does not have becomes a graph MATCH
  // that writes nothing and permanently blocks the signal's source fingerprint.
  // The reconciled relatedItems — not the model's — must reach persistence,
  // scoring, and therefore the graph sync.
  it('persists the reconciled endpoints, never the ones the model invented', async () => {
    mockGenerateSignalExpansion.mockResolvedValue({
      ...FAKE_EXPANDED_CONTENT,
      relatedItems: {
        technologies: [
          { id: 'tech-real', name: 'Real Tech', relevance: 'core' },
          { id: 'tech-invented', name: 'Invented Tech', relevance: 'related' },
        ],
        companies: [],
        signals: [],
      },
    });
    mockResolveSignalExpansionEndpoints.mockResolvedValueOnce({
      relatedItems: {
        technologies: [{ id: 'tech-real', name: 'Real Tech', relevance: 'core' }],
        companies: [],
        signals: [],
      },
      decisions: [
        {
          kind: 'technologies',
          proposedId: 'tech-invented',
          proposedLabel: 'Invented Tech',
          outcome: 'rejected',
          reason: 'unknown-id-and-name',
        },
      ],
      keptCount: 1,
      resolvedCount: 0,
      rejectedCount: 1,
    } as never);

    const ctx = buildEventContext();
    await getHandler()(ctx);

    const [, expandedContentArg, , resolutionArg] = mockPersistSignalExpansion.mock.calls[0];
    expect(expandedContentArg.relatedItems.technologies).toEqual([
      { id: 'tech-real', name: 'Real Tech', relevance: 'core' },
    ]);
    expect(resolutionArg).toMatchObject({ rejectedCount: 1 });

    // Scoring must see the same reconciled content the graph will.
    const [, scoredContent] = mockScoreSignalExpansion.mock.calls[0];
    expect(scoredContent.relatedItems.technologies).toHaveLength(1);
  });

  it('auto-applies high-trust signals when SIGNAL_AUTOPILOT_ENABLED', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    // Trust 90 ≥ threshold 85 → auto-apply branch fires.
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);

    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    // The dynamic-import branch must call the autopilot helper exactly once.
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledTimes(1);
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledWith(
      'sig-1',
      expect.objectContaining({ expansionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), threshold: 85 })
    );

    // The auto-apply step ran.
    const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames).toContain('auto-apply-signal');

    // app/signal.auto-applied is emitted with the entity reference + trust.
    const autoAppliedCall = ctx.step.sendEvent.mock.calls.find(
      (call) => (call[1] as { name: string }).name === 'app/signal.auto-applied'
    );
    expect(autoAppliedCall).toBeDefined();
    expect(autoAppliedCall![1]).toMatchObject({
      name: 'app/signal.auto-applied',
      data: expect.objectContaining({
        signalId: 'sig-1',
        entityId: 'tech-99',
        entityType: 'technology',
        trustScore: HIGH_TRUST_SCORE.overall,
        threshold: 85,
      }),
    });

    expect(ctx.step.invoke.mock.calls.map((call) => call[0])).toEqual([
      'sync-auto-applied-technology-0',
      'resync-auto-applied-signal-0',
    ]);
    expect(ctx.step.invoke.mock.invocationCallOrder[0]).toBeLessThan(ctx.step.invoke.mock.invocationCallOrder[1]);

    // Result envelope carries the autoApplied flag.
    expect(result).toMatchObject({
      success: true,
      signalId: 'sig-1',
      autoApplied: true,
    });
  });

  it('does not auto-apply a high score without two confirming sources', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue({
      ...HIGH_TRUST_SCORE,
      breakdown: { ...HIGH_TRUST_SCORE.breakdown, corroboration: 40 },
      factors: ['Single source (no corroboration)'],
    });
    mockGenerateSignalExpansion.mockResolvedValueOnce({ ...FAKE_EXPANDED_CONTENT, sources: [] });

    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    expect(mockAutoApproveAndImportTechnology).not.toHaveBeenCalled();
    expect(ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0])).not.toContain('auto-apply-signal');
    expect(result).toMatchObject({ success: true, signalId: 'sig-1', autoApplied: false });
  });

  it('reports autoApplied=false only after a qualified mutation is confirmed not to have committed', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('write rejected'));

    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledWith(
      'sig-1',
      expect.objectContaining({ threshold: 85 })
    );
    expect(result).toMatchObject({ success: true, signalId: 'sig-1', autoApplied: false });
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();
    expect(mockFirestoreGet).toHaveBeenCalledWith('signals', 'sig-1');
    expect(mockFirestoreGet).toHaveBeenCalledWith('technologies', expect.stringMatching(/^tech-signal-[a-f0-9]{24}$/));
  });

  it('recovers a committed import when the transaction response is lost and continues ordered graph sync', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockImplementation(async (collectionName: string, documentId: string) => {
      if (collectionName === 'signals') {
        return {
          exists: true,
          data: () => ({
            ...FAKE_SIGNAL,
            status: 'Imported',
            importedAs: { type: 'technology', id: 'tech-committed' },
          }),
        };
      }
      return { exists: documentId === 'tech-committed', data: () => ({ id: documentId }) };
    });

    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    expect(result).toMatchObject({ success: true, signalId: 'sig-1', autoApplied: true });
    expect(ctx.step.invoke.mock.calls.map((call) => call[0])).toEqual([
      'sync-auto-applied-technology-0',
      'resync-auto-applied-signal-0',
    ]);
    expect(ctx.step.invoke.mock.calls[0][1]).toMatchObject({
      data: { technologyId: 'tech-committed', operation: 'create' },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('retries when only part of an ambiguous import is visible', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockImplementation(async (collectionName: string) =>
      collectionName === 'signals'
        ? {
            exists: true,
            data: () => ({
              ...FAKE_SIGNAL,
              status: 'Imported',
              importedAs: { type: 'technology', id: 'tech-missing' },
            }),
          }
        : { exists: false, data: () => undefined }
    );

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).rejects.toThrow('only part of the Signal/Technology import is present');

    expect(ctx.step.invoke).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0])).not.toContain(
      'mark-expansion-failed'
    );
  });

  it('retries when the ambiguous commit state cannot be reread', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).rejects.toThrow('the Signal reread failed');

    expect(ctx.step.invoke).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0])).not.toContain(
      'mark-expansion-failed'
    );
  });

  it.each([
    {
      name: 'unknown Signal status',
      signal: { ...FAKE_SIGNAL, status: 'Mystery' },
      message: 'unknown or missing status',
    },
    {
      name: 'malformed importedAs link',
      signal: { ...FAKE_SIGNAL, status: 'Imported', importedAs: { type: 'technology', id: '' } },
      message: 'importedAs link is malformed',
    },
    {
      name: 'unknown importedAs entity type',
      signal: { ...FAKE_SIGNAL, status: 'Imported', importedAs: { type: 'project', id: 'project-1' } },
      message: 'importedAs link is malformed',
    },
  ])('retries an ambiguous commit with $name', async ({ signal, message }) => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockImplementation(async (collectionName: string) =>
      collectionName === 'signals' ? { exists: true, data: () => signal } : { exists: false, data: () => undefined }
    );

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).rejects.toThrow(message);
    expect(ctx.step.invoke).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('retries when a non-Imported Signal already has any importedAs link', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockImplementation(async (collectionName: string) =>
      collectionName === 'signals'
        ? {
            exists: true,
            data: () => ({
              ...FAKE_SIGNAL,
              status: 'Validated',
              importedAs: { type: 'technology', id: 'tech-dangling' },
            }),
          }
        : { exists: false, data: () => undefined }
    );

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).rejects.toThrow('non-Imported Signal already has an importedAs link');
    expect(ctx.step.invoke).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not retry a completed non-Technology import when no deterministic Technology exists', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('already imported as company'));
    mockFirestoreGet.mockImplementation(async (collectionName: string) =>
      collectionName === 'signals'
        ? {
            exists: true,
            data: () => ({
              ...FAKE_SIGNAL,
              status: 'Imported',
              importedAs: { type: 'company', id: 'company-1' },
            }),
          }
        : { exists: false, data: () => undefined }
    );

    await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ autoApplied: false });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('recognizes a serialized recovery error by stable name and never stamps expansionFailed', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockAutoApproveAndImportTechnology.mockRejectedValueOnce(new Error('commit response lost'));
    mockFirestoreGet.mockRejectedValueOnce(new Error('Firestore unavailable'));
    const ctx = buildEventContext();
    ctx.step.run.mockImplementation(async (name: string, fn: AnyFunction) => {
      try {
        return await fn();
      } catch (error) {
        if (name !== 'auto-apply-signal' || !(error instanceof Error)) throw error;
        const serialized = new Error(error.message);
        serialized.name = error.name;
        throw serialized;
      }
    });

    await expect(getHandler()(ctx)).rejects.toMatchObject({ name: 'AutoApplyRecoveryError' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0])).not.toContain(
      'mark-expansion-failed'
    );
  });

  it('retries post-import graph sync with fresh invoke steps without marking expansion failed', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    const runMemo = new Map<string, unknown>();
    const ctx = buildEventContext({}, runMemo);
    ctx.step.invoke.mockResolvedValueOnce({ success: false });

    await expect(getHandler()(ctx)).rejects.toThrow('Auto-applied graph synchronization failed');
    expect(ctx.step.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.step.invoke.mock.calls[0][0]).toBe('sync-auto-applied-technology-0');
    expect(ctx.step.sendEvent).not.toHaveBeenCalledWith('emit-signal-auto-applied', expect.anything());
    expect(mockUpdate).not.toHaveBeenCalled();
    const { inngest: inngestMock } = require('../../client');
    expect((inngestMock.send as jest.Mock).mock.calls).not.toEqual(
      expect.arrayContaining([[expect.objectContaining({ name: 'app/signal.expand.failed' })]])
    );

    const retryCtx = { ...buildEventContext({}, runMemo), attempt: 1 };
    await expect(getHandler()(retryCtx)).resolves.toMatchObject({ autoApplied: true });
    expect(retryCtx.step.invoke.mock.calls.map((call) => call[0])).toEqual([
      'sync-auto-applied-technology-1',
      'resync-auto-applied-signal-1',
    ]);
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledTimes(1);
  });

  it('resumes a committed import when the kill switch and threshold change before retry', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    const runMemo = new Map<string, unknown>();
    const firstCtx = buildEventContext({}, runMemo);
    firstCtx.step.invoke.mockResolvedValueOnce({ success: false });

    await expect(getHandler()(firstCtx)).rejects.toThrow('Auto-applied graph synchronization failed');
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledTimes(1);

    // The import already committed. A policy change may prevent future imports,
    // but it must not strand graph synchronization for this one.
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'false';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '100';
    const retryCtx = { ...buildEventContext({}, runMemo), attempt: 1 };

    await expect(getHandler()(retryCtx)).resolves.toMatchObject({ autoApplied: true });
    expect(retryCtx.step.invoke.mock.calls.map((call) => call[0])).toEqual([
      'sync-auto-applied-technology-1',
      'resync-auto-applied-signal-1',
    ]);
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledTimes(1);
    const durableDecision = runMemo.get('decide-signal-auto-apply') as {
      qualifies: boolean;
      threshold: number | null;
    };
    expect(durableDecision).toMatchObject({ qualifies: true, threshold: 85 });
  });

  it('reports the completed mutation when only its activity event fails', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '85';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    const ctx = buildEventContext();
    ctx.step.sendEvent.mockRejectedValueOnce(new Error('activity feed unavailable'));
    const result = await getHandler()(ctx);

    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledWith(
      'sig-1',
      expect.objectContaining({ threshold: 85 })
    );
    expect(result).toMatchObject({ success: true, signalId: 'sig-1', autoApplied: true });
  });

  it.each(['company', 'trend', undefined] as const)('keeps a high-trust %s expansion in triage', async (entityType) => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);
    mockGenerateSignalExpansion.mockResolvedValueOnce({
      ...FAKE_EXPANDED_CONTENT,
      entityProfile: entityType ? { ...FAKE_EXPANDED_CONTENT.entityProfile, type: entityType } : undefined,
    });

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).resolves.toMatchObject({ autoApplied: false });
    expect(mockAutoApproveAndImportTechnology).not.toHaveBeenCalled();
    expect(ctx.step.invoke).not.toHaveBeenCalled();
  });

  it.each(['-1', '0.85', '85x', '', '101'])(
    'fails closed for invalid SIGNAL_AUTO_APPROVE_THRESHOLD=%j',
    async (threshold) => {
      process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
      process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = threshold;
      mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);

      await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ autoApplied: false });
      expect(mockAutoApproveAndImportTechnology).not.toHaveBeenCalled();
    }
  );

  it.each(['0', '100'])('accepts the bounded threshold endpoint %s', async (threshold) => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = threshold;
    mockScoreSignalExpansion.mockReturnValue({ ...HIGH_TRUST_SCORE, overall: 100 });

    await getHandler()(buildEventContext());
    expect(mockAutoApproveAndImportTechnology).toHaveBeenCalledWith(
      'sig-1',
      expect.objectContaining({ threshold: Number(threshold) })
    );
  });

  it('gives the unprefixed threshold precedence over the compatibility alias', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'true';
    process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '95';
    process.env.IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD = '0';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);

    await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ autoApplied: false });
    expect(mockAutoApproveAndImportTechnology).not.toHaveBeenCalled();
  });

  it('lets an explicit primary kill-switch false override a stale true alias', async () => {
    process.env.SIGNAL_AUTOPILOT_ENABLED = 'false';
    process.env.IMPULSE_SIGNAL_AUTOPILOT_ENABLED = 'true';
    mockScoreSignalExpansion.mockReturnValue(HIGH_TRUST_SCORE);

    await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ autoApplied: false });
    expect(mockAutoApproveAndImportTechnology).not.toHaveBeenCalled();
  });

  it('emits a distinct terminal notification for exhausted post-import graph sync', async () => {
    const onFailure = getRegistry().configs[FUNCTION_ID].onFailure as AnyFunction;
    const error = new Error('ordered graph sync exhausted retries');
    error.name = 'AutoApplyGraphSyncError';

    await onFailure({
      error,
      event: { data: { event: { data: { signalId: 'sig-1' } } } },
    });

    const { inngest: inngestMock } = require('../../client');
    expect(inngestMock.send).toHaveBeenCalledWith({
      name: 'app/signal.auto-apply.sync.failed',
      data: expect.objectContaining({ signalId: 'sig-1', error: error.message }),
    });
    expect(inngestMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'app/signal.expand.failed' }));
  });

  it('falls back to mark-expansion-failed when AI throws', async () => {
    // Failure branch — Gemini rejects; the handler must persist the failure
    // flag, emit the failure event with name 'app/signal.expand.failed', and
    // re-throw so Inngest retries.
    const aiError = new Error('Gemini API timeout');
    mockGenerateSignalExpansion.mockRejectedValue(aiError);

    const ctx = buildEventContext();
    await expect(getHandler()(ctx)).rejects.toThrow('Gemini API timeout');

    // The failure-branch steps both ran.
    const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
    expect(stepNames).toContain('mark-expansion-failed');
    expect(stepNames).toContain('send-failure');
    // The persist-step must NOT have been reached on this branch.
    expect(stepNames).not.toContain('persist-signal-expansion');
    expect(stepNames).not.toContain('send-completion');
    expect(mockPersistSignalExpansion).not.toHaveBeenCalled();

    // Firestore was updated with the expansionFailed flag + error message.
    // Admin SDK shape: signalRef.update(payload) — payload is the single arg.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [updatePayload] = mockUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(updatePayload).toMatchObject({
      expansionFailed: true,
      expansionError: 'Gemini API timeout',
    });
    expect(typeof updatePayload.expansionFailedAt).toBe('number');
    expect(typeof updatePayload.updatedAt).toBe('number');

    // app/signal.expand.failed is emitted with the signalId + error.
    const { inngest: inngestMock } = require('../../client');
    const sendCalls = (inngestMock.send as jest.Mock).mock.calls;
    const failureCall = sendCalls.find((call: [{ name: string }]) => call[0].name === 'app/signal.expand.failed');
    expect(failureCall).toBeDefined();
    expect(failureCall![0]).toMatchObject({
      name: 'app/signal.expand.failed',
      data: expect.objectContaining({
        signalId: 'sig-1',
        error: 'Gemini API timeout',
      }),
    });

    // Completion event must not be emitted on the failure branch.
    const completionCall = sendCalls.find((call: [{ name: string }]) => call[0].name === 'app/signal.expand.completed');
    expect(completionCall).toBeUndefined();
  });
});
