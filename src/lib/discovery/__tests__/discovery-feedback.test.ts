/**
 * @jest-environment node
 *
 * P0-T4 generic feedback recorder + A1 key-space unification. Asserts: write-gating
 * (feedbackEnabled), approved/rejected engagement mapping, the bare-dismiss
 * survivorship guard, and that the posterior is keyed on the entity's TAG topic
 * (resolveEntityTopic) — the SAME key-space the selector ranks on — NOT the old
 * coarse `entityType:proposalType`. Plus the never-throws guarantee for every
 * dependency's catch arm.
 */
export {};

const mockGetDiscoveryConfig = jest.fn();
const mockTrackInsightEngagement = jest.fn();
const mockTouchInterestProfile = jest.fn();
const mockResolveEntityTopic = jest.fn();

jest.mock('../discovery-config', () => ({
  __esModule: true,
  getDiscoveryConfig: (...a: unknown[]) => mockGetDiscoveryConfig(...a),
}));
jest.mock('@/lib/graph/preferences', () => ({
  __esModule: true,
  trackInsightEngagement: (...a: unknown[]) => mockTrackInsightEngagement(...a),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  __esModule: true,
  touchInterestProfile: (...a: unknown[]) => mockTouchInterestProfile(...a),
}));
jest.mock('../entity-topic', () => ({
  __esModule: true,
  resolveEntityTopic: (...a: unknown[]) => mockResolveEntityTopic(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { recordProposalFeedback } = require('../discovery-feedback');

const enabled = () => mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
const disabled = () => mockGetDiscoveryConfig.mockReturnValue({ feedbackEnabled: false });

describe('recordProposalFeedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrackInsightEngagement.mockResolvedValue(undefined);
    mockTouchInterestProfile.mockResolvedValue(undefined);
    // A1: the entity's tag topic — what the selector ranks on.
    mockResolveEntityTopic.mockResolvedValue('vector-database');
  });

  it('is a no-op when feedbackEnabled is false (no writes, no topic resolution)', async () => {
    disabled();
    await expect(
      recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved')
    ).resolves.toBeUndefined();
    expect(mockResolveEntityTopic).not.toHaveBeenCalled();
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    expect(mockTouchInterestProfile).not.toHaveBeenCalled();
  });

  it('keys the posterior on the entity TAG topic (resolveEntityTopic), not entityType:proposalType', async () => {
    enabled();
    await recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved');
    expect(mockResolveEntityTopic).toHaveBeenCalledWith('t1', 'technology');
    expect(mockTrackInsightEngagement).toHaveBeenCalledWith('u1', 'a1', 'acted', 'vector-database');
    expect(mockTouchInterestProfile).toHaveBeenCalledWith('u1');
  });

  it('maps rejected -> "dismissed" on the same tag key-space', async () => {
    enabled();
    await recordProposalFeedback('u1', 'r1', 'relation', 't1', 'technology', 'rejected', 'out-of-scope');
    expect(mockTrackInsightEngagement).toHaveBeenCalledWith('u1', 'r1', 'dismissed', 'vector-database');
    expect(mockTouchInterestProfile).toHaveBeenCalledWith('u1');
  });

  it('bare dismiss (hide) touches only — NEVER moves engagement weight (survivorship guard)', async () => {
    enabled();
    await recordProposalFeedback('u1', 'a9', 'assessment', 't1', 'technology', 'dismissed');
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
    expect(mockTouchInterestProfile).toHaveBeenCalledWith('u1');
  });

  it('two proposals on entities sharing a tag fold into the SAME topic posterior', async () => {
    enabled();
    await recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved');
    await recordProposalFeedback('u1', 'a2', 'assessment', 't2', 'technology', 'approved');
    expect(mockTrackInsightEngagement.mock.calls[0][3]).toBe('vector-database');
    expect(mockTrackInsightEngagement.mock.calls[1][3]).toBe('vector-database');
  });

  it('never throws when resolveEntityTopic rejects (best-effort catch)', async () => {
    enabled();
    mockResolveEntityTopic.mockRejectedValue(new Error('firestore down'));
    await expect(
      recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved')
    ).resolves.toBeUndefined();
    expect(mockTrackInsightEngagement).not.toHaveBeenCalled();
  });

  it('never throws when trackInsightEngagement rejects (catch arm covered)', async () => {
    enabled();
    mockTrackInsightEngagement.mockRejectedValue(new Error('neo4j down'));
    await expect(
      recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved')
    ).resolves.toBeUndefined();
  });

  it('never throws when touchInterestProfile rejects (load-bearing catch arm)', async () => {
    enabled();
    mockTouchInterestProfile.mockRejectedValue(new Error('neo4j down'));
    await expect(
      recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'approved')
    ).resolves.toBeUndefined();
  });

  // P1a-T6 reason-coded semantics.
  it('reason "correct" on a reject counts as "acted" (the system was right)', async () => {
    enabled();
    await recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'rejected', 'correct');
    expect(mockTrackInsightEngagement).toHaveBeenCalledWith('u1', 'a1', 'acted', 'vector-database');
  });

  it('a reject with a non-correct reason still moves weight down ("dismissed")', async () => {
    enabled();
    await recordProposalFeedback('u1', 'a1', 'assessment', 't1', 'technology', 'rejected', 'low-quality');
    expect(mockTrackInsightEngagement).toHaveBeenCalledWith('u1', 'a1', 'dismissed', 'vector-database');
  });
});
