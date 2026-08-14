import { createFirebaseAdminMock, fakeQuerySnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();

// DISC-014: the upsert update path now runs inside db.runTransaction, so the
// head swap lands on `transactionUpdate` (not the doc ref's own .update) and a
// captured version lands on `transactionSet`.
const { transactionUpdate, transactionSet } = adminMock;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { upsertReportBySlot } = require('../reports');

const baseInput = {
  missionId: 'mission-1',
  slotName: 'main',
  title: 'Vendor Report',
  html: '<p>hi</p>',
  description: 'd',
  createdBy: 'agent' as const,
  agentType: 'creator',
  ownerId: 'user-1',
  entityIds: [] as string[],
};

describe('upsertReportBySlot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new report when no doc exists for (missionId, slotName)', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    const result = await upsertReportBySlot(baseInput);
    expect(adminMock.set).toHaveBeenCalled();
    expect(result.isUpsert).toBe(false);
    expect(result.reportId).toMatch(/^report-/);
  });

  it('updates the existing report when one already exists for the same key', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 'report-existing', missionId: 'mission-1', slotName: 'main', title: 'old', html: '<p>old</p>' },
      ])
    );
    const result = await upsertReportBySlot({ ...baseInput, title: 'Vendor Report v2', html: '<p>hi v2</p>' });
    // The upsert calls .update() on the existing doc's ref, not on adminMock.update.
    // We assert isUpsert + id which is the externally observable contract.
    expect(adminMock.set).not.toHaveBeenCalled();
    expect(result.isUpsert).toBe(true);
    expect(result.reportId).toBe('report-existing');
  });

  it('marks a newly inserted report as AI-generated (Art 50 disclosure)', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await upsertReportBySlot(baseInput);
    expect(adminMock.set).toHaveBeenCalledWith(expect.objectContaining({ aiGenerated: true }));
  });

  it('persists an exact export identity and clears it on an unbound republish', async () => {
    const artifactIdentity = {
      sha256: 'a'.repeat(64),
      cssSha256: 'b'.repeat(64),
      bytes: 1234,
      stagedAt: '2026-08-05T00:00:00.000Z',
      revisionNumber: 0,
      reviewedBy: ['design-pass', 'critique-report'] as const,
      evidenceBundleSha256: 'c'.repeat(64),
    };
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await upsertReportBySlot({ ...baseInput, artifactIdentity });
    expect(adminMock.set).toHaveBeenCalledWith(expect.objectContaining({ artifactIdentity }));

    jest.clearAllMocks();
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 'report-existing', missionId: 'mission-1', slotName: 'main', html: '<p>old exact</p>', artifactIdentity },
      ])
    );
    await upsertReportBySlot({ ...baseInput, html: '<p>legacy rewrite</p>' });
    expect(transactionUpdate.mock.calls[0][1]).toMatchObject({ artifactIdentity: null });
  });

  it('queries with both missionId and slotName as the composite key', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await upsertReportBySlot({ ...baseInput, missionId: 'mission-2', slotName: 'tco-breakdown' });
    expect(adminMock.where).toHaveBeenCalledWith('missionId', '==', 'mission-2');
    expect(adminMock.where).toHaveBeenCalledWith('slotName', '==', 'tco-breakdown');
  });

  it('backs up the outgoing html as previousHtml on the update path (revisions overwrite in place)', async () => {
    const snapshot = fakeQuerySnapshot([
      { id: 'report-existing', missionId: 'mission-1', slotName: 'main', title: 'old', html: '<p>old</p>' },
    ]);
    adminMock.get.mockResolvedValueOnce(snapshot);

    await upsertReportBySlot({ ...baseInput, html: '<p>revision 2</p>', savedBy: 'agent:creator' });

    // tx.update(ref, fields) — fields is the second arg.
    const updateArg = transactionUpdate.mock.calls[0][1];
    expect(updateArg).toMatchObject({ html: '<p>revision 2</p>', previousHtml: '<p>old</p>' });
    // DISC-014: the outgoing html is captured as a history version, attributed.
    expect(transactionSet).toHaveBeenCalledTimes(1);
    expect(transactionSet.mock.calls[0][1]).toMatchObject({
      html: '<p>old</p>',
      savedBy: 'agent:creator',
      reason: 'revision',
    });
  });

  it('does NOT overwrite previousHtml or capture a version on an idempotent same-html republish', async () => {
    const snapshot = fakeQuerySnapshot([
      { id: 'report-existing', missionId: 'mission-1', slotName: 'main', title: 'old', html: '<p>same</p>' },
    ]);
    adminMock.get.mockResolvedValueOnce(snapshot);

    await upsertReportBySlot({ ...baseInput, html: '<p>same</p>' });

    const updateArg = transactionUpdate.mock.calls[0][1];
    expect(updateArg.html).toBe('<p>same</p>');
    expect(updateArg).not.toHaveProperty('previousHtml');
    expect(transactionSet).not.toHaveBeenCalled();
  });

  // REPORT-001: the design-review lifecycle is persisted on insert so a
  // design-failing draft is born `needs-review` (off catalog/share).
  it('persists reviewStatus + designPassVerdict on insert when provided', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await upsertReportBySlot({
      ...baseInput,
      reviewStatus: 'needs-review',
      designPassVerdict: 'FAIL',
      designPassDetails: 'off-brand',
    });
    expect(adminMock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewStatus: 'needs-review',
        designPassVerdict: 'FAIL',
        designPassDetails: 'off-brand',
      })
    );
  });

  it('omits the review-lifecycle fields entirely when no design review ran (back-compat)', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await upsertReportBySlot(baseInput);
    const setArg = adminMock.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('reviewStatus');
    expect(setArg).not.toHaveProperty('designPassVerdict');
  });

  it('overwrites the slot status on a re-publish (update path re-runs the review)', async () => {
    const snapshot = fakeQuerySnapshot([
      { id: 'report-existing', missionId: 'mission-1', slotName: 'main', title: 'old', html: '<p>old</p>' },
    ]);
    adminMock.get.mockResolvedValueOnce(snapshot);

    await upsertReportBySlot({ ...baseInput, html: '<p>v2</p>', reviewStatus: 'published', designPassVerdict: 'PASS' });

    const updateArg = transactionUpdate.mock.calls[0][1];
    expect(updateArg).toMatchObject({ reviewStatus: 'published', designPassVerdict: 'PASS' });
  });

  // Regression: a whole-map `metadata: { description }` write would erase
  // dataSnapshotAt (set at insert time) and ogImage on every revision.
  it('updates metadata via dotted path so dataSnapshotAt/ogImage survive revisions', async () => {
    const snapshot = fakeQuerySnapshot([
      { id: 'report-existing', missionId: 'mission-1', slotName: 'main', title: 'old', html: '<p>old</p>' },
    ]);
    adminMock.get.mockResolvedValueOnce(snapshot);

    await upsertReportBySlot({ ...baseInput, description: 'revised description' });

    const updateCall = transactionUpdate.mock.calls[0][1];
    expect(updateCall['metadata.description']).toBe('revised description');
    expect(updateCall).not.toHaveProperty('metadata');
  });
});
