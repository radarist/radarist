/**
 * @jest-environment node
 *
 * Tests for document-refresh-admin — the narrow T1.4 admin-SDK helper used
 * by the URL-document refresh Inngest function. Covers each exported
 * function's happy path + key error cases. The 32 existing
 * `refresh-url-document.test.ts` cases already mock this helper at its
 * module boundary, so these tests focus on the helper's own behavior.
 */

import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// `require` (not `import`) — see signals-autopilot-admin.test.ts for the TDZ note.
const {
  getDocumentById,
  startDocumentRefresh,
  completeDocumentRefresh,
  failDocumentRefresh,
  markDocumentBlocked,
} = require('../document-refresh-admin');

describe('document-refresh-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getDocumentById', () => {
    it('returns null when the doc does not exist', async () => {
      adminMock.docGet.mockResolvedValue({ exists: false, id: 'doc-1', data: () => null });
      await expect(getDocumentById('doc-1')).resolves.toBeNull();
    });

    it('returns the parsed Document when the doc exists', async () => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'doc-1',
        data: () => ({
          title: 'White paper',
          type: 'url',
          status: 'processed',
          createdAt: 1700_000_000_000,
          updatedAt: 1710_000_000_000,
        }),
      });
      const doc = await getDocumentById('doc-1');
      expect(doc).toMatchObject({ id: 'doc-1', title: 'White paper', type: 'url' });
    });

    it('converts Timestamp-shaped fields to millis', async () => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'doc-1',
        data: () => ({
          title: 't',
          type: 'url',
          status: 'processed',
          createdAt: { toMillis: () => 1700_000_000_000 },
          updatedAt: { toMillis: () => 1710_000_000_000 },
          lastFetchedAt: { toMillis: () => 1715_000_000_000 },
        }),
      });
      const doc = await getDocumentById('doc-1');
      expect(doc).toMatchObject({
        createdAt: 1700_000_000_000,
        updatedAt: 1710_000_000_000,
        lastFetchedAt: 1715_000_000_000,
      });
    });
  });

  describe('startDocumentRefresh', () => {
    it('throws when the document does not exist', async () => {
      adminMock.docGet.mockResolvedValue({ exists: false, id: 'd1', data: () => null });
      await expect(startDocumentRefresh('d1')).rejects.toThrow(/Document not found/);
    });

    it('throws when type !== url', async () => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'd1',
        data: () => ({ type: 'file', status: 'processed', createdAt: 1, updatedAt: 1 }),
      });
      await expect(startDocumentRefresh('d1')).rejects.toThrow(/Cannot refresh non-URL document/);
    });

    it('returns false when a refresh is actively in progress (fresh flag)', async () => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'd1',
        data: () => ({
          type: 'url',
          status: 'processed',
          refreshInProgress: true,
          createdAt: 1,
          // Flag was set moments ago → genuinely active.
          updatedAt: Date.now(),
        }),
      });
      await expect(startDocumentRefresh('d1')).resolves.toBe(false);
      expect(adminMock.update).not.toHaveBeenCalled();
    });

    it('re-arms a STALE refreshInProgress flag (crashed run) and returns true', async () => {
      // A worker died between startDocumentRefresh and complete/fail — the
      // flag is stuck true but updatedAt is far older than REFRESH_STALE_MS.
      // The time-bounded guard must self-heal instead of blocking forever.
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'd1',
        data: () => ({
          type: 'url',
          status: 'processed',
          refreshInProgress: true,
          createdAt: 1,
          updatedAt: Date.now() - 16 * 60 * 1000, // 16 min ago > 15-min window
        }),
      });
      await expect(startDocumentRefresh('d1')).resolves.toBe(true);
      const update = adminMock.update.mock.calls[0][0];
      expect(update.refreshInProgress).toBe(true);
    });

    it('sets refreshInProgress=true and returns true', async () => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'd1',
        data: () => ({ type: 'url', status: 'processed', createdAt: 1, updatedAt: 1 }),
      });
      await expect(startDocumentRefresh('d1')).resolves.toBe(true);
      const update = adminMock.update.mock.calls[0][0];
      expect(update.refreshInProgress).toBe(true);
      expect(typeof update.updatedAt).toBe('number');
    });
  });

  describe('completeDocumentRefresh', () => {
    beforeEach(() => {
      adminMock.docGet.mockResolvedValue({
        exists: true,
        id: 'd1',
        data: () => ({ type: 'url', status: 'processed', version: 3, createdAt: 1, updatedAt: 1 }),
      });
    });

    it('clears refreshInProgress + records lastFetchedAt when content unchanged', async () => {
      await completeDocumentRefresh('d1', false);
      const update = adminMock.update.mock.calls[0][0];
      expect(update.refreshInProgress).toBe(false);
      expect(typeof update.lastFetchedAt).toBe('number');
      expect(update.version).toBeUndefined();
    });

    it('bumps version and stages reprocessing when content changed', async () => {
      await completeDocumentRefresh('d1', true, 'sha-abc');
      const update = adminMock.update.mock.calls[0][0];
      expect(update.version).toBe(4);
      expect(update.contentHash).toBe('sha-abc');
      expect(update.status).toBe('uploaded');
      expect(update.graphSyncStatus).toBe('pending');
    });
  });

  describe('failDocumentRefresh', () => {
    it('records fetchError and clears refreshInProgress', async () => {
      await failDocumentRefresh('d1', 'timeout');
      const update = adminMock.update.mock.calls[0][0];
      expect(update.refreshInProgress).toBe(false);
      expect(update.fetchError).toBe('timeout');
    });
  });

  describe('markDocumentBlocked', () => {
    it('sets status=blocked + fetchError', async () => {
      await markDocumentBlocked('d1', 'robots-blocked');
      const update = adminMock.update.mock.calls[0][0];
      expect(update.status).toBe('blocked');
      expect(update.fetchError).toBe('robots-blocked');
    });
  });
});
