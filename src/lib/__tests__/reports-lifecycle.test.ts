/**
 * @file lib/__tests__/reports-lifecycle.test.ts
 * @description REPORT-002 — truthful draft / publication / share state.
 *
 * A report has exactly one lifecycle state derived from persisted fields:
 *   - 'needs-review' — retained draft (design/quality gate withheld it);
 *   - 'private'      — published to the owner, no public link;
 *   - 'shared'       — explicit persisted shared:true AND not needs-review.
 *
 * The owner catalog INCLUDES needs-review drafts (a paid draft must never
 * disappear from its owner), while sharing a draft is refused server-side
 * inside the update transaction, and the mission upsert returns the private
 * /reports/{id} route — never a /share link that does not exist yet.
 */

import { createFirebaseAdminMock, fakeQuerySnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
const { transactionUpdate, subGet } = adminMock;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { reportLifecycleState, listReportsOwnedBy, updateReport, upsertReportBySlot } = require('../reports');

const OWNER = 'user-alice';

const baseReport = {
  id: 'report-abc-123',
  title: 'Report',
  html: '<html><body><h1>R</h1></body></html>',
  createdAt: '2026-07-01T10:00:00.000Z',
  createdBy: 'agent',
  ownerId: OWNER,
  entityIds: [],
  metadata: { description: 'd', dataSnapshotAt: '2026-07-01T10:00:00Z' },
  shared: false,
};

function mockDocRead(data: Record<string, unknown> | null, id = 'report-abc-123') {
  adminMock.docGet.mockResolvedValue({
    exists: data !== null,
    id,
    data: () => data,
    ref: { collection: adminMock.subCollection },
  });
}

describe('REPORT-002 lifecycle state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('reportLifecycleState', () => {
    it('maps needs-review to the draft state regardless of the shared flag', () => {
      expect(reportLifecycleState({ reviewStatus: 'needs-review', shared: false })).toBe('needs-review');
      // A stale shared flag never overrides the withheld state.
      expect(reportLifecycleState({ reviewStatus: 'needs-review', shared: true })).toBe('needs-review');
    });

    it('maps published/absent status without shared to private', () => {
      expect(reportLifecycleState({ reviewStatus: 'published', shared: false })).toBe('private');
      expect(reportLifecycleState({ shared: false })).toBe('private');
      // Only an explicit boolean true counts as shared (legacy junk fails closed).
      expect(reportLifecycleState({ shared: 'yes' as unknown as boolean })).toBe('private');
    });

    it('maps explicit persisted shared:true on a published report to shared', () => {
      expect(reportLifecycleState({ reviewStatus: 'published', shared: true })).toBe('shared');
      expect(reportLifecycleState({ shared: true })).toBe('shared');
    });
  });

  describe('owner catalog draft visibility', () => {
    it('includes needs-review drafts in the owner-scoped listing', async () => {
      adminMock.get.mockResolvedValue(
        fakeQuerySnapshot([
          { ...baseReport, id: 'report-final' },
          { ...baseReport, id: 'report-draft', reviewStatus: 'needs-review' },
        ])
      );

      const items = await listReportsOwnedBy(OWNER);

      expect(items.map((r: { id: string }) => r.id)).toEqual(['report-final', 'report-draft']);
      const draft = items.find((r: { id: string }) => r.id === 'report-draft');
      expect(draft?.reviewStatus).toBe('needs-review');
    });
  });

  describe('share gate on update', () => {
    it('refuses shared:true on a needs-review draft inside the transaction', async () => {
      mockDocRead({ ...baseReport, reviewStatus: 'needs-review' });

      await expect(updateReport('report-abc-123', { shared: true })).rejects.toThrow(
        'Report is pending review and cannot be shared'
      );
      expect(transactionUpdate).not.toHaveBeenCalled();
    });

    it('allows sharing when the same update explicitly approves the draft', async () => {
      mockDocRead({ ...baseReport, reviewStatus: 'needs-review' });
      subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

      const updated = await updateReport('report-abc-123', { shared: true, reviewStatus: 'published' });
      expect(updated.shared).toBe(true);
      expect(transactionUpdate).toHaveBeenCalledTimes(1);
    });

    it('allows sharing a published report', async () => {
      mockDocRead({ ...baseReport, reviewStatus: 'published' });
      subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

      const updated = await updateReport('report-abc-123', { shared: true });
      expect(updated.shared).toBe(true);
    });
  });

  describe('upsertReportBySlot result', () => {
    it('returns the private reportUrl — never a share link at publish time', async () => {
      adminMock.get.mockResolvedValue({ empty: true, size: 0, docs: [] });

      const result = await upsertReportBySlot({
        missionId: 'mission-1',
        slotName: 'main-report',
        title: 'T',
        html: '<html><body>ok</body></html>',
        description: 'd',
        createdBy: 'agent',
        ownerId: OWNER,
        entityIds: [],
      });

      expect(result.reportUrl).toBe(`/reports/${result.reportId}`);
      expect(result).not.toHaveProperty('shareUrl');
    });
  });
});

// ============================================================================
// REPORT-004 — atomic lifecycle restore alongside the html swap
// ============================================================================

describe('restoreReportVersion alsoSet (REPORT-004)', () => {
  const { restoreReportVersion } = require('../reports');

  beforeEach(() => jest.clearAllMocks());

  it('restores lifecycle fields atomically with the html in one transaction update', async () => {
    mockDocRead({
      ...baseReport,
      html: '<html><body>rejected revision</body></html>',
      previousHtml: '<html><body>original</body></html>',
      reviewStatus: 'needs-review',
    });
    subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    await restoreReportVersion('report-abc-123', {
      savedBy: 'agent:creator',
      alsoSet: {
        reviewStatus: 'published',
        designPassVerdict: 'PASS',
        qualityGate: null,
      },
    });

    expect(transactionUpdate).toHaveBeenCalledTimes(1);
    const [, fields] = transactionUpdate.mock.calls[0];
    expect(fields).toMatchObject({
      html: '<html><body>original</body></html>',
      reviewStatus: 'published',
      designPassVerdict: 'PASS',
      qualityGate: null,
    });
  });
});

// ============================================================================
// SEC-009 — ownership at the mission WRITE chokepoint (upsertReportBySlot)
// ============================================================================

describe('upsertReportBySlot ownership (SEC-009)', () => {
  const { upsertReportBySlot } = require('../reports');

  beforeEach(() => jest.clearAllMocks());

  const slotInput = {
    missionId: 'mission-1',
    slotName: 'main-report',
    title: 'T',
    html: '<html><body>new body</body></html>',
    description: 'd',
    createdBy: 'agent' as const,
    entityIds: [],
  };

  it('refuses to overwrite a slot owned by a different user (forged missionId)', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([{ ...baseReport, ownerId: 'user-mallory' }]));

    await expect(upsertReportBySlot({ ...slotInput, ownerId: OWNER })).rejects.toThrow('Report not found');
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('heals an ownerless legacy slot by stamping the mission dispatcher on republish', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([{ ...baseReport, ownerId: undefined }]));
    subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    await upsertReportBySlot({ ...slotInput, ownerId: OWNER });

    expect(transactionUpdate).toHaveBeenCalledTimes(1);
    expect(transactionUpdate.mock.calls[0][1]).toMatchObject({ ownerId: OWNER });
  });

  it('does not rewrite ownerId on a slot the dispatcher already owns', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([{ ...baseReport, ownerId: OWNER }]));
    subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    await upsertReportBySlot({ ...slotInput, ownerId: OWNER });

    expect(transactionUpdate.mock.calls[0][1]).not.toHaveProperty('ownerId');
  });
});
