/**
 * @jest-environment node
 *
 * P0-T6 — cold-start broad prior. Empty prefs synthesize a low-confidence broad
 * prior; real prefs pass through; a read error still returns the prior (never
 * empty — catch arm covered, TEST-FIX-1). seedInterestProfile is idempotent.
 */
export {};

const mockGetUserPreferences = jest.fn();
const mockMergeInterestProfileTopics = jest.fn();
const mockReplaceSyntheticInterestProfileTopics = jest.fn();
const mockGetDiscoveryConfig = jest.fn();

jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  getUserPreferences: (...a: unknown[]) => mockGetUserPreferences(...a),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  __esModule: true,
  mergeInterestProfileTopics: (...a: unknown[]) => mockMergeInterestProfileTopics(...a),
  replaceSyntheticInterestProfileTopics: (...a: unknown[]) => mockReplaceSyntheticInterestProfileTopics(...a),
}));
jest.mock('../discovery-config', () => ({
  __esModule: true,
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { DEFAULT_BROAD_TOPICS, getEffectivePreferences, seedInterestProfile } = require('../cold-start');

describe('cold-start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDiscoveryConfig.mockReturnValue({ vertical: 'ai-ml-infra', explorationRate: 0.15 });
    mockMergeInterestProfileTopics.mockResolvedValue(undefined);
    mockReplaceSyntheticInterestProfileTopics.mockResolvedValue(undefined);
  });

  describe('getEffectivePreferences', () => {
    it('synthesizes a low-confidence broad prior when the user has no prefs', async () => {
      mockGetUserPreferences.mockResolvedValue([]);
      const prefs = await getEffectivePreferences('u1');
      expect(prefs).toHaveLength(DEFAULT_BROAD_TOPICS.length);
      for (const p of prefs) {
        expect(p.weight).toBe(0.15);
        expect(p.actedCount).toBe(0);
      }
      expect(prefs.map((p: { topic: string }) => p.topic)).toEqual([...DEFAULT_BROAD_TOPICS]);
    });

    it('returns real prefs unchanged when present', async () => {
      const real = [{ topic: 'graph-db', weight: 0.9, actedCount: 5, dismissedCount: 0 }];
      mockGetUserPreferences.mockResolvedValue(real);
      const prefs = await getEffectivePreferences('u1');
      expect(prefs).toEqual(real);
    });

    it('falls back to the broad prior on read error (never empty, catch arm covered)', async () => {
      mockGetUserPreferences.mockRejectedValue(new Error('neo4j down'));
      const prefs = await getEffectivePreferences('u1');
      expect(prefs.length).toBeGreaterThan(0);
      expect(prefs).toHaveLength(DEFAULT_BROAD_TOPICS.length);
    });

    // DUP-5 unification — one decay-of-record shared with the fetch lane
    // (interest-keywords.ts's getAggregateInterestKeywords).
    describe('recency decay (DUP-5 — same 30-day half-life curve as the fetch lane)', () => {
      it('effective preference weight decays with 30d half-life (same curve as the fetch lane)', async () => {
        const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
        mockGetUserPreferences.mockResolvedValue([
          { topic: 'graph-db', weight: 1, actedCount: 5, dismissedCount: 0, lastUpdated: sixtyDaysAgo },
        ]);

        const prefs = await getEffectivePreferences('u1');

        // 60 days = 2 half-lives → weight quarters (0.5^2 = 0.25).
        expect(prefs[0].weight).toBeCloseTo(0.25, 2);
      });

      it('missing lastUpdated → undecayed', async () => {
        const real = [{ topic: 'graph-db', weight: 0.9, actedCount: 5, dismissedCount: 0 }];
        mockGetUserPreferences.mockResolvedValue(real);

        const prefs = await getEffectivePreferences('u1');

        expect(prefs).toEqual(real);
      });

      it('broad prior rows are undecayed (synthetic rows carry no lastUpdated)', async () => {
        mockGetUserPreferences.mockResolvedValue([]);

        const prefs = await getEffectivePreferences('u1');

        for (const p of prefs) {
          expect(p.weight).toBe(0.15);
          expect(p.lastUpdated).toBeUndefined();
        }
      });
    });
  });

  describe('seedInterestProfile', () => {
    it('seeds the broad topics when none are given', async () => {
      await seedInterestProfile('u1');
      expect(mockMergeInterestProfileTopics).toHaveBeenCalledWith('u1', 'ai-ml-infra', [
        ...DEFAULT_BROAD_TOPICS,
      ]);
    });

    it('seeds explicit topics when given', async () => {
      await seedInterestProfile('u1', ['custom-topic']);
      expect(mockMergeInterestProfileTopics).toHaveBeenCalledWith('u1', 'ai-ml-infra', ['custom-topic']);
    });

    it('seeds a missing system profile through explicit synthetic replacement', async () => {
      await seedInterestProfile('system-discovery');

      expect(mockReplaceSyntheticInterestProfileTopics).toHaveBeenCalledWith(
        'system-discovery',
        'ai-ml-infra',
        [...DEFAULT_BROAD_TOPICS]
      );
      expect(mockMergeInterestProfileTopics).not.toHaveBeenCalled();
    });

    it('swallows merge errors (best-effort, catch arm covered)', async () => {
      mockMergeInterestProfileTopics.mockRejectedValue(new Error('neo4j down'));
      await expect(seedInterestProfile('u1')).resolves.toBeUndefined();
    });
  });
});
