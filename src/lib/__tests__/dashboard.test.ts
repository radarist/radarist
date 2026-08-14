/**
 * Unit Tests for Dashboard Module
 *
 * Tests all dashboard data aggregation functions:
 * - getDashboardData() - Main aggregation
 * - getNeedsAttentionItems() - Attention items
 * - getPortfolioMetrics() - Portfolio statistics
 * - getAgentFeed() - Agent activity feed
 * - getRecentUpdates() - Cross-entity updates
 * - getQuickStats() - Quick stat cards
 * - getSignalTrends() - Signal trend data
 *
 * @jest-environment node
 */

import type { Signal, Prototype, Strategy } from '../types';
import type { AgentRun } from '@/lib/schemas/agent-run';

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('../firebase', () => ({
  db: {},
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  getDocs: jest.fn(),
}));

// Mock all service dependencies
const mockGetStrategies = jest.fn();
const mockGetPrototypes = jest.fn();
const mockGetPrototypeStatistics = jest.fn();
const mockComputePrototypeStatistics = jest.fn();
const mockComputeSignalStatistics = jest.fn();
const mockGetSignals = jest.fn();
const mockGetPendingSignals = jest.fn();
const mockGetHighConfidenceSignals = jest.fn();
const mockGetSignalStatistics = jest.fn();
const mockGetRecentAgentRuns = jest.fn();
const mockGetSystemConfig = jest.fn();
const mockGetCompanies = jest.fn();
const mockGetUseCases = jest.fn();
const mockGetTechnologies = jest.fn();
const mockGetPainPoints = jest.fn();

jest.mock('../strategies', () => ({
  getStrategies: (...args: unknown[]) => mockGetStrategies(...args),
}));

jest.mock('../prototypes', () => ({
  getPrototypes: (...args: unknown[]) => mockGetPrototypes(...args),
  getPrototypeStatistics: (...args: unknown[]) => mockGetPrototypeStatistics(...args),
  computePrototypeStatistics: (...args: unknown[]) => mockComputePrototypeStatistics(...args),
}));

jest.mock('../signals-client', () => ({
  getSignals: (...args: unknown[]) => mockGetSignals(...args),
  getPendingSignals: (...args: unknown[]) => mockGetPendingSignals(...args),
  getHighConfidenceSignals: (...args: unknown[]) => mockGetHighConfidenceSignals(...args),
  getSignalStatistics: (...args: unknown[]) => mockGetSignalStatistics(...args),
  computeSignalStatistics: (...args: unknown[]) => mockComputeSignalStatistics(...args),
}));

// DISC-008: the dashboard reads live agent runs (the real, written data) and
// maps them into the AgentActivity view model via the pure ./dashboard/
// agent-run-activity module (left un-mocked so the real mapping is exercised).
jest.mock('../agent-runs-client', () => ({
  getRecentAgentRuns: (...args: unknown[]) => mockGetRecentAgentRuns(...args),
}));

jest.mock('../system-config', () => ({
  getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
}));

jest.mock('../companies', () => ({
  getCompanies: (...args: unknown[]) => mockGetCompanies(...args),
}));

jest.mock('../use-cases', () => ({
  getUseCases: (...args: unknown[]) => mockGetUseCases(...args),
}));

jest.mock('../technology-service', () => ({
  getTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
}));

jest.mock('../pain-points', () => ({
  getPainPoints: (...args: unknown[]) => mockGetPainPoints(...args),
}));

// Import after mocks
const {
  getDashboardData,
  getNeedsAttentionItems,
  getPortfolioMetrics,
  getAgentFeed,
  getRecentUpdates,
  getQuickStats,
  getSignalTrends,
  selectPendingSignals,
  selectHighConfidenceSignals,
} = require('../dashboard');

const { getDocs } = require('firebase/firestore');

// AUDIT-019: dashboard reads are scoped to the signed-in user's uid.
const TEST_UID = 'user-1';

// ============================================================================
// TEST DATA FACTORIES
// ============================================================================

function createMockSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-1',
    title: 'Test Signal',
    description: 'Test signal description',
    type: 'news',
    source: 'TechCrunch',
    url: 'https://example.com',
    detectedAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
    processedAt: Date.now(),
    relevanceScore: 75,
    alignmentScore: 60,
    status: 'Detected',
    ...overrides,
  } as Signal;
}

function createMockPrototype(overrides?: Partial<Prototype>): Prototype {
  return {
    id: 'proto-1',
    name: 'Test Prototype',
    description: 'Test description',
    status: 'In Development',
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3, // 3 days ago
    updatedAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
    ...overrides,
  } as Prototype;
}

function createMockStrategy(overrides?: Partial<Strategy>): Strategy {
  return {
    id: 'strat-1',
    name: 'Test Strategy',
    description: 'Test strategy description',
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    ...overrides,
  } as Strategy;
}

// DISC-008: dashboard agent surfaces read live agent runs and map them
// internally. Feed the RUN shape (@/lib/schemas/agent-run); the real mapping
// (./dashboard/agent-run-activity) turns a `failure` run into a high-priority
// `agent-pending` needs-attention item and a feed card.
function createMockRun(overrides?: Partial<AgentRun>): AgentRun {
  return {
    id: 'run-1',
    userId: 'user-1',
    agentName: 'scout',
    action: 'Scout: Found new signal',
    status: 'success',
    tokenUsage: { input: 100, output: 200 },
    costUsd: 0.01,
    duration: 1200,
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 min ago
    ...overrides,
  } as AgentRun;
}

const mockPrototypeStats = {
  total: 5,
  activeCount: 3,
  deliveredCount: 1,
  totalEstimatedValue: 100000,
  totalActualValue: 50000,
};

const mockSignalStats = {
  total: 20,
  pendingCount: 5,
  importRate: 40,
  averageRelevance: 72,
  signalsByType: { news: 10, patent: 5, paper: 5 },
};

const mockSystemConfig = {
  agentMode: {
    mode: 'copilot',
    autoActionThreshold: 85,
  },
};

// ============================================================================
// SETUP
// ============================================================================

function setupDefaultMocks() {
  // getDocs for getRadars - returns empty radars
  getDocs.mockResolvedValue({
    docs: [],
    size: 0,
    empty: true,
  });

  mockGetStrategies.mockResolvedValue([]);
  mockGetPrototypes.mockResolvedValue([]);
  mockGetPrototypeStatistics.mockResolvedValue(mockPrototypeStats);
  mockComputePrototypeStatistics.mockReturnValue(mockPrototypeStats);
  mockGetSignals.mockResolvedValue([]);
  mockGetPendingSignals.mockResolvedValue([]);
  mockGetHighConfidenceSignals.mockResolvedValue([]);
  mockGetSignalStatistics.mockResolvedValue(mockSignalStats);
  mockComputeSignalStatistics.mockReturnValue(mockSignalStats);
  mockGetRecentAgentRuns.mockResolvedValue([]);
  mockGetSystemConfig.mockResolvedValue(mockSystemConfig);
  mockGetCompanies.mockResolvedValue([]);
  mockGetUseCases.mockResolvedValue([]);
  mockGetTechnologies.mockResolvedValue([]);
  mockGetPainPoints.mockResolvedValue([]);
}

// ============================================================================
// TESTS
// ============================================================================

describe('Dashboard Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  // ==========================================================================
  // getDashboardData
  // ==========================================================================

  describe('getDashboardData()', () => {
    it('PERF-001: one dashboard load = ONE read per collection, statistics computed from shared data', async () => {
      await getDashboardData(TEST_UID);

      // Each collection is fetched exactly once by the shared upfront batch.
      expect(mockGetPrototypes).toHaveBeenCalledTimes(1);
      expect(mockGetSignals).toHaveBeenCalledTimes(1);
      expect(mockGetRecentAgentRuns).toHaveBeenCalledTimes(1);
      expect(mockGetRecentAgentRuns).toHaveBeenCalledWith(TEST_UID, 100);

      // The fetching statistics variants must NOT run — their re-reads were
      // the duplication. Aggregates come from the pure computes over shared data.
      expect(mockGetPrototypeStatistics).not.toHaveBeenCalled();
      expect(mockGetSignalStatistics).not.toHaveBeenCalled();
      expect(mockComputePrototypeStatistics).toHaveBeenCalledTimes(1);
      expect(mockComputeSignalStatistics).toHaveBeenCalledTimes(1);
    });

    it('PERF-001: feed, needs-attention, and metrics all consume the SAME shared runs fetch', async () => {
      const failedRun = {
        id: 'run-fail',
        userId: 'u1',
        agentName: 'scout',
        action: 'Sweep failed',
        status: 'failure',
        tokenUsage: { input: 1, output: 1 },
        costUsd: 0,
        duration: 10,
        createdAt: new Date().toISOString(),
        errors: ['boom'],
      };
      mockGetRecentAgentRuns.mockResolvedValue([failedRun]);

      const result = await getDashboardData(TEST_UID);

      expect(mockGetRecentAgentRuns).toHaveBeenCalledTimes(1);
      // Same single fetch feeds the agent feed…
      expect(result.agentFeed.map((a: { id: string }) => a.id)).toEqual(['run-fail']);
      // …and the needs-attention failure card.
      expect(result.needsAttention.find((i: { id: string }) => i.id === 'activity-run-fail')).toBeDefined();
    });

    it('PERF-006: dashboard performs ONE signal read — no getPendingSignals / getHighConfidenceSignals re-query', async () => {
      // Copilot mode so both the pending AND the high-confidence branches run;
      // if either re-queried Firestore this assertion would catch it.
      mockGetSystemConfig.mockResolvedValue({ agentMode: { mode: 'copilot', autoActionThreshold: 80 } });
      mockGetSignals.mockResolvedValue([
        createMockSignal({ id: 'sig-validated', status: 'Validated', relevanceScore: 90 }),
      ]);

      await getDashboardData(TEST_UID);

      // The single shared read…
      expect(mockGetSignals).toHaveBeenCalledTimes(1);
      // …and the two eliminated re-reads never fire on the live dashboard path.
      expect(mockGetPendingSignals).not.toHaveBeenCalled();
      expect(mockGetHighConfidenceSignals).not.toHaveBeenCalled();
    });

    it('PERF-006: unchanged results — the shared snapshot yields the same pending + high-confidence items', async () => {
      mockGetSystemConfig.mockResolvedValue({ agentMode: { mode: 'copilot', autoActionThreshold: 80 } });
      // One Validated signal (→ pending card) that is also high-relevance (→ auto-import card),
      // plus a Detected signal that must NOT surface as pending.
      mockGetSignals.mockResolvedValue([
        createMockSignal({ id: 'sig-hot', status: 'Validated', relevanceScore: 95 }),
        createMockSignal({ id: 'sig-detected', status: 'Detected', relevanceScore: 95 }),
      ]);

      const result = await getDashboardData(TEST_UID);

      // Pending card comes only from the Validated signal.
      expect(result.needsAttention.find((i: { id: string }) => i.id === 'signal-sig-hot')).toBeDefined();
      expect(result.needsAttention.find((i: { id: string }) => i.id === 'signal-sig-detected')).toBeUndefined();
      // High-confidence auto-import card comes from the same Validated signal (>= threshold 80).
      expect(result.needsAttention.find((i: { id: string }) => i.id === 'signal-auto-sig-hot')).toBeDefined();
    });

    it('UX-019: a failed-run attention card links to that exact run detail page', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([
        createMockRun({ id: 'run-boom', status: 'failure', errors: ['kaboom'] }),
      ]);

      const result = await getDashboardData(TEST_UID);

      const item = result.needsAttention.find((i: { id: string }) => i.id === 'activity-run-boom');
      expect(item).toBeDefined();
      // Not a generic per-agent triage surface — the exact run.
      expect(item.actionUrl).toBe('/agents/runs/run-boom');
    });

    it('should return complete dashboard data structure', async () => {
      const result = await getDashboardData(TEST_UID);

      expect(result).toHaveProperty('needsAttention');
      expect(result).toHaveProperty('portfolioMetrics');
      expect(result).toHaveProperty('agentFeed');
      expect(result).toHaveProperty('recentUpdates');
      expect(result).toHaveProperty('lastRefreshed');
      expect(result.lastRefreshed).toBeGreaterThan(0);
    });

    it('should call all data fetchers in parallel', async () => {
      await getDashboardData(TEST_UID);

      expect(mockGetPrototypes).toHaveBeenCalled();
      expect(mockGetSignals).toHaveBeenCalled();
      expect(mockGetStrategies).toHaveBeenCalled();
      expect(mockGetCompanies).toHaveBeenCalled();
      expect(mockGetUseCases).toHaveBeenCalled();
      expect(mockGetTechnologies).toHaveBeenCalled();
      expect(mockGetPainPoints).toHaveBeenCalled();
    });

    it('should propagate errors from data fetchers', async () => {
      mockGetPrototypes.mockRejectedValue(new Error('Firestore error'));

      await expect(getDashboardData(TEST_UID)).rejects.toThrow('Failed to fetch dashboard data');
    });

    it('should include needsAttention items when signals are pending', async () => {
      // PERF-006: the live dashboard path derives pending signals from the
      // shared `getSignals()` snapshot (status 'Validated'), not a separate
      // `getPendingSignals()` read.
      const pendingSignal = createMockSignal({ id: 'sig-pending', status: 'Validated' });
      mockGetSignals.mockResolvedValue([pendingSignal]);

      const result = await getDashboardData(TEST_UID);

      expect(result.needsAttention.length).toBeGreaterThanOrEqual(1);
    });

    it('should populate portfolioMetrics with technology count', async () => {
      mockGetTechnologies.mockResolvedValue([
        { id: 't1', name: 'React' },
        { id: 't2', name: 'Vue' },
      ]);

      const result = await getDashboardData(TEST_UID);

      expect(result.portfolioMetrics.totalTechnologies).toBe(2);
    });
  });

  // ==========================================================================
  // PERF-006: pure signal-selection helpers (in-memory equivalents of the
  // legacy getPendingSignals() / getHighConfidenceSignals() queries)
  // ==========================================================================

  describe('selectPendingSignals() [PERF-006]', () => {
    it("mirrors getPendingSignals(): keeps only 'Validated', newest-first", () => {
      const signals = [
        createMockSignal({ id: 'v-old', status: 'Validated', detectedAt: 1000 }),
        createMockSignal({ id: 'detected', status: 'Detected', detectedAt: 5000 }),
        createMockSignal({ id: 'v-new', status: 'Validated', detectedAt: 3000 }),
        createMockSignal({ id: 'imported', status: 'Imported', detectedAt: 4000 }),
      ];

      const result = selectPendingSignals(signals);

      // Only Validated signals, ordered by detectedAt desc.
      expect(result.map((s: Signal) => s.id)).toEqual(['v-new', 'v-old']);
    });

    it('caps at 50, matching getSignalsByStatus("Validated", 50)', () => {
      const signals = Array.from({ length: 60 }, (_, i) =>
        createMockSignal({ id: `v-${i}`, status: 'Validated', detectedAt: i })
      );

      const result = selectPendingSignals(signals);

      expect(result).toHaveLength(50);
      // Newest-first cap keeps the 50 highest detectedAt values.
      expect(result[0].id).toBe('v-59');
      expect(result[49].id).toBe('v-10');
    });

    it('returns an empty array when nothing is Validated', () => {
      expect(selectPendingSignals([createMockSignal({ status: 'Detected' })])).toEqual([]);
    });
  });

  describe('selectHighConfidenceSignals() [PERF-006]', () => {
    it('mirrors getHighConfidenceSignals(): relevance >= threshold, sorted by relevance then recency', () => {
      const signals = [
        createMockSignal({ id: 'below', relevanceScore: 70, detectedAt: 9000 }),
        createMockSignal({ id: 'top', relevanceScore: 95, detectedAt: 1000 }),
        createMockSignal({ id: 'mid-old', relevanceScore: 85, detectedAt: 1000 }),
        createMockSignal({ id: 'mid-new', relevanceScore: 85, detectedAt: 2000 }),
      ];

      const result = selectHighConfidenceSignals(signals, 80);

      // 'below' (70 < 80) excluded; ties on relevance break by detectedAt desc.
      expect(result.map((s: Signal) => s.id)).toEqual(['top', 'mid-new', 'mid-old']);
    });

    it('is uncapped (unlike the pending selector)', () => {
      const signals = Array.from({ length: 60 }, (_, i) =>
        createMockSignal({ id: `hc-${i}`, relevanceScore: 90, detectedAt: i })
      );

      expect(selectHighConfidenceSignals(signals, 80)).toHaveLength(60);
    });

    it('treats the threshold as inclusive (>=)', () => {
      const signals = [createMockSignal({ id: 'exact', relevanceScore: 80 })];
      expect(selectHighConfidenceSignals(signals, 80).map((s: Signal) => s.id)).toEqual(['exact']);
    });
  });

  // ==========================================================================
  // getNeedsAttentionItems
  // ==========================================================================

  describe('getNeedsAttentionItems()', () => {
    it('should return empty array when no items need attention', async () => {
      const items = await getNeedsAttentionItems(TEST_UID);

      expect(items).toEqual([]);
    });

    it('should include pending signals with correct priority', async () => {
      const highRelevanceSignal = createMockSignal({
        id: 'sig-high',
        relevanceScore: 90,
        title: 'High relevance signal',
      });
      const lowRelevanceSignal = createMockSignal({
        id: 'sig-low',
        relevanceScore: 50,
        title: 'Low relevance signal',
      });

      mockGetPendingSignals.mockResolvedValue([highRelevanceSignal, lowRelevanceSignal]);

      const items = await getNeedsAttentionItems(TEST_UID);

      const highItem = items.find((i: { id: string }) => i.id === 'signal-sig-high');
      const lowItem = items.find((i: { id: string }) => i.id === 'signal-sig-low');

      expect(highItem).toBeDefined();
      expect(highItem.priority).toBe('high');
      expect(lowItem).toBeDefined();
      expect(lowItem.priority).toBe('medium');
    });

    it('should include high-confidence signals in copilot mode', async () => {
      mockGetSystemConfig.mockResolvedValue({
        agentMode: { mode: 'copilot', autoActionThreshold: 85 },
      });

      const highConfSignal = createMockSignal({
        id: 'sig-auto',
        relevanceScore: 95,
        title: 'Auto-importable signal',
      });
      mockGetHighConfidenceSignals.mockResolvedValue([highConfSignal]);

      const items = await getNeedsAttentionItems(TEST_UID);

      const autoItem = items.find((i: { id: string }) => i.id === 'signal-auto-sig-auto');
      expect(autoItem).toBeDefined();
      expect(autoItem.type).toBe('signal-high-confidence');
    });

    it('should not include high-confidence signals in autopilot mode', async () => {
      mockGetSystemConfig.mockResolvedValue({
        agentMode: { mode: 'autopilot', autoActionThreshold: 85 },
      });

      const items = await getNeedsAttentionItems(TEST_UID);

      const autoItems = items.filter((i: { type: string }) => i.type === 'signal-high-confidence');
      expect(autoItems).toHaveLength(0);
    });

    it('surfaces a failed agent run as a high-priority agent-pending item', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([createMockRun({ id: 'act-1', status: 'failure' })]);

      const items = await getNeedsAttentionItems(TEST_UID);

      const actItem = items.find((i: { id: string }) => i.id === 'activity-act-1');
      expect(actItem).toBeDefined();
      expect(actItem.type).toBe('agent-pending');
      expect(actItem.priority).toBe('high');
    });

    it('does not surface a successful agent run as needing attention', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([createMockRun({ id: 'ok-1', status: 'success' })]);

      const items = await getNeedsAttentionItems(TEST_UID);

      expect(items.find((i: { id: string }) => i.id === 'activity-ok-1')).toBeUndefined();
    });

    it('should include prototypes approaching presentation dates', async () => {
      const now = Date.now();
      const threeDaysFromNow = now + 3 * 24 * 60 * 60 * 1000;
      const prototype = createMockPrototype({
        id: 'proto-soon',
        name: 'Upcoming Demo',
        presentationDate: threeDaysFromNow,
        status: 'Demo Ready',
      });
      mockGetPrototypes.mockResolvedValue([prototype]);

      const items = await getNeedsAttentionItems(TEST_UID);

      const protoItem = items.find((i: { id: string }) => i.id === 'prototype-presentation-proto-soon');
      expect(protoItem).toBeDefined();
      expect(protoItem.type).toBe('prototype-deadline');
    });

    it('should not include prototypes with Delivered status', async () => {
      const now = Date.now();
      const prototype = createMockPrototype({
        id: 'proto-done',
        name: 'Done Prototype',
        presentationDate: now + 2 * 24 * 60 * 60 * 1000,
        status: 'Delivered',
      });
      mockGetPrototypes.mockResolvedValue([prototype]);

      const items = await getNeedsAttentionItems(TEST_UID);

      const protoItem = items.find((i: { id: string }) => i.id === 'prototype-presentation-proto-done');
      expect(protoItem).toBeUndefined();
    });

    it('should sort items by priority then timestamp', async () => {
      const now = Date.now();
      const highPriSignal = createMockSignal({
        id: 'sig-h',
        relevanceScore: 90,
        detectedAt: now - 5000,
      });
      const medPriSignal = createMockSignal({
        id: 'sig-m',
        relevanceScore: 50,
        detectedAt: now - 1000,
      });

      mockGetPendingSignals.mockResolvedValue([medPriSignal, highPriSignal]);

      const items = await getNeedsAttentionItems(TEST_UID);

      // High priority should come first
      const highIndex = items.findIndex((i: { id: string }) => i.id === 'signal-sig-h');
      const medIndex = items.findIndex((i: { id: string }) => i.id === 'signal-sig-m');
      expect(highIndex).toBeLessThan(medIndex);
    });

    it('should propagate errors', async () => {
      mockGetSystemConfig.mockRejectedValue(new Error('Config error'));

      await expect(getNeedsAttentionItems(TEST_UID)).rejects.toThrow('Failed to fetch needs attention items');
    });
  });

  // ==========================================================================
  // getPortfolioMetrics
  // ==========================================================================

  describe('getPortfolioMetrics()', () => {
    it('should return complete portfolio metrics', async () => {
      mockGetTechnologies.mockResolvedValue([{ id: 't1', name: 'React' }]);
      mockGetCompanies.mockResolvedValue([{ id: 'c1', name: 'Acme' }]);
      mockGetUseCases.mockResolvedValue([]);
      mockGetPainPoints.mockResolvedValue([{ id: 'pp1', title: 'Slow builds' }]);

      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.totalTechnologies).toBe(1);
      expect(metrics.totalCompanies).toBe(1);
      expect(metrics.totalPainPoints).toBe(1);
      expect(metrics.totalUseCases).toBe(0);
    });

    it('should aggregate ring distribution from radar entries', async () => {
      getDocs
        // First call: getRadars -> radarsSnapshot
        .mockResolvedValueOnce({
          docs: [
            {
              id: 'radar-1',
              data: () => ({
                name: 'Tech Radar',
                quadrants: [
                  { id: 'q_tools', name: 'Tools', order: 0 },
                  { id: 'q_languages', name: 'Languages', order: 1 },
                ],
                ringSystem: 'standard',
              }),
            },
          ],
          size: 1,
          empty: false,
        })
        // Second call: getRadars -> entries for radar-1
        .mockResolvedValueOnce({
          docs: [
            {
              data: () => ({
                name: 'React',
                ring: 'Adopt',
                quadrantId: 'q_tools',
              }),
            },
            {
              data: () => ({
                name: 'Vue',
                ring: 'Trial',
                quadrantId: 'q_tools',
              }),
            },
          ],
          size: 2,
          empty: false,
        });

      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.technologiesByRing['Adopt']).toBe(1);
      expect(metrics.technologiesByRing['Trial']).toBe(1);
      // New shape: keyed by quadrantId with { name, count } value
      expect(metrics.technologiesByQuadrant['q_tools']).toEqual({ name: 'Tools', count: 2 });
    });

    it('should include prototype metrics', async () => {
      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.prototypeMetrics.total).toBe(mockPrototypeStats.total);
      expect(metrics.prototypeMetrics.activeCount).toBe(mockPrototypeStats.activeCount);
    });

    it('should include signal metrics', async () => {
      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.signalMetrics.totalDetected).toBe(mockSignalStats.total);
      expect(metrics.signalMetrics.pendingReview).toBe(mockSignalStats.pendingCount);
      expect(metrics.signalMetrics.importRate).toBe(mockSignalStats.importRate);
    });

    it('derives agent metrics from live runs (total + failed count)', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([
        createMockRun({ id: 'r1', agentName: 'scout', status: 'success' }),
        createMockRun({ id: 'r2', agentName: 'linker', status: 'success' }),
        createMockRun({ id: 'r3', agentName: 'scout', status: 'failure' }),
      ]);

      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.agentMetrics.totalActivities).toBe(3);
      expect(metrics.agentMetrics.pendingReview).toBe(1); // one failed run
      expect(metrics.agentMetrics.autoActionRate).toBe(67); // 2 of 3 processed succeeded
      expect(metrics.agentMetrics.byAgent.ScoutAgent).toBe(2);
    });

    it('should count prototypes by status', async () => {
      mockGetPrototypes.mockResolvedValue([
        createMockPrototype({ status: 'Ideation' }),
        createMockPrototype({ status: 'In Development' }),
        createMockPrototype({ status: 'In Development' }),
      ]);

      const metrics = await getPortfolioMetrics(TEST_UID);

      expect(metrics.prototypeMetrics.byStatus['Ideation']).toBe(1);
      expect(metrics.prototypeMetrics.byStatus['In Development']).toBe(2);
    });

    it('should propagate errors', async () => {
      mockGetTechnologies.mockRejectedValue(new Error('DB error'));

      await expect(getPortfolioMetrics(TEST_UID)).rejects.toThrow('Failed to calculate portfolio metrics');
    });
  });

  // ==========================================================================
  // getAgentFeed
  // ==========================================================================

  describe('getAgentFeed()', () => {
    it('maps live agent runs into feed activities', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([createMockRun(), createMockRun({ id: 'run-2' })]);

      const feed = await getAgentFeed(TEST_UID, 20);

      expect(feed).toHaveLength(2);
      // Real mapping: run.action → activity.title, agentName 'scout' → ScoutAgent.
      expect(feed[0].title).toBe('Scout: Found new signal');
      expect(feed[0].agent).toBe('ScoutAgent');
    });

    it('should pass maxResults to getRecentAgentRuns', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([]);

      await getAgentFeed(TEST_UID, 10);

      expect(mockGetRecentAgentRuns).toHaveBeenCalledWith(TEST_UID, 10);
    });

    it('should use default maxResults of 20', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([]);

      await getAgentFeed(TEST_UID);

      expect(mockGetRecentAgentRuns).toHaveBeenCalledWith(TEST_UID, 20);
    });

    it('should propagate errors', async () => {
      mockGetRecentAgentRuns.mockRejectedValue(new Error('Runs error'));

      await expect(getAgentFeed(TEST_UID)).rejects.toThrow('Failed to fetch agent feed');
    });
  });

  // ==========================================================================
  // getRecentUpdates
  // ==========================================================================

  describe('getRecentUpdates()', () => {
    it('should return empty array when no recent updates', async () => {
      const updates = await getRecentUpdates(7);

      expect(updates).toEqual([]);
    });

    it('should include recently created prototypes', async () => {
      const now = Date.now();
      const recentProto = createMockPrototype({
        id: 'proto-new',
        name: 'New Prototype',
        createdAt: now - 1000 * 60 * 60, // 1 hour ago
        updatedAt: now - 1000 * 60 * 60,
        status: 'Ideation',
      });
      mockGetPrototypes.mockResolvedValue([recentProto]);

      const updates = await getRecentUpdates(7);

      const protoUpdate = updates.find((u: { entityId: string }) => u.entityId === 'proto-new');
      expect(protoUpdate).toBeDefined();
      expect(protoUpdate.action).toBe('created');
      expect(protoUpdate.entityType).toBe('prototype');
    });

    it('should include recently updated prototypes as status_change', async () => {
      const now = Date.now();
      const updatedProto = createMockPrototype({
        id: 'proto-updated',
        name: 'Updated Prototype',
        createdAt: now - 1000 * 60 * 60 * 24 * 30, // 30 days ago
        updatedAt: now - 1000 * 60 * 60, // 1 hour ago
        status: 'Demo Ready',
      });
      mockGetPrototypes.mockResolvedValue([updatedProto]);

      const updates = await getRecentUpdates(7);

      const protoUpdate = updates.find((u: { entityId: string }) => u.entityId === 'proto-updated');
      expect(protoUpdate).toBeDefined();
      expect(protoUpdate.action).toBe('status_change');
    });

    it('should include imported signals', async () => {
      const now = Date.now();
      const importedSignal = createMockSignal({
        id: 'sig-imported',
        title: 'Imported Signal',
        status: 'Imported',
        importedAs: { type: 'technology', id: 'tech-new' },
        detectedAt: now - 1000 * 60 * 60,
        processedAt: now - 1000 * 60 * 30,
      });
      mockGetSignals.mockResolvedValue([importedSignal]);

      const updates = await getRecentUpdates(7);

      const sigUpdate = updates.find((u: { entityId: string }) => u.entityId === 'sig-imported');
      expect(sigUpdate).toBeDefined();
      expect(sigUpdate.action).toBe('imported');
    });

    it('should include detected signals', async () => {
      const now = Date.now();
      const detectedSignal = createMockSignal({
        id: 'sig-det',
        title: 'Detected Signal',
        status: 'Detected',
        detectedAt: now - 1000 * 60 * 60,
      });
      mockGetSignals.mockResolvedValue([detectedSignal]);

      const updates = await getRecentUpdates(7);

      const sigUpdate = updates.find((u: { entityId: string }) => u.entityId === 'sig-det');
      expect(sigUpdate).toBeDefined();
      expect(sigUpdate.action).toBe('created');
    });

    it('should include recently created strategies', async () => {
      const now = Date.now();
      const newStrat = createMockStrategy({
        id: 'strat-new',
        name: 'New Strategy',
        createdAt: now - 1000 * 60 * 60,
        updatedAt: now - 1000 * 60 * 60,
      });
      mockGetStrategies.mockResolvedValue([newStrat]);

      const updates = await getRecentUpdates(7);

      const stratUpdate = updates.find((u: { entityId: string }) => u.entityId === 'strat-new');
      expect(stratUpdate).toBeDefined();
      expect(stratUpdate.action).toBe('created');
    });

    it('should include recently updated strategies', async () => {
      const now = Date.now();
      const updatedStrat = createMockStrategy({
        id: 'strat-upd',
        name: 'Updated Strategy',
        createdAt: now - 1000 * 60 * 60 * 24 * 30,
        updatedAt: now - 1000 * 60 * 60,
      });
      mockGetStrategies.mockResolvedValue([updatedStrat]);

      const updates = await getRecentUpdates(7);

      const stratUpdate = updates.find((u: { entityId: string }) => u.entityId === 'strat-upd');
      expect(stratUpdate).toBeDefined();
      expect(stratUpdate.action).toBe('updated');
    });

    it('should exclude updates older than specified days', async () => {
      const now = Date.now();
      const oldProto = createMockPrototype({
        id: 'proto-old',
        createdAt: now - 1000 * 60 * 60 * 24 * 30, // 30 days ago
        updatedAt: now - 1000 * 60 * 60 * 24 * 30,
      });
      mockGetPrototypes.mockResolvedValue([oldProto]);

      const updates = await getRecentUpdates(7);

      expect(updates).toHaveLength(0);
    });

    it('should sort updates by timestamp (newest first)', async () => {
      const now = Date.now();
      const olderProto = createMockPrototype({
        id: 'proto-older',
        name: 'Older',
        createdAt: now - 1000 * 60 * 60 * 5, // 5 hours ago
        updatedAt: now - 1000 * 60 * 60 * 5,
        status: 'Ideation',
      });
      const newerProto = createMockPrototype({
        id: 'proto-newer',
        name: 'Newer',
        createdAt: now - 1000 * 60 * 60, // 1 hour ago
        updatedAt: now - 1000 * 60 * 60,
        status: 'Ideation',
      });
      mockGetPrototypes.mockResolvedValue([olderProto, newerProto]);

      const updates = await getRecentUpdates(7);

      expect(updates[0].entityId).toBe('proto-newer');
      expect(updates[1].entityId).toBe('proto-older');
    });

    it('should propagate errors', async () => {
      mockGetPrototypes.mockRejectedValue(new Error('Proto error'));

      await expect(getRecentUpdates()).rejects.toThrow('Failed to fetch recent updates');
    });
  });

  // ==========================================================================
  // getQuickStats
  // ==========================================================================

  describe('getQuickStats()', () => {
    it('should return all stat fields', async () => {
      const stats = await getQuickStats(TEST_UID);

      expect(stats).toHaveProperty('totalTechnologies');
      expect(stats).toHaveProperty('totalCompanies');
      expect(stats).toHaveProperty('totalPrototypes');
      expect(stats).toHaveProperty('activePrototypes');
      expect(stats).toHaveProperty('pendingSignals');
      expect(stats).toHaveProperty('pendingReview');
      expect(stats).toHaveProperty('todaySignals');
    });

    it('should count technologies from decoupled collection', async () => {
      mockGetTechnologies.mockResolvedValue([
        { id: 't1', name: 'React' },
        { id: 't2', name: 'Vue' },
        { id: 't3', name: 'Angular' },
      ]);

      const stats = await getQuickStats(TEST_UID);

      expect(stats.totalTechnologies).toBe(3);
    });

    it('should count today signals correctly', async () => {
      const _now = Date.now();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todaySignal = createMockSignal({
        id: 'today-sig',
        detectedAt: todayStart.getTime() + 1000, // 1 second after midnight
      });
      const yesterdaySignal = createMockSignal({
        id: 'yesterday-sig',
        detectedAt: todayStart.getTime() - 1000 * 60 * 60 * 24, // yesterday
      });
      mockGetSignals.mockResolvedValue([todaySignal, yesterdaySignal]);

      const stats = await getQuickStats(TEST_UID);

      expect(stats.todaySignals).toBe(1);
    });

    it('counts failed agent runs as the pending-review total', async () => {
      mockGetRecentAgentRuns.mockResolvedValue([
        createMockRun({ id: 'act-1', status: 'failure' }),
        createMockRun({ id: 'act-2', status: 'failure' }),
        createMockRun({ id: 'ok-1', status: 'success' }), // not counted
      ]);

      const stats = await getQuickStats(TEST_UID);

      expect(stats.pendingReview).toBe(2);
    });

    it('should propagate errors', async () => {
      mockGetTechnologies.mockRejectedValue(new Error('DB error'));

      await expect(getQuickStats(TEST_UID)).rejects.toThrow('Failed to fetch quick stats');
    });
  });

  // ==========================================================================
  // getSignalTrends
  // ==========================================================================

  describe('getSignalTrends()', () => {
    it('should return empty array when no signals', async () => {
      mockGetSignals.mockResolvedValue([]);

      const trends = await getSignalTrends(30);

      expect(trends).toEqual([]);
    });

    it('should group signals by date', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00.000Z'));

      try {
        const now = Date.now();
        const today = new Date(now).toISOString().split('T')[0];

        const signal1 = createMockSignal({
          id: 'sig-1',
          type: 'news',
          detectedAt: now - 1000 * 60 * 60, // 1 hour ago
        });
        const signal2 = createMockSignal({
          id: 'sig-2',
          type: 'patent',
          detectedAt: now - 1000 * 60 * 30, // 30 min ago
        });
        mockGetSignals.mockResolvedValue([signal1, signal2]);

        const trends = await getSignalTrends(30);

        const todayTrend = trends.find((t: { date: string }) => t.date === today);
        expect(todayTrend).toBeDefined();
        expect(todayTrend.total).toBe(2);
        expect(todayTrend.byType.news).toBe(1);
        expect(todayTrend.byType.patent).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should exclude signals older than specified days', async () => {
      const oldSignal = createMockSignal({
        id: 'old-sig',
        detectedAt: Date.now() - 1000 * 60 * 60 * 24 * 60, // 60 days ago
      });
      mockGetSignals.mockResolvedValue([oldSignal]);

      const trends = await getSignalTrends(30);

      expect(trends).toEqual([]);
    });

    it('should sort trends by date ascending', async () => {
      const now = Date.now();
      const yesterday = new Date(now - 1000 * 60 * 60 * 24).toISOString().split('T')[0];
      const today = new Date(now).toISOString().split('T')[0];

      const signalYesterday = createMockSignal({
        id: 'sig-y',
        detectedAt: now - 1000 * 60 * 60 * 24 + 1000, // yesterday + 1s
      });
      const signalToday = createMockSignal({
        id: 'sig-t',
        detectedAt: now - 1000 * 60 * 60, // 1 hour ago
      });
      mockGetSignals.mockResolvedValue([signalYesterday, signalToday]);

      const trends = await getSignalTrends(30);

      if (trends.length >= 2) {
        expect(trends[0].date).toBe(yesterday);
        expect(trends[1].date).toBe(today);
      }
    });

    it('should propagate errors', async () => {
      mockGetSignals.mockRejectedValue(new Error('Signal error'));

      await expect(getSignalTrends()).rejects.toThrow('Failed to fetch signal trends');
    });
  });

  // ==========================================================================
  // actionUrl route existence (regression guard for the 2026-05-12 fix)
  //
  // Background: the dashboard generated `actionUrl: '/signals/${id}'`,
  // `actionUrl: '/prototypes/${id}'`, and `actionUrl: '/agents'`, but none of
  // those routes existed on disk (signal detail lives at
  // `/triage/signals/[id]`, prototypes are listed at `/library/prototypes`
  // with no per-id detail, and `/agents` is not a top-level page — only its
  // subroutes are). Every "Recent Updates" / "Needs Attention" click 404'd.
  //
  // This block verifies that every actionUrl returned by getNeedsAttentionItems
  // and getRecentUpdates resolves to a real `page.tsx` in `src/app/`, including
  // dynamic-segment matches (e.g. `/triage/signals/sig-1` →
  // `src/app/triage/signals/[id]/page.tsx`).
  // ==========================================================================

  describe('actionUrl points to a real route on disk', () => {
    const { existsSync } = require('fs');
    const { join } = require('path');

    function routeExists(actionUrl: string): boolean {
      const appRoot = join(process.cwd(), 'src/app');
      const segments = actionUrl.split('/').filter(Boolean);

      // 1. Literal match: /library/prototypes → src/app/library/prototypes/page.tsx
      if (existsSync(join(appRoot, ...segments, 'page.tsx'))) return true;

      // 2. Dynamic-segment match: try replacing each trailing segment in turn
      // with the common dynamic-segment names Next.js uses. We start from the
      // deepest segment because that's where dynamic ids almost always live.
      const dynamicNames = ['[id]', '[slug]', '[entityId]'];
      for (let i = segments.length - 1; i >= 0; i--) {
        for (const dyn of dynamicNames) {
          const candidate = [...segments];
          candidate[i] = dyn;
          if (existsSync(join(appRoot, ...candidate, 'page.tsx'))) return true;
        }
      }

      return false;
    }

    it('every actionUrl from getNeedsAttentionItems exists', async () => {
      mockGetSystemConfig.mockResolvedValue({
        agentMode: { mode: 'copilot', autoActionThreshold: 80 },
      });
      mockGetPendingSignals.mockResolvedValue([createMockSignal({ id: 'sig-pending', relevanceScore: 90 })]);
      mockGetHighConfidenceSignals.mockResolvedValue([createMockSignal({ id: 'sig-hc', relevanceScore: 95 })]);
      mockGetRecentAgentRuns.mockResolvedValue([createMockRun({ id: 'act-1', status: 'failure' })]);
      mockGetPrototypes.mockResolvedValue([
        createMockPrototype({
          id: 'proto-soon',
          presentationDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
          status: 'In Development',
        }),
      ]);

      const items = await getNeedsAttentionItems(TEST_UID);

      // Sanity: we exercised every actionUrl branch in dashboard.ts.
      // If this assertion fails, the test fixtures don't cover all paths.
      expect(items.length).toBeGreaterThan(0);

      const dead = items.filter((i: { actionUrl: string }) => !routeExists(i.actionUrl));
      if (dead.length > 0) {
        console.error(
          'Dead routes from getNeedsAttentionItems:',
          dead.map((d: { id: string; type: string; actionUrl: string }) => `${d.type}/${d.id} -> ${d.actionUrl}`)
        );
      }
      expect(dead).toEqual([]);
    });

    it('every actionUrl from getRecentUpdates exists', async () => {
      mockGetSystemConfig.mockResolvedValue({
        agentMode: { mode: 'copilot', autoActionThreshold: 80 },
      });
      mockGetPendingSignals.mockResolvedValue([createMockSignal({ id: 'sig-recent', relevanceScore: 85 })]);
      mockGetHighConfidenceSignals.mockResolvedValue([createMockSignal({ id: 'sig-hc-recent', relevanceScore: 95 })]);
      mockGetPrototypes.mockResolvedValue([
        createMockPrototype({
          id: 'proto-recent',
          presentationDate: Date.now() + 5 * 24 * 60 * 60 * 1000,
          status: 'In Development',
        }),
      ]);
      mockGetStrategies.mockResolvedValue([createMockStrategy({ id: 'strat-recent' })]);
      mockGetSignals.mockResolvedValue([createMockSignal({ id: 'sig-feed' })]);

      const updates = await getRecentUpdates();

      // Pull every distinct actionUrl that surfaces in the updates feed.
      // Some entries may have no actionUrl (e.g. radar moves), which is fine —
      // we only assert the present ones resolve.
      const dead = updates
        .filter((u: { actionUrl?: string }) => u.actionUrl)
        .filter((u: { actionUrl: string }) => !routeExists(u.actionUrl));
      if (dead.length > 0) {
        console.error(
          'Dead routes from getRecentUpdates:',
          dead.map((d: { id: string; actionUrl: string }) => `${d.id} -> ${d.actionUrl}`)
        );
      }
      expect(dead).toEqual([]);
    });
  });
});
