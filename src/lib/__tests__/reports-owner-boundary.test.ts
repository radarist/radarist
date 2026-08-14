/**
 * @file lib/__tests__/reports-owner-boundary.test.ts
 * @description SEC-009 — one server-side ownership boundary for reports.
 *
 * Every authenticated surface (list, exact-ID read, update, restore, version
 * listing, historical-HTML read) must resolve through an owner check that
 * returns the SAME not-found result for absent, foreign, and ownerless
 * (legacy) reports, so request IDs cannot probe another user's inventory.
 * Public share access is deliberately NOT covered here — it stays governed by
 * verified publication/share state only (see share page tests).
 */

import { createFirebaseAdminMock, fakeQuerySnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
const { transactionUpdate, subGet, subDocGet } = adminMock;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const {
  listReportsOwnedBy,
  getReportOwnedBy,
  getReportsByMissionIdOwnedBy,
  updateReport,
  restoreReportVersion,
} = require('../reports');
const { listReportVersionsOwnedBy, getReportVersionOwnedBy } = require('../reports/report-versions');

const OWNER = 'user-alice';
const OTHER = 'user-mallory';

const ownedReport = {
  id: 'report-abc-123',
  title: 'Owned Report',
  html: '<html><body><h1>Mine</h1></body></html>',
  createdAt: '2026-07-01T10:00:00.000Z',
  createdBy: 'agent',
  ownerId: OWNER,
  entityIds: [],
  metadata: { description: 'mine', dataSnapshotAt: '2026-07-01T10:00:00Z' },
  shared: false,
};

const ownerlessReport = { ...ownedReport, id: 'report-legacy-1', ownerId: undefined };

function mockDocRead(data: Record<string, unknown> | null, id = 'report-abc-123') {
  adminMock.docGet.mockResolvedValue({
    exists: data !== null,
    id,
    data: () => data,
    ref: { collection: adminMock.subCollection },
  });
}

describe('SEC-009 owner boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // listReportsOwnedBy
  // --------------------------------------------------------------------------
  describe('listReportsOwnedBy', () => {
    it('filters by ownerId server-side and strips html bodies', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([ownedReport]));

      const result = await listReportsOwnedBy(OWNER);

      expect(adminMock.where).toHaveBeenCalledWith('ownerId', '==', OWNER);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('report-abc-123');
      expect(result[0]).not.toHaveProperty('html');
      expect(result[0]).not.toHaveProperty('previousHtml');
    });

    it('returns [] for an empty ownerId without querying', async () => {
      const result = await listReportsOwnedBy('');
      expect(result).toEqual([]);
      expect(adminMock.get).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getReportOwnedBy — absent, foreign, and ownerless are indistinguishable
  // --------------------------------------------------------------------------
  describe('getReportOwnedBy', () => {
    it('returns the report for its owner', async () => {
      mockDocRead(ownedReport);
      const result = await getReportOwnedBy('report-abc-123', OWNER);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('report-abc-123');
      expect(result?.html).toContain('Mine');
    });

    it('returns null for an absent report', async () => {
      mockDocRead(null);
      await expect(getReportOwnedBy('report-nope', OWNER)).resolves.toBeNull();
    });

    it('returns null for a foreign report (no existence leak)', async () => {
      mockDocRead(ownedReport);
      await expect(getReportOwnedBy('report-abc-123', OTHER)).resolves.toBeNull();
    });

    it('returns null for an ownerless legacy report (deny until migrated)', async () => {
      mockDocRead(ownerlessReport, 'report-legacy-1');
      await expect(getReportOwnedBy('report-legacy-1', OWNER)).resolves.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getReportsByMissionIdOwnedBy — owner-scoped, error-propagating, ordered
  // --------------------------------------------------------------------------
  describe('getReportsByMissionIdOwnedBy', () => {
    const MISSION = 'mission-42';

    it('scopes the query by BOTH missionId and ownerId (no foreign body download)', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([ownedReport]));

      const result = await getReportsByMissionIdOwnedBy(MISSION, OWNER);

      // Both equality predicates are pushed into Firestore — a foreign owner's
      // report bodies are never read/downloaded, then filtered client-side.
      expect(adminMock.where).toHaveBeenCalledWith('missionId', '==', MISSION);
      expect(adminMock.where).toHaveBeenCalledWith('ownerId', '==', OWNER);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('report-abc-123');
      // Full body is retained (mission-recovery callers need the html).
      expect(result[0].html).toContain('Mine');
    });

    it('excludes a foreign report defensively even if the query returns one', async () => {
      // Simulate a mis-scoped query result — the in-memory isOwnedBy check must
      // still drop it, so the owner predicate is a real second boundary.
      const foreign = { ...ownedReport, id: 'report-foreign', ownerId: OTHER };
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([foreign]));

      await expect(getReportsByMissionIdOwnedBy(MISSION, OWNER)).resolves.toEqual([]);
    });

    it('excludes an ownerless legacy report defensively (deny until migrated)', async () => {
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([{ ...ownerlessReport, missionId: MISSION }]));

      await expect(getReportsByMissionIdOwnedBy(MISSION, OWNER)).resolves.toEqual([]);
    });

    it('returns [] for a blank ownerId without querying (fail closed)', async () => {
      expect(await getReportsByMissionIdOwnedBy(MISSION, '')).toEqual([]);
      expect(await getReportsByMissionIdOwnedBy(MISSION, '   ')).toEqual([]);
      expect(adminMock.get).not.toHaveBeenCalled();
    });

    it('returns [] for a blank missionId without querying (fail closed)', async () => {
      expect(await getReportsByMissionIdOwnedBy('', OWNER)).toEqual([]);
      expect(await getReportsByMissionIdOwnedBy('   ', OWNER)).toEqual([]);
      expect(adminMock.get).not.toHaveBeenCalled();
    });

    it('propagates a storage/query failure instead of returning []', async () => {
      adminMock.get.mockRejectedValue(new Error('firestore unavailable'));

      await expect(getReportsByMissionIdOwnedBy(MISSION, OWNER)).rejects.toThrow('firestore unavailable');
    });

    it('orders owned reports newest-first with a deterministic id tiebreaker', async () => {
      const older = { ...ownedReport, id: 'report-a', createdAt: '2026-07-01T09:00:00.000Z' };
      const newer = { ...ownedReport, id: 'report-b', createdAt: '2026-07-02T09:00:00.000Z' };
      // Same timestamp as `newer` → id decides the order, deterministically.
      const tie = { ...ownedReport, id: 'report-c', createdAt: '2026-07-02T09:00:00.000Z' };
      adminMock.get.mockResolvedValue(fakeQuerySnapshot([older, tie, newer]));

      const result = await getReportsByMissionIdOwnedBy(MISSION, OWNER);

      expect(result.map((r: { id: string }) => r.id)).toEqual(['report-b', 'report-c', 'report-a']);
    });
  });

  // --------------------------------------------------------------------------
  // updateReport with requireOwnerId — enforced inside the transaction
  // --------------------------------------------------------------------------
  describe('updateReport requireOwnerId', () => {
    it('rejects a foreign caller with the same error as not-found and writes nothing', async () => {
      mockDocRead(ownedReport);
      await expect(updateReport('report-abc-123', { title: 'Stolen' }, { requireOwnerId: OTHER })).rejects.toThrow(
        'Report not found'
      );
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('rejects an ownerless legacy report with the same error', async () => {
      mockDocRead(ownerlessReport, 'report-legacy-1');
      await expect(updateReport('report-legacy-1', { title: 'Claimed' }, { requireOwnerId: OWNER })).rejects.toThrow(
        'Report not found'
      );
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('allows the owner on repeated calls (no first-write-only gate)', async () => {
      mockDocRead(ownedReport);
      subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

      const first = await updateReport('report-abc-123', { title: 'Renamed' }, { requireOwnerId: OWNER });
      const second = await updateReport('report-abc-123', { title: 'Renamed' }, { requireOwnerId: OWNER });

      expect(first.title).toBe('Renamed');
      expect(second.title).toBe('Renamed');
      expect(transactionUpdate).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // restoreReportVersion with requireOwnerId
  // --------------------------------------------------------------------------
  describe('restoreReportVersion requireOwnerId', () => {
    it('rejects a foreign caller with the same error as not-found', async () => {
      mockDocRead({ ...ownedReport, previousHtml: '<html><body>old</body></html>' });
      await expect(restoreReportVersion('report-abc-123', { requireOwnerId: OTHER })).rejects.toThrow(
        'Report not found'
      );
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('allows the owner to restore the previous version', async () => {
      mockDocRead({ ...ownedReport, previousHtml: '<html><body>old</body></html>' });
      subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

      const restored = await restoreReportVersion('report-abc-123', { requireOwnerId: OWNER });
      expect(restored.html).toBe('<html><body>old</body></html>');
    });
  });

  // --------------------------------------------------------------------------
  // Version history — owner preflight on the parent report
  // --------------------------------------------------------------------------
  describe('listReportVersionsOwnedBy', () => {
    it('throws Report not found for a foreign parent report', async () => {
      mockDocRead(ownedReport);
      await expect(listReportVersionsOwnedBy('report-abc-123', OTHER)).rejects.toThrow('Report not found');
      expect(subGet).not.toHaveBeenCalled();
    });

    it('throws Report not found for an absent parent report', async () => {
      mockDocRead(null);
      await expect(listReportVersionsOwnedBy('report-nope', OWNER)).rejects.toThrow('Report not found');
    });

    it('throws Report not found for an ownerless parent report', async () => {
      mockDocRead(ownerlessReport, 'report-legacy-1');
      await expect(listReportVersionsOwnedBy('report-legacy-1', OWNER)).rejects.toThrow('Report not found');
    });

    it('lists version summaries for the owner', async () => {
      mockDocRead(ownedReport);
      subGet.mockResolvedValue(
        fakeQuerySnapshot([
          { id: 'ver-2', versionNumber: 2, createdAt: '2026-07-02T00:00:00Z', savedBy: 'user:u', htmlLength: 10 },
        ])
      );

      const versions = await listReportVersionsOwnedBy('report-abc-123', OWNER);
      expect(versions).toHaveLength(1);
      expect(versions[0].versionId).toBe('ver-2');
      expect(versions[0]).not.toHaveProperty('html');
    });
  });

  describe('getReportVersionOwnedBy', () => {
    it('returns null for a foreign parent report (no historical-HTML leak)', async () => {
      mockDocRead(ownedReport);
      await expect(getReportVersionOwnedBy('report-abc-123', 'ver-1', OTHER)).resolves.toBeNull();
      expect(subDocGet).not.toHaveBeenCalled();
    });

    it('returns null for an ownerless parent report', async () => {
      mockDocRead(ownerlessReport, 'report-legacy-1');
      await expect(getReportVersionOwnedBy('report-legacy-1', 'ver-1', OWNER)).resolves.toBeNull();
    });

    it('returns the full version (with html) for the owner', async () => {
      mockDocRead(ownedReport);
      subDocGet.mockResolvedValue({
        exists: true,
        id: 'ver-1',
        data: () => ({
          versionNumber: 1,
          html: '<html><body>v1</body></html>',
          htmlLength: 28,
          createdAt: '2026-07-01T00:00:00Z',
          savedBy: 'user:u',
        }),
      });

      const version = await getReportVersionOwnedBy('report-abc-123', 'ver-1', OWNER);
      expect(version?.versionId).toBe('ver-1');
      expect(version?.html).toContain('v1');
    });

    it('returns null when the version itself is missing', async () => {
      mockDocRead(ownedReport);
      subDocGet.mockResolvedValue({ exists: false, data: () => null });
      await expect(getReportVersionOwnedBy('report-abc-123', 'ver-404', OWNER)).resolves.toBeNull();
    });
  });
});

// ============================================================================
// Bounded reads — the chat catalog must not pull the whole collection
// ============================================================================

describe('listReportsOwnedBy limit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes the caller-supplied bound into the Firestore query', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([ownedReport]));

    await listReportsOwnedBy(OWNER, { limit: 10 });

    expect(adminMock.where).toHaveBeenCalledWith('ownerId', '==', OWNER);
    expect(adminMock.limit).toHaveBeenCalledWith(10);
  });

  it('reads without a bound when none is requested (the /reports catalog)', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([ownedReport]));

    await listReportsOwnedBy(OWNER);

    expect(adminMock.limit).not.toHaveBeenCalled();
  });
});
