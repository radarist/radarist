/**
 * @jest-environment node
 *
 * GRAPH-066 — the pair-lock create/delete transaction. One RadarPlacement per
 * (radarId, technologyId) pair, enforced by a server-owned lock read/written in
 * the same transaction as the placement. Covers: fresh create writes placement +
 * lock; exact retry resyncs the existing placement (idempotent, no new write);
 * a conflicting payload on an occupied pair is rejected; a single legacy
 * placement is adopted (lock backfilled, legacy doc id preserved); multiple
 * legacy placements halt migration; quadrant/ring are validated against the exact
 * radar; and delete removes the pair lock atomically.
 */
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['evt'] }) },
}));
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

const mockRunTransaction = jest.fn();
const mockDocGet = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchSet = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);
const mockGetAll = jest.fn();

jest.mock('@/lib/firebase-admin', () => {
  const docRef = { get: mockDocGet, set: jest.fn(), update: jest.fn(), delete: jest.fn() };
  const ref: Record<string, unknown> = { get: jest.fn(), doc: jest.fn(() => docRef) };
  ref.where = jest.fn(() => ref);
  ref.limit = jest.fn(() => ref);
  return {
    db: {
      collection: jest.fn(() => ref),
      runTransaction: mockRunTransaction,
      batch: jest.fn(() => ({ delete: mockBatchDelete, set: mockBatchSet, commit: mockBatchCommit })),
      getAll: mockGetAll,
    },
  };
});

const {
  adminCreateRadarPlacement,
  adminUpdateRadarPlacement,
  adminDeleteRadarPlacement,
  adminCascadeDeletePlacements,
  PlacementPairConflictError,
  AmbiguousLegacyPlacementError,
  PlacementValidationError,
  PlacementAuthorizationError,
  PlacementParentDeletingError,
  MalformedPlacementLockError,
} = require('../radar-placement-admin');
const { buildRadarPlacementPairKey } = require('../radar-placement-pair-key');

const RADAR = {
  id: 'radar-1',
  quadrants: [{ id: 'techniques', name: 'Techniques', order: 0 }],
  ringSystem: 'Standard',
};

const INPUT = {
  technologyId: 'tech-1',
  radarId: 'radar-1',
  quadrantId: 'techniques',
  ring: 'Trial',
  placedBy: 'user-1',
};

const docSnap = (data: unknown) => ({ exists: data !== null, id: 'placement-existing', data: () => data });
const querySnap = (docs: Array<{ id: string; data: unknown }>) => ({
  empty: docs.length === 0,
  size: docs.length,
  docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
});

/**
 * Wire the next create transaction. `reads` is the exact ordered sequence of
 * snapshots the transaction fn will pull from `tx.get`: tech, radar, lock, then
 * either the existing-placement doc (lock present) or the legacy query (no lock).
 */
function wireCreateTransaction(reads: unknown[]) {
  const txSet = jest.fn();
  const txDelete = jest.fn();
  const txGet = jest.fn();
  // #3 — the create transaction reads two parent-deletion leases (radar, then
  // technology) right after the radar read. Inject inactive leases so callers
  // keep listing only the domain reads (tech, radar, lock, existing/legacy).
  const inactiveLease = { exists: false, data: () => undefined };
  const withLeases = reads.length >= 2 ? [reads[0], reads[1], inactiveLease, inactiveLease, ...reads.slice(2)] : reads;
  withLeases.forEach((r) => txGet.mockResolvedValueOnce(r));
  mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ get: txGet, set: txSet, delete: txDelete })
  );
  return { txSet, txDelete, txGet };
}

beforeEach(() => jest.clearAllMocks());

describe('adminCreateRadarPlacement pair lock (GRAPH-066)', () => {
  it('fresh pair: writes the placement doc AND the pair lock', async () => {
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) }, // technology
      { exists: true, data: () => RADAR }, // radar
      { exists: false }, // lock absent
      querySnap([]), // no legacy placements
    ]);

    const placement = await adminCreateRadarPlacement(INPUT);

    expect(placement.technologyId).toBe('tech-1');
    // two sets: the placement doc and the pair lock.
    expect(txSet).toHaveBeenCalledTimes(2);
  });

  it('exact retry: resyncs the existing placement without a second write', async () => {
    const existing = { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' };
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      }, // lock present
      docSnap(existing), // existing placement, same position
    ]);

    const placement = await adminCreateRadarPlacement(INPUT);

    expect(placement.id).toBe('placement-existing');
    expect(txSet).not.toHaveBeenCalled(); // idempotent — no new placement, no new lock
  });

  it('conflict: a different payload on an occupied pair is rejected', async () => {
    const existing = { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Adopt' };
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      },
      docSnap(existing), // occupied with a DIFFERENT ring
    ]);

    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(PlacementPairConflictError);
  });

  it('#5 exact retry compares the FULL payload: a changed rationale/status/TRL is a conflict, not a retry', async () => {
    // Same quadrant + ring as INPUT, but a different rationale — must NOT be
    // treated as an idempotent retry.
    const existing = {
      technologyId: 'tech-1',
      radarId: 'radar-1',
      quadrantId: 'techniques',
      ring: 'Trial',
      rationale: 'old reasoning',
      status: 'New',
      trlScore: 5,
    };
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      },
      docSnap(existing),
    ]);

    await expect(
      adminCreateRadarPlacement({ ...INPUT, rationale: 'new reasoning', status: 'Stable', trlScore: 7 })
    ).rejects.toThrow(PlacementPairConflictError);
  });

  it('#5 exact retry with a byte-identical full payload still resyncs idempotently', async () => {
    const existing = {
      technologyId: 'tech-1',
      radarId: 'radar-1',
      quadrantId: 'techniques',
      ring: 'Trial',
      rationale: 'pilot underway',
      status: 'New',
      timeToImpact: 'unknown',
    };
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      },
      docSnap(existing),
    ]);

    const placement = await adminCreateRadarPlacement({
      ...INPUT,
      rationale: 'pilot underway',
      status: 'New',
    });
    expect(placement.id).toBe('placement-existing');
    expect(txSet).not.toHaveBeenCalled();
  });

  it('adopts a single legacy placement on an EXACT-retry payload: backfills the lock, preserves the legacy id', async () => {
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      { exists: false }, // no lock yet
      querySnap([
        // Matches INPUT's full canonical payload (same quadrant + ring).
        {
          id: 'legacy-placement-1',
          data: { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' },
        },
      ]),
    ]);

    const placement = await adminCreateRadarPlacement(INPUT);

    expect(placement.id).toBe('legacy-placement-1');
    // exactly one set — the lock backfill — and NO new placement doc.
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('#3 refuses to adopt a legacy placement with a DIFFERENT payload — returns a conflict', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      { exists: false },
      querySnap([
        // Same pair, but a DIFFERENT ring — must NOT be silently overwritten.
        {
          id: 'legacy-placement-1',
          data: { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Adopt' },
        },
      ]),
    ]);
    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(PlacementPairConflictError);
  });

  it('halts on multiple legacy placements for one pair (never chooses silently)', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      { exists: false },
      querySnap([
        { id: 'legacy-1', data: { technologyId: 'tech-1', radarId: 'radar-1' } },
        { id: 'legacy-2', data: { technologyId: 'tech-1', radarId: 'radar-1' } },
      ]),
    ]);

    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(AmbiguousLegacyPlacementError);
  });

  it('rejects a quadrant that is not configured on the exact radar', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
    ]);

    await expect(adminCreateRadarPlacement({ ...INPUT, quadrantId: 'not-a-quadrant' })).rejects.toThrow(
      PlacementValidationError
    );
  });

  it('rejects a ring that is not valid on the exact radar', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
    ]);

    await expect(adminCreateRadarPlacement({ ...INPUT, ring: 'Bogus' })).rejects.toThrow(PlacementValidationError);
  });
});

describe('#6 lock validation — fail closed', () => {
  it('rejects a malformed lock (body missing radarId/technologyId) instead of creating beside it', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      { exists: true, data: () => ({ placementId: 'placement-existing' }) }, // malformed: no radarId/technologyId
    ]);
    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(MalformedPlacementLockError);
  });

  it('rejects a lock that points at a placement belonging to a different pair', async () => {
    const foreign = { technologyId: 'tech-OTHER', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' };
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      },
      docSnap(foreign), // referenced placement is a DIFFERENT technology
    ]);
    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(MalformedPlacementLockError);
  });

  it('a stale lock (placement gone) adopts the single matching legacy placement, never creates beside it', async () => {
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR },
      {
        exists: true,
        data: () => ({
          placementId: 'placement-gone',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      },
      { exists: false }, // referenced placement is gone (stale lock)
      querySnap([
        {
          id: 'legacy-1',
          data: { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' },
        },
      ]), // one legacy match (exact-retry payload)
    ]);
    const placement = await adminCreateRadarPlacement(INPUT);
    expect(placement.id).toBe('legacy-1');
    expect(txSet).toHaveBeenCalledTimes(1); // only the lock backfill
  });
});

describe('#3 parent-deletion lease barrier', () => {
  it('refuses a create while the parent radar is mid-cascade (active lease)', async () => {
    const txGet = jest
      .fn()
      .mockResolvedValueOnce({ exists: true, data: () => ({ id: 'tech-1' }) }) // technology
      .mockResolvedValueOnce({ exists: true, data: () => ({ ...RADAR, createdBy: 'user-1' }) }) // radar
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ parentKind: 'radar', parentId: 'radar-1', expiresAt: 9e15 }),
      }); // ACTIVE radar lease
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: txGet, set: jest.fn(), delete: jest.fn() })
    );
    await expect(adminCreateRadarPlacement(INPUT)).rejects.toThrow(PlacementParentDeletingError);
  });
});

describe('#3 authorization — radar ownership/legacy policy', () => {
  it('rejects a create on a radar owned by a different user', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => ({ ...RADAR, createdBy: 'someone-else' }) },
    ]);
    await expect(adminCreateRadarPlacement(INPUT, { requireOwnerId: 'user-1' })).rejects.toThrow(
      PlacementAuthorizationError
    );
  });

  it('allows a create when the caller owns the radar', async () => {
    const { txSet } = wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => ({ ...RADAR, createdBy: 'user-1' }) }, // owned by caller
      { exists: false },
      querySnap([]),
    ]);
    await adminCreateRadarPlacement(INPUT, { requireOwnerId: 'user-1' });
    expect(txSet).toHaveBeenCalledTimes(2);
  });

  it('#2 denies a create on an ownerless-and-unshared radar (no blanket access)', async () => {
    wireCreateTransaction([
      { exists: true, data: () => ({ id: 'tech-1' }) },
      { exists: true, data: () => RADAR }, // ownerless, not shared
    ]);
    await expect(adminCreateRadarPlacement(INPUT, { requireOwnerId: 'user-1' })).rejects.toThrow(
      PlacementAuthorizationError
    );
  });
});

describe('#7 transactional update/move', () => {
  it('rejects a move into a ring not valid on the exact radar', async () => {
    const stored = { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' };
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txGet = jest
        .fn()
        .mockResolvedValueOnce({ exists: true, id: 'placement-1', data: () => stored }) // placement
        .mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => RADAR }); // radar
      return fn({ get: txGet, update: jest.fn(), set: jest.fn() });
    });
    await expect(adminUpdateRadarPlacement('placement-1', { ring: 'Bogus' })).rejects.toThrow(PlacementValidationError);
  });

  it('rejects an update whose pair lock points at a different placement', async () => {
    const stored = { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' };
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txGet = jest
        .fn()
        .mockResolvedValueOnce({ exists: true, id: 'placement-1', data: () => stored })
        .mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => RADAR })
        .mockResolvedValueOnce({ exists: true, data: () => ({ placementId: 'placement-OTHER' }) }); // mismatched lock
      return fn({ get: txGet, update: jest.fn(), set: jest.fn() });
    });
    await expect(adminUpdateRadarPlacement('placement-1', { ring: 'Adopt' })).rejects.toThrow(
      MalformedPlacementLockError
    );
  });

  it('#3 rejects a caller-supplied identity mutation (radarId) BEFORE any read', async () => {
    // Changing radarId via an ordinary update would rewrite the placement's radar
    // while the pair lock (keyed on the ORIGINAL radarId+technologyId) stays put —
    // silent lock/doc drift. Identity fields are not caller-supplied: reject up
    // front, before opening the transaction, and mutate nothing.
    await expect(
      adminUpdateRadarPlacement('placement-1', { radarId: 'radar-OTHER', ring: 'Adopt' } as never)
    ).rejects.toThrow(PlacementValidationError);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it.each(['technologyId', 'placedBy', 'createdAt', 'movedFrom', 'movedAt', 'id'])(
    '#3 rejects a caller-supplied %s mutation before any read',
    async (field) => {
      await expect(adminUpdateRadarPlacement('placement-1', { [field]: 'x', ring: 'Adopt' } as never)).rejects.toThrow(
        PlacementValidationError
      );
      expect(mockRunTransaction).not.toHaveBeenCalled();
    }
  );
});

describe('#8 adminCascadeDeletePlacements — lock-aware bulk delete', () => {
  it('for each placement deletes the doc + owned pair lock (CAS) AND writes a delete tombstone', async () => {
    const rows = [
      { id: 'placement-a', radarId: 'radar-1', technologyId: 'tech-a' },
      { id: 'placement-b', radarId: 'radar-1', technologyId: 'tech-b' },
    ];
    // Both locks still point at their placement → both deleted (CAS passes).
    mockGetAll.mockResolvedValueOnce([
      { exists: true, data: () => ({ placementId: 'placement-a' }) },
      { exists: true, data: () => ({ placementId: 'placement-b' }) },
    ]);

    const deleted = await adminCascadeDeletePlacements(rows);

    expect(deleted).toBe(2);
    // 2 deletes per placement (doc + lock) = 4 total.
    expect(mockBatchDelete).toHaveBeenCalledTimes(4);
    expect(mockBatchSet).toHaveBeenCalledTimes(2);
    const tombstone = mockBatchSet.mock.calls[0][1];
    expect(tombstone).toMatchObject({ operation: 'delete', status: 'pending' });
    expect(mockBatchCommit).toHaveBeenCalled();
  });

  it('#3 CAS: never deletes a lock a concurrent create already re-owned to a different placement', async () => {
    const rows = [{ id: 'placement-a', radarId: 'radar-1', technologyId: 'tech-a' }];
    // The lock now points at a DIFFERENT placement → must NOT be deleted.
    mockGetAll.mockResolvedValueOnce([{ exists: true, data: () => ({ placementId: 'placement-OTHER' }) }]);

    await adminCascadeDeletePlacements(rows);

    // Only the placement doc is deleted (1), the lock is left intact.
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an empty cascade', async () => {
    expect(await adminCascadeDeletePlacements([])).toBe(0);
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });
});

describe('adminDeleteRadarPlacement pair lock (GRAPH-066)', () => {
  it('removes the placement doc + pair lock AND writes a durable delete tombstone atomically', async () => {
    mockDocGet.mockResolvedValueOnce(docSnap({ technologyId: 'tech-1', radarId: 'radar-1' }));
    const txDelete = jest.fn();
    const txSet = jest.fn();
    const expectedPairKey = buildRadarPlacementPairKey('radar-1', 'tech-1');
    mockRunTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txGet = jest.fn().mockResolvedValueOnce({
        exists: true,
        data: () => ({
          placementId: 'placement-existing',
          radarId: 'radar-1',
          technologyId: 'tech-1',
          keyVersion: 1,
          createdAt: 1000,
        }),
      });
      return fn({ get: txGet, delete: txDelete, set: txSet });
    });

    await adminDeleteRadarPlacement('placement-existing');

    // both the placement doc and the lock doc are deleted in the transaction...
    expect(txDelete).toHaveBeenCalledTimes(2);
    // ...and the durable delete tombstone is written in the SAME transaction.
    expect(txSet).toHaveBeenCalledTimes(1);
    const tombstone = txSet.mock.calls[0][1];
    expect(tombstone).toMatchObject({
      placementId: 'placement-existing',
      pairKey: expectedPairKey,
      radarId: 'radar-1',
      technologyId: 'tech-1',
      operation: 'delete',
      status: 'pending',
    });
  });
});
