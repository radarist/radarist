export {};
/**
 * @jest-environment node
 *
 * recommend-stale-reports — proactively stage UPDATE recommendations for reports that
 * have gone stale, so the inbox surfaces "refresh report X" alongside "produce report Y".
 *
 * SEC-009: this sweep runs for EVERY active user, so it must resolve reports
 * through the owner boundary. It previously read the global listing and
 * filtered in memory with `if (ownerId && ownerId !== userId) continue`, which
 * let OWNERLESS legacy reports fall through and staged their title + id into
 * every user's inbox — the one surface that could reveal a report the
 * authenticated routes deny. The boundary excludes ownerless docs by query
 * construction (proven in lib/__tests__/reports-owner-boundary.test.ts); these
 * tests pin that this caller uses it and passes the acting user's id.
 */
const listReportsOwnedBy = jest.fn();
const listReports = jest.fn();
const createArtifact = jest.fn(async (..._a: unknown[]) => ({ created: true }));
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  listReportsOwnedBy: (...a: unknown[]) => listReportsOwnedBy(...a),
  // Present but must stay unused — a global listing here is the SEC-009 defect.
  listReports: (...a: unknown[]) => listReports(...a),
}));
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  __esModule: true,
  createProposedArtifactIfNotExists: (...a: unknown[]) => createArtifact(...a),
}));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { recommendStaleReportUpdates } = require('../recommend-stale-reports');

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  listReportsOwnedBy.mockResolvedValue([]);
});

describe('recommendStaleReportUpdates', () => {
  it('recommends an UPDATE for a stale report, targeting it via updateOf', async () => {
    const now = Date.now();
    listReportsOwnedBy.mockResolvedValue([{ id: 'rOld', title: 'Q1 Radar', createdAt: now - 30 * DAY }]);
    const n = await recommendStaleReportUpdates('user-1', { staleMs: 7 * DAY, now });
    expect(n).toBe(1);
    expect(createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactKind: 'report',
        updateOf: { type: 'report', id: 'rOld' },
        sourceUserId: 'user-1',
      })
    );
  });

  it('skips fresh reports', async () => {
    const now = Date.now();
    listReportsOwnedBy.mockResolvedValue([{ id: 'rNew', title: 'Fresh', createdAt: now - 1 * DAY }]);
    const n = await recommendStaleReportUpdates('user-1', { staleMs: 7 * DAY, now });
    expect(n).toBe(0);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  // SEC-009 regression guard — this is the shape of the leak, not a restatement
  // of the boundary's own test: the sweep must ask the boundary for the ACTING
  // user's reports and must never read the global listing (whose results
  // include other users' and ownerless docs).
  it('resolves through the owner boundary with the acting user id, never the global listing', async () => {
    const now = Date.now();
    listReportsOwnedBy.mockResolvedValue([{ id: 'rOld', title: 'Q1 Radar', createdAt: now - 30 * DAY }]);

    await recommendStaleReportUpdates('user-42', { staleMs: 7 * DAY, now });

    expect(listReportsOwnedBy).toHaveBeenCalledWith('user-42');
    expect(listReports).not.toHaveBeenCalled();
  });

  it('stages nothing when the acting user owns no reports (an ownerless corpus yields an empty scope)', async () => {
    const now = Date.now();
    // What the boundary returns for a user whose only same-era reports are
    // ownerless legacy docs: nothing. The sweep must stage nothing rather than
    // fall back to a broader read.
    listReportsOwnedBy.mockResolvedValue([]);

    const n = await recommendStaleReportUpdates('user-42', { staleMs: 7 * DAY, now });

    expect(n).toBe(0);
    expect(createArtifact).not.toHaveBeenCalled();
    expect(listReports).not.toHaveBeenCalled();
  });
});
