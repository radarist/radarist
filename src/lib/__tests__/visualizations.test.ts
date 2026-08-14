/**
 * @jest-environment node
 */

import { createFirebaseAdminMock, fakeQuerySnapshot, fakeDocSnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

// The service uses `FieldValue.delete()` to clear a `liked` rating —
// stub the sentinel so we can assert it lands in the Firestore patch
// without booting the real firebase-admin module.
const FIELD_DELETE_SENTINEL = Symbol('FieldValue.delete');
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => FIELD_DELETE_SENTINEL },
}));

const mockDeleteStoredImage = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/storage', () => ({
  __esModule: true,
  deleteStoredImage: (...args: unknown[]) => mockDeleteStoredImage(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const {
  createVisualization,
  listVisualizations,
  readVisualizationById,
  getVisualizationById,
  updateVisualization,
  deleteVisualization,
  deleteVisualizations,
  buildLearnedStyleFragment,
} = require('../visualizations');

const SAMPLE_VIZ_DATA = {
  title: 'TRL Comparison',
  prompt: 'Compare TRL scores of top technologies',
  refinedPrompt: 'Compare TRL scores of 5 technologies: React (7), Vue (6)...',
  imageUrl: 'https://storage.example.com/viz.png',
  thumbnailUrl: 'https://storage.example.com/viz-thumb.png',
  mimeType: 'image/png' as const,
  style: 'professional' as const,
  dataSnapshot: {
    entities: [{ id: 'tech-1', name: 'React', type: 'technology' }],
    description: '5 technologies with TRL scores',
  },
  userId: 'user-1',
  createdBy: 'user' as const,
  metadata: {
    model: 'gemini-3-flash-preview',
    width: 1920,
    height: 1080,
    sizeBytes: 120000,
  },
};

describe('visualizations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteStoredImage.mockResolvedValue(undefined);
  });

  describe('createVisualization', () => {
    it('should create a visualization with generated id', async () => {
      const result = await createVisualization(SAMPLE_VIZ_DATA);
      expect(adminMock.set).toHaveBeenCalledTimes(1);
      expect(result.id).toMatch(/^viz-/);
      expect(result.title).toBe('TRL Comparison');
      expect(result.shared).toBe(false);
      expect(result.createdAt).toBeDefined();
    });

    it('uses the persisted id for subsequent exact reads', async () => {
      const created = await createVisualization(SAMPLE_VIZ_DATA);
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(created, created.id));

      const reread = await getVisualizationById(created.id);

      expect(reread).toEqual(created);
      expect(adminMock.doc).toHaveBeenLastCalledWith(created.id);
    });
  });

  describe('listVisualizations', () => {
    it('should return visualizations ordered by createdAt desc', async () => {
      adminMock.get.mockResolvedValueOnce(
        fakeQuerySnapshot([
          { id: 'viz-1', title: 'Chart A', createdAt: '2026-03-14T10:00:00Z' },
          { id: 'viz-2', title: 'Chart B', createdAt: '2026-03-14T09:00:00Z' },
        ])
      );

      const result = await listVisualizations('user-1');
      expect(result).toHaveLength(2);
      expect(adminMock.where).toHaveBeenCalledWith('userId', '==', 'user-1');
      expect(result.map((visualization: { id: string }) => visualization.id)).toEqual(['viz-1', 'viz-2']);
    });
  });

  describe('getVisualizationById', () => {
    it('returns an explicit found result when metadata exists', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot({ id: 'viz-1', title: 'Chart A' }));

      await expect(readVisualizationById('viz-1')).resolves.toMatchObject({
        status: 'found',
        visualization: { id: 'viz-1', title: 'Chart A' },
      });
    });

    it('returns explicit not-found only after Firestore confirms absence', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(null));

      await expect(readVisualizationById('viz-999')).resolves.toEqual({ status: 'not-found' });
    });

    it('does not convert a Firestore outage into not-found', async () => {
      adminMock.docGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

      await expect(readVisualizationById('viz-1')).rejects.toThrow('Firestore unavailable');
    });

    it('should return a visualization by id', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot({ id: 'viz-1', title: 'Chart A' }));
      const result = await getVisualizationById('viz-1');
      expect(result).toBeDefined();
      expect(result.title).toBe('Chart A');
    });

    it('should return null for non-existent visualization', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(null));
      const result = await getVisualizationById('viz-999');
      expect(result).toBeNull();
    });

    it('normalizes a malformed legacy dataSnapshot in memory without rewriting the doc', async () => {
      adminMock.docGet.mockResolvedValueOnce(
        fakeDocSnapshot({
          id: 'viz-legacy',
          title: 'Legacy',
          dataSnapshot: {
            entities: [
              { id: 'tech-1', name: 'React', type: '' },
              { id: '', name: 'dropped', type: 'technology' },
            ],
            description: 'legacy snapshot',
          },
        })
      );

      const result = await getVisualizationById('viz-legacy');

      expect(result?.dataSnapshot).toEqual({
        entities: [{ id: 'tech-1', name: 'React', type: 'unknown' }],
        description: 'legacy snapshot',
      });
      expect(adminMock.set).not.toHaveBeenCalled();
      expect(adminMock.update).not.toHaveBeenCalled();
    });

    it('normalizes an entirely missing dataSnapshot to the empty bounded shape', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot({ id: 'viz-old', title: 'No snapshot' }));

      const result = await getVisualizationById('viz-old');

      expect(result?.dataSnapshot).toEqual({ entities: [], description: '' });
    });
  });

  describe('listVisualizations legacy normalization', () => {
    it('normalizes malformed snapshots on every listed row', async () => {
      adminMock.get.mockResolvedValueOnce(
        fakeQuerySnapshot([
          { id: 'viz-1', title: 'A', dataSnapshot: { entities: 'garbage', description: 42 } },
          {
            id: 'viz-2',
            title: 'B',
            dataSnapshot: { entities: [{ id: 'sig-1', name: 'Signal', type: 'signal' }], description: 'ok' },
          },
        ])
      );

      const result = await listVisualizations('user-1');

      expect(result[0].dataSnapshot).toEqual({ entities: [], description: '' });
      expect(result[1].dataSnapshot).toEqual({
        entities: [{ id: 'sig-1', name: 'Signal', type: 'signal' }],
        description: 'ok',
      });
    });
  });

  describe('updateVisualization', () => {
    it('should update shared status', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-1', userId: 'user-1' }));

      await expect(updateVisualization('viz-1', 'user-1', { shared: true })).resolves.toEqual({
        status: 'updated',
      });
      expect(adminMock.transactionUpdate).toHaveBeenCalledTimes(1);
    });

    it('should drop undefined keys from the patch', async () => {
      // `liked: true` alone should NOT clobber `title` / `shared` on
      // the doc — the service must filter out the undefined keys.
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-1', userId: 'user-1' }));
      await updateVisualization('viz-1', 'user-1', { liked: true });
      const patch = adminMock.transactionUpdate.mock.calls[0][1];
      expect(patch.liked).toBe(true);
      expect('title' in patch).toBe(false);
      expect('shared' in patch).toBe(false);
      expect(patch.updatedAt).toEqual(expect.any(String));
    });

    it('should translate `liked: null` into a Firestore field-delete', async () => {
      // Storing literal `null` would fail the Zod `optional()` validator
      // on subsequent reads — the service must convert it to a
      // FieldValue.delete() sentinel so the read path sees `undefined`.
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-1', userId: 'user-1' }));
      await updateVisualization('viz-1', 'user-1', { liked: null });
      const patch = adminMock.transactionUpdate.mock.calls[0][1];
      expect(patch.liked).toBe(FIELD_DELETE_SENTINEL);
    });

    it('does not update an absent or foreign visualization', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-1', userId: 'user-2' }));

      await expect(updateVisualization('viz-1', 'user-1', { title: 'Stolen' })).resolves.toEqual({
        status: 'not-found',
      });
      expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('deleteVisualization', () => {
    it('should delete from Firestore and Storage', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-1', userId: 'user-1' }));

      await expect(deleteVisualization('viz-1', 'user-1')).resolves.toEqual({ status: 'deleted' });
      expect(adminMock.transactionDelete).toHaveBeenCalledTimes(1);
      // Should attempt to delete both full image and thumbnail
      expect(mockDeleteStoredImage).toHaveBeenCalledTimes(2);
    });

    it('deletes the exact stored object while targeting the record by its persisted id', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'viz-firestore-123',
          userId: 'user-1',
          storageObjectPath: 'visualizations/user-1/visualization-asset-storage-456',
        })
      );

      await deleteVisualization('viz-firestore-123', 'user-1');

      expect(adminMock.doc).toHaveBeenCalledWith('viz-firestore-123');
      expect(adminMock.transactionDelete).toHaveBeenCalledTimes(1);
      expect(mockDeleteStoredImage).toHaveBeenCalledTimes(1);
      expect(mockDeleteStoredImage).toHaveBeenCalledWith('visualizations/user-1/visualization-asset-storage-456');
    });

    it('does not read Storage or delete metadata for a foreign visualization', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-foreign', userId: 'user-2' }));

      await expect(deleteVisualization('viz-foreign', 'user-1')).resolves.toEqual({ status: 'not-found' });
      expect(mockDeleteStoredImage).not.toHaveBeenCalled();
      expect(adminMock.transactionDelete).not.toHaveBeenCalled();
    });
  });

  describe('deleteVisualizations', () => {
    it('should bulk delete multiple visualizations', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-owned', userId: 'user-1' }));

      await expect(deleteVisualizations(['viz-1', 'viz-2'], 'user-1')).resolves.toBe(2);
      expect(adminMock.transactionDelete).toHaveBeenCalledTimes(2);
    });

    it('deduplicates ids before concurrent deletion and counts the record once', async () => {
      adminMock.docGet.mockResolvedValue(fakeDocSnapshot({ id: 'viz-owned', userId: 'user-1' }));

      await expect(deleteVisualizations(['viz-owned', 'viz-owned'], 'user-1')).resolves.toBe(1);
      expect(adminMock.transactionDelete).toHaveBeenCalledTimes(1);
    });

    it('should handle empty ids array', async () => {
      await expect(deleteVisualizations([], 'user-1')).resolves.toBe(0);
      expect(adminMock.transactionDelete).not.toHaveBeenCalled();
    });
  });

  describe('createVisualization edge cases', () => {
    it('should set shared to false by default', async () => {
      const result = await createVisualization(SAMPLE_VIZ_DATA);
      expect(result.shared).toBe(false);
    });

    it('should generate unique ids for different calls', async () => {
      const result1 = await createVisualization(SAMPLE_VIZ_DATA);
      const result2 = await createVisualization(SAMPLE_VIZ_DATA);
      expect(result1.id).not.toBe(result2.id);
    });

    it('should include ISO createdAt timestamp', async () => {
      const result = await createVisualization(SAMPLE_VIZ_DATA);
      expect(() => new Date(result.createdAt)).not.toThrow();
      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('deleteVisualization error handling', () => {
    it('retains the Firestore retry anchor if Storage cleanup fails', async () => {
      adminMock.docGet.mockResolvedValue(
        fakeDocSnapshot({
          id: 'viz-1',
          userId: 'user-1',
          storageObjectPath: 'visualizations/user-1/visualization-asset-1',
        })
      );
      mockDeleteStoredImage.mockRejectedValue(new Error('Storage unavailable'));

      await expect(deleteVisualization('viz-1', 'user-1')).rejects.toThrow('Storage unavailable');
      expect(adminMock.transactionDelete).not.toHaveBeenCalled();
    });
  });

  describe('buildLearnedStyleFragment', () => {
    it('builds a fragment from liked and disliked designs', async () => {
      adminMock.get
        .mockResolvedValueOnce(
          fakeQuerySnapshot([
            { id: 'v1', title: 'Growth Curve', style: 'professional', updatedAt: '2026-06-01T00:00:00Z' },
            { id: 'v2', title: 'Market Map', style: 'colorful', updatedAt: '2026-06-02T00:00:00Z' },
          ])
        )
        .mockResolvedValueOnce(
          fakeQuerySnapshot([
            { id: 'v3', title: 'Cluttered Dashboard', style: 'dark', updatedAt: '2026-06-01T12:00:00Z' },
          ])
        );

      const fragment = await buildLearnedStyleFragment();

      expect(fragment).toContain('Growth Curve');
      expect(fragment).toContain('Market Map');
      expect(fragment).toContain('Avoid the patterns');
      expect(fragment).toContain('Cluttered Dashboard');
    });

    it('returns undefined with no rated designs', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));
      const fragment = await buildLearnedStyleFragment();
      expect(fragment).toBeUndefined();
    });

    it('query uses no orderBy (index-free) and sorts client-side', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));
      await buildLearnedStyleFragment();

      expect(adminMock.orderBy).not.toHaveBeenCalled();
      expect(adminMock.where).toHaveBeenCalledWith('liked', '==', true);
      expect(adminMock.where).toHaveBeenCalledWith('liked', '==', false);
      expect(adminMock.limit).toHaveBeenCalledWith(20);
    });

    it('returns undefined and logs a warning when the query throws (fail-open)', async () => {
      adminMock.get.mockRejectedValueOnce(new Error('Firestore unavailable'));
      const fragment = await buildLearnedStyleFragment();
      expect(fragment).toBeUndefined();
    });
  });
});
