/**
 * @jest-environment node
 *
 * Tests for trends-admin — the narrow admin-SDK helper that replaces the
 * client-SDK `computeTrends` for Inngest workers (daily-pipeline step 6).
 *
 * Mocks `@/lib/firebase-admin` with the shared `createFirebaseAdminMock()`
 * helper and `@/lib/signals-admin` for the signal reads. The pure
 * computation layer (`trends-core`) is exercised for real — the AI
 * clustering path is avoided by using < 3 signals, which takes the
 * deterministic single-cluster fallback in `clusterSignals`.
 */

import { createFirebaseAdminMock, fakeQuerySnapshot } from '@/lib/__tests__/helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockAdminGetSignalsByStatus = jest.fn();
jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminGetSignalsByStatus: (...args: unknown[]) => mockAdminGetSignalsByStatus(...args),
}));

// The AI client must not be reached in these tests (< 3 signals takes the
// non-AI clustering fallback), but mock it so an accidental reach fails
// loudly instead of making a network call.
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateStructuredContent: jest.fn().mockRejectedValue(new Error('AI must not be called in trends-admin tests')),
}));

// `require` (not `import`) so the SUT loads AFTER `adminMock` is initialized
// (import hoisting would hit the jest.mock factory's temporal dead zone).
const { adminComputeTrends, adminCreateTrend, adminUpdateTrend, adminDeleteTrend } = require('../trends-admin');

function makeSignal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sig-1',
    title: 'Photonic Routing',
    description: 'Sub-microsecond packet routing on photonic hardware.',
    type: 'news',
    status: 'Validated',
    detectedAt: Date.now(),
    aiSummary: 'Photonic routing breakthrough.',
    linkedEntities: { technologies: ['photonics'] },
    ...overrides,
  };
}

describe('trends-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no existing trends in Firestore.
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));
  });

  describe('adminCreateTrend / adminUpdateTrend / adminDeleteTrend', () => {
    it('creates a trend doc in computedTrends with audit timestamps', async () => {
      const trend = await adminCreateTrend({
        name: 'Photonic Routing',
        trajectory: 'emerging',
        signalIds: ['sig-1'],
        signalCount: 1,
        dailyCounts: [],
        lastComputedAt: Date.now(),
        confidence: 50,
        keywords: ['photonics'],
        summary: 'Test',
      });

      expect(adminMock.collection).toHaveBeenCalledWith('computedTrends');
      expect(adminMock.set).toHaveBeenCalledTimes(1);
      const written = adminMock.set.mock.calls[0][0];
      expect(written).toMatchObject({ name: 'Photonic Routing', trajectory: 'emerging' });
      expect(written.id).toMatch(/^trend-/);
      expect(typeof written.createdAt).toBe('number');
      expect(typeof written.updatedAt).toBe('number');
      expect(trend.id).toBe(written.id);
    });

    it('updates a trend and bumps updatedAt', async () => {
      await adminUpdateTrend('trend-1', { signalCount: 7 });

      expect(adminMock.doc).toHaveBeenCalledWith('trend-1');
      expect(adminMock.update).toHaveBeenCalledTimes(1);
      const updated = adminMock.update.mock.calls[0][0];
      expect(updated).toMatchObject({ signalCount: 7 });
      expect(typeof updated.updatedAt).toBe('number');
    });

    it('deletes a trend by id', async () => {
      await adminDeleteTrend('trend-9');

      expect(adminMock.doc).toHaveBeenCalledWith('trend-9');
      expect(adminMock.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('adminComputeTrends', () => {
    it('returns zeros when there are not enough recent signals to cluster', async () => {
      mockAdminGetSignalsByStatus.mockResolvedValue([makeSignal()]);

      const result = await adminComputeTrends({ minSignalsPerCluster: 2 });

      expect(result).toEqual({ created: 0, updated: 0, deleted: 0, trends: [] });
      expect(adminMock.set).not.toHaveBeenCalled();
      expect(adminMock.update).not.toHaveBeenCalled();
    });

    it('creates a new trend from a signal cluster (admin SDK writes only)', async () => {
      mockAdminGetSignalsByStatus.mockResolvedValue([
        makeSignal({ id: 'sig-1' }),
        makeSignal({ id: 'sig-2', title: 'Photonic Routing' }),
      ]);

      const result = await adminComputeTrends({ minSignalsPerCluster: 2 });

      expect(mockAdminGetSignalsByStatus).toHaveBeenCalledWith('Validated');
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(adminMock.set).toHaveBeenCalledTimes(1);
      const written = adminMock.set.mock.calls[0][0];
      expect(written).toMatchObject({
        name: 'Photonic Routing',
        signalIds: ['sig-1', 'sig-2'],
        signalCount: 2,
      });
    });

    it('updates an existing trend when the cluster name matches', async () => {
      mockAdminGetSignalsByStatus.mockResolvedValue([makeSignal({ id: 'sig-1' }), makeSignal({ id: 'sig-2' })]);
      adminMock.get.mockResolvedValue(
        fakeQuerySnapshot([
          {
            id: 'trend-existing',
            name: 'Photonic Routing',
            trajectory: 'emerging',
            signalIds: ['sig-1'],
            signalCount: 1,
            dailyCounts: [],
            lastComputedAt: Date.now() - 1000,
            confidence: 40,
            keywords: [],
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 5000,
          },
        ])
      );

      const result = await adminComputeTrends({ minSignalsPerCluster: 2 });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(adminMock.set).not.toHaveBeenCalled();
      expect(adminMock.update).toHaveBeenCalledTimes(1);
      const updated = adminMock.update.mock.calls[0][0];
      expect(updated.signalIds).toEqual(expect.arrayContaining(['sig-1', 'sig-2']));
    });

    it('deletes stale trends with no recent signals', async () => {
      mockAdminGetSignalsByStatus.mockResolvedValue([makeSignal({ id: 'sig-1' }), makeSignal({ id: 'sig-2' })]);
      adminMock.get.mockResolvedValue(
        fakeQuerySnapshot([
          {
            id: 'trend-stale',
            name: 'Forgotten Fad',
            trajectory: 'declining',
            signalIds: ['sig-ancient'],
            signalCount: 1,
            dailyCounts: [],
            lastComputedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
            confidence: 30,
            keywords: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ])
      );

      const result = await adminComputeTrends({ minSignalsPerCluster: 2 });

      expect(result.deleted).toBe(1);
      expect(adminMock.delete).toHaveBeenCalledTimes(1);
    });
  });
});
