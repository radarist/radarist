/**
 * @file lib/signals/feedback.ts
 * @description Signal feedback functions (Phase 4.2)
 *
 * Manages user feedback on signals for continuous improvement:
 * - Submit thumbs up/down votes
 * - Track feedback reasons
 * - Include/exclude from feedback loop
 * - Analytics for agent performance
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

'use server';

import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { adminUpdateSignal, adminGetSignalById } from '@/lib/signals-admin';
import type { Feedback } from '@/lib/schemas/signal';
import type { Signal } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { normalizeTopicKey } from '@/lib/discovery/candidate-topic';

const log = createLogger('signals/feedback');

/**
 * Interest steering (P1, extracted T27): fold an approve/reject into the SAME tag-topic
 * posterior the discovery selector reads — so the signals a user (or an AI-executor acting on
 * their behalf) likes/dislikes teach the scout what to find next.
 *
 * Extracted verbatim from `submitSignalFeedback`'s fire-and-forget wire so the identical
 * posterior write also covers the live admin approve/reject services (`signals-admin.ts`,
 * used by the AI chat executors) — those previously skipped the posterior entirely, and a raw
 * signal with no linked entity + no `discoveryTopic` dropped its feedback outright (T27 also
 * added the `metadata.matchedKeyword` fallback to `deriveSignalTopic` to close that gap).
 *
 * `signal` MUST be the signal's state as of BEFORE this vote is applied — `submitSignalFeedback`
 * passes the `priorSignal` it reads ahead of the status flip; admin callers pass whatever they
 * last fetched. `signal.feedback` is read as the PRIOR decision. Posterior idempotency is
 * based on the semantic engagement action rather than vote direction alone: up and
 * down+reason=correct both mean acted, while every other down vote means dismissed. A semantic
 * transition moves one count between the two outcomes atomically; a semantically identical
 * transition does not write the posterior again. This also handles reason-only changes on a
 * repeated down vote.
 *
 * Self-gated on `getDiscoveryConfig().feedbackEnabled`. Skips (rather than keying on junk) when
 * `deriveSignalTopic` can't resolve a topic. Never throws — every failure is caught, logged, and
 * swallowed; callers still fire this with their own defensive `.catch()` (belt-and-suspenders,
 * not because this function is expected to reject).
 *
 * US-2 novel-topic bridge (Task 26, amends the 2026-06-26 discovery-loop decision bound —
 * documented in `graph-learning.md`): on an UP-vote only, also appends `topic` to the user's
 * `InterestProfile.topics` via `addInterestTopic` so a liked topic the user has never explored
 * becomes a fetch-keyword candidate (`getAggregateInterestTopics` reads it with no extra wiring).
 * Down-votes never touch topics — decay (not removal) is the fade mechanism. This lives INSIDE
 * `steerSignalInterest` (not `submitSignalFeedback`) so the admin approve/reject path
 * (`signals-admin.ts`) gains the bridge too, not just the thumbs-UI path. Best-effort: wrapped
 * in its own try/catch so a bridge failure never breaks the posterior write above.
 */
export async function steerSignalInterest(
  signal: Signal | null | undefined,
  vote: 'up' | 'down',
  userId: string,
  reason?: string
): Promise<void> {
  const signalId = signal?.id;
  if (!signalId) return;

  const priorVote = signal?.feedback?.vote;
  const priorEngagement = priorVote
    ? priorVote === 'up' || signal.feedback?.reason === 'correct'
      ? 'acted'
      : 'dismissed'
    : undefined;
  const nextEngagement = vote === 'up' || reason === 'correct' ? 'acted' : 'dismissed';
  const posteriorChanged = priorEngagement !== nextEngagement;
  const shouldBridgeTopic = vote === 'up' && priorVote !== 'up';

  // A repeated semantic decision is posterior-idempotent. Keep the up-only topic bridge
  // independent: down+correct and up are both "acted", but only the up vote grants durable
  // InterestProfile membership.
  if (!posteriorChanged && !shouldBridgeTopic) return;

  try {
    const { getDiscoveryConfig } = await import('@/lib/discovery/discovery-config');
    if (!getDiscoveryConfig().feedbackEnabled) return;
    const { deriveSignalTopic } = await import('@/lib/signals/signal-topic');
    const derivedTopic = await deriveSignalTopic(signal);
    if (!derivedTopic) return; // no linked-tech topic → skip rather than key on junk
    const topic = normalizeTopicKey(derivedTopic);
    if (posteriorChanged && priorEngagement) {
      // The old decrement-then-record sequence could commit only its decrement when the second
      // graph write failed. Move both counters in one managed Neo4j transaction instead.
      let transitionApplied = false;
      try {
        const { transitionInsightEngagement } = await import('@/lib/graph/preferences');
        await transitionInsightEngagement(userId, signalId, topic, priorEngagement, nextEngagement);
        transitionApplied = true;
      } catch (transitionErr) {
        log.warn('signal interest transition failed (non-fatal)', {
          signalId,
          topic,
          error: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
        });
      }

      // First-vote feedback gets this profile touch through recordProposalFeedback. Preserve
      // the same recency behavior for a successfully-applied semantic transition.
      if (transitionApplied) {
        try {
          const { touchInterestProfile } = await import('@/lib/graph/interest-profile');
          await touchInterestProfile(userId);
        } catch (touchErr) {
          log.warn('signal interest profile touch failed (non-fatal)', {
            signalId,
            error: touchErr instanceof Error ? touchErr.message : String(touchErr),
          });
        }
      }
    } else if (posteriorChanged) {
      // Keep first-vote behavior on the shared discovery boundary: it records one engagement
      // and touches the InterestProfile under that function's existing best-effort contract.
      const { recordProposalFeedback } = await import('@/lib/discovery/discovery-feedback');
      await recordProposalFeedback(
        userId,
        signalId,
        'signal',
        signalId,
        'signal',
        vote === 'up' ? 'approved' : 'rejected',
        reason,
        topic
      );
    }

    if (shouldBridgeTopic) {
      // US-2 bridge: best-effort, own try/catch — a bridge failure must never undo the
      // posterior write above or break steering for the caller.
      try {
        const { addInterestTopic } = await import('@/lib/graph/interest-profile');
        await addInterestTopic(userId, topic);
      } catch (bridgeErr) {
        log.warn('novel-topic interest bridge failed (non-fatal)', {
          signalId,
          topic,
          error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
        });
      }
    }

    log.debug('signal interest-steering applied', {
      signalId,
      topic,
      direction: vote,
      flippedFrom: priorVote,
      posteriorChanged,
    });
  } catch (steerErr) {
    log.warn('signal interest-steering failed (non-fatal)', {
      signalId,
      error: steerErr instanceof Error ? steerErr.message : String(steerErr),
    });
  }
}

/**
 * A signal entry included in the feedback loop for agent training.
 * Contains key signal properties plus its feedback data.
 */
interface FeedbackLoopEntry {
  signalId: string;
  title: string;
  description: string;
  source: string;
  type: Signal['type'];
  relevanceScore: number;
  alignmentScore: number;
  feedback: Feedback;
}

/**
 * Submit feedback for a signal
 *
 * @param signalId - Signal ID
 * @param vote - Up or down vote
 * @param reason - Optional reason for the vote
 * @param includedInFeedbackLoop - Whether to include in agent training
 * @param userId - User ID (optional, defaults to 'anonymous')
 * @returns Success status
 */
export async function submitSignalFeedback(
  signalId: string,
  vote: 'up' | 'down',
  reason?: string,
  includedInFeedbackLoop: boolean = true,
  userId: string = 'anonymous',
  updateStatus: boolean = true // New parameter to also update status
): Promise<{ success: boolean; error?: string }> {
  try {
    const feedback: Feedback = {
      vote,
      votedAt: Date.now(),
      votedBy: userId,
      includedInFeedbackLoop,
      ...(reason && { reason }), // Only include reason if it's provided
    };

    // Build update object
    const updateData: Record<string, unknown> = {
      feedback,
      updatedAt: Date.now(),
    };

    // Also update status if requested
    if (updateStatus) {
      updateData.status = vote === 'up' ? 'Approved' : 'Rejected';
      updateData.reviewedAt = Date.now();
      updateData.reviewedBy = userId;
    }

    // ROOT CAUSE FIX (2026-06-15): this is a `'use server'` Server Action, so it
    // runs in the Next.js SERVER runtime. The Firebase *client* SDK (`updateDoc`
    // from `firebase/firestore`) throws `FIRESTORE INTERNAL ASSERTION FAILED
    // (a540)` server-side — which silently failed EVERY like (status never
    // persisted, thumbs-up vanished on refresh). Server writes MUST use the admin
    // SDK to preserve the client/server boundary.
    // Read the signal BEFORE the overwrite — steerSignalInterest reads its `.feedback.vote` as
    // the PRIOR vote for the idempotency/flip-undo guard (re-vote = no-op; a flip undoes the
    // prior direction). priorSignal also carries the linkedEntities used to derive the steering
    // topic, so no extra read is needed below.
    const priorSignal = updateStatus ? await adminGetSignalById(signalId).catch(() => null) : null;

    await adminUpdateSignal(signalId, updateData);

    log.info('Vote submitted for signal', { vote, signalId, status: updateStatus ? updateData.status : undefined });

    // Interest steering (P1): an approve/reject folds into the SAME tag-topic posterior the
    // discovery selector reads — so the signals you like teach the scout what to find next.
    // Fire-and-forget; steerSignalInterest is self-contained (idempotency, flip-undo, the
    // feedbackEnabled gate, and its own error swallowing all live inside it — see its doc
    // comment) — the `updateStatus` check below is caller-specific (a bare metadata vote with
    // no status change never steers) so it stays here rather than inside the shared helper.
    if (updateStatus) {
      void steerSignalInterest(priorSignal, vote, userId, reason).catch((steerErr) => {
        log.warn('signal interest-steering failed (non-fatal)', {
          signalId,
          error: steerErr instanceof Error ? steerErr.message : String(steerErr),
        });
      });
    }

    // Enrich + link on like: an up-vote/approve means "I care about this" → enrich it
    // (deep-research expansion) AND link it to entities, in the background. FIRE-AND-FORGET
    // so the like returns immediately. We call the server helper DIRECTLY (in-process) —
    // the previous `fetchWithAuth('/api/...')` indirection THREW server-side ("Failed to
    // parse URL" — relative URL has no base in a Server Action; the client auth token is
    // also absent), so enrichment never ran. queueEnrichOnLike is idempotent (skips
    // already-full / in-flight signals → 0 tokens) and a no-op in batch/off mode.
    if (vote === 'up' && updateStatus) {
      void (async () => {
        try {
          const { queueEnrichOnLike } = await import('@/lib/signals/enrich-on-like');
          await queueEnrichOnLike(signalId);
        } catch (enrichErr) {
          log.warn('enrich-on-like failed (non-fatal)', {
            signalId,
            error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
          });
        }
      })();
    }

    return { success: true };
  } catch (error) {
    log.error('Failed to submit feedback', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to submit feedback',
    };
  }
}

/**
 * Get feedback statistics for signals
 *
 * @returns Feedback stats
 */
export async function getFeedbackStats(): Promise<{
  totalFeedback: number;
  upvotes: number;
  downvotes: number;
  withReasons: number;
  inFeedbackLoop: number;
}> {
  try {
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, where('feedback', '!=', null));
    const snapshot = await getDocs(q);

    let upvotes = 0;
    let downvotes = 0;
    let withReasons = 0;
    let inFeedbackLoop = 0;

    snapshot.docs.forEach((doc) => {
      const signal = doc.data();
      const feedback = signal.feedback as Feedback | undefined;

      if (feedback?.vote === 'up') upvotes++;
      if (feedback?.vote === 'down') downvotes++;
      if (feedback?.reason) withReasons++;
      if (feedback?.includedInFeedbackLoop) inFeedbackLoop++;
    });

    return {
      totalFeedback: snapshot.size,
      upvotes,
      downvotes,
      withReasons,
      inFeedbackLoop,
    };
  } catch (error) {
    log.error('Failed to get feedback stats', error instanceof Error ? error : undefined);
    return {
      totalFeedback: 0,
      upvotes: 0,
      downvotes: 0,
      withReasons: 0,
      inFeedbackLoop: 0,
    };
  }
}

/**
 * Get signals with negative feedback for review
 *
 * @param limit - Maximum number of signals to return
 * @returns Signals with downvotes
 */
export async function getSignalsWithNegativeFeedback(limit: number = 20) {
  try {
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, where('feedback.vote', '==', 'down'));
    const snapshot = await getDocs(q);

    const signals = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).slice(0, limit);

    return signals;
  } catch (error) {
    log.error('Failed to get signals with negative feedback', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Get feedback loop data for agent training
 *
 * Returns signals that users have explicitly included in the feedback loop.
 * This can be used to improve signal detection and scoring algorithms.
 *
 * @returns Feedback loop data
 */
export async function getFeedbackLoopData(): Promise<{
  positive: FeedbackLoopEntry[];
  negative: FeedbackLoopEntry[];
}> {
  try {
    const signalsRef = collection(db, 'signals');
    const q = query(signalsRef, where('feedback.includedInFeedbackLoop', '==', true));
    const snapshot = await getDocs(q);

    const positive: FeedbackLoopEntry[] = [];
    const negative: FeedbackLoopEntry[] = [];

    snapshot.docs.forEach((doc) => {
      const signal = { id: doc.id, ...doc.data() } as Signal;
      const feedback = signal.feedback;

      if (feedback?.vote === 'up') {
        positive.push({
          signalId: signal.id,
          title: signal.title,
          description: signal.description,
          source: signal.source,
          type: signal.type,
          relevanceScore: signal.relevanceScore,
          alignmentScore: signal.alignmentScore,
          feedback,
        });
      } else if (feedback?.vote === 'down') {
        negative.push({
          signalId: signal.id,
          title: signal.title,
          description: signal.description,
          source: signal.source,
          type: signal.type,
          relevanceScore: signal.relevanceScore,
          alignmentScore: signal.alignmentScore,
          feedback,
        });
      }
    });

    log.info('Retrieved feedback loop data', { positive: positive.length, negative: negative.length });

    return { positive, negative };
  } catch (error) {
    log.error('Failed to get feedback loop data', error instanceof Error ? error : undefined);
    return { positive: [], negative: [] };
  }
}
