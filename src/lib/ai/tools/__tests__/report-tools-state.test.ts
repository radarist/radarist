/**
 * @file report-tools-state.test.ts
 * @description REPORT-002 — Assistant-facing lifecycle-state discipline.
 *
 * The chat tools must let the Assistant distinguish generated, draft
 * (needs-review), published-private, and shared reports — and must emit a
 * public /share/report/{id} URL ONLY when the persisted document verifiably
 * carries shared:true on a non-draft report. A share request against a
 * needs-review draft is refused with the repair path.
 *
 * @jest-environment node
 */

export {};

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({ __esModule: true }));
jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: (s: string) => s,
  sanitizeReportHtml: (s: string) => s,
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/reports', () => {
  const actual = jest.requireActual('@/lib/reports');
  return {
    __esModule: true,
    upsertReportBySlot: jest.fn(),
    updateReport: jest.fn(),
    restoreReportVersion: jest.fn(),
    getReportOwnedBy: jest.fn(),
    listReportsOwnedBy: jest.fn(),
    // The real derivation — the discipline under test rides on it.
    reportLifecycleState: actual.reportLifecycleState,
  };
});
jest.mock('@/lib/firebase-admin', () => ({ __esModule: true, db: {} }));

const { executeListReports, executeGetReportById, executeUpdateReport } = require('../report-tools');
const {
  listReportsOwnedBy: mockList,
  getReportOwnedBy: mockGet,
  updateReport: mockUpdate,
} = jest.requireMock('@/lib/reports');

const CTX = { userId: 'u1' };

const base = {
  id: 'report-a',
  title: 'A',
  createdAt: '2026-07-01T00:00:00Z',
  createdBy: 'agent',
  agentType: 'creator',
  missionId: 'mission-1',
  entityIds: [],
  metadata: { description: 'd', dataSnapshotAt: '2026-07-01T00:00:00Z' },
  shared: false,
};

beforeEach(() => jest.clearAllMocks());

describe('executeListReports — state + URL discipline', () => {
  it('annotates each report with its lifecycle state and private reportUrl; shareUrl only when shared', async () => {
    mockList.mockResolvedValue([
      { ...base, id: 'report-draft', reviewStatus: 'needs-review' },
      { ...base, id: 'report-private' },
      { ...base, id: 'report-shared', shared: true },
    ]);

    const result = await executeListReports({}, CTX);

    const byId = Object.fromEntries(result.reports.map((r: { id: string }) => [r.id, r]));
    expect(byId['report-draft'].state).toBe('needs-review');
    expect(byId['report-draft'].reportUrl).toBe('/reports/report-draft');
    expect(byId['report-draft'].shareUrl).toBeUndefined();

    expect(byId['report-private'].state).toBe('private');
    expect(byId['report-private'].shareUrl).toBeUndefined();

    expect(byId['report-shared'].state).toBe('shared');
    expect(byId['report-shared'].shareUrl).toBe('/share/report/report-shared');
  });
});

describe('executeGetReportById — state + URL discipline', () => {
  it('returns private reportUrl and no shareUrl for an unshared report', async () => {
    mockGet.mockResolvedValue({ ...base });
    const result = await executeGetReportById({ reportId: 'report-a' }, CTX);
    expect(result.found).toBe(true);
    expect(result.report.state).toBe('private');
    expect(result.report.reportUrl).toBe('/reports/report-a');
    expect(result.report.shareUrl).toBeUndefined();
  });

  it('returns the shareUrl only for a verifiably shared report', async () => {
    mockGet.mockResolvedValue({ ...base, shared: true });
    const result = await executeGetReportById({ reportId: 'report-a' }, CTX);
    expect(result.report.state).toBe('shared');
    expect(result.report.shareUrl).toBe('/share/report/report-a');
  });
});

describe('executeUpdateReport — share flow truth', () => {
  it('refuses to share a needs-review draft and names the repair path', async () => {
    mockGet.mockResolvedValue({ ...base, reviewStatus: 'needs-review' });

    await expect(executeUpdateReport({ reportId: 'report-a', shared: true }, CTX)).rejects.toThrow(
      /needs-review draft and cannot be publicly shared[\s\S]*approve/i
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('emits the shareUrl only after re-reading persisted shared:true', async () => {
    // Preflight read: private report. Post-write read: persisted shared:true.
    mockGet.mockResolvedValueOnce({ ...base }).mockResolvedValueOnce({ ...base, shared: true });

    const result = await executeUpdateReport({ reportId: 'report-a', shared: true }, CTX);

    expect(result.state).toBe('shared');
    expect(result.shareUrl).toBe('/share/report/report-a');
    // Two reads: owner preflight + persisted verification.
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('reports the persisted state when the share write did NOT land as shared', async () => {
    // The service can refuse/downgrade (e.g. concurrent gate) — the result
    // must reflect what is actually persisted, never assume the request won.
    mockGet.mockResolvedValueOnce({ ...base }).mockResolvedValueOnce({ ...base, shared: false });

    const result = await executeUpdateReport({ reportId: 'report-a', shared: true }, CTX);

    expect(result.state).toBe('private');
    expect(result.shareUrl).toBeUndefined();
  });

  it('returns the private state for a metadata edit on a private report', async () => {
    mockGet.mockResolvedValueOnce({ ...base }).mockResolvedValueOnce({ ...base });

    const result = await executeUpdateReport({ reportId: 'report-a', title: 'Renamed' }, CTX);

    expect(result.success).toBe(true);
    expect(result.reportUrl).toBe('/reports/report-a');
    expect(result.state).toBe('private');
    expect(result.shareUrl).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith(
      'report-a',
      { title: 'Renamed' },
      { savedBy: 'user:u1', requireOwnerId: 'u1' }
    );
  });
});

// ============================================================================
// REPORT-004 — mission-bound exact-HTML loading (includeHtml)
// ============================================================================

describe('executeGetReportById — includeHtml (REPORT-004)', () => {
  const HTML = '<html><body><h1>Exact artifact</h1></body></html>';

  it('returns the exact persisted html + sha256 for the bound mission', async () => {
    mockGet.mockResolvedValue({ ...base, html: HTML, missionId: 'mission-1' });

    const result = await executeGetReportById(
      { reportId: 'report-a', includeHtml: true },
      { userId: 'u1', missionId: 'mission-1' }
    );

    expect(result.report.html).toBe(HTML);
    const { createHash } = require('node:crypto');
    expect(result.report.htmlSha256).toBe(createHash('sha256').update(HTML, 'utf8').digest('hex'));
  });

  it('ignores includeHtml outside a mission context (chat stays metadata-only)', async () => {
    mockGet.mockResolvedValue({ ...base, html: HTML, missionId: 'mission-1' });

    const result = await executeGetReportById({ reportId: 'report-a', includeHtml: true }, { userId: 'u1' });

    expect(result.report.html).toBeUndefined();
    expect(result.report.htmlSha256).toBeUndefined();
  });

  it("ignores includeHtml for another mission's report", async () => {
    mockGet.mockResolvedValue({ ...base, html: HTML, missionId: 'mission-OTHER' });

    const result = await executeGetReportById(
      { reportId: 'report-a', includeHtml: true },
      { userId: 'u1', missionId: 'mission-1' }
    );

    expect(result.report.html).toBeUndefined();
  });

  it('never returns html without an explicit includeHtml request', async () => {
    mockGet.mockResolvedValue({ ...base, html: HTML, missionId: 'mission-1' });

    const result = await executeGetReportById({ reportId: 'report-a' }, { userId: 'u1', missionId: 'mission-1' });

    expect(result.report.html).toBeUndefined();
  });
});

// ============================================================================
// SEC-009 — executeRestoreReport delegates ownership to the transaction
// ============================================================================

describe('executeRestoreReport', () => {
  const { executeRestoreReport } = require('../report-tools');
  const { restoreReportVersion: mockRestore } = jest.requireMock('@/lib/reports');

  it('restores through the service with the acting user as savedBy AND requireOwnerId', async () => {
    mockRestore.mockResolvedValueOnce(undefined);

    const result = await executeRestoreReport({ reportId: 'report-a' }, CTX);

    expect(result.success).toBe(true);
    expect(mockRestore).toHaveBeenCalledWith('report-a', { savedBy: 'user:u1', requireOwnerId: 'u1' });
  });

  it('remaps the boundary not-found into the tool not-found (no existence leak)', async () => {
    // Absent, foreign, and ownerless all arrive as this one error.
    mockRestore.mockRejectedValueOnce(new Error('Report not found'));

    await expect(executeRestoreReport({ reportId: 'report-foreign' }, CTX)).rejects.toThrow(
      'Report report-foreign not found'
    );
  });

  it('reports a missing backup as a soft failure rather than throwing', async () => {
    mockRestore.mockRejectedValueOnce(new Error('No previous version available'));

    const result = await executeRestoreReport({ reportId: 'report-a' }, CTX);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no previous version available/i);
  });

  it('requires an authenticated user context', async () => {
    await expect(executeRestoreReport({ reportId: 'report-a' }, { userId: '' })).rejects.toThrow(
      /authenticated user context/
    );
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
