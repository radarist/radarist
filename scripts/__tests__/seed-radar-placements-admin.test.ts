/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('firebase/firestore', () => {
  throw new Error('Admin-only RadarPlacement seed helper imported firebase/firestore');
});

const {
  clearServerOwnedRadarPlacementCollection,
  RADAR_PLACEMENT_COLLECTION,
  SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS,
  seedRadarPlacementsWithAdmin,
} = require('../lib/seed-radar-placements-admin') as typeof import('../lib/seed-radar-placements-admin');

describe('Admin-only RadarPlacement demo seed boundary', () => {
  it('loads without importing the Firebase Web SDK', () => {
    expect(RADAR_PLACEMENT_COLLECTION).toBe('radarPlacements');
    expect(SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS).toEqual([
      'radarPlacements',
      'radarPlacementPairs',
      'radarPlacementDeleteOutbox',
      'placementParentDeletionLeases',
    ]);
  });

  it('writes deterministic placements and pair locks in one Admin batch', async () => {
    const set = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    const db = {
      batch: jest.fn(() => ({ set, commit })),
      collection: jest.fn((collectionName: string) => ({
        doc: jest.fn((id: string) => ({ path: `${collectionName}/${id}` })),
      })),
    };
    const placements = [
      { id: 'p-1', radarId: 'r-1', technologyId: 't-1', ring: 'Trial' },
      { id: 'p-2', radarId: 'r-1', technologyId: 't-2', ring: 'Adopt' },
    ];

    await seedRadarPlacementsWithAdmin(db as never, placements, 1234);

    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(4);
    const writtenPaths = set.mock.calls.map(([ref]) => ref.path);
    expect(writtenPaths).toContain('radarPlacements/p-1');
    expect(writtenPaths).toContain('radarPlacements/p-2');
    expect(writtenPaths.filter((path) => path.startsWith('radarPlacementPairs/'))).toHaveLength(2);
    for (const [, value] of set.mock.calls.filter(([ref]) => ref.path.startsWith('radarPlacementPairs/'))) {
      expect(value).toMatchObject({ keyVersion: 1, createdAt: 1234 });
    }
  });

  it('clears protected state with an Admin batch and reports the count', async () => {
    const refs = [{ path: 'radarPlacements/p-1' }, { path: 'radarPlacements/p-2' }];
    const deleteDocument = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    const db = {
      collection: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ empty: false, size: refs.length, docs: refs.map((ref) => ({ ref })) }),
      })),
      batch: jest.fn(() => ({ delete: deleteDocument, commit })),
    };

    const count = await clearServerOwnedRadarPlacementCollection(db as never, 'radarPlacements');

    expect(count).toBe(2);
    expect(deleteDocument.mock.calls.map(([ref]) => ref.path)).toEqual([
      'radarPlacements/p-1',
      'radarPlacements/p-2',
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not create an Admin batch when the protected collection is empty', async () => {
    const db = {
      collection: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ empty: true, size: 0, docs: [] }),
      })),
      batch: jest.fn(),
    };

    await expect(
      clearServerOwnedRadarPlacementCollection(db as never, 'radarPlacementDeleteOutbox')
    ).resolves.toBe(0);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('chunks collection cleanup at the Firestore batch-write limit', async () => {
    const refs = Array.from({ length: 501 }, (_, index) => ({ path: `radarPlacements/p-${index}` }));
    const batches: Array<{ delete: jest.Mock; commit: jest.Mock }> = [];
    const db = {
      collection: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ empty: false, size: refs.length, docs: refs.map((ref) => ({ ref })) }),
      })),
      batch: jest.fn(() => {
        const batch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
        batches.push(batch);
        return batch;
      }),
    };

    await expect(
      clearServerOwnedRadarPlacementCollection(db as never, 'radarPlacements')
    ).resolves.toBe(501);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.delete).toHaveBeenCalledTimes(500);
    expect(batches[1]?.delete).toHaveBeenCalledTimes(1);
    expect(batches.every((batch) => batch.commit.mock.calls.length === 1)).toBe(true);
  });
});
