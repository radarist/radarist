/**
 * @file radars-admin.test.ts
 * @description Locks the admin-SDK helpers the AI assistant uses for
 * listRadars + deleteRadar. The shape of `summarizeRadar` is part of
 * the contract the `/api/ai/chat` route returns to the model — drift
 * here means the model sees a different payload than the system
 * prompt examples promise.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock, fakeQuerySnapshot } from './helpers/firebase-admin-mock';
import type { QuadrantConfig } from '@/lib/types';

// Poison client-only modules: importing this admin service must never resolve
// the browser entity factory or Firebase client SDK, including transitively.
jest.mock('@/lib/entity-factory', () => {
  throw new Error('radars-admin must not import the Firebase client entity factory');
});
jest.mock('@/lib/firebase', () => {
  throw new Error('radars-admin must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('radars-admin must not import firebase/firestore');
});

const { adminMock } = createFirebaseAdminMock();
// The shared admin mock doesn't expose `db.batch()` (most callers
// don't need it). Patch the cascade-delete surface for this test
// specifically — production uses chunked batches to stay under the
// 500-write Firestore admin limit.
const batchDelete = jest.fn();
const batchSet = jest.fn();
const batchCommit = jest.fn().mockResolvedValue(undefined);
(adminMock.db as unknown as { batch: () => unknown }).batch = jest.fn(() => ({
  delete: batchDelete,
  set: batchSet,
  commit: batchCommit,
}));
// GRAPH-066 #3 — the cascade pre-reads pair locks (CAS). Default: not owning, so
// locks aren't deleted here; the lock-CAS delete is unit-tested in the pairlock suite.
(adminMock.db as unknown as { getAll: (...refs: unknown[]) => Promise<unknown[]> }).getAll = jest.fn(
  async (...refs: unknown[]) => refs.map(() => ({ exists: false, data: () => undefined }))
);
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockDeleteRelationsForEntity = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: mockDeleteRelationsForEntity,
}));

const mockProjectionSend = jest.fn();
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: mockProjectionSend },
}));

const mockRequestRadarGraphDeletion = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/radar-deletion-sync', () => ({
  requestRadarGraphDeletion: mockRequestRadarGraphDeletion,
}));

// GRAPH-066 #3 — radar deletion must hold the parent-deletion barrier across its
// snapshot→delete window, or a create landing in that window survives as an
// orphan. Record the wrapper's use while keeping the REAL lock-aware cascade
// underneath, so every existing lock/batch assertion still exercises production
// code (and the lease's own Firestore writes stay out of the shared doc mock).
const leaseEvents: string[] = [];
jest.mock('@/lib/radar-placement-admin', () => {
  const actual = jest.requireActual('@/lib/radar-placement-admin');
  return {
    ...actual,
    withPlacementParentDeletionLease: jest.fn(async (kind: string, parentId: string, run: () => Promise<unknown>) => {
      leaseEvents.push(`acquire:${kind}:${parentId}`);
      try {
        return await run();
      } finally {
        leaseEvents.push(`release:${kind}:${parentId}`);
      }
    }),
  };
});

// Lazy-load the module under test so its `import { db } from
// '@/lib/firebase-admin'` resolves AFTER `adminMock` is initialised.
// An ESM `import` at the top of the file gets hoisted alongside
// `jest.mock` and reaches the factory before line 14 has run.
const {
  adminListRadars,
  adminDeleteRadar,
  adminCreateRadar,
  adminUpdateRadar,
  adminSearchTechnologies,
  summarizeRadar,
} = require('../radars-admin');
const { createRadarProjectionEvent } = require('../radar-projection-sync');

// GRAPH-060 #2 — the user-facing mutation primitives now REQUIRE an owner and
// always enforce it. `OWNER` is the authenticated caller these tests act as; the
// owner check reads the radar doc (one extra `docGet`) and passes only when its
// `createdBy` matches. `ownerDocOnce()` queues that owner-read.
const OWNER = 'owner-1';
const ownerDocOnce = (id = 'radar-1') =>
  adminMock.docGet.mockResolvedValueOnce({ exists: true, id, data: () => ({ createdBy: OWNER }) });

describe('radars-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    leaseEvents.length = 0;
    adminMock.get.mockReset().mockResolvedValue(fakeQuerySnapshot([]));
    adminMock.delete.mockReset().mockResolvedValue(undefined);
    batchCommit.mockReset().mockResolvedValue(undefined);
    mockRequestRadarGraphDeletion.mockReset().mockResolvedValue(undefined);
    mockDeleteRelationsForEntity.mockReset().mockResolvedValue(0);
    mockProjectionSend.mockResolvedValue({ ids: ['radar-event'] });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('admin Radar projection handoff', () => {
    it('dispatches exactly one versioned projection after create commits', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));

      const radar = await adminCreateRadar('user-1', 'Assistant Radar', 'Created without placements', [
        { id: 'q1', name: 'Now', order: 0, description: undefined },
      ]);

      expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
      const written = adminMock.transactionSet.mock.calls[0][1] as { quadrants: QuadrantConfig[] };
      expect(written.quadrants).toEqual([{ id: 'q1', name: 'Now', order: 0 }]);
      expect(Object.prototype.hasOwnProperty.call(written.quadrants[0], 'description')).toBe(false);
      expect(mockProjectionSend).toHaveBeenCalledTimes(1);
      expect(mockProjectionSend).toHaveBeenCalledWith(createRadarProjectionEvent(radar));
    });

    it('#1 requires an ownerId and persists it as createdBy so the creator owns the radar', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));

      const radar = await adminCreateRadar('user-1', 'Owned Radar', undefined, [{ id: 'q1', name: 'Now', order: 0 }]);

      expect(radar.createdBy).toBe('user-1');
      expect(adminMock.transactionSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ createdBy: 'user-1' })
      );
    });

    it('#1 rejects a create with no authenticated owner (empty ownerId fails closed)', async () => {
      await expect(adminCreateRadar('', 'Ownerless Radar')).rejects.toThrow(/owner/i);
      expect(adminMock.transactionSet).not.toHaveBeenCalled();
    });

    it('dispatches exactly one newer projection after an Admin update commits', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(2_000);
      const current = {
        id: 'radar-1',
        name: 'Before',
        slug: 'before',
        description: '',
        quadrants: [{ id: 'q1', name: 'Now', order: 0 }],
        entries: [],
        createdAt: 1_000,
        updatedAt: 2_000,
      };
      ownerDocOnce();
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => current });

      const result = await adminUpdateRadar('radar-1', OWNER, { name: 'After' });

      expect(adminMock.transactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: 'After',
          slug: 'after',
          updatedAt: 2_001,
        })
      );
      expect(mockProjectionSend).toHaveBeenCalledTimes(1);
      expect(mockProjectionSend).toHaveBeenCalledWith(createRadarProjectionEvent(result));
    });

    it('commits a seven-quadrant update without nested undefined and dispatches its exact projection once', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(2_000);
      const current = {
        id: 'radar-1',
        name: 'Radar',
        slug: 'radar',
        quadrants: [{ id: 'q1', name: 'Now', order: 0 }],
        entries: [],
        createdAt: 1_000,
        updatedAt: 2_000,
      };
      ownerDocOnce();
      adminMock.docGet
        .mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => current })
        .mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => current });
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
      const quadrants = Array.from({ length: 7 }, (_, index) => ({
        id: `q${index + 1}`,
        name: `Quadrant ${index + 1}`,
        order: index,
        description: undefined,
      }));

      const result = await adminUpdateRadar('radar-1', OWNER, { quadrants });

      expect(adminMock.transactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          quadrants: quadrants.map(({ id, name, order }) => ({ id, name, order })),
          updatedAt: 2_001,
        })
      );
      const written = adminMock.transactionUpdate.mock.calls[0][1] as { quadrants: QuadrantConfig[] };
      expect(written.quadrants.every((config) => !Object.prototype.hasOwnProperty.call(config, 'description'))).toBe(
        true
      );
      expect(mockProjectionSend).toHaveBeenCalledTimes(1);
      expect(mockProjectionSend).toHaveBeenCalledWith(createRadarProjectionEvent(result));
    });

    it('allocates distinct revisions for consecutive same-millisecond updates', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(2_000);
      const initial = {
        id: 'radar-1',
        name: 'Radar',
        slug: 'radar',
        quadrants: [],
        entries: [],
        createdAt: 1_000,
        updatedAt: 2_000,
      };
      const afterFirst = { ...initial, description: 'First', updatedAt: 2_001 };
      // Each update runs an owner check (docGet) then a commit read (docGet).
      ownerDocOnce();
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => initial });
      ownerDocOnce();
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => afterFirst });

      await adminUpdateRadar('radar-1', OWNER, { description: 'First' });
      await adminUpdateRadar('radar-1', OWNER, { description: 'Second' });

      expect(adminMock.transactionUpdate.mock.calls.map((call) => call[1].updatedAt)).toEqual([2_001, 2_002]);
      const sentIds = mockProjectionSend.mock.calls.map(([event]) => event.id);
      expect(new Set(sentIds).size).toBe(2);
    });

    it('fails honestly after the Firestore create commit when dispatch is not acknowledged', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(3_000);
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
      mockProjectionSend.mockRejectedValueOnce(new Error('acknowledgement lost'));

      await expect(adminCreateRadar('user-1', 'Ambiguous Radar')).rejects.toThrow(
        /saved in Firestore.*not acknowledged.*Do not recreate.*reconciliation/i
      );

      expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
      expect(mockProjectionSend).toHaveBeenCalledTimes(1);
    });

    it('fails honestly after the Firestore update commit when dispatch is not acknowledged', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(4_000);
      const current = {
        id: 'radar-1',
        name: 'Before',
        slug: 'before',
        quadrants: [{ id: 'q1', name: 'Now', order: 0 }],
        entries: [],
        createdAt: 1_000,
        updatedAt: 3_000,
      };
      ownerDocOnce();
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => current });
      mockProjectionSend.mockRejectedValueOnce(new Error('Inngest unavailable'));

      await expect(adminUpdateRadar('radar-1', OWNER, { description: 'Committed' })).rejects.toThrow(
        /saved in Firestore.*not acknowledged.*reconciliation/i
      );

      expect(adminMock.transactionUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ description: 'Committed', updatedAt: 4_000 })
      );
      expect(mockProjectionSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('#2 owner-only admin authorization (required, never optional)', () => {
    const { RadarAuthorizationError } = require('../radars-admin');

    it('adminDeleteRadar rejects a non-owner and deletes nothing', async () => {
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => ({ createdBy: 'alice' }) });

      await expect(adminDeleteRadar('radar-1', 'bob', { cascade: true })).rejects.toBeInstanceOf(
        RadarAuthorizationError
      );
      expect(adminMock.delete).not.toHaveBeenCalled();
      expect(mockRequestRadarGraphDeletion).not.toHaveBeenCalled();
    });

    it('adminDeleteRadar allows the owner', async () => {
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => ({ createdBy: 'alice' }) });
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([])); // no placements

      await expect(adminDeleteRadar('radar-1', 'alice', { cascade: true })).resolves.toEqual({
        placementsDeleted: 0,
      });
      expect(adminMock.delete).toHaveBeenCalledTimes(1);
      // The whole snapshot→delete window runs inside the parent-deletion barrier.
      expect(leaseEvents).toEqual(['acquire:radar:radar-1', 'release:radar:radar-1']);
    });

    it('adminDeleteRadar releases the parent-deletion barrier even when the cascade fails', async () => {
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => ({ createdBy: 'alice' }) });
      adminMock.get.mockRejectedValueOnce(new Error('placement snapshot unavailable'));

      await expect(adminDeleteRadar('radar-1', 'alice', { cascade: true })).rejects.toThrow(
        'placement snapshot unavailable'
      );
      expect(leaseEvents).toEqual(['acquire:radar:radar-1', 'release:radar:radar-1']);
    });

    it('adminDeleteRadar rejects a missing radar (never deletable by id alone)', async () => {
      adminMock.docGet.mockResolvedValueOnce({ exists: false, id: 'gone', data: () => undefined });

      await expect(adminDeleteRadar('gone', 'bob', { cascade: true })).rejects.toBeInstanceOf(RadarAuthorizationError);
      expect(adminMock.delete).not.toHaveBeenCalled();
    });

    it('adminDeleteRadar with an empty/absent owner fails closed BEFORE any read', async () => {
      await expect(adminDeleteRadar('radar-1', '', { cascade: true })).rejects.toBeInstanceOf(RadarAuthorizationError);
      // No owner read, no placement read, no delete — refused before touching Firestore.
      expect(adminMock.docGet).not.toHaveBeenCalled();
      expect(adminMock.get).not.toHaveBeenCalled();
      expect(adminMock.delete).not.toHaveBeenCalled();
    });

    it('adminUpdateRadar rejects a non-owner and commits nothing', async () => {
      adminMock.docGet.mockResolvedValueOnce({ exists: true, id: 'radar-1', data: () => ({ createdBy: 'alice' }) });

      await expect(adminUpdateRadar('radar-1', 'bob', { description: 'Hijack' })).rejects.toBeInstanceOf(
        RadarAuthorizationError
      );
      expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
    });

    it('adminUpdateRadar with an empty/absent owner fails closed BEFORE any read', async () => {
      await expect(adminUpdateRadar('radar-1', '', { description: 'Anon' })).rejects.toBeInstanceOf(
        RadarAuthorizationError
      );
      expect(adminMock.docGet).not.toHaveBeenCalled();
      expect(adminMock.transactionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('adminListRadars', () => {
    it('projects each doc id onto the doc data', async () => {
      adminMock.get.mockResolvedValue(
        fakeQuerySnapshot([
          { id: 'r1', name: 'AI Radar', quadrants: [{ id: 'q1', name: 'Q1', order: 0 }] },
          { id: 'r2', name: 'Frontend', quadrants: [] },
        ])
      );

      const radars = await adminListRadars();
      expect(radars).toHaveLength(2);
      expect(radars[0].id).toBe('r1');
      expect(radars[1].name).toBe('Frontend');
    });
  });

  describe('adminSearchTechnologies', () => {
    it('filters the complete collection before limiting exact search results', async () => {
      const targetName = 'FINAL-QA-20260715 Gate-Based Superconducting Qubits';
      adminMock.get.mockResolvedValueOnce(
        fakeQuerySnapshot([
          ...Array.from({ length: 200 }, (_, index) => ({
            id: `tech-old-${String(index).padStart(3, '0')}`,
            name: `Unrelated technology ${index}`,
            description: 'Existing library record',
            tags: [],
          })),
          {
            id: 'tech-new-marker',
            name: targetName,
            description: 'Retained synthetic marker technology',
            tags: ['quantum'],
          },
        ])
      );

      const results = await adminSearchTechnologies({ search: targetName, limit: 1 });

      expect(results).toEqual([expect.objectContaining({ id: 'tech-new-marker', name: targetName })]);
      expect(adminMock.limit).not.toHaveBeenCalled();
    });
  });

  describe('adminDeleteRadar', () => {
    it('deletes the radar doc when cascade is disabled', async () => {
      ownerDocOnce('r1');
      await adminDeleteRadar('r1', OWNER, { cascade: false });
      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledWith('r1', false);
      expect(adminMock.delete).toHaveBeenCalledTimes(1);
    });

    it('refuses non-cascade deletion when Firestore still has placements', async () => {
      ownerDocOnce('r1');
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([{ id: 'p1', radarId: 'r1' }]));

      await expect(adminDeleteRadar('r1', OWNER, { cascade: false })).rejects.toThrow(
        'Cannot delete radar r1 without cascading: 1 placement(s) still reference it'
      );

      expect(mockRequestRadarGraphDeletion).not.toHaveBeenCalled();
      expect(adminMock.delete).not.toHaveBeenCalled();
    });

    it('cascades placements (lock-aware) before deleting the radar doc', async () => {
      // Two placements on this radar — the lock-aware cascade removes each
      // placement doc AND its pair lock AND writes a delete tombstone, then the
      // radar doc is deleted directly.
      adminMock.get.mockResolvedValueOnce(
        fakeQuerySnapshot([
          { id: 'p1', radarId: 'r1', technologyId: 't1' },
          { id: 'p2', radarId: 'r1', technologyId: 't2' },
        ])
      );

      ownerDocOnce('r1');
      const result = await adminDeleteRadar('r1', OWNER);
      expect(result.placementsDeleted).toBe(2);
      // Relations cleaned once (prepareEntityDeletions); the cascade skips a
      // redundant relation pass.
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledTimes(2);
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledWith('p1');
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledWith('p2');
      // GRAPH-066 #8 — the placement docs are deleted (2) and a delete tombstone
      // is written per placement (2 sets) in one committed batch. Pair-lock
      // deletion is CAS-gated (locks not owned in this mock) — covered by the
      // pairlock suite's owning/non-owning cases.
      expect(batchDelete).toHaveBeenCalledTimes(2);
      expect(batchSet).toHaveBeenCalledTimes(2);
      expect(batchCommit).toHaveBeenCalledTimes(1);
      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledWith('r1', true);
      expect(adminMock.delete).toHaveBeenCalledTimes(1);
    });

    it('retains all placements and the radar when any placement relation cleanup fails', async () => {
      adminMock.get.mockResolvedValueOnce(
        fakeQuerySnapshot([
          { id: 'p1', radarId: 'r1' },
          { id: 'p2', radarId: 'r1' },
        ])
      );
      mockDeleteRelationsForEntity.mockImplementation(async (id: string) => {
        if (id === 'p2') throw new Error('relation cleanup unavailable');
        return 1;
      });

      ownerDocOnce('r1');
      await expect(adminDeleteRadar('r1', OWNER)).rejects.toThrow(
        'Cannot delete radar r1: relation cleanup failed for placement(s) p2'
      );

      expect(batchDelete).not.toHaveBeenCalled();
      expect(batchCommit).not.toHaveBeenCalled();
      expect(mockRequestRadarGraphDeletion).not.toHaveBeenCalled();
      expect(adminMock.delete).not.toHaveBeenCalled();
    });

    it('retains the radar document when graph dispatch fails after a placement batch commits', async () => {
      ownerDocOnce('r1');
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([{ id: 'p1', radarId: 'r1' }]));
      mockRequestRadarGraphDeletion.mockRejectedValueOnce(new Error('Inngest unavailable'));

      await expect(adminDeleteRadar('r1', OWNER)).rejects.toThrow('Inngest unavailable');

      expect(batchCommit).toHaveBeenCalledTimes(1);
      expect(adminMock.delete).not.toHaveBeenCalled();
    });

    it('converges on retry when dispatch succeeds but the final radar delete fails', async () => {
      ownerDocOnce('r1');
      ownerDocOnce('r1');
      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([])).mockResolvedValueOnce(fakeQuerySnapshot([]));
      adminMock.delete.mockRejectedValueOnce(new Error('Firestore unavailable')).mockResolvedValueOnce(undefined);

      await expect(adminDeleteRadar('r1', OWNER)).rejects.toThrow('Firestore unavailable');
      await expect(adminDeleteRadar('r1', OWNER)).resolves.toEqual({ placementsDeleted: 0 });

      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledTimes(2);
      expect(adminMock.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('summarizeRadar', () => {
    it('returns id/name/description/ringSystem/quadrants without stats', async () => {
      const out = summarizeRadar({
        id: 'r1',
        name: 'AI Radar',
        description: 'desc',
        ringSystem: 'TRL',
        quadrants: [{ id: 'q1', name: 'Q1', order: 0 }],
      } as Parameters<typeof summarizeRadar>[0]);

      expect(out).toEqual({
        id: 'r1',
        name: 'AI Radar',
        description: 'desc',
        ringSystem: 'TRL',
        quadrants: [{ id: 'q1', name: 'Q1', order: 0 }],
      });
    });

    it('always emits description ("") and ringSystem ("Standard") when the doc omits them', async () => {
      // The company-wide radar has no description field — before this
      // defaulting, JSON.stringify dropped the key and external MCP
      // clients saw an inconsistent shape across radars.
      const out = summarizeRadar({
        id: 'r-company',
        name: 'Company Radar',
        quadrants: [],
      } as unknown as Parameters<typeof summarizeRadar>[0]);

      expect(out.description).toBe('');
      expect(out.ringSystem).toBe('Standard');
      expect(Object.keys(out)).toEqual(expect.arrayContaining(['description', 'ringSystem']));
    });

    it('coerces string-quadrants into the structured shape', async () => {
      const out = summarizeRadar({
        id: 'r1',
        name: 'Legacy',
        quadrants: ['Q1', 'Q2'],
      } as unknown as Parameters<typeof summarizeRadar>[0]);

      expect(out.quadrants).toEqual([
        { id: '', name: 'Q1', order: 0 },
        { id: '', name: 'Q2', order: 0 },
      ]);
    });
  });
});
