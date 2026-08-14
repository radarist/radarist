export {};
/**
 * @jest-environment node
 *
 * deriveSignalTopic — resolve a signal's interest topic from its FIRST linked technology
 * (signals have no tags of their own). The linked-tech path is PREFERRED; when it yields
 * nothing it falls back to `metadata.discoveryTopic` (S12 discovery-lane signals), and only
 * returns undefined when neither exists (the wire is then skipped rather than keying on junk).
 */
const entriesByRadar: Record<string, Array<{ id: number; tags?: string[] }>> = {};
const entriesReadCounts: Record<string, number> = {};
const db = {
  collection: (c: string) => ({
    doc: (radarId: string) => ({
      collection: (_sub: string) => ({
        get: async () => {
          entriesReadCounts[radarId] = (entriesReadCounts[radarId] ?? 0) + 1;
          return { docs: (entriesByRadar[radarId] ?? []).map((e) => ({ data: () => e })) };
        },
      }),
    }),
    _c: c,
  }),
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { deriveSignalTopic, deriveSignalTopicsBatch } = require('../signal-topic');

const sig = (over: Record<string, unknown> = {}) =>
  ({ id: 'sig1', linkedEntities: { technologies: ['radar1:5'] }, ...over }) as never;

beforeEach(() => {
  for (const k of Object.keys(entriesByRadar)) delete entriesByRadar[k];
  for (const k of Object.keys(entriesReadCounts)) delete entriesReadCounts[k];
  entriesByRadar['radar1'] = [{ id: 5, tags: ['vector-database', 'ai'] }];
});

describe('deriveSignalTopic', () => {
  it('resolves the linked RadarEntry and derives the topic from its tags', async () => {
    expect(await deriveSignalTopic(sig())).toBe('vector-database');
  });

  it('returns undefined for a null signal (deleted on the hot path)', async () => {
    expect(await deriveSignalTopic(null)).toBeUndefined();
  });

  it('returns undefined when the signal has no linked technology', async () => {
    expect(await deriveSignalTopic(sig({ linkedEntities: {} }))).toBeUndefined();
    expect(await deriveSignalTopic(sig({ linkedEntities: { technologies: [] } }))).toBeUndefined();
  });

  it('returns undefined when the entry is not found in the radar', async () => {
    expect(await deriveSignalTopic(sig({ linkedEntities: { technologies: ['radar1:999'] } }))).toBeUndefined();
  });

  it('returns undefined for a malformed compound id', async () => {
    expect(await deriveSignalTopic(sig({ linkedEntities: { technologies: ['not-a-pair'] } }))).toBeUndefined();
  });

  it('returns undefined when the resolved entry has no usable tags', async () => {
    entriesByRadar['radar1'] = [{ id: 5, tags: [] }];
    expect(await deriveSignalTopic(sig())).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // metadata.discoveryTopic fallback (Task S12.4) — the discovery lane's
  // signals have no linked radar tech, so without this fallback a user's
  // dislike of a discovery signal was silently dropped.
  // -------------------------------------------------------------------------

  it('falls back to metadata.discoveryTopic when there is no linked technology', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: { discoveryTopic: 'drug-discovery' } }));
    expect(result).toBe('drug-discovery');
  });

  it('returns undefined when there is no linked technology and no discoveryTopic', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: {} }));
    expect(result).toBeUndefined();
  });

  it('prefers the linked-tech topic over metadata.discoveryTopic when both are present', async () => {
    const result = await deriveSignalTopic(sig({ metadata: { discoveryTopic: 'drug-discovery' } }));
    expect(result).toBe('vector-database');
  });

  it('treats a blank/whitespace metadata.discoveryTopic as absent', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: { discoveryTopic: '   ' } }));
    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // metadata.matchedKeyword fallback (T27) — raw signals with no linked tech AND
  // no discoveryTopic (e.g. a keyword-fetched signal that never got a discoveryTopic
  // stamped) previously dropped their feedback entirely. This is fallback 3, after
  // discoveryTopic, mirroring deriveSignalTopicsBatch's existing precedence.
  // -------------------------------------------------------------------------

  it('derives topic from metadata.matchedKeyword when no linked tech/discoveryTopic', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: { matchedKeyword: 'RAG Pipelines' } }));
    expect(result).toBe('rag-pipelines');
  });

  it('prefers metadata.discoveryTopic over metadata.matchedKeyword when both are present', async () => {
    const result = await deriveSignalTopic(
      sig({ linkedEntities: {}, metadata: { discoveryTopic: 'drug-discovery', matchedKeyword: 'ignored' } })
    );
    expect(result).toBe('drug-discovery');
  });

  it('prefers the linked-tech topic over metadata.matchedKeyword when both are present', async () => {
    const result = await deriveSignalTopic(sig({ metadata: { matchedKeyword: 'ignored' } }));
    expect(result).toBe('vector-database');
  });

  it('treats a blank/whitespace metadata.matchedKeyword as absent', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: { matchedKeyword: '   ' } }));
    expect(result).toBeUndefined();
  });

  it('returns undefined when there is no linked technology, discoveryTopic, or matchedKeyword', async () => {
    const result = await deriveSignalTopic(sig({ linkedEntities: {}, metadata: {} }));
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// deriveSignalTopicsBatch — LIST-SCALE batched resolution (US-2 "For you" sort).
// Precedence MIRRORS deriveSignalTopic (linked-tech first, discoveryTopic/matchedKeyword
// fallback) — this is a write/read key-space parity requirement: the feedback writer
// (deriveSignalTopic) resolves linked-tech first, so a signal with BOTH a resolvable
// linkedTechRef and discovery metadata must resolve to the SAME topic here, or a like/dislike
// on that signal would post to one topic and the "For you" boost would read a different one.
// Read cost is still minimized: only signals WITHOUT a linkedTechRef take the read-free path;
// every signal WITH a linkedTechRef groups into the radar-read pass, which still reads each
// referenced radar's entries AT MOST ONCE per call regardless of signal count.
// =============================================================================
describe('deriveSignalTopicsBatch', () => {
  const ref = (over: Record<string, unknown> = {}) => ({ id: 'sig1', ...over });

  it('resolves topics read-free for signals with NO linkedTechRef (zero radar reads)', async () => {
    const signals = [
      ref({ id: 's1', discoveryTopic: 'drug-discovery' }),
      ref({ id: 's2', matchedKeyword: 'RAG Pipelines' }),
      ref({ id: 's3', discoveryTopic: 'quantum-computing', matchedKeyword: 'ignored-when-discoveryTopic-present' }),
    ];

    const result = await deriveSignalTopicsBatch(signals);

    expect(result).toEqual({
      s1: 'drug-discovery',
      s2: 'rag-pipelines',
      s3: 'quantum-computing',
    });
    expect(Object.keys(entriesReadCounts)).toHaveLength(0);
  });

  it("reads each radar's entries at most once for linked-tech signals (3 signals, 2 radars → 2 reads)", async () => {
    entriesByRadar['radar1'] = [{ id: 5, tags: ['vector-database'] }];
    entriesByRadar['radar2'] = [{ id: 7, tags: ['synthetic-biology'] }];

    const signals = [
      ref({ id: 's1', linkedTechRef: 'radar1:5' }),
      ref({ id: 's2', linkedTechRef: 'radar1:5' }),
      ref({ id: 's3', linkedTechRef: 'radar2:7' }),
    ];

    const result = await deriveSignalTopicsBatch(signals);

    expect(result).toEqual({
      s1: 'vector-database',
      s2: 'vector-database',
      s3: 'synthetic-biology',
    });
    expect(entriesReadCounts['radar1']).toBe(1);
    expect(entriesReadCounts['radar2']).toBe(1);
    expect(Object.values(entriesReadCounts).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('linked-tech topic wins over discovery metadata (write/read key-space parity)', async () => {
    entriesByRadar['radar1'] = [{ id: 5, tags: ['vector-database'] }];

    const signals = [ref({ id: 's1', linkedTechRef: 'radar1:5', discoveryTopic: 'drug-discovery' })];

    const result = await deriveSignalTopicsBatch(signals);

    // Must match deriveSignalTopic's resolution for the equivalent Signal shape — see the
    // parity-lock test below, which asserts this equivalence generically.
    expect(result).toEqual({ s1: 'vector-database' });
    expect(entriesReadCounts['radar1']).toBe(1);
  });

  it('falls back to discovery metadata when the linked entry cannot be resolved', async () => {
    // radar1 has no entry with id 999 — entry lookup fails, so the resolver must fall back
    // to discoveryTopic exactly like deriveSignalTopic does, instead of returning undefined.
    const signals = [ref({ id: 's1', linkedTechRef: 'radar1:999', discoveryTopic: 'drug-discovery' })];

    const result = await deriveSignalTopicsBatch(signals);

    expect(result).toEqual({ s1: 'drug-discovery' });
    expect(entriesReadCounts['radar1']).toBe(1);
  });

  it('returns undefined for a signal with neither a read-free topic nor a resolvable linked tech', async () => {
    const signals = [ref({ id: 's1' })];

    const result = await deriveSignalTopicsBatch(signals);

    expect(result).toEqual({ s1: undefined });
    expect(Object.keys(entriesReadCounts)).toHaveLength(0);
  });

  it('returns undefined when the linked entry is not found in its radar and there is no discovery fallback', async () => {
    const signals = [ref({ id: 's1', linkedTechRef: 'radar1:999' })];

    const result = await deriveSignalTopicsBatch(signals);

    expect(result).toEqual({ s1: undefined });
    expect(entriesReadCounts['radar1']).toBe(1);
  });

  it('returns an empty map for an empty input without any reads', async () => {
    const result = await deriveSignalTopicsBatch([]);

    expect(result).toEqual({});
    expect(Object.keys(entriesReadCounts)).toHaveLength(0);
  });
});

// =============================================================================
// Parity lock: deriveSignalTopicsBatch must resolve EVERY signal identically to
// deriveSignalTopic run per-signal against the same mocked reads. This is the load-bearing
// invariant behind the write/read key-space parity fix — if the batch resolver's precedence
// ever diverges from the single-signal writer again, this test must fail.
// =============================================================================
describe('deriveSignalTopicsBatch / deriveSignalTopic parity', () => {
  it('resolves identically to per-signal deriveSignalTopic for a mixed batch', async () => {
    entriesByRadar['radar1'] = [
      { id: 5, tags: ['vector-database'] },
      { id: 6, tags: [] },
    ];
    entriesByRadar['radar2'] = [{ id: 7, tags: ['synthetic-biology'] }];

    // Each fixture pairs a SignalTopicRef (batch input) with the equivalent full Signal shape
    // deriveSignalTopic expects, so both resolvers see identical source data.
    const fixtures = [
      // linked + resolvable, no discovery metadata
      {
        ref: { id: 's1', linkedTechRef: 'radar1:5' },
        signal: sig({ id: 's1', linkedEntities: { technologies: ['radar1:5'] }, metadata: {} }),
      },
      // linked + resolvable, ALSO carries discovery metadata — the exact regression case
      {
        ref: { id: 's2', linkedTechRef: 'radar1:5', discoveryTopic: 'drug-discovery' },
        signal: sig({
          id: 's2',
          linkedEntities: { technologies: ['radar1:5'] },
          metadata: { discoveryTopic: 'drug-discovery' },
        }),
      },
      // linked but unresolvable entry → falls back to discoveryTopic
      {
        ref: { id: 's3', linkedTechRef: 'radar1:999', discoveryTopic: 'drug-discovery' },
        signal: sig({
          id: 's3',
          linkedEntities: { technologies: ['radar1:999'] },
          metadata: { discoveryTopic: 'drug-discovery' },
        }),
      },
      // no linkedTechRef at all, read-free discoveryTopic
      {
        ref: { id: 's4', discoveryTopic: 'quantum-computing' },
        signal: sig({ id: 's4', linkedEntities: {}, metadata: { discoveryTopic: 'quantum-computing' } }),
      },
      // linked + resolvable entry, but the entry has no usable (non-stopword) tags → falls
      // back to discoveryTopic in both resolvers.
      {
        ref: { id: 's5', linkedTechRef: 'radar1:6', discoveryTopic: 'drug-discovery' },
        signal: sig({
          id: 's5',
          linkedEntities: { technologies: ['radar1:6'] },
          metadata: { discoveryTopic: 'drug-discovery' },
        }),
      },
      // second radar, linked + resolvable
      {
        ref: { id: 's6', linkedTechRef: 'radar2:7' },
        signal: sig({ id: 's6', linkedEntities: { technologies: ['radar2:7'] }, metadata: {} }),
      },
      // neither linked nor discovery metadata
      {
        ref: { id: 's7' },
        signal: sig({ id: 's7', linkedEntities: {}, metadata: {} }),
      },
      // T27: matchedKeyword-only (no linkedTechRef, no discoveryTopic) — deriveSignalTopic now
      // has the SAME fallback-3 matchedKeyword precedence deriveSignalTopicsBatch already had,
      // so this must resolve identically in both instead of the pre-T27 asymmetry.
      {
        ref: { id: 's8', matchedKeyword: 'RAG Pipelines' },
        signal: sig({ id: 's8', linkedEntities: {}, metadata: { matchedKeyword: 'RAG Pipelines' } }),
      },
      // T27: linked + resolvable entry with no usable tags, discoveryTopic ABSENT but
      // matchedKeyword present → both resolvers must fall through to matchedKeyword.
      {
        ref: { id: 's9', linkedTechRef: 'radar1:6', matchedKeyword: 'RAG Pipelines' },
        signal: sig({
          id: 's9',
          linkedEntities: { technologies: ['radar1:6'] },
          metadata: { matchedKeyword: 'RAG Pipelines' },
        }),
      },
    ];

    const batchResult = await deriveSignalTopicsBatch(fixtures.map((f) => f.ref));

    for (const { ref: r, signal } of fixtures) {
      const single = await deriveSignalTopic(signal);
      expect(batchResult[r.id]).toBe(single);
    }
  });
});
