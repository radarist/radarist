/**
 * Unit Tests for Pipeline AI Tools
 *
 * Tests AI tools for pipeline control:
 * - getPipelineStatus
 * - triggerPipeline
 * - getTrends
 * - getTrendDetails
 * - getTrendSummary
 *
 * @jest-environment node
 * @phase Phase 6: Daily Pipeline
 */

import type { ComputedTrend } from '../trends-core';

// Mock the inngest client
jest.mock('../inngest/client', () => ({
  inngest: {
    send: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock the trends-admin module
jest.mock('../trends-admin', () => ({
  adminGetTrends: jest.fn(),
  adminGetTrendStats: jest.fn(),
  adminGetTrendById: jest.fn(),
}));

// Mock the graph module
jest.mock('../graph', () => ({
  getGraphServiceHealth: jest.fn(),
}));

// Mock the pipeline module
jest.mock('../pipeline', () => ({
  getGraphRefreshStats: jest.fn(),
  verifyGraphIntegrity: jest.fn(),
}));

// Import mocked modules
import { inngest } from '../inngest/client';
import { adminGetTrends, adminGetTrendStats, adminGetTrendById } from '../trends-admin';
import { getGraphServiceHealth } from '../graph';
import { getGraphRefreshStats, verifyGraphIntegrity } from '../pipeline';

const mockInngestSend = inngest.send as jest.Mock;
const mockGetTrends = adminGetTrends as jest.Mock;
const mockGetTrendStats = adminGetTrendStats as jest.Mock;
const mockGetTrendById = adminGetTrendById as jest.Mock;
const mockGetGraphServiceHealth = getGraphServiceHealth as jest.Mock;
const mockGetGraphRefreshStats = getGraphRefreshStats as jest.Mock;
const mockVerifyGraphIntegrity = verifyGraphIntegrity as jest.Mock;

// Import functions after mocking
import {
  executeGetPipelineStatus,
  executeTriggerPipeline,
  executeGetTrends,
  executeGetTrendDetails,
  executeGetTrendSummary,
} from '../ai/tools/pipeline-tools';

/**
 * Helper to create a mock trend
 */
function createMockTrend(overrides?: Partial<ComputedTrend>): ComputedTrend {
  const now = Date.now();
  return {
    id: 'trend-123',
    name: 'AI in Food Tech',
    trajectory: 'emerging',
    signalCount: 15,
    confidence: 85,
    keywords: ['AI', 'food tech'],
    summary: 'AI solutions in food technology...',
    signalIds: ['s1', 's2'],
    dailyCounts: [
      { date: '2026-01-07', count: 5 },
      { date: '2026-01-08', count: 7 },
      { date: '2026-01-09', count: 3 },
    ],
    relatedEntities: {
      companies: ['TechCorp'],
      technologies: ['ML'],
    },
    lastComputedAt: now,
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now,
    ...overrides,
  };
}

describe('Pipeline AI Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executeGetPipelineStatus()', () => {
    it('should return pipeline status', async () => {
      mockGetGraphServiceHealth.mockResolvedValueOnce({
        healthy: true,
        backend: 'neo4j',
        latencyMs: 50,
      });

      const result = await executeGetPipelineStatus({});

      expect(result.success).toBe(true);
      expect(result.status.healthy).toBe(true);
      expect(result.status.graphHealth.healthy).toBe(true);
      expect(result.status.nextRunAt).toBeGreaterThan(Date.now());
    });

    it('should include graph stats when requested', async () => {
      mockGetGraphServiceHealth.mockResolvedValueOnce({
        healthy: true,
        backend: 'neo4j',
        latencyMs: 50,
      });
      mockGetGraphRefreshStats.mockResolvedValueOnce({
        nodeCount: 100,
        claimCount: 50,
        relationCount: 200,
      });

      const result = await executeGetPipelineStatus({ includeGraphStats: true });

      expect(result.success).toBe(true);
      expect(result.status.graphStats).toBeDefined();
      expect(result.status.graphStats?.nodes).toBe(100);
    });

    it('should include integrity check when requested', async () => {
      mockGetGraphServiceHealth.mockResolvedValueOnce({
        healthy: true,
        backend: 'neo4j',
        latencyMs: 50,
      });
      mockVerifyGraphIntegrity.mockResolvedValueOnce({
        healthy: true,
        issues: [],
      });

      const result = await executeGetPipelineStatus({ includeIntegrityCheck: true });

      expect(result.success).toBe(true);
      expect(result.status.integrityCheck).toBeDefined();
      expect(result.status.integrityCheck?.healthy).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockGetGraphServiceHealth.mockRejectedValueOnce(new Error('Graph service unavailable'));

      const result = await executeGetPipelineStatus({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Graph service unavailable');
    });
  });

  describe('executeTriggerPipeline()', () => {
    it('should trigger the pipeline', async () => {
      mockInngestSend.mockResolvedValueOnce(undefined);

      const result = await executeTriggerPipeline({ reason: 'Manual trigger for testing' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Pipeline triggered');
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/pipeline.trigger',
        data: expect.objectContaining({
          source: 'ai-assistant',
          reason: 'Manual trigger for testing',
        }),
      });
    });

    it('should use default reason if not provided', async () => {
      mockInngestSend.mockResolvedValueOnce(undefined);

      const result = await executeTriggerPipeline({});

      expect(result.success).toBe(true);
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/pipeline.trigger',
        data: expect.objectContaining({
          reason: 'Triggered via AI assistant',
        }),
      });
    });

    it('should handle trigger errors', async () => {
      mockInngestSend.mockRejectedValueOnce(new Error('Inngest error'));

      const result = await executeTriggerPipeline({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Inngest error');
    });
  });

  describe('executeGetTrends()', () => {
    it('should return trends', async () => {
      const mockTrends = [
        createMockTrend({ id: 'trend-1', name: 'Trend 1' }),
        createMockTrend({ id: 'trend-2', name: 'Trend 2' }),
      ];

      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrends({});

      expect(result.success).toBe(true);
      expect(result.trends).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by trajectory', async () => {
      const mockTrends = [
        createMockTrend({ trajectory: 'emerging' }),
        createMockTrend({ trajectory: 'growing' }),
        createMockTrend({ trajectory: 'emerging' }),
      ];

      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrends({ trajectory: 'emerging' });

      expect(result.success).toBe(true);
      expect(result.trends.every((t) => t.trajectory === 'emerging')).toBe(true);
    });

    it('should filter by keyword', async () => {
      const mockTrends = [
        createMockTrend({
          id: 'trend-1',
          name: 'Healthcare Innovation',
          keywords: ['healthcare', 'medicine'],
          summary: 'Medical technology advances',
        }),
        createMockTrend({
          id: 'trend-2',
          name: 'Blockchain Finance',
          keywords: ['blockchain', 'finance'],
          summary: 'Blockchain in finance sector',
        }),
      ];

      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrends({ keyword: 'healthcare' });

      expect(result.success).toBe(true);
      expect(result.total).toBe(1);
      expect(result.trends[0].name).toBe('Healthcare Innovation');
    });

    it('should respect limit parameter', async () => {
      const mockTrends = Array.from({ length: 20 }, (_, i) =>
        createMockTrend({ id: `trend-${i}`, confidence: 0.9 - i * 0.01 })
      );

      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrends({ limit: 5 });

      expect(result.success).toBe(true);
      expect(result.trends).toHaveLength(5);
    });

    it('should sort by confidence', async () => {
      const mockTrends = [
        createMockTrend({ confidence: 0.7 }),
        createMockTrend({ confidence: 0.9 }),
        createMockTrend({ confidence: 0.8 }),
      ];

      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrends({});

      expect(result.trends[0].confidence).toBe(0.9);
      expect(result.trends[1].confidence).toBe(0.8);
    });

    it('should handle errors gracefully', async () => {
      mockGetTrends.mockRejectedValueOnce(new Error('Database error'));

      const result = await executeGetTrends({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('executeGetTrendDetails()', () => {
    it('should return trend details', async () => {
      const mockTrend = createMockTrend();

      mockGetTrendById.mockResolvedValueOnce(mockTrend);

      const result = await executeGetTrendDetails({ trendId: 'trend-123' });

      expect(result.success).toBe(true);
      expect(result.trend).toEqual(mockTrend);
    });

    it('should require trend ID', async () => {
      const result = await executeGetTrendDetails({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Trend ID is required');
    });

    it('should handle non-existent trend', async () => {
      mockGetTrendById.mockResolvedValueOnce(null);

      const result = await executeGetTrendDetails({ trendId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle errors gracefully', async () => {
      mockGetTrendById.mockRejectedValueOnce(new Error('Database error'));

      const result = await executeGetTrendDetails({ trendId: 'trend-123' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('executeGetTrendSummary()', () => {
    it('should return trend summary', async () => {
      mockGetTrendStats.mockResolvedValueOnce({
        total: 10,
        emerging: 3,
        growing: 4,
        stable: 2,
        declining: 1,
      });

      const mockTrends = [
        createMockTrend({ keywords: ['AI', 'ML'] }),
        createMockTrend({ keywords: ['AI', 'blockchain'] }),
        createMockTrend({ keywords: ['cloud'] }),
      ];
      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrendSummary();

      expect(result.success).toBe(true);
      expect(result.summary.total).toBe(10);
      expect(result.summary.emerging).toBe(3);
      expect(result.summary.topKeywords).toContain('AI');
    });

    it('should calculate top keywords', async () => {
      mockGetTrendStats.mockResolvedValueOnce({
        total: 3,
        emerging: 1,
        growing: 1,
        stable: 1,
        declining: 0,
      });

      const mockTrends = [
        createMockTrend({ keywords: ['AI', 'ML', 'data'] }),
        createMockTrend({ keywords: ['AI', 'cloud'] }),
        createMockTrend({ keywords: ['AI', 'ML'] }),
      ];
      mockGetTrends.mockResolvedValueOnce(mockTrends);

      const result = await executeGetTrendSummary();

      expect(result.summary.topKeywords[0]).toBe('AI'); // Most frequent
    });

    it('should handle empty trends', async () => {
      mockGetTrendStats.mockResolvedValueOnce({
        total: 0,
        emerging: 0,
        growing: 0,
        stable: 0,
        declining: 0,
      });
      mockGetTrends.mockResolvedValueOnce([]);

      const result = await executeGetTrendSummary();

      expect(result.success).toBe(true);
      expect(result.summary.total).toBe(0);
      expect(result.summary.topKeywords).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      mockGetTrendStats.mockRejectedValueOnce(new Error('Database error'));

      const result = await executeGetTrendSummary();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle complete pipeline status check flow', async () => {
      mockGetGraphServiceHealth.mockResolvedValueOnce({
        healthy: true,
        backend: 'neo4j',
        latencyMs: 25,
      });
      mockGetGraphRefreshStats.mockResolvedValueOnce({
        nodeCount: 500,
        claimCount: 200,
        relationCount: 1000,
      });
      mockVerifyGraphIntegrity.mockResolvedValueOnce({
        healthy: true,
        issues: [],
      });

      const result = await executeGetPipelineStatus({
        includeGraphStats: true,
        includeIntegrityCheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.status.healthy).toBe(true);
      expect(result.status.graphStats?.nodes).toBe(500);
      expect(result.status.integrityCheck?.healthy).toBe(true);
    });

    it('should handle trend analysis flow', async () => {
      // First get summary
      mockGetTrendStats.mockResolvedValueOnce({
        total: 5,
        emerging: 2,
        growing: 2,
        stable: 1,
        declining: 0,
      });
      mockGetTrends.mockResolvedValueOnce([
        createMockTrend({ keywords: ['AI'] }),
        createMockTrend({ keywords: ['AI'] }),
      ]);

      const summaryResult = await executeGetTrendSummary();
      expect(summaryResult.success).toBe(true);

      // Then get emerging trends
      mockGetTrends.mockResolvedValueOnce([
        createMockTrend({ trajectory: 'emerging', id: 'trend-1' }),
        createMockTrend({ trajectory: 'emerging', id: 'trend-2' }),
      ]);

      const trendsResult = await executeGetTrends({ trajectory: 'emerging' });
      expect(trendsResult.success).toBe(true);
      expect(trendsResult.trends).toHaveLength(2);

      // Then get details of top trend
      mockGetTrendById.mockResolvedValueOnce(createMockTrend({ id: 'trend-1', name: 'Top Trend' }));

      const detailsResult = await executeGetTrendDetails({ trendId: 'trend-1' });
      expect(detailsResult.success).toBe(true);
      expect(detailsResult.trend?.name).toBe('Top Trend');
    });
  });
});
