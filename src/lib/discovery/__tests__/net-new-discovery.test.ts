/**
 * @jest-environment node
 *
 * B0-B1 — net-new discovery: model proposes real technologies for the user's interest
 * topics; ones already in the catalog are dropped; the rest become PENDING
 * proposedEntities (never auto-minted); the per-cycle limit is respected.
 */
export {};

const mockGenerateStructured = jest.fn();
const mockGetInterestProfile = jest.fn();
const mockCreateProposedEntity = jest.fn();
const mockTechQuery = jest.fn();

jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateStructuredContent: (...a: unknown[]) => mockGenerateStructured(...a),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  __esModule: true,
  getInterestProfile: (...a: unknown[]) => mockGetInterestProfile(...a),
}));
jest.mock('@/lib/proposed-entities-admin', () => ({
  __esModule: true,
  createProposedEntityIfNotExists: (...a: unknown[]) => mockCreateProposedEntity(...a),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => ({
      where: (_f: string, _op: string, val: string) => ({
        limit: () => ({ get: () => mockTechQuery(val) }),
      }),
    }),
  },
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const {
  discoverNetNewTechnologies,
  discoverNetNewEntities,
  discoveryCandidatesSchema,
} = require('../net-new-discovery');

describe('discoveryCandidatesSchema (DISC-015 — strict shape acceptance)', () => {
  const valid = { name: 'Pinecone', description: 'Managed vector DB', tags: ['vector-database'] };

  it('accepts the documented {candidates:[...]} object response', () => {
    const parsed = discoveryCandidatesSchema.parse({ candidates: [valid] });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].name).toBe('Pinecone');
  });

  it('accepts the known bounded bare-array variant and normalizes it to {candidates}', () => {
    const parsed = discoveryCandidatesSchema.parse([valid, { name: 'Weaviate', description: 'oss', tags: ['v'] }]);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates.map((c: { name: string }) => c.name)).toEqual(['Pinecone', 'Weaviate']);
  });

  it('applies soft-field defaults without inventing required content', () => {
    const parsed = discoveryCandidatesSchema.parse([valid]);
    expect(parsed.candidates[0].relevance).toBe(55); // catch default
    expect(parsed.candidates[0].whyRelevant).toBe('');
    expect(parsed.candidates[0].sourceUrl).toBe('');
  });

  it.each([
    ['an arbitrary object with no candidates', { foo: 1 }],
    ['candidates as a non-array', { candidates: 'nope' }],
    ['a bare array of non-candidate junk', [{ random: 1 }]],
    ['a mixed array (one valid, one junk) — no partial coercion', [valid, { random: 1 }]],
    ['a candidate missing its required name', [{ description: 'd', tags: ['t'] }]],
    ['a string root', 'candidates'],
    ['a number root', 42],
    ['a null root', null],
  ])('rejects %s rather than coercing it into candidates', (_label, raw) => {
    expect(() => discoveryCandidatesSchema.parse(raw)).toThrow();
  });
});

describe('discoverNetNewEntities (DISC-015 — per-dimension diagnostics)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInterestProfile.mockResolvedValue({ userId: 'u1', topics: ['llm'], vertical: 'ai', updatedAt: 'x' });
    mockTechQuery.mockResolvedValue({ empty: true });
    mockCreateProposedEntity.mockResolvedValue({ created: true, entity: {} });
  });

  it('reports ok=true on a successful dimension', async () => {
    mockGenerateStructured.mockResolvedValue({ candidates: [{ name: 'X', description: 'd', tags: ['t'] }] });
    const res = await discoverNetNewEntities('u1', { entityType: 'technology', limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('returns a diagnostic (ok=false) on a malformed model response WITHOUT throwing or fabricating candidates', async () => {
    mockGenerateStructured.mockRejectedValue(new Error('Schema validation failed: candidates: Required'));
    const res = await discoverNetNewEntities('u1', { entityType: 'technology', limit: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Schema validation failed');
    expect(res.proposed).toBe(0);
    expect(res.considered).toBe(0);
    expect(res.proposedNames).toEqual([]);
    expect(mockCreateProposedEntity).not.toHaveBeenCalled(); // never fabricates
  });

  it('an unsupported dimension is a valid empty result (ok=true, no model call)', async () => {
    const res = await discoverNetNewEntities('u1', { entityType: 'prototype', limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.proposed).toBe(0);
    expect(mockGenerateStructured).not.toHaveBeenCalled();
  });

  describe('view-context focus (DISC-016)', () => {
    it('scopes the prompt and matchedTopics to the transported focus topics, skipping the profile read', async () => {
      mockGenerateStructured.mockResolvedValue({
        candidates: [{ name: 'FocusTech', description: 'd', tags: ['graph-db'] }],
      });
      const res = await discoverNetNewEntities('u1', {
        entityType: 'technology',
        limit: 5,
        focusTopics: ['graph-db', 'temporal-kg'],
      });

      // The prompt is grounded in what the user was LOOKING AT, not the generic profile.
      const prompt = mockGenerateStructured.mock.calls[0][0] as string;
      expect(prompt).toContain('graph-db');
      expect(prompt).toContain('temporal-kg');
      expect(prompt).not.toContain('llm'); // profile topic must not leak in
      expect(mockGetInterestProfile).not.toHaveBeenCalled();
      expect(res.topics).toEqual(['graph-db', 'temporal-kg']);
      expect(mockCreateProposedEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ matchedTopics: ['graph-db', 'temporal-kg'] }),
        })
      );
    });

    it('bounds oversized focus lists to 12 topics', async () => {
      mockGenerateStructured.mockResolvedValue({ candidates: [] });
      const many = Array.from({ length: 30 }, (_, i) => `topic-${i}`);
      const res = await discoverNetNewEntities('u1', { entityType: 'technology', limit: 5, focusTopics: many });
      expect(res.topics).toHaveLength(12);
    });

    it('falls back to the interest profile when focus is absent or empty (unchanged behavior)', async () => {
      mockGenerateStructured.mockResolvedValue({ candidates: [] });
      await discoverNetNewEntities('u1', { entityType: 'technology', limit: 5, focusTopics: [] });
      expect(mockGetInterestProfile).toHaveBeenCalledWith('u1');
      expect(mockGenerateStructured.mock.calls[0][0] as string).toContain('llm');
    });
  });
});

describe('discoverNetNewTechnologies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInterestProfile.mockResolvedValue({
      userId: 'u1',
      topics: ['vector-database', 'llm'],
      vertical: 'ai',
      updatedAt: 'x',
    });
    mockTechQuery.mockResolvedValue({ empty: true }); // nothing in the catalog by default
    mockCreateProposedEntity.mockResolvedValue({ created: true, entity: {} });
  });

  it('proposes net-new technologies for the interest topics (pending entities)', async () => {
    mockGenerateStructured.mockResolvedValue({
      candidates: [
        { name: 'Pinecone', description: 'Managed vector DB', tags: ['vector-database', 'managed'] },
        { name: 'Weaviate', description: 'Open-source vector DB', tags: ['vector-database', 'oss'] },
      ],
    });
    const res = await discoverNetNewTechnologies('u1', { limit: 5 });
    // prompt is grounded in the user's interest topics
    expect(mockGenerateStructured.mock.calls[0][0]).toContain('vector-database');
    expect(res.proposed).toBe(2);
    expect(res.proposedNames).toEqual(['Pinecone', 'Weaviate']);
    expect(mockCreateProposedEntity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'technology', name: 'Pinecone' })
    );
  });

  it('drops a candidate already in the catalog (not net-new)', async () => {
    mockTechQuery.mockImplementation((slug: string) => Promise.resolve({ empty: slug !== 'pinecone' }));
    mockGenerateStructured.mockResolvedValue({
      candidates: [
        { name: 'Pinecone', description: 'exists', tags: ['vector-database'] },
        { name: 'Weaviate', description: 'new', tags: ['vector-database'] },
      ],
    });
    const res = await discoverNetNewTechnologies('u1', { limit: 5 });
    expect(res.proposed).toBe(1);
    expect(res.proposedNames).toEqual(['Weaviate']);
  });

  it('respects the per-cycle limit', async () => {
    mockGenerateStructured.mockResolvedValue({
      candidates: [
        { name: 'A', description: 'a', tags: ['x'] },
        { name: 'B', description: 'b', tags: ['x'] },
        { name: 'C', description: 'c', tags: ['x'] },
      ],
    });
    const res = await discoverNetNewTechnologies('u1', { limit: 2 });
    expect(res.proposed).toBe(2);
    expect(mockCreateProposedEntity).toHaveBeenCalledTimes(2);
  });

  it('does NOT count an already-proposed candidate as newly proposed', async () => {
    mockCreateProposedEntity.mockResolvedValue({ created: false, entity: {}, reason: 'already_pending' });
    mockGenerateStructured.mockResolvedValue({ candidates: [{ name: 'Pinecone', description: 'x', tags: ['v'] }] });
    const res = await discoverNetNewTechnologies('u1', { limit: 5 });
    expect(res.proposed).toBe(0);
  });

  it('a single failing candidate does NOT discard the rest of the paid batch', async () => {
    mockGenerateStructured.mockResolvedValue({
      candidates: [
        { name: 'Pinecone', description: 'a', tags: ['v'] },
        { name: 'Boom', description: 'b', tags: ['v'] },
        { name: 'Weaviate', description: 'c', tags: ['v'] },
      ],
    });
    mockCreateProposedEntity.mockImplementation((input: { name: string }) =>
      input.name === 'Boom'
        ? Promise.reject(new Error('firestore unavailable'))
        : Promise.resolve({ created: true, entity: {} })
    );
    const res = await discoverNetNewTechnologies('u1', { limit: 5 });
    expect(res.proposed).toBe(2); // Pinecone + Weaviate survive
    expect(res.failed).toBe(1); // Boom counted, not silently dropped
    expect(res.proposedNames).toEqual(['Pinecone', 'Weaviate']);
  });

  it('discovers a NON-technology dimension (useCase) — proposes with that entityType', async () => {
    mockGenerateStructured.mockResolvedValue({
      candidates: [{ name: 'Automated invoice triage', description: 'x', tags: ['finance-ops'] }],
    });
    const res = await discoverNetNewEntities('u1', { entityType: 'useCase', limit: 5 });
    expect(res.entityType).toBe('useCase');
    expect(res.proposed).toBe(1);
    expect(mockCreateProposedEntity).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'useCase' }));
  });

  it('returns an empty result for an unsupported dimension (no model call)', async () => {
    const res = await discoverNetNewEntities('u1', { entityType: 'prototype', limit: 5 });
    expect(res.proposed).toBe(0);
    expect(mockGenerateStructured).not.toHaveBeenCalled();
  });

  it('falls back to the broad prior when the user has no interest topics', async () => {
    mockGetInterestProfile.mockResolvedValue(null);
    mockGenerateStructured.mockResolvedValue({ candidates: [] });
    await discoverNetNewTechnologies('u1', { limit: 3 });
    expect(mockGenerateStructured.mock.calls[0][0]).toContain('vector-database'); // a DEFAULT_BROAD_TOPIC
  });
});
