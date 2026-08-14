/**
 * @file lib/reports/__tests__/report-version-capture.test.ts
 * @jest-environment node
 *
 * REPORT-004 — `captureReportVersionWithReceipt`: the durable, immutable
 * pre-revision capture. The revision agent receives this version's identity
 * (id + sha256 + length) as its server-owned prior-artifact reference, and the
 * regression rollback restores from it deterministically. Identical heads are
 * never duplicated — the newest identical version is reused as the reference.
 */

import { createHash } from 'node:crypto';
import { createFirebaseAdminMock } from '../../__tests__/helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { captureReportVersionWithReceipt } = require('../report-versions');

const HTML = '<html><body><h1>Prior</h1></body></html>';
const HTML_SHA = createHash('sha256').update(HTML, 'utf8').digest('hex');

function mockReportHead(html: string | null) {
  adminMock.docGet.mockResolvedValue({
    exists: html !== null,
    id: 'report-1',
    data: () => (html === null ? null : { id: 'report-1', html }),
    ref: { collection: adminMock.subCollection },
  });
}

describe('captureReportVersionWithReceipt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('appends an immutable version with sha256 + check receipt', async () => {
    mockReportHead(HTML);
    adminMock.subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    const captured = await captureReportVersionWithReceipt('report-1', {
      savedBy: 'agent:creator',
      reason: 'pre-revision',
      checkReceipt: {
        verdict: 'REVISE',
        failingChecks: ['creator-brand-compliance'],
        designPassVerdict: 'FAIL',
        reviewStatus: 'needs-review',
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.htmlSha256).toBe(HTML_SHA);
    expect(captured!.htmlLength).toBe(HTML.length);
    expect(captured!.versionNumber).toBe(1);
    expect(adminMock.transactionSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        html: HTML,
        htmlSha256: HTML_SHA,
        reason: 'pre-revision',
        savedBy: 'agent:creator',
        checkReceipt: expect.objectContaining({ verdict: 'REVISE', reviewStatus: 'needs-review' }),
      })
    );
  });

  it('reuses the identical newest version instead of duplicating it, and backfills its evidence', async () => {
    mockReportHead(HTML);
    const existingRef = { id: 'ver-existing' };
    adminMock.subGet.mockResolvedValue({
      empty: false,
      size: 1,
      docs: [{ id: 'ver-existing', ref: existingRef, data: () => ({ versionNumber: 4, html: HTML }) }],
    });

    const captured = await captureReportVersionWithReceipt('report-1', {
      savedBy: 'agent:creator',
      reason: 'pre-revision',
      checkReceipt: { verdict: 'REVISE', failingChecks: ['citations-present'] },
    });

    expect(captured).toEqual(
      expect.objectContaining({ versionId: 'ver-existing', versionNumber: 4, htmlLength: HTML.length })
    );
    // No duplicate version doc — exactly one write, and it MERGES the sha256 +
    // receipt onto the reused doc so the returned reference really carries the
    // evidence this function promises.
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
    expect(adminMock.transactionSet).toHaveBeenCalledWith(
      existingRef,
      expect.objectContaining({
        htmlSha256: HTML_SHA,
        checkReceipt: expect.objectContaining({ verdict: 'REVISE' }),
      }),
      { merge: true }
    );
  });

  it('folds a legacy previousHtml buffer before the head so the pre-versioning draft survives', async () => {
    // Without the fold, THIS capture makes history non-empty, so
    // stageVersionCapture's own fold (guarded on an empty history) never runs
    // again and the legacy draft is lost the next time the head is overwritten.
    const LEGACY = '<html><body><h1>Pre-versioning draft</h1></body></html>';
    adminMock.docGet.mockResolvedValue({
      exists: true,
      id: 'report-1',
      data: () => ({ id: 'report-1', html: HTML, previousHtml: LEGACY }),
      ref: { collection: adminMock.subCollection },
    });
    adminMock.subGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    const captured = await captureReportVersionWithReceipt('report-1', { savedBy: 'agent:creator' });

    expect(adminMock.transactionSet).toHaveBeenCalledTimes(2);
    const [firstWrite, secondWrite] = adminMock.transactionSet.mock.calls;
    expect(firstWrite[1]).toMatchObject({ html: LEGACY, versionNumber: 1, reason: 'legacy-previous' });
    expect(secondWrite[1]).toMatchObject({ html: HTML, versionNumber: 2 });
    expect(captured!.versionNumber).toBe(2);
  });

  it('appends as the next monotonic version when the newest differs', async () => {
    mockReportHead(HTML);
    adminMock.subGet.mockResolvedValue({
      empty: false,
      size: 1,
      docs: [{ id: 'ver-old', data: () => ({ versionNumber: 4, html: '<p>different</p>' }) }],
    });

    const captured = await captureReportVersionWithReceipt('report-1', { savedBy: 'agent:creator' });

    expect(captured!.versionNumber).toBe(5);
    expect(adminMock.transactionSet).toHaveBeenCalledTimes(1);
  });

  it('returns null for a missing report', async () => {
    mockReportHead(null);
    const captured = await captureReportVersionWithReceipt('report-gone', { savedBy: 'agent:creator' });
    expect(captured).toBeNull();
    expect(adminMock.transactionSet).not.toHaveBeenCalled();
  });
});
