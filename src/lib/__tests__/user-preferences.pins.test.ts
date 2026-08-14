/**
 * @jest-environment node
 *
 * AI-005 — pinned preferences persistence:
 *  - the nightly harvest's full-doc set() PRESERVES the existing `pinned`
 *    sub-object (the original clobber bug);
 *  - setPinnedPreferences sets/clears per-field pins (null clears) and creates
 *    a schema-valid stub doc for fresh users;
 *  - resetUserPreferences deletes the doc.
 */
export {};

const store = new Map<string, Record<string, unknown>>();

interface QueryResultDoc {
  data: () => Record<string, unknown>;
}
const missionsQuery = {
  where: () => missionsQuery,
  orderBy: () => missionsQuery,
  limit: () => missionsQuery,
  get: async (): Promise<{ docs: QueryResultDoc[] }> => ({
    docs:
      (store.get('__missions__') as unknown as Array<Record<string, unknown>> | undefined)?.map((m) => ({
        data: () => m,
      })) ?? [],
  }),
};

function makeDocRef(name: string, id: string) {
  return {
    __key: `${name}/${id}`,
    get: async () => ({
      exists: store.has(`${name}/${id}`),
      data: () => store.get(`${name}/${id}`),
    }),
    set: async (d: Record<string, unknown>) => void store.set(`${name}/${id}`, d),
    delete: async () => void store.delete(`${name}/${id}`),
  };
}

const db = {
  collection: (name: string) => {
    if (name === 'missions') return missionsQuery;
    return { doc: (id: string) => makeDocRef(name, id) };
  },
  // Adversarial #2 made both preference writers transactional — mirror the
  // house buffering-transaction double (writes land when the callback resolves).
  runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const writes: Array<() => void> = [];
    const tx = {
      get: async (ref: ReturnType<typeof makeDocRef>) => ref.get(),
      set: (ref: ReturnType<typeof makeDocRef>, d: Record<string, unknown>) => {
        writes.push(() => void store.set(ref.__key, d));
      },
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  },
};

jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { harvestUserPreferences, setPinnedPreferences, resetUserPreferences } =
  require('../user-preferences') as typeof import('../user-preferences');

function seedMissions(missions: Array<{ prompt: string; agent: string }>) {
  store.set('__missions__', missions.map((m) => ({ ...m, createdAt: new Date().toISOString() })) as never);
}

beforeEach(() => store.clear());

describe('harvestUserPreferences preserves pins (clobber fix)', () => {
  it('carries the existing pinned sub-object across the nightly full-doc set()', async () => {
    store.set('userPreferences/u1', {
      userId: 'u1',
      updatedAt: '2026-07-01T00:00:00.000Z',
      missionsAnalyzed: 3,
      structureConfidence: 0,
      requestsConfidenceScores: false,
      preferredAgents: [],
      topTopics: [],
      avgPromptLength: 10,
      pinned: { preferredStructure: 'IMRAD', requestsConfidenceScores: true },
    });
    seedMissions([{ prompt: 'Quick question about GPU pricing', agent: 'scout' }]);

    const result = await harvestUserPreferences('u1');

    const written = store.get('userPreferences/u1')!;
    expect(written.pinned).toEqual({ preferredStructure: 'IMRAD', requestsConfidenceScores: true });
    expect(result.pinned).toEqual({ preferredStructure: 'IMRAD', requestsConfidenceScores: true });
    // Harvested fields still refreshed by the run
    expect(written.missionsAnalyzed).toBe(1);
  });

  it('drops an invalid stored pinned object instead of persisting garbage', async () => {
    store.set('userPreferences/u1', {
      userId: 'u1',
      pinned: { preferredStructure: 'NOT-A-STRUCTURE' },
    });
    seedMissions([{ prompt: 'anything', agent: 'scout' }]);
    await harvestUserPreferences('u1');
    expect(store.get('userPreferences/u1')!.pinned).toBeUndefined();
  });

  it('writes no pinned field when none existed (fresh user unchanged)', async () => {
    seedMissions([{ prompt: 'anything', agent: 'scout' }]);
    await harvestUserPreferences('u1');
    expect('pinned' in store.get('userPreferences/u1')!).toBe(false);
  });
});

describe('setPinnedPreferences', () => {
  it('creates a schema-valid stub doc with the pin for a fresh user', async () => {
    const result = await setPinnedPreferences('u2', { preferredStructure: 'SBAR' });
    expect(result.pinned).toEqual({ preferredStructure: 'SBAR' });
    const written = store.get('userPreferences/u2')!;
    expect(written.pinned).toEqual({ preferredStructure: 'SBAR' });
    expect(written.userId).toBe('u2');
    expect(written.missionsAnalyzed).toBe(0);
  });

  it('merges per-field: sets one pin without touching another; null clears', async () => {
    await setPinnedPreferences('u3', { preferredStructure: 'IMRAD' });
    await setPinnedPreferences('u3', { requestsConfidenceScores: true });
    expect(store.get('userPreferences/u3')!.pinned).toEqual({
      preferredStructure: 'IMRAD',
      requestsConfidenceScores: true,
    });

    await setPinnedPreferences('u3', { preferredStructure: null });
    expect(store.get('userPreferences/u3')!.pinned).toEqual({ requestsConfidenceScores: true });
  });

  it('collapses an all-cleared pin object away entirely (no empty pinned map)', async () => {
    await setPinnedPreferences('u4', { preferredCitationStyle: 'IEEE' });
    await setPinnedPreferences('u4', { preferredCitationStyle: null });
    expect('pinned' in store.get('userPreferences/u4')!).toBe(false);
  });
});

describe('resetUserPreferences', () => {
  it('deletes the doc (pins included — reset means reset)', async () => {
    await setPinnedPreferences('u5', { preferredStructure: 'radar' });
    expect(store.has('userPreferences/u5')).toBe(true);
    await resetUserPreferences('u5');
    expect(store.has('userPreferences/u5')).toBe(false);
  });
});
