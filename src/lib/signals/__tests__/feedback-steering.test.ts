export {};
/**
 * @jest-environment node
 *
 * P1 — signal feedback → interest steering. The fire-and-forget wire inside
 * submitSignalFeedback must: fold an approve/reject into the shared posterior via
 * recordProposalFeedback('signal', …, topicOverride); be IDEMPOTENT by semantic action;
 * undo the prior semantic action on a transition (including a reason-only change); self-gate
 * on the flag; and skip when there's no topic.
 */
jest.mock('../../firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  getDocs: jest.fn(),
}));
const adminUpdateSignal = jest.fn().mockResolvedValue(undefined);
const adminGetSignalById = jest.fn();
jest.mock('@/lib/signals-admin', () => ({ adminUpdateSignal, adminGetSignalById }));
jest.mock('@/lib/signals/enrich-on-like', () => ({
  queueEnrichOnLike: jest.fn().mockResolvedValue({ queued: false }),
}));

const feedbackEnabled = { value: true };
jest.mock('@/lib/discovery/discovery-config', () => ({
  getDiscoveryConfig: () => ({ feedbackEnabled: feedbackEnabled.value }),
}));

const deriveSignalTopic = jest.fn().mockResolvedValue('vector-database');
jest.mock('@/lib/signals/signal-topic', () => ({ deriveSignalTopic: (...a: unknown[]) => deriveSignalTopic(...a) }));

const recordProposalFeedback = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/discovery/discovery-feedback', () => ({
  recordProposalFeedback: (...a: unknown[]) => recordProposalFeedback(...a),
}));

const transitionInsightEngagement = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/graph/preferences', () => ({
  transitionInsightEngagement: (...a: unknown[]) => transitionInsightEngagement(...a),
}));

const addInterestTopic = jest.fn().mockResolvedValue(true);
const touchInterestProfile = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/graph/interest-profile', () => ({
  addInterestTopic: (...a: unknown[]) => addInterestTopic(...a),
  touchInterestProfile: (...a: unknown[]) => touchInterestProfile(...a),
}));

const mockLogWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { submitSignalFeedback } = require('../feedback');

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  jest.clearAllMocks();
  feedbackEnabled.value = true;
  deriveSignalTopic.mockResolvedValue('vector-database');
  adminGetSignalById.mockResolvedValue({ id: 'sig1', feedback: undefined }); // no prior vote
});

describe('signal feedback → interest steering', () => {
  it('first up-vote → records approved feedback on the derived topic, no decrement', async () => {
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(transitionInsightEngagement).not.toHaveBeenCalled();
    expect(touchInterestProfile).not.toHaveBeenCalled();
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'signal',
      'sig1',
      'signal',
      'approved',
      undefined,
      'vector-database'
    );
  });

  it('flip up→down atomically transitions acted to dismissed and touches profile recency', async () => {
    adminGetSignalById.mockResolvedValue({ id: 'sig1', feedback: { vote: 'up' } });
    await submitSignalFeedback('sig1', 'down', 'noise', true, 'user-1');
    await flush();
    expect(transitionInsightEngagement).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'vector-database',
      'acted',
      'dismissed'
    );
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(touchInterestProfile).toHaveBeenCalledWith('user-1');
  });

  it('same vote (up→up) → idempotent no-op (no steering)', async () => {
    adminGetSignalById.mockResolvedValue({ id: 'sig1', feedback: { vote: 'up' } });
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(transitionInsightEngagement).not.toHaveBeenCalled();
  });

  it('same down vote with correct→noise reason change moves acted to dismissed', async () => {
    adminGetSignalById.mockResolvedValue({
      id: 'sig1',
      feedback: { vote: 'down', reason: 'correct' },
    });

    await submitSignalFeedback('sig1', 'down', 'noise', true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'vector-database',
      'acted',
      'dismissed'
    );
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(touchInterestProfile).toHaveBeenCalledWith('user-1');
  });

  it('same down vote with noise→correct reason change moves dismissed to acted', async () => {
    adminGetSignalById.mockResolvedValue({
      id: 'sig1',
      feedback: { vote: 'down', reason: 'noise' },
    });

    await submitSignalFeedback('sig1', 'down', 'correct', true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'vector-database',
      'dismissed',
      'acted'
    );
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(touchInterestProfile).toHaveBeenCalledWith('user-1');
  });

  it('same down semantic action with a different non-correct reason is a no-op', async () => {
    adminGetSignalById.mockResolvedValue({
      id: 'sig1',
      feedback: { vote: 'down', reason: 'noise' },
    });

    await submitSignalFeedback('sig1', 'down', 'outdated', true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).not.toHaveBeenCalled();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('down+correct→up does not double-count acted and still grants durable topic membership', async () => {
    adminGetSignalById.mockResolvedValue({
      id: 'sig1',
      feedback: { vote: 'down', reason: 'correct' },
    });

    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).not.toHaveBeenCalled();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(addInterestTopic).toHaveBeenCalledWith('user-1', 'vector-database');
  });

  it('up→down+correct keeps acted unchanged and never removes durable topic membership', async () => {
    adminGetSignalById.mockResolvedValue({ id: 'sig1', feedback: { vote: 'up' } });

    await submitSignalFeedback('sig1', 'down', 'correct', true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).not.toHaveBeenCalled();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(addInterestTopic).not.toHaveBeenCalled();
  });

  it('an atomic transition failure cannot fall back to a split write and does not block an up-only topic bridge', async () => {
    adminGetSignalById.mockResolvedValue({
      id: 'sig1',
      feedback: { vote: 'down', reason: 'noise' },
    });
    transitionInsightEngagement.mockRejectedValueOnce(new Error('transaction rolled back'));

    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).toHaveBeenCalledTimes(1);
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(touchInterestProfile).not.toHaveBeenCalled();
    expect(addInterestTopic).toHaveBeenCalledWith('user-1', 'vector-database');
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('transition failed'),
      expect.objectContaining({ signalId: 'sig1', topic: 'vector-database' })
    );
  });

  it('flag OFF → no steering', async () => {
    feedbackEnabled.value = false;
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('no derivable topic → skips (no junk-keyed posterior row)', async () => {
    deriveSignalTopic.mockResolvedValue(undefined);
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('updateStatus=false (bare metadata vote) → no steering', async () => {
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1', false);
    await flush();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });
});

// =============================================================================
// B1 — cross-path posterior double-count fix. Before the fix, an admin/AI approve (which now
// stamps `feedback.vote`) and a later human thumbs vote guarded on the SAME key (feedback.vote)
// only on the thumbs side — the admin path guarded on `status` instead, so the two paths never
// cross-protected each other. These tests seed `adminGetSignalById` with a signal that already
// carries the admin-stamped `feedback.vote` (simulating "an admin approve/reject already ran")
// and confirm the thumbs path's `steerSignalInterest` guard reads it correctly: same-direction
// short-circuits (no double-count), opposite semantic actions move atomically.
// =============================================================================
describe('signal feedback → interest steering — cross-path (B1)', () => {
  it('a thumbs up-vote after an admin approve that stamped vote=up records NO additional posterior', async () => {
    // Simulates the state left behind by adminApproveSignal after the B1 fix: status Approved,
    // feedback.vote already 'up' (stamped by the admin path's own steering write).
    adminGetSignalById.mockResolvedValue({ id: 'sig1', status: 'Approved', feedback: { vote: 'up' } });

    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();

    // Same semantic action short-circuits before any graph write.
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(transitionInsightEngagement).not.toHaveBeenCalled();
  });

  it('a thumbs DOWN-vote after an admin up-approve atomically moves acted to dismissed', async () => {
    adminGetSignalById.mockResolvedValue({ id: 'sig1', status: 'Approved', feedback: { vote: 'up' } });

    await submitSignalFeedback('sig1', 'down', 'changed my mind', true, 'user-1');
    await flush();

    expect(transitionInsightEngagement).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'vector-database',
      'acted',
      'dismissed'
    );
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });
});

describe('signal feedback → novel-topic interest bridge (US-2, Task 26)', () => {
  it('up-vote bridges the topic into InterestProfile (best-effort)', async () => {
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(addInterestTopic).toHaveBeenCalledWith('user-1', 'vector-database');
    // ...and it runs AFTER the posterior write, not instead of it.
    expect(recordProposalFeedback).toHaveBeenCalled();
  });

  it('normalizes a raw matched-keyword topic once for both posterior and profile stores', async () => {
    deriveSignalTopic.mockResolvedValue('  RAG   Pipelines  ');

    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();

    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'signal',
      'sig1',
      'signal',
      'approved',
      undefined,
      'rag-pipelines'
    );
    expect(addInterestTopic).toHaveBeenCalledWith('user-1', 'rag-pipelines');
  });

  it('down-vote never writes topics', async () => {
    adminGetSignalById.mockResolvedValue({ id: 'sig1', feedback: { vote: 'up' } });
    await submitSignalFeedback('sig1', 'down', 'noise', true, 'user-1');
    await flush();
    expect(transitionInsightEngagement).toHaveBeenCalledWith(
      'user-1',
      'sig1',
      'vector-database',
      'acted',
      'dismissed'
    );
    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(addInterestTopic).not.toHaveBeenCalled();
  });

  it('bridge failure does not break steering', async () => {
    addInterestTopic.mockRejectedValueOnce(new Error('neo4j blip'));
    await expect(submitSignalFeedback('sig1', 'up', undefined, true, 'user-1')).resolves.toEqual({ success: true });
    await flush();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('bridge'),
      expect.objectContaining({ signalId: 'sig1', topic: 'vector-database' })
    );
    // recordProposalFeedback already succeeded before the bridge threw.
    expect(recordProposalFeedback).toHaveBeenCalled();
  });

  it('no derivable topic → bridge never called (nothing to key on)', async () => {
    deriveSignalTopic.mockResolvedValue(undefined);
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(addInterestTopic).not.toHaveBeenCalled();
  });

  it('flag OFF → bridge never called', async () => {
    feedbackEnabled.value = false;
    await submitSignalFeedback('sig1', 'up', undefined, true, 'user-1');
    await flush();
    expect(addInterestTopic).not.toHaveBeenCalled();
  });
});
