/**
 * @jest-environment node
 */

/**
 * @file Tests for fetch-signals Inngest function
 *
 * Tests verify:
 * - Signals are created from all fetcher results
 * - dryRun mode fetches but does not write
 * - Single-signal failure does not abort the entire batch
 * - System config is loaded via the admin SDK (not the client-SDK chain)
 * - Each signal is written via the admin SDK directly
 * - Duplicate detection skips signals with an existing (source, url)
 *
 * The function was rewritten on 2026-05-12 to bypass the client-SDK chain
 * (signals-core → entity-factory → @/lib/firebase) that was hanging gRPC
 * streams server-side and silently failing the 6-hourly cron. These tests
 * lock the admin-SDK path in place.
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Admin SDK mock — chainable collection().doc().{get,set} + .where().limit().get()
// ---------------------------------------------------------------------------
//
// `systemConfigFixture` controls what `system-config/global` returns.
// `existingSignals` is a Map keyed by `${source}::${url}` and used by the
// dedupe pre-check (`findSignalByUrlAdmin`).
// `createdSignals` records every `doc().set()` so tests can assert on writes.

const systemConfigFixture: { current: unknown } = { current: null };
const existingSignals = new Map<string, boolean>();
const createdSignals: Array<{ id: string; data: Record<string, unknown> }> = [];
const setShouldRejectFor = new Set<string>();

const mockDocGet = jest.fn(async (_id: string) => ({
  exists: systemConfigFixture.current !== null,
  data: () => systemConfigFixture.current,
}));

const mockDocSet = jest.fn(async (data: Record<string, unknown>) => {
  if (setShouldRejectFor.has(data.title as string)) {
    throw new Error('firestore down');
  }
  createdSignals.push({ id: data.id as string, data });
});

const mockWhereGet = jest.fn(async (source: string, url: string) => {
  const key = `${source}::${url}`;
  const empty = !existingSignals.has(key);
  return { empty, docs: [] };
});

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collectionName: string) => {
      if (collectionName === 'system-config') {
        return {
          doc: jest.fn((id: string) => ({
            get: () => mockDocGet(id),
          })),
        };
      }
      // signals collection: supports both doc().set() (create) and
      // .where().where().limit().get() (dedupe lookup)
      return {
        doc: jest.fn((id: string) => ({
          set: (data: Record<string, unknown>) => mockDocSet({ ...data, id }),
        })),
        where: jest.fn((field: string, _op: string, value: string) => {
          const ctx: { source?: string; url?: string } = {};
          if (field === 'source') ctx.source = value;
          if (field === 'url') ctx.url = value;
          const builder = {
            where: jest.fn((f2: string, _o: string, v2: string) => {
              if (f2 === 'source') ctx.source = v2;
              if (f2 === 'url') ctx.url = v2;
              return {
                limit: jest.fn(() => ({
                  get: () => mockWhereGet(ctx.source ?? '', ctx.url ?? ''),
                })),
              };
            }),
            limit: jest.fn(() => ({
              get: () => mockWhereGet(ctx.source ?? '', ctx.url ?? ''),
            })),
          };
          return builder;
        }),
      };
    }),
  },
}));

jest.mock('@/lib/signal-fetchers', () => ({
  fetchFromAllSources: jest.fn(),
}));

jest.mock('@/lib/discovery/interest-keywords', () => ({
  getAggregateInterestKeywords: jest.fn().mockResolvedValue({ keywords: ['vector databases'] }),
}));

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({
          event: { data },
          step: {
            run: async (_name: string, fn: () => unknown) => fn(),
          },
        }),
    })),
    send: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as fetchers from '@/lib/signal-fetchers';
import { getAggregateInterestKeywords } from '@/lib/discovery/interest-keywords';
import { fetchSignalsJob } from '../fetch-signals';

const mockedFetch = fetchers.fetchFromAllSources as jest.Mock;
const mockedGetAggregateInterestKeywords = getAggregateInterestKeywords as jest.Mock;

// ---------------------------------------------------------------------------
// Default test config: all six real sources enabled
// ---------------------------------------------------------------------------

const DEFAULT_TEST_CONFIG = {
  id: 'global',
  agentMode: {
    mode: 'copilot',
    autoActionThreshold: 90,
    autoAddTechnologies: false,
    autoUpdateMaturity: false,
    autoLinkRelationships: true,
    autoImportSignals: false,
  },
  signalDetection: {
    enabled: true,
    minRelevanceScore: 0,
    sources: {
      patents: true,
      papers: true,
      news: true,
      funding: true,
      github: true,
      trends: true,
    },
  },
  sweep: {
    enabled: true,
    maxActionsPerSweep: 10,
  },
  notifications: {
    email: false,
    dashboard: true,
  },
  updatedAt: Date.now(),
};

function makeResult(
  items: Array<{
    title: string;
    url: string;
    source: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }>
) {
  return {
    success: true,
    signals: items.map((item, i) => ({
      id: `sig-raw-${i}`,
      slug: item.title.toLowerCase().replace(/\s+/g, '-'),
      type: item.source as 'news' | 'patents' | 'papers' | 'github',
      title: item.title,
      description: item.description ?? 'desc',
      source: item.source,
      url: item.url,
      date: Date.now(),
      detectedAt: Date.now(),
      relevanceScore: 50,
      alignmentScore: 50,
      alignedStrategies: [],
      linkedEntities: {},
      status: 'Detected' as const,
      sentiment: 'neutral' as const,
      aiSummary: item.description ?? 'desc',
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
    itemsScanned: items.length,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchSignalsJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    systemConfigFixture.current = DEFAULT_TEST_CONFIG;
    existingSignals.clear();
    createdSignals.length = 0;
    setShouldRejectFor.clear();
  });

  it('creates signals from all fetcher results via admin SDK', async () => {
    mockedFetch.mockResolvedValue({
      news: makeResult([{ title: 'A', description: 'desc', url: 'https://a', source: 'news' }]),
      patents: makeResult([{ title: 'B', description: 'desc', url: 'https://b', source: 'patents' }]),
    });

    const r = await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(createdSignals).toHaveLength(2);
    expect(createdSignals[0].data.title).toBe('A');
    expect(createdSignals[0].data.source).toBe('news');
    expect(createdSignals[1].data.title).toBe('B');
    expect(r.totalCreated).toBe(2);
  });

  it('honours dryRun: fetches but does not write', async () => {
    mockedFetch.mockResolvedValue({
      news: makeResult([{ title: 'X', url: 'u', source: 'news' }]),
    });

    const r = await (fetchSignalsJob as any).execute({ source: 'news', dryRun: true });

    expect(createdSignals).toHaveLength(0);
    expect(r.totalCreated).toBe(0);
    expect(r.sources.news).toBe(1);
  });

  it('narrows config.signalDetection.sources to only the requested source', async () => {
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'news' });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, calledConfig] = (mockedFetch as any).mock.calls[0];
    expect(calledConfig.signalDetection.sources).toEqual({
      patents: false,
      papers: false,
      news: true,
      github: false,
      funding: false,
      trends: false,
      hackernews: false,
      sec: false,
    });
  });

  it('drives fetchParams.keywords from the interest-keywords helper, not hardcoded defaults', async () => {
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(mockedFetch.mock.calls[0][0].keywords).toEqual(['vector databases']);
  });

  // ------------------------------------------------------------------------
  // C1 — relevance pre-selection wiring. The BaseFetcher filter
  // (base-fetcher.ts:174-177) already exists; this threads the configured
  // minRelevanceScore (0-100) into fetchParams.minRelevance so it actually
  // takes effect. Use `??` (not `||`) so an explicit 0 in config still means
  // "no filter" — see DEFAULT_TEST_CONFIG.signalDetection.minRelevanceScore
  // above, which relies on that exact semantic.
  // ------------------------------------------------------------------------

  it('threads config minRelevanceScore into fetchFromAllSources params', async () => {
    systemConfigFixture.current = {
      ...DEFAULT_TEST_CONFIG,
      signalDetection: { ...DEFAULT_TEST_CONFIG.signalDetection, minRelevanceScore: 62 },
    };
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(mockedFetch.mock.calls[0][0]).toEqual(expect.objectContaining({ minRelevance: 62 }));
  });

  it('defaults minRelevance to 50 when the config field is absent', async () => {
    const { minRelevanceScore: _omit, ...signalDetectionWithoutMinRelevance } = DEFAULT_TEST_CONFIG.signalDetection;
    systemConfigFixture.current = {
      ...DEFAULT_TEST_CONFIG,
      signalDetection: signalDetectionWithoutMinRelevance,
    };
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(mockedFetch.mock.calls[0][0]).toEqual(expect.objectContaining({ minRelevance: 50 }));
  });

  it('threads an explicit minRelevanceScore of 0 as 0 (not as a default) via ?? operator', async () => {
    systemConfigFixture.current = {
      ...DEFAULT_TEST_CONFIG,
      signalDetection: { ...DEFAULT_TEST_CONFIG.signalDetection, minRelevanceScore: 0 },
    };
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(mockedFetch).toHaveBeenCalledWith(expect.objectContaining({ minRelevance: 0 }), expect.any(Object));
  });

  it('skips items that already exist by (source, url) and reports skippedDuplicates', async () => {
    mockedFetch.mockResolvedValue({
      news: makeResult([
        { title: 'A', url: 'https://a', source: 'news' },
        { title: 'B', url: 'https://b', source: 'news' },
        { title: 'C', url: 'https://c', source: 'news' },
      ]),
    });
    // First is a duplicate, rest are new
    existingSignals.set('news::https://a', true);

    const r = await (fetchSignalsJob as any).execute({ source: 'news' });

    expect(createdSignals).toHaveLength(2);
    expect(createdSignals.map((s) => s.data.title)).toEqual(['B', 'C']);
    expect(r.totalCreated).toBe(2);
    expect(r.skippedDuplicates).toBe(1);
  });

  it('continues after a single-signal write failure', async () => {
    mockedFetch.mockResolvedValue({
      news: makeResult([
        { title: 'A', url: 'a', source: 'news' },
        { title: 'B', url: 'b', source: 'news' },
      ]),
    });
    setShouldRejectFor.add('A'); // First write fails

    const r = await (fetchSignalsJob as any).execute({});

    expect(r.totalCreated).toBe(1);
    expect(r.sources.news).toBe(2);
    expect(createdSignals).toHaveLength(1);
    expect(createdSignals[0].data.title).toBe('B');
  });

  // ------------------------------------------------------------------------
  // Regression guard for the 2026-05-12 fix.
  //
  // The bug: signals-core.ts:createSignal → entity-factory.ts:createEntity
  // → @/lib/firebase (client SDK). Server-side the client SDK has no auth
  // context and the gRPC stream hangs ~52s before failing with "client is
  // offline". The 6-hourly cron had been silently failing since 2026-05-11
  // until we bypassed the service-module chain entirely.
  //
  // These tests confirm the function reads the system config and writes
  // signals through the admin SDK directly — if a future refactor reintroduces
  // the service-module chain, these assertions catch it because the mocked
  // admin-SDK doc().set() / doc().get() spies stop being hit.
  // ------------------------------------------------------------------------

  it('loads system config via the admin SDK (not the client-SDK chain)', async () => {
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(mockDocGet).toHaveBeenCalled();
  });

  it('fails closed when system-config/global is missing', async () => {
    systemConfigFixture.current = null;
    mockedFetch.mockResolvedValue({ news: makeResult([]) });

    const r = await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(r).toMatchObject({ action: 'disabled', totalCreated: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('fails closed when system config cannot be read', async () => {
    mockDocGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const result = await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(result).toMatchObject({ action: 'disabled', totalCreated: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when signal detection is disabled', async () => {
    systemConfigFixture.current = {
      ...DEFAULT_TEST_CONFIG,
      signalDetection: { ...DEFAULT_TEST_CONFIG.signalDetection, enabled: false },
    };

    const r = await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(r).toMatchObject({ action: 'disabled', totalCreated: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when the background automation master switch is paused', async () => {
    systemConfigFixture.current = {
      ...DEFAULT_TEST_CONFIG,
      sweep: { enabled: false, maxActionsPerSweep: 10 },
    };

    const r = await (fetchSignalsJob as any).execute({ source: 'all' });

    expect(r).toMatchObject({ action: 'disabled', totalCreated: 0 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('writes each signal through the admin SDK doc().set() (not the client-SDK chain)', async () => {
    mockedFetch.mockResolvedValue({
      news: makeResult([{ title: 'AdminPath', url: 'https://x', source: 'news' }]),
    });

    await (fetchSignalsJob as any).execute({ source: 'news' });

    expect(mockDocSet).toHaveBeenCalledTimes(1);
    const written = mockDocSet.mock.calls[0][0] as Record<string, any>;
    expect(written.title).toBe('AdminPath');
    expect(written.slug).toBe('adminpath');
    expect(written.id).toMatch(/^signal-\d+-[a-z0-9]+$/);
    expect(written.createdAt).toBeGreaterThan(0);
    expect(written.metadata.fetchedBy).toBe('inngest:fetch-signals');
  });

  // ------------------------------------------------------------------------
  // Task S12.4 — map metadata.matchedKeyword to metadata.discoveryTopic using
  // the interest-keywords step's discoveryTopics map, so discovery-lane
  // signals carry a topic `deriveSignalTopic` can fall back to.
  // ------------------------------------------------------------------------

  it('maps metadata.matchedKeyword to metadata.discoveryTopic via the interest-keywords discoveryTopics map', async () => {
    mockedGetAggregateInterestKeywords.mockResolvedValueOnce({
      keywords: ['RAG Pipelines', 'quantum computing'],
      discoveryTopics: { 'RAG Pipelines': 'agentic-memory' },
    });
    mockedFetch.mockResolvedValue({
      news: makeResult([
        {
          title: 'Discovery Hit',
          url: 'https://discovery',
          source: 'news',
          metadata: { matchedKeyword: 'RAG Pipelines' },
        },
        {
          title: 'Reinforcement Hit',
          url: 'https://reinforcement',
          source: 'news',
          metadata: { matchedKeyword: 'quantum computing' },
        },
      ]),
    });

    await (fetchSignalsJob as any).execute({ source: 'news' });

    expect(createdSignals).toHaveLength(2);
    const discoveryDoc = createdSignals.find((s) => s.data.title === 'Discovery Hit')!;
    const reinforcementDoc = createdSignals.find((s) => s.data.title === 'Reinforcement Hit')!;
    expect((discoveryDoc.data.metadata as Record<string, unknown>).discoveryTopic).toBe('agentic-memory');
    expect((reinforcementDoc.data.metadata as Record<string, unknown>).discoveryTopic).toBeUndefined();
  });
});
