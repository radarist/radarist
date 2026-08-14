/**
 * @jest-environment node
 *
 * A4 — nightly interest-refresh cron: gated by deriveInterestEnabled, derives per active
 * user, isolates derivation failures, and refuses partial aggregate snapshots.
 */
export {};

const mockGetDiscoveryConfig = jest.fn();
const mockGetActiveUserIds = jest.fn();
const mockDerive = jest.fn();
const mockGetInterestProfile = jest.fn();
const mockReplaceSyntheticInterestProfileTopics = jest.fn();

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: jest.fn((_config: unknown, _trigger: unknown, handler: unknown) => handler),
    send: jest.fn(),
  },
}));
jest.mock('@/lib/discovery/discovery-config', () => ({
  __esModule: true,
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getActiveUserIds: (...a: unknown[]) => mockGetActiveUserIds(...a),
}));
jest.mock('@/lib/discovery/derive-interest', () => ({
  __esModule: true,
  deriveInterestFromBehavior: (...a: unknown[]) => mockDerive(...a),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  __esModule: true,
  MAX_INTEREST_PROFILE_TOPICS: 25,
  getInterestProfile: (...a: unknown[]) => mockGetInterestProfile(...a),
  replaceSyntheticInterestProfileTopics: (...a: unknown[]) => mockReplaceSyntheticInterestProfileTopics(...a),
}));
jest.mock('@/lib/discovery/cold-start', () => ({
  __esModule: true,
  DEFAULT_BROAD_TOPICS: ['vector-database', 'llm-orchestration'],
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { refreshInterestProfiles } = require('../refresh-interest-profiles');
const { SKIP_REASONS } = require('../../skip-reasons');
const step = { run: (_name: string, fn: () => unknown) => fn() };

describe('refreshInterestProfiles cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDerive.mockResolvedValue({ topics: ['llm'], seeded: 1 });
    mockGetInterestProfile.mockResolvedValue(null);
    mockReplaceSyntheticInterestProfileTopics.mockResolvedValue(undefined);
  });

  it('skips entirely when derive-interest is disabled', async () => {
    mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: false });
    const res = await refreshInterestProfiles({ step });
    expect(res).toEqual({
      skipped: true,
      reason: SKIP_REASONS.DERIVE_INTEREST_DISABLED,
      userCount: 0,
      refreshed: 0,
    });
    expect(mockGetActiveUserIds).not.toHaveBeenCalled();
    expect(mockDerive).not.toHaveBeenCalled();
    expect(mockReplaceSyntheticInterestProfileTopics).not.toHaveBeenCalled();
  });

  it('derives interest for every active user when enabled', async () => {
    mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
    mockGetActiveUserIds.mockResolvedValue(['u1', 'u2', 'u3']);
    const res = await refreshInterestProfiles({ step });
    expect(mockDerive).toHaveBeenCalledTimes(3);
    expect(mockDerive).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ skipped: false, userCount: 3, refreshed: 3, systemTopics: 0 });
  });

  it('isolates a per-user failure — the batch continues', async () => {
    mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
    mockGetActiveUserIds.mockResolvedValue(['u1', 'u2']);
    mockDerive.mockRejectedValueOnce(new Error('neo4j hiccup')).mockResolvedValue({ topics: [], seeded: 0 });
    const res = await refreshInterestProfiles({ step });
    expect(mockDerive).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ skipped: false, userCount: 2, refreshed: 1, systemTopics: 0 });
  });

  // H11 — the cron sweep's 'system-discovery' leg fail-closed to [] because
  // NOTHING ever wrote that InterestProfile. The nightly refresh now also
  // aggregates active users' profiles into it.
  describe('system-discovery aggregate profile (H11)', () => {
    it("aggregates active users' profile topics into the system-discovery InterestProfile", async () => {
      mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
      mockGetActiveUserIds.mockResolvedValue(['u1', 'u2']);
      mockGetInterestProfile.mockImplementation(async (userId: string) =>
        userId === 'u1'
          ? { userId, vertical: 'ai-ml-infra', topics: ['llm', 'graph-db'], updatedAt: 'x' }
          : { userId, vertical: 'ai-ml-infra', topics: ['llm', 'vector-db'], updatedAt: 'x' }
      );

      const res = await refreshInterestProfiles({ step });

      // Frequency-ranked union: 'llm' appears in both profiles, so it leads.
      expect(mockReplaceSyntheticInterestProfileTopics).toHaveBeenCalledWith('system-discovery', 'ai-ml-infra', [
        'llm',
        'graph-db',
        'vector-db',
      ]);
      expect(res).toEqual({ skipped: false, userCount: 2, refreshed: 2, systemTopics: 3 });
    });

    it('falls back to the broad cold-start prior when no user has any topics yet', async () => {
      mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
      mockGetActiveUserIds.mockResolvedValue(['u1']);
      mockGetInterestProfile.mockResolvedValue(null);

      const res = await refreshInterestProfiles({ step });

      expect(mockReplaceSyntheticInterestProfileTopics).toHaveBeenCalledWith('system-discovery', 'ai-ml-infra', [
        'vector-database',
        'llm-orchestration',
      ]);
      expect(res).toEqual({ skipped: false, userCount: 1, refreshed: 1, systemTopics: 0 });
    });

    it('fails for Inngest retry and never replaces from a partial profile read', async () => {
      mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
      mockGetActiveUserIds.mockResolvedValue(['u1', 'u2']);
      mockGetInterestProfile.mockImplementation(async (userId: string) => {
        if (userId === 'u1') throw new Error('neo4j hiccup');
        return { userId, vertical: 'ai-ml-infra', topics: ['llm'], updatedAt: 'x' };
      });

      await expect(refreshInterestProfiles({ step })).rejects.toThrow('neo4j hiccup');

      expect(mockGetInterestProfile).toHaveBeenCalledTimes(2);
      expect(mockReplaceSyntheticInterestProfileTopics).not.toHaveBeenCalled();
    });

    it('does not publish the broad prior when any read fails after an empty profile', async () => {
      mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
      mockGetActiveUserIds.mockResolvedValue(['u1', 'u2']);
      mockGetInterestProfile.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('read timeout'));

      await expect(refreshInterestProfiles({ step })).rejects.toThrow('read timeout');

      expect(mockReplaceSyntheticInterestProfileTopics).not.toHaveBeenCalled();
    });

    it('caps an oversized aggregate snapshot at 25 topics', async () => {
      mockGetDiscoveryConfig.mockReturnValue({ deriveInterestEnabled: true, vertical: 'ai-ml-infra' });
      mockGetActiveUserIds.mockResolvedValue(['u1']);
      mockGetInterestProfile.mockResolvedValue({
        userId: 'u1',
        vertical: 'ai-ml-infra',
        topics: Array.from({ length: 30 }, (_, index) => `topic-${String(index).padStart(2, '0')}`),
        updatedAt: 'x',
      });

      const res = await refreshInterestProfiles({ step });

      const writtenTopics = mockReplaceSyntheticInterestProfileTopics.mock.calls[0][2] as string[];
      expect(writtenTopics).toHaveLength(25);
      expect(writtenTopics).toEqual(Array.from({ length: 25 }, (_, index) => `topic-${String(index).padStart(2, '0')}`));
      expect(res).toEqual({ skipped: false, userCount: 1, refreshed: 1, systemTopics: 25 });
    });
  });
});
