/**
 * @jest-environment node
 *
 * GRAPH-066 — the two writers that still bypassed the audited placement
 * primitives.
 *
 * 1. `withPlacementParentDeletionLease` is the ONE barrier every cascade that
 *    snapshots placements before deleting them must hold. Without it a create
 *    landing between the snapshot and the parent's removal is not in the deleted
 *    set and survives as an orphan placement + orphan pair lock.
 * 2. `adminReassignPlacementQuadrant` replaces a raw `doc().update()` in the
 *    radar quadrant-rewrite path. That path runs BEFORE the radar adopts its new
 *    quadrant set, so it cannot use the ordinary update (which validates against
 *    the radar's CURRENT config) — but it must still validate the target and
 *    verify the pair lock still owns the placement.
 */
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['evt'] });
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: mockInngestSend } }));
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

const mockRunTransaction = jest.fn();
const mockLeaseSet = jest.fn().mockResolvedValue(undefined);
const mockLeaseDelete = jest.fn().mockResolvedValue(undefined);
const mockDocRef = jest.fn();

jest.mock('@/lib/firebase-admin', () => {
  const ref: Record<string, unknown> = {
    get: jest.fn(),
    doc: jest.fn((id: string) => {
      mockDocRef(id);
      return { id, get: jest.fn(), set: mockLeaseSet, update: jest.fn(), delete: mockLeaseDelete };
    }),
  };
  ref.where = jest.fn(() => ref);
  ref.limit = jest.fn(() => ref);
  return {
    db: {
      collection: jest.fn((name: string) => ({ ...ref, __collection: name })),
      runTransaction: mockRunTransaction,
      batch: jest.fn(() => ({ delete: jest.fn(), set: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) })),
      getAll: jest.fn(),
    },
  };
});

const {
  withPlacementParentDeletionLease,
  adminReassignPlacementQuadrant,
  PlacementValidationError,
  MalformedPlacementLockError,
} = require('../radar-placement-admin');
const { buildRadarPlacementPairKey } = require('../radar-placement-pair-key');
const { placementParentDeletionLeaseId } = require('../radar-placement-deletion-lease');

const PLACEMENT = {
  id: 'placement-1',
  radarId: 'radar-1',
  technologyId: 'tech-1',
  quadrantId: 'old-quadrant',
  ring: 'Trial',
};

function wireReassignTransaction(reads: unknown[]) {
  const txSet = jest.fn();
  const txUpdate = jest.fn();
  const txGet = jest.fn();
  reads.forEach((read) => txGet.mockResolvedValueOnce(read));
  mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ get: txGet, set: txSet, update: txUpdate, delete: jest.fn() })
  );
  return { txSet, txUpdate };
}

beforeEach(() => jest.clearAllMocks());

describe('withPlacementParentDeletionLease', () => {
  it('holds the barrier for the exact parent across the whole cascade', async () => {
    const observed: string[] = [];
    mockLeaseSet.mockImplementationOnce(async () => {
      observed.push('acquired');
    });
    mockLeaseDelete.mockImplementationOnce(async () => {
      observed.push('released');
    });

    const result = await withPlacementParentDeletionLease('radar', 'radar-1', async () => {
      observed.push('cascade');
      return 7;
    });

    expect(result).toBe(7);
    expect(observed).toEqual(['acquired', 'cascade', 'released']);
    expect(mockDocRef).toHaveBeenCalledWith(placementParentDeletionLeaseId('radar', 'radar-1'));
  });

  it('releases the barrier even when the cascade throws, so creates are never blocked forever', async () => {
    await expect(
      withPlacementParentDeletionLease('technology', 'tech-1', async () => {
        throw new Error('cascade exploded');
      })
    ).rejects.toThrow('cascade exploded');

    expect(mockLeaseSet).toHaveBeenCalledTimes(1);
    expect(mockLeaseDelete).toHaveBeenCalledTimes(1);
    expect(mockDocRef).toHaveBeenCalledWith(placementParentDeletionLeaseId('technology', 'tech-1'));
  });

  it('never leaves the barrier held when its own release fails', async () => {
    mockLeaseDelete.mockRejectedValueOnce(new Error('firestore unavailable'));
    await expect(withPlacementParentDeletionLease('radar', 'radar-1', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('adminReassignPlacementQuadrant', () => {
  it('refuses a target that is not in the prospective quadrant set', async () => {
    await expect(adminReassignPlacementQuadrant('placement-1', 'ghost', ['alpha', 'beta'])).rejects.toBeInstanceOf(
      PlacementValidationError
    );
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('refuses a placement that no longer exists', async () => {
    wireReassignTransaction([{ exists: false }]);
    await expect(adminReassignPlacementQuadrant('placement-1', 'alpha', ['alpha'])).rejects.toBeInstanceOf(
      PlacementValidationError
    );
  });

  it('fails closed when the pair lock points at a different placement', async () => {
    wireReassignTransaction([
      { exists: true, id: 'placement-1', data: () => PLACEMENT },
      { exists: true, data: () => ({ placementId: 'placement-other' }) },
    ]);

    await expect(adminReassignPlacementQuadrant('placement-1', 'alpha', ['alpha'])).rejects.toBeInstanceOf(
      MalformedPlacementLockError
    );
  });

  it('heals a missing pair lock in band and reassigns the quadrant', async () => {
    const { txSet, txUpdate } = wireReassignTransaction([
      { exists: true, id: 'placement-1', data: () => PLACEMENT },
      { exists: false },
    ]);

    const updated = await adminReassignPlacementQuadrant('placement-1', 'alpha', ['alpha', 'beta']);

    expect(updated.quadrantId).toBe('alpha');
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0][1]).toMatchObject({
      placementId: 'placement-1',
      radarId: 'radar-1',
      technologyId: 'tech-1',
    });
    expect(mockDocRef).toHaveBeenCalledWith(buildRadarPlacementPairKey('radar-1', 'tech-1'));
    expect(txUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quadrantId: 'alpha' }));
  });

  it('never rewrites identity fields and always hands the change to the graph', async () => {
    const { txUpdate } = wireReassignTransaction([
      { exists: true, id: 'placement-1', data: () => PLACEMENT },
      { exists: true, data: () => ({ placementId: 'placement-1' }) },
    ]);

    await adminReassignPlacementQuadrant('placement-1', 'beta', ['alpha', 'beta']);

    expect(Object.keys(txUpdate.mock.calls[0][1]).sort()).toEqual(['quadrantId', 'updatedAt']);
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/radar-placement.sync.requested',
        data: expect.objectContaining({ placementId: 'placement-1', operation: 'update' }),
      })
    );
  });
});
