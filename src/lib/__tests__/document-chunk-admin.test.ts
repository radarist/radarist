/**
 * Tests for document-chunk-admin.ts
 *
 * Focus: the embedding write-back path (H7) — `adminUpdateChunkEmbedding`
 * persists a freshly generated vector back to the Firestore chunk so the
 * next document sync does NOT re-embed every chunk, and refuses to persist
 * empty/zero-length vectors (which would clobber a previously-good one).
 */

// Mock server-only marker (module is server-only by design)
jest.mock('server-only', () => ({}));

const mockUpdate = jest.fn();
const mockDoc = jest.fn((_id: string) => ({ update: mockUpdate }));
const mockCollection = jest.fn((_name: string) => ({ doc: mockDoc }));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => mockCollection(name),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => 1700000000000, __isTimestamp: true })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms, __isTimestamp: true })),
  },
}));

import { adminUpdateChunkEmbedding, EmptyEmbeddingError } from '../document-chunk-admin';

describe('adminUpdateChunkEmbedding (H7 write-back)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('writes embedding, model and embeddedAt to the chunk document', async () => {
    const embedding = new Array(768).fill(0.02);

    await adminUpdateChunkEmbedding('chunk-1', embedding, 'gemini-embedding-001');

    expect(mockCollection).toHaveBeenCalledWith('documentChunks');
    expect(mockDoc).toHaveBeenCalledWith('chunk-1');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const payload = mockUpdate.mock.calls[0][0];
    expect(payload.embedding).toHaveLength(768);
    expect(payload.embeddingModel).toBe('gemini-embedding-001');
    expect(payload.embeddedAt).toEqual(expect.objectContaining({ __isTimestamp: true }));
  });

  it('refuses to persist an empty embedding vector (throws EmptyEmbeddingError, no write)', async () => {
    await expect(adminUpdateChunkEmbedding('chunk-1', [], 'gemini-embedding-001')).rejects.toThrow(EmptyEmbeddingError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to persist a non-array embedding (throws EmptyEmbeddingError, no write)', async () => {
    await expect(
      adminUpdateChunkEmbedding('chunk-1', undefined as unknown as number[], 'gemini-embedding-001')
    ).rejects.toThrow(EmptyEmbeddingError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rethrows Firestore update failures', async () => {
    mockUpdate.mockRejectedValue(new Error('firestore down'));
    await expect(adminUpdateChunkEmbedding('chunk-1', [0.1, 0.2], 'gemini-embedding-001')).rejects.toThrow(
      'firestore down'
    );
  });
});
