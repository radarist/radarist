/**
 * Unit Tests for the Trends modules
 *
 * The client-SDK CRUD module (`src/lib/trends.ts`) was deleted on 2026-06-10
 * after its last consumers migrated to the admin-SDK helper. Trend logic now
 * lives in two modules, both covered here:
 * - `trends-core.ts` — pure computation (trajectory, daily counts)
 * - `trends-admin.ts` — admin-SDK Firestore reads (list, by-id, stats)
 *
 * Write-path coverage (adminCreateTrend / adminUpdateTrend / adminDeleteTrend
 * / adminComputeTrends) lives in `trends-admin.test.ts`.
 *
 * @jest-environment node
 * @phase Phase 6: Daily Pipeline
 */

import type { ComputedTrend, DailyCount } from '../trends-core';
import { createFirebaseAdminMock, fakeQuerySnapshot, fakeDocSnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminGetSignalsByStatus: jest.fn(),
}));

// trends-core statically imports the Gemini client; nothing in this suite
// reaches AI clustering — mock it so an accidental reach fails loudly
// instead of making a network call.
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateStructuredContent: jest.fn().mockRejectedValue(new Error('AI must not be called in trends tests')),
}));

import { computeTrajectory, buildDailyCounts } from '../trends-core';

// `require` (not `import`) so the SUT loads AFTER `adminMock` is initialized
// (import hoisting would hit the jest.mock factory's temporal dead zone).
const { adminGetTrends, adminGetTrendById, adminGetTrendStats } = require('../trends-admin');

/**
 * Helper to create a mock trend
 */
function createMockTrend(overrides?: Partial<ComputedTrend>): ComputedTrend {
  const now = Date.now();
  return {
    id: 'trend-123',
    name: 'Artificial Intelligence in Food Tech',
    trajectory: 'emerging',
    signalCount: 15,
    confidence: 85,
    keywords: ['AI', 'food tech', 'machine learning', 'automation'],
    summary: 'AI-powered solutions are rapidly emerging in the food technology sector...',
    signalIds: ['signal-1', 'signal-2', 'signal-3'],
    dailyCounts: [
      { date: '2026-01-07', count: 5 },
      { date: '2026-01-08', count: 7 },
      { date: '2026-01-09', count: 3 },
    ],
    relatedEntities: {
      companies: ['TechCorp', 'FoodAI'],
      technologies: ['Machine Learning', 'Computer Vision'],
    },
    lastComputedAt: now,
    createdAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    updatedAt: now,
    ...overrides,
  };
}

describe('Trends Modules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no trends in Firestore.
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));
  });

  describe('adminGetTrends()', () => {
    it('should fetch all trends ordered by lastComputedAt desc', async () => {
      const mockTrends = [
        createMockTrend({ id: 'trend-1', name: 'Trend 1' }),
        createMockTrend({ id: 'trend-2', name: 'Trend 2' }),
      ];

      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot(mockTrends));

      const result = await adminGetTrends();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Trend 1');
      expect(result[0].id).toBe('trend-1');
      expect(adminMock.collection).toHaveBeenCalledWith('computedTrends');
      expect(adminMock.orderBy).toHaveBeenCalledWith('lastComputedAt', 'desc');
    });

    it('should return empty array when no trends exist', async () => {
      const result = await adminGetTrends();

      expect(result).toEqual([]);
    });
  });

  describe('adminGetTrendById()', () => {
    it('should fetch a trend by ID', async () => {
      const mockTrend = createMockTrend();

      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(mockTrend, mockTrend.id));

      const result = await adminGetTrendById('trend-123');

      expect(result).toBeDefined();
      expect(result?.name).toBe('Artificial Intelligence in Food Tech');
      expect(adminMock.doc).toHaveBeenCalledWith('trend-123');
      expect(adminMock.docGet).toHaveBeenCalledTimes(1);
    });

    it('should return null when trend does not exist', async () => {
      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(null));

      const result = await adminGetTrendById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle trends with no signals', async () => {
      const emptyTrend = createMockTrend({
        signalCount: 0,
        signalIds: [],
        dailyCounts: [],
      });

      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(emptyTrend, emptyTrend.id));

      const result = await adminGetTrendById('trend-123');

      expect(result?.signalCount).toBe(0);
      expect(result?.signalIds).toEqual([]);
    });

    it('should handle trends with missing optional fields', async () => {
      const minimalTrend: ComputedTrend = {
        id: 'trend-123',
        name: 'Minimal Trend',
        trajectory: 'emerging',
        signalCount: 1,
        confidence: 50,
        keywords: [],
        signalIds: [],
        dailyCounts: [],
        lastComputedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      adminMock.docGet.mockResolvedValueOnce(fakeDocSnapshot(minimalTrend, minimalTrend.id));

      const result = await adminGetTrendById('trend-123');

      expect(result).toBeDefined();
      expect(result?.summary).toBeUndefined();
      expect(result?.relatedEntities).toBeUndefined();
    });
  });

  describe('adminGetTrendStats()', () => {
    it('should calculate trend statistics', async () => {
      const mockTrends = [
        createMockTrend({ trajectory: 'emerging', confidence: 80, keywords: ['AI'] }),
        createMockTrend({ trajectory: 'emerging', confidence: 90, keywords: ['AI', 'ML'] }),
        createMockTrend({ trajectory: 'growing', confidence: 85, keywords: ['ML'] }),
        createMockTrend({ trajectory: 'stable', confidence: 75, keywords: ['cloud'] }),
        createMockTrend({ trajectory: 'declining', confidence: 60, keywords: ['legacy'] }),
      ];

      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot(mockTrends));

      const stats = await adminGetTrendStats();

      expect(stats.total).toBe(5);
      expect(stats.emerging).toBe(2);
      expect(stats.growing).toBe(1);
      expect(stats.stable).toBe(1);
      expect(stats.declining).toBe(1);
      expect(stats.avgConfidence).toBe(78); // (80+90+85+75+60)/5 = 78
      expect(stats.topKeywords).toContain('AI');
      expect(stats.topKeywords).toContain('ML');
    });

    it('should rank top keywords by frequency', async () => {
      const mockTrends = [
        createMockTrend({ keywords: ['AI', 'ML', 'data'] }),
        createMockTrend({ keywords: ['AI', 'cloud'] }),
        createMockTrend({ keywords: ['AI', 'ML'] }),
      ];

      adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot(mockTrends));

      const stats = await adminGetTrendStats();

      expect(stats.topKeywords[0]).toBe('AI'); // Most frequent
      expect(stats.topKeywords[1]).toBe('ML');
    });

    it('should handle empty trends', async () => {
      const stats = await adminGetTrendStats();

      expect(stats.total).toBe(0);
      expect(stats.emerging).toBe(0);
      expect(stats.avgConfidence).toBe(0);
      expect(stats.topKeywords).toEqual([]);
    });
  });

  describe('computeTrajectory()', () => {
    it('should return emerging for few signals', () => {
      const counts: DailyCount[] = [
        { date: '2026-01-09', count: 2 },
        { date: '2026-01-08', count: 1 },
      ];

      const result = computeTrajectory(counts);

      expect(result).toBe('emerging');
    });

    it('should return stable for not enough data', () => {
      const counts: DailyCount[] = [
        { date: '2026-01-09', count: 3 },
        { date: '2026-01-08', count: 2 },
        { date: '2026-01-07', count: 3 },
      ];

      const result = computeTrajectory(counts);

      // Total is 8, which is >= 5, so with < 7 days it returns stable
      expect(result).toBe('stable');
    });

    it('should return growing for increasing trend', () => {
      const counts: DailyCount[] = [];
      // Create 14 days of data with growth pattern
      for (let i = 13; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        // Recent 7 days have more signals than previous 7
        counts.push({ date: dateStr, count: i < 7 ? 5 : 2 });
      }

      const result = computeTrajectory(counts);

      expect(result).toBe('growing');
    });

    it('should return declining for decreasing trend', () => {
      const counts: DailyCount[] = [];
      // Create 14 days of data with decline pattern
      for (let i = 13; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        // Previous 7 days have more signals than recent 7
        counts.push({ date: dateStr, count: i < 7 ? 2 : 5 });
      }

      const result = computeTrajectory(counts);

      expect(result).toBe('declining');
    });

    it('should return stable for consistent trend', () => {
      const counts: DailyCount[] = [];
      // Create 14 days of data with stable pattern
      for (let i = 13; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        counts.push({ date: dateStr, count: 5 });
      }

      const result = computeTrajectory(counts);

      expect(result).toBe('stable');
    });

    it('should return emerging when previous period has 0 signals', () => {
      const counts: DailyCount[] = [];
      // Create 14 days where previous 7 have 0 signals
      for (let i = 13; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        counts.push({ date: dateStr, count: i < 7 ? 3 : 0 });
      }

      const result = computeTrajectory(counts);

      expect(result).toBe('emerging');
    });
  });

  describe('buildDailyCounts()', () => {
    it('should build daily counts from signals', () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const signals = [
        { detectedAt: today.getTime() } as any,
        { detectedAt: today.getTime() } as any,
        { detectedAt: yesterday.getTime() } as any,
      ];

      const result = buildDailyCounts(signals, 7);

      expect(result).toHaveLength(7);
      // Find today's count
      const todayStr = today.toISOString().split('T')[0];
      const todayCount = result.find((d) => d.date === todayStr);
      expect(todayCount?.count).toBe(2);

      // Find yesterday's count
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const yesterdayCount = result.find((d) => d.date === yesterdayStr);
      expect(yesterdayCount?.count).toBe(1);
    });

    it('should initialize all dates with 0', () => {
      const result = buildDailyCounts([], 7);

      expect(result).toHaveLength(7);
      expect(result.every((d) => d.count === 0)).toBe(true);
    });

    it('should use default of 30 days', () => {
      const result = buildDailyCounts([]);

      expect(result).toHaveLength(30);
    });
  });
});
