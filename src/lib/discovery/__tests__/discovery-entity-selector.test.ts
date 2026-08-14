export {};
/**
 * @jest-environment node
 *
 * P1a-T4 (radar-rescope) — the FIRST posterior reader. Candidate scoping is now by
 * RADAR: technology candidates are the radar's placed techs (joined via
 * radarPlacements → technologyId), NOT a `technologies.quadrantId` filter (quadrantId
 * is a placement field, absent on real tech docs). Load-bearing: (b) δ keeps the
 * less-explored topic visible; (c) δ never dominates a real weight.
 */

const mockGetInterestProfile = jest.fn();
const mockGetEffectivePreferences = jest.fn();
const mockGetProposedAssessments = jest.fn();
const mockGetProposedEntities = jest.fn();
const mockGetProposedRelations = jest.fn();
const mockGetDiscoveryConfig = jest.fn();
const mockGetTechsForRadar = jest.fn();
const mockSeedInterestProfile = jest.fn();

// db is ONLY hit on the fallback path (non-technology, or technology with no radarId).
let fallbackDocs: Array<Record<string, unknown> & { id: string }> = [];
const collectionSpy = jest.fn();
const db = {
  collection: (name: string) => {
    collectionSpy(name);
    return { get: async () => ({ docs: fallbackDocs.map((d) => ({ id: d.id, data: () => d })) }) };
  },
};

jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/graph/interest-profile', () => ({
  getInterestProfile: (...a: unknown[]) => mockGetInterestProfile(...a),
}));
jest.mock('@/lib/discovery/cold-start', () => ({
  getEffectivePreferences: (...a: unknown[]) => mockGetEffectivePreferences(...a),
  seedInterestProfile: (...a: unknown[]) => mockSeedInterestProfile(...a),
}));
jest.mock('@/lib/proposed-assessments-admin', () => ({
  getProposedAssessments: (...a: unknown[]) => mockGetProposedAssessments(...a),
}));
jest.mock('@/lib/proposed-entities-admin', () => ({
  getProposedEntities: (...a: unknown[]) => mockGetProposedEntities(...a),
}));
jest.mock('@/lib/proposed-relations-admin', () => ({
  getProposedRelations: (...a: unknown[]) => mockGetProposedRelations(...a),
}));
jest.mock('@/lib/discovery/discovery-config', () => ({
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/radars-admin', () => ({
  adminGetTechnologiesWithPlacementsForRadar: (...a: unknown[]) => mockGetTechsForRadar(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { selectDiscoveryEntities } = require('../discovery-entity-selector');

const opts = { entityType: 'technology' as const, radarId: 'r1', userId: 'u1', limit: 5 };
// A radar-placed technology, shaped like adminGetTechnologiesWithPlacementsForRadar output.
const tech = (id: string, name: string, tags: string[]) => ({
  id,
  name,
  tags,
  placement: { radarId: 'r1', quadrantId: 'q_x' },
});

describe('selectDiscoveryEntities (radar-scoped)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fallbackDocs = [];
    mockGetInterestProfile.mockResolvedValue({ userId: 'u1', topics: [], updatedAt: 'x' });
    mockGetEffectivePreferences.mockResolvedValue([]);
    mockGetProposedAssessments.mockResolvedValue([]);
    mockGetProposedEntities.mockResolvedValue([]);
    mockGetProposedRelations.mockResolvedValue([]);
    mockGetDiscoveryConfig.mockReturnValue({ explorationRate: 0.15 });
    mockGetTechsForRadar.mockResolvedValue([]);
    mockSeedInterestProfile.mockResolvedValue(undefined);
  });

  it('(f/M18) seeds a cold-start InterestProfile and proceeds with the broad prior in the SAME run', async () => {
    // A fresh user must not silently dispatch nothing: the no-profile branch
    // seeds the broad prior (seedInterestProfile) and selects in this run.
    mockGetInterestProfile.mockResolvedValue(null);
    mockGetTechsForRadar.mockResolvedValue([tech('t1', 'X', ['llm'])]);
    const out = await selectDiscoveryEntities(opts);
    expect(mockSeedInterestProfile).toHaveBeenCalledWith('u1');
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t1']);
  });

  it('(f2) does NOT re-seed when the user already has an InterestProfile', async () => {
    mockGetTechsForRadar.mockResolvedValue([tech('t1', 'X', ['llm'])]);
    await selectDiscoveryEntities(opts);
    expect(mockSeedInterestProfile).not.toHaveBeenCalled();
  });

  it('scopes candidates to the radar via the radarPlacements join (NOT a quadrantId filter)', async () => {
    mockGetTechsForRadar.mockResolvedValue([tech('t1', 'Neo4j', ['graph-db'])]);
    const out = await selectDiscoveryEntities(opts);
    expect(mockGetTechsForRadar).toHaveBeenCalledWith('r1');
    expect(collectionSpy).not.toHaveBeenCalled(); // no whole-collection scan
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t1']);
  });

  it('CONTRACT: a radar-join READ FAILURE rejects (never silently resolves to [])', async () => {
    // A read failure must propagate to the Inngest step's onFailure, not masquerade
    // as an empty radar / no-candidates. Pins the throw-don't-swallow contract.
    mockGetTechsForRadar.mockRejectedValue(new Error('firestore unavailable'));
    await expect(selectDiscoveryEntities(opts)).rejects.toThrow('firestore unavailable');
  });

  it('(a) excludes technologies with a PENDING or APPROVED assessment', async () => {
    mockGetProposedAssessments.mockResolvedValue([
      { technologyId: 't-pending', status: 'pending' },
      { technologyId: 't-approved', status: 'approved' },
    ]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-pending', 'Pending', ['llm']),
      tech('t-approved', 'Approved', ['llm']),
      tech('t-keep', 'Keep', ['llm']),
    ]);
    const out = await selectDiscoveryEntities(opts);
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t-keep']);
  });

  it('excludes a candidate that already has a pending/approved "evaluates" relation (no re-evaluation flood)', async () => {
    // A completed evaluation stages a Document—evaluates→entity relation; the selector
    // must treat that as "already evaluated" so the sweep does not re-dispatch it.
    mockGetProposedRelations.mockResolvedValue([
      { targetId: 't-evaluated', relationType: 'evaluates', status: 'pending' },
      { targetId: 't-approved-eval', relationType: 'evaluates', status: 'approved' },
      { targetId: 't-keep', relationType: 'uses', status: 'pending' }, // non-evaluates → NOT excluded
    ]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-evaluated', 'Evaluated', ['llm']),
      tech('t-approved-eval', 'Approved', ['llm']),
      tech('t-keep', 'Keep', ['llm']),
    ]);
    const out = await selectDiscoveryEntities(opts);
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t-keep']);
  });

  it('(a2) does NOT permanently exclude a rejected/dismissed assessment', async () => {
    mockGetProposedAssessments.mockResolvedValue([
      { technologyId: 't-rejected', status: 'rejected' },
      { technologyId: 't-dismissed', status: 'dismissed' },
    ]);
    mockGetTechsForRadar.mockResolvedValue([tech('t-rejected', 'R', ['llm']), tech('t-dismissed', 'D', ['llm'])]);
    const out = await selectDiscoveryEntities(opts);
    expect(out.map((c: { entityId: string }) => c.entityId).sort()).toEqual(['t-dismissed', 't-rejected']);
  });

  it('(b) at equal weight, the LESS-explored topic ranks higher (δ is live)', async () => {
    mockGetEffectivePreferences.mockResolvedValue([{ topic: 'frequent', weight: 0, actedCount: 1, dismissedCount: 2 }]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-frequent', 'Frequent', ['frequent']),
      tech('t-fresh', 'Fresh', ['fresh']),
    ]);
    const out = await selectDiscoveryEntities(opts);
    expect(out[0].entityId).toBe('t-fresh');
    expect(out[0].explorationDelta).toBeGreaterThan(out[1].explorationDelta);
  });

  it('(c) a real high weight beats a never-explored topic (δ does NOT dominate)', async () => {
    mockGetEffectivePreferences.mockResolvedValue([{ topic: 'liked', weight: 0.5, actedCount: 5, dismissedCount: 0 }]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-liked', 'Liked', ['liked']),
      tech('t-unknown', 'Unknown', ['unknown']),
    ]);
    const out = await selectDiscoveryEntities(opts);
    expect(out[0].entityId).toBe('t-liked');
    expect(out[0].baseScore).toBe(0.5);
  });

  it('(M1) scores a candidate on its BEST-matching meaningful tag, not just the first', async () => {
    // 'competitor' is a stopword AND the first tag; 'vector-database' is the real interest.
    // Seed/read alignment: the candidate must still be weighted via its non-first tag.
    mockGetEffectivePreferences.mockResolvedValue([
      { topic: 'vector-database', weight: 0.7, actedCount: 3, dismissedCount: 0 },
    ]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-multi', 'Multi', ['competitor', 'vector-database']),
      tech('t-none', 'None', ['unrelated']),
    ]);
    const out = await selectDiscoveryEntities(opts);
    const multi = out.find((c: { entityId: string }) => c.entityId === 't-multi') as {
      baseScore: number;
      topic: string;
    };
    expect(multi.baseScore).toBe(0.7); // matched via the NON-first tag
    expect(multi.topic).toBe('vector-database');
    expect(out[0].entityId).toBe('t-multi'); // ranks above the unmatched candidate
  });

  it('(focus) a view-focused entityId outranks a high learned weight (GRAPH-045 contextual scout)', async () => {
    mockGetEffectivePreferences.mockResolvedValue([{ topic: 'liked', weight: 1, actedCount: 5, dismissedCount: 0 }]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-liked', 'Liked', ['liked']),
      tech('t-in-view', 'In View', ['unrelated']),
    ]);
    const out = await selectDiscoveryEntities({ ...opts, focus: { focusEntityIds: ['t-in-view'] } });
    expect(out[0].entityId).toBe('t-in-view');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('(focus) a raw view tag matches through topic normalization (e.g. "Graph DB" → graph-db)', async () => {
    // 't-other' carries the higher learned weight, so WITHOUT the focus boost it
    // would rank first — the un-normalized view tag must lift 't-topical' above it.
    mockGetEffectivePreferences.mockResolvedValue([
      { topic: 'unrelated', weight: 0.9, actedCount: 5, dismissedCount: 0 },
    ]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-other', 'Other', ['unrelated']),
      tech('t-topical', 'Topical', ['graph-db']),
    ]);
    const out = await selectDiscoveryEntities({ ...opts, focus: { focusTopics: ['Graph DB'] } });
    expect(out[0].entityId).toBe('t-topical');
  });

  it('(focus) does NOT resurrect an excluded (pending/approved) candidate', async () => {
    mockGetProposedAssessments.mockResolvedValue([{ technologyId: 't-pending', status: 'pending' }]);
    mockGetTechsForRadar.mockResolvedValue([tech('t-pending', 'Pending', ['llm']), tech('t-keep', 'Keep', ['llm'])]);
    const out = await selectDiscoveryEntities({ ...opts, focus: { focusEntityIds: ['t-pending'] } });
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t-keep']);
  });

  it('(focus) an unmatched focus leaves ranking identical to the no-focus baseline', async () => {
    mockGetEffectivePreferences.mockResolvedValue([{ topic: 'liked', weight: 0.5, actedCount: 5, dismissedCount: 0 }]);
    mockGetTechsForRadar.mockResolvedValue([
      tech('t-liked', 'Liked', ['liked']),
      tech('t-unknown', 'Unknown', ['unknown']),
    ]);
    const baseline = await selectDiscoveryEntities(opts);
    const focused = await selectDiscoveryEntities({ ...opts, focus: { focusEntityIds: ['not-here'] } });
    expect(focused).toEqual(baseline);
  });

  it('(d) respects the limit', async () => {
    mockGetTechsForRadar.mockResolvedValue(Array.from({ length: 10 }, (_, i) => tech(`t${i}`, `T${i}`, ['x'])));
    const out = await selectDiscoveryEntities({ ...opts, limit: 3 });
    expect(out).toHaveLength(3);
  });

  it('(fallback) a non-technology type topic-ranks its whole collection (no radar join)', async () => {
    fallbackDocs = [{ id: 'uc1', title: 'UC', tags: ['workflow'] }];
    await selectDiscoveryEntities({ ...opts, entityType: 'useCase' });
    expect(collectionSpy).toHaveBeenCalledWith('use-cases');
    expect(mockGetTechsForRadar).not.toHaveBeenCalled();
  });

  it('(fallback) a technology with NO radarId topic-ranks the whole technologies collection', async () => {
    fallbackDocs = [{ id: 't9', name: 'X', tags: ['llm'] }];
    const { radarId: _omit, ...noRadar } = opts;
    const out = await selectDiscoveryEntities(noRadar);
    expect(collectionSpy).toHaveBeenCalledWith('technologies');
    expect(mockGetTechsForRadar).not.toHaveBeenCalled();
    expect(out.map((c: { entityId: string }) => c.entityId)).toEqual(['t9']);
  });
});
