/**
 * @jest-environment node
 *
 * resolveEntityTopic reads an entity's tags from the SAME source the selector ranks
 * on (its Firestore doc) and derives the tag topic — so the feedback write key-space
 * lines up with the selector read key-space (the whole point of A1).
 */
export {};

const mockDocGet = jest.fn();
const db = {
  collection: (c: string) => ({ doc: (id: string) => ({ get: () => mockDocGet(c, id) }) }),
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { resolveEntityTopic } = require('../entity-topic');

describe('resolveEntityTopic', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads tags from the entity collection and derives the tag topic', async () => {
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ tags: ['Vector Database', 'ai'] }) });
    const topic = await resolveEntityTopic('t1', 'technology');
    expect(mockDocGet).toHaveBeenCalledWith('technologies', 't1');
    expect(topic).toBe('vector-database');
  });

  it('maps each supported entityType to its collection', async () => {
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ tags: ['x'] }) });
    await resolveEntityTopic('u1', 'useCase');
    expect(mockDocGet).toHaveBeenCalledWith('use-cases', 'u1');
  });

  it('M17: skips stopword tags — keys on the first MEANINGFUL tag (the key-space the selector scores on)', async () => {
    // 'competitor' is a TAG_STOPWORD: the selector's scoreCandidate only reads
    // weights over meaningfulTags, so feedback keyed on the raw first tag would
    // be stranded — and its engagement count would LOWER the class's exploration
    // bonus (inverted learning).
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ tags: ['Competitor', 'Vector Database'] }) });
    expect(await resolveEntityTopic('t3', 'technology')).toBe('vector-database');
  });

  it('M17: falls back to entityType when every tag is a stopword', async () => {
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ tags: ['competitor', 'hyped'] }) });
    expect(await resolveEntityTopic('t4', 'technology')).toBe('technology');
  });

  it('falls back to entityType when the entity is missing (deleted mid-flight)', async () => {
    mockDocGet.mockResolvedValue({ exists: false });
    expect(await resolveEntityTopic('gone', 'technology')).toBe('technology');
  });

  it('falls back to entityType when the entity has no tags', async () => {
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({}) });
    expect(await resolveEntityTopic('t2', 'painPoint')).toBe('painpoint');
  });

  it('falls back to entityType for an unknown entityType (no collection)', async () => {
    expect(await resolveEntityTopic('x', 'mystery')).toBe('mystery');
    expect(mockDocGet).not.toHaveBeenCalled();
  });
});
