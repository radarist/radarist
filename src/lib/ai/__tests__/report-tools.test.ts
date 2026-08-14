/**
 * @file ai/__tests__/report-tools.test.ts
 * @jest-environment node
 *
 * SEC-009: the report tools resolve through the owner-scoped service boundary
 * in lib/reports.ts (no direct Firestore reads in the executors). REPORT-002:
 * results carry the lifecycle state + private reportUrl; a shareUrl appears
 * only for verifiably shared reports, and the owner catalog INCLUDES
 * needs-review drafts (annotated) instead of hiding a paid draft.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/html-sanitizer', () => ({
  sanitizeHtml: jest.fn((html: string) => html),
}));

jest.mock('@/lib/reports', () => ({
  createReport: jest.fn(),
  deleteReport: jest.fn(),
  getReportOwnedBy: jest.fn(),
  listReportsOwnedBy: jest.fn(),
  updateReport: jest.fn(),
  restoreReportVersion: jest.fn(),
  upsertReportBySlot: jest.fn(),
  reportLifecycleState: jest.requireActual('@/lib/schemas/report').reportLifecycleState,
}));

import { REPORT_TOOLS, executeListReports, executeGetReportById, executeDeleteReport } from '../tools/report-tools';
import {
  _resetConfirmationStore,
  destructiveActionFingerprint,
  destructiveConfirmationPhrase,
} from '../destructive-confirmation';

const {
  deleteReport: mockDeletePersistedReport,
  getReportOwnedBy: mockGetReportOwnedBy,
  listReportsOwnedBy: mockListReportsOwnedBy,
} = jest.requireMock('@/lib/reports') as {
  deleteReport: jest.Mock;
  getReportOwnedBy: jest.Mock;
  listReportsOwnedBy: jest.Mock;
};

function listItem(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Title ${id}`,
    createdAt: '2026-02-26T00:00:00Z',
    createdBy: 'agent',
    ownerId: 'user-1',
    agentType: 'creator',
    metadata: { description: `Desc ${id}` },
    shared: false,
    ...extra,
  };
}

describe('report-tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmationStore();
    mockGetReportOwnedBy.mockResolvedValue(null);
    mockListReportsOwnedBy.mockResolvedValue([]);
  });

  describe('REPORT_TOOLS declarations', () => {
    it('should declare listReports tool', () => {
      const tool = REPORT_TOOLS.find((t) => t.name === 'listReports');
      expect(tool).toBeDefined();
    });

    it('should declare getReportById tool', () => {
      const tool = REPORT_TOOLS.find((t) => t.name === 'getReportById');
      expect(tool).toBeDefined();
      expect(tool!.parameters!.required).toContain('reportId');
    });

    it('declares deleteReport confirmation requirements for human and machine callers', () => {
      const tool = REPORT_TOOLS.find((candidate) => candidate.name === 'deleteReport');
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/exact action-bound confirmation phrase/i);
      expect(tool?.description).toMatch(/confirmed=true/i);
      expect(tool?.parameters?.properties).toHaveProperty('confirmed');
      expect(tool?.parameters?.required).toEqual(['reportId']);
    });
  });

  describe('executeListReports', () => {
    const ctx = { userId: 'user-1' };

    it('should return report summaries without html, with state + private reportUrl', async () => {
      mockListReportsOwnedBy.mockResolvedValue([listItem('r1')]);

      const result = await executeListReports({ limit: 10 }, ctx);
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0]).not.toHaveProperty('html');
      expect(result.reports[0].title).toBe('Title r1');
      expect(result.reports[0].state).toBe('private');
      expect(result.reports[0].reportUrl).toBe('/reports/r1');
      // REPORT-002: an unshared report advertises NO public share link.
      expect(result.reports[0].shareUrl).toBeUndefined();
    });

    it('pushes the default-10 / max-50 bound into the boundary query (never reads the whole catalog)', async () => {
      await executeListReports({}, ctx);
      expect(mockListReportsOwnedBy).toHaveBeenLastCalledWith('user-1', { limit: 10 });

      await executeListReports({ limit: 100 }, ctx);
      expect(mockListReportsOwnedBy).toHaveBeenLastCalledWith('user-1', { limit: 50 });
    });

    // C4: per-user authorization
    it('should reject when userId is missing (C4)', async () => {
      await expect(executeListReports({ limit: 10 }, { userId: '' })).rejects.toThrow(/authenticated user context/);
      expect(mockListReportsOwnedBy).not.toHaveBeenCalled();
    });

    it('should resolve through the owner-scoped boundary with the caller uid (C4/SEC-009)', async () => {
      await executeListReports({ limit: 10 }, { userId: 'user-42' });
      expect(mockListReportsOwnedBy).toHaveBeenCalledWith('user-42', { limit: 10 });
    });

    // REPORT-002: the owner's catalog INCLUDES needs-review drafts (a paid
    // draft must never vanish) — annotated, with no public share link.
    it('includes needs-review drafts annotated with their state and no shareUrl', async () => {
      mockListReportsOwnedBy.mockResolvedValue([
        listItem('published-r', { reviewStatus: 'published', shared: true }),
        listItem('needs-review-r', { reviewStatus: 'needs-review' }),
        listItem('legacy-r'),
      ]);

      const result = await executeListReports({ limit: 10 }, ctx);
      const byId = Object.fromEntries(result.reports.map((r) => [r.id, r]));
      expect(Object.keys(byId)).toEqual(['published-r', 'needs-review-r', 'legacy-r']);
      expect(byId['needs-review-r'].state).toBe('needs-review');
      expect(byId['needs-review-r'].shareUrl).toBeUndefined();
      expect(byId['published-r'].state).toBe('shared');
      expect(byId['published-r'].shareUrl).toBe('/share/report/published-r');
      expect(byId['legacy-r'].state).toBe('private');
      expect(byId['legacy-r'].shareUrl).toBeUndefined();
    });
  });

  describe('executeGetReportById', () => {
    const ctx = { userId: 'user-1' };

    it('should return report metadata with state + reportUrl and no html', async () => {
      mockGetReportOwnedBy.mockResolvedValue({
        ...listItem('r1', { title: 'Test Report', entityIds: ['tech-1'], html: '<h1>Big</h1>' }),
      });

      const result = await executeGetReportById({ reportId: 'r1' }, ctx);
      expect(result.found).toBe(true);
      expect(result.report!.title).toBe('Test Report');
      expect(result.report!.state).toBe('private');
      expect(result.report!.reportUrl).toBe('/reports/r1');
      expect(result.report!.shareUrl).toBeUndefined();
      expect(result.report).not.toHaveProperty('html');
      expect(mockGetReportOwnedBy).toHaveBeenCalledWith('r1', 'user-1');
    });

    it('should return found=false for missing report', async () => {
      mockGetReportOwnedBy.mockResolvedValue(null);
      const result = await executeGetReportById({ reportId: 'nonexistent' }, ctx);
      expect(result.found).toBe(false);
    });

    // C4: per-user authorization
    it('should reject when userId is missing (C4)', async () => {
      await expect(executeGetReportById({ reportId: 'r1' }, { userId: '' })).rejects.toThrow(
        /authenticated user context/
      );
    });

    it('should return found=false for non-owner without leaking existence (C4/SEC-009)', async () => {
      // Model the REAL boundary rather than restating "null → not found": the
      // report exists and belongs to someone else, and the executor must ask
      // the boundary with the CALLER's uid (not the doc's) and surface exactly
      // the missing-report shape.
      const foreign = listItem('r1', { ownerId: 'user-OTHER', title: 'Other user report' });
      mockGetReportOwnedBy.mockImplementation(async (id: string, uid: string) =>
        foreign.ownerId === uid ? foreign : null
      );

      const result = await executeGetReportById({ reportId: 'r1' }, { userId: 'user-1' });

      expect(mockGetReportOwnedBy).toHaveBeenCalledWith('r1', 'user-1');
      expect(result.found).toBe(false);
      expect(result.report).toBeUndefined();
      // Same shape as a genuinely absent report — no existence oracle.
      mockGetReportOwnedBy.mockResolvedValue(null);
      expect(await executeGetReportById({ reportId: 'r-absent' }, { userId: 'user-1' })).toEqual(result);
    });
  });

  describe('executeDeleteReport', () => {
    const machineContext = { userId: 'user-1', principal: 'machine' as const };

    it.each([undefined, null, 42, '', '   ', '\ud800'])(
      'rejects malformed report ID %p before reading or deleting',
      async (reportId) => {
        const result = await executeDeleteReport({ reportId, confirmed: true }, machineContext);

        expect(result).toEqual({ success: false, error: 'A non-empty report ID is required for deletion.' });
        expect(mockGetReportOwnedBy).not.toHaveBeenCalled();
        expect(mockDeletePersistedReport).not.toHaveBeenCalled();
      }
    );

    it('requires confirmed=true from machine callers before the owner read', async () => {
      const refused = await executeDeleteReport({ reportId: 'report-1' }, machineContext);
      expect(refused).toMatchObject({ success: false, data: { requiresConfirmation: true } });
      expect(mockGetReportOwnedBy).not.toHaveBeenCalled();

      mockGetReportOwnedBy.mockResolvedValue(listItem('report-1'));
      const deleted = await executeDeleteReport({ reportId: 'report-1', confirmed: true }, machineContext);

      expect(deleted).toEqual({ success: true, reportId: 'report-1', mutatedEntityTypes: ['report'] });
      expect(mockGetReportOwnedBy).toHaveBeenCalledWith('report-1', 'user-1');
      expect(mockDeletePersistedReport).toHaveBeenCalledWith('report-1');
    });

    it('requires an exact next-turn phrase from a human and makes it one-time', async () => {
      const fingerprint = destructiveActionFingerprint('deleteReport', 'report-1');
      const phrase = destructiveConfirmationPhrase(fingerprint);
      const args = { reportId: 'report-1', confirmed: true };

      const first = await executeDeleteReport(args, {
        userId: 'user-1',
        principal: 'human',
        requestId: 'request-1',
        confirmationText: phrase,
      });
      expect(first).toMatchObject({ success: false, data: { requiresConfirmation: true } });

      const sameTurn = await executeDeleteReport(args, {
        userId: 'user-1',
        principal: 'human',
        requestId: 'request-1',
        confirmationText: phrase,
      });
      expect(sameTurn.success).toBe(false);
      expect(mockGetReportOwnedBy).not.toHaveBeenCalled();

      mockGetReportOwnedBy.mockResolvedValue(listItem('report-1'));
      const redeemed = await executeDeleteReport(args, {
        userId: 'user-1',
        principal: 'human',
        requestId: 'request-2',
        confirmationText: phrase,
      });
      expect(redeemed.success).toBe(true);
      expect(mockDeletePersistedReport).toHaveBeenCalledTimes(1);

      const replay = await executeDeleteReport(args, {
        userId: 'user-1',
        principal: 'human',
        requestId: 'request-3',
        confirmationText: phrase,
      });
      expect(replay.success).toBe(false);
      expect(mockDeletePersistedReport).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending human deletion on a generic confirmation', async () => {
      await executeDeleteReport(
        { reportId: 'report-1' },
        { userId: 'user-1', principal: 'human', requestId: 'request-1' }
      );

      const result = await executeDeleteReport(
        { reportId: 'report-1' },
        { userId: 'user-1', principal: 'human', requestId: 'request-2', confirmationText: 'yes' }
      );

      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/did not exactly confirm/i) });
      expect(mockGetReportOwnedBy).not.toHaveBeenCalled();
    });

    it('does not reveal or delete a report owned by another user', async () => {
      // The report exists under a different owner: the boundary must be asked
      // with the CALLER's uid, deny, and the delete must never run.
      const foreign = listItem('report-1', { ownerId: 'user-other' });
      mockGetReportOwnedBy.mockImplementation(async (id: string, uid: string) =>
        foreign.ownerId === uid ? foreign : null
      );

      await expect(executeDeleteReport({ reportId: 'report-1', confirmed: true }, machineContext)).rejects.toThrow(
        'Report report-1 not found'
      );

      expect(mockGetReportOwnedBy).toHaveBeenCalledWith('report-1', 'user-1');
      expect(mockDeletePersistedReport).not.toHaveBeenCalled();
    });

    it('reports possible mutation when recursive deletion fails after ownership verification', async () => {
      mockGetReportOwnedBy.mockResolvedValue(listItem('report-1'));
      mockDeletePersistedReport.mockRejectedValueOnce(new Error('partial recursive delete'));

      const result = await executeDeleteReport({ reportId: 'report-1', confirmed: true }, machineContext);

      expect(result).toEqual({
        success: false,
        error: 'partial recursive delete',
        data: { mutatedEntityTypes: ['report'] },
      });
    });

    it('requires an authenticated user context', async () => {
      await expect(
        executeDeleteReport({ reportId: 'report-1', confirmed: true }, { userId: '', principal: 'machine' })
      ).rejects.toThrow(/authenticated user context/);
      expect(mockGetReportOwnedBy).not.toHaveBeenCalled();
    });
  });
});
