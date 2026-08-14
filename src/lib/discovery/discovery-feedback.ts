/**
 * @file discovery/discovery-feedback.ts
 * @description The single, dimension-agnostic learning-store entry point. Folds a
 * triage decision (approve / reject / bare-dismiss) on any proposal type into the
 * per-topic UserPreference posterior + bumps the user's InterestProfile.
 *
 * Invariants:
 *  - WRITE-GATED: a no-op unless `DISCOVERY_FEEDBACK_ENABLED` is set. (Historical
 *    note, now FALSE: this module's original P0 doc claimed "no reader consumes
 *    the posterior" so the write path had to be provable in isolation
 *    (BIAS-FIX-1). Readers went live during the graph-alive-loops pass — the
 *    fetch-signals reinforcement lane (`interest-keywords.ts`), the discovery
 *    sweep candidate selector (`discovery-entity-selector.ts`), the A4 briefing
 *    ranker (`insight-ranking.ts` via `getEffectivePreferences`), and the
 *    signals "For you" boost (`interest-rank.ts`) all read this posterior now —
 *    share this posterior.)
 *  - BEST-EFFORT: wraps BOTH dependencies in one try/catch and NEVER throws — a
 *    learning-store failure must never convert a triage 200 into a 500.
 *  - SURVIVORSHIP GUARD: a bare `dismissed` (hide) only touches recency; it does
 *    NOT move engagement weight (hide ≠ reasoned reject). P1a-T6 tightens the
 *    reason semantics further.
 */
import 'server-only';
import { trackInsightEngagement } from '@/lib/graph/preferences';
import { touchInterestProfile } from '@/lib/graph/interest-profile';
import { createLogger } from '@/lib/logger';
import { getDiscoveryConfig } from './discovery-config';
import { resolveEntityTopic } from './entity-topic';
import { normalizeTopicKey } from './candidate-topic';

const log = createLogger('discovery/discovery-feedback');

export type ProposalType = 'assessment' | 'relation' | 'entity' | 'update' | 'artifact' | 'signal';
export type FeedbackAction = 'approved' | 'rejected' | 'dismissed';

/**
 * Record a triage decision into the learning store.
 *
 * @param action approved → 'acted'; rejected → 'dismissed'; bare dismissed → hide-only.
 * @param reason optional rejection reason (semantics tightened in P1a-T6).
 */
export async function recordProposalFeedback(
  userId: string,
  proposalId: string,
  proposalType: ProposalType,
  entityId: string,
  entityType: string,
  action: FeedbackAction,
  reason?: string,
  /**
   * Explicit topic for subjects that aren't a real entity (e.g. a query-scoped artifact
   * recommendation with no entityIds) — skips the entity lookup and keys directly on this
   * tag-space topic, so the feedback isn't stranded on a verbatim type like 'document'.
   */
  topicOverride?: string
): Promise<void> {
  try {
    // Inside the try so the never-throw contract holds even if a future config
    // field adds a throwing parse — a config-read failure becomes a logged no-op.
    if (!getDiscoveryConfig().feedbackEnabled) return;

    // Key the posterior on the entity's TAG topic — the SAME key-space the selector
    // ranks candidates on (A1). Previously this used a coarse `entityType:proposalType`
    // key, disjoint from the read side, so approve/reject never re-ranked anything.
    const resolvedTopic = topicOverride?.trim() ? topicOverride : await resolveEntityTopic(entityId, entityType);
    const topic = normalizeTopicKey(resolvedTopic);
    // Reason-coded semantics (P1a-T6):
    //  - approved              → 'acted'
    //  - rejected, reason='correct' → 'acted'  (the system's suggestion was right)
    //  - rejected, other reason → 'dismissed' (human judged it down)
    //  - bare dismissed (hide) → null          (survivorship guard: no weight move)
    const engagement: 'acted' | 'dismissed' | null =
      action === 'approved' ? 'acted' : action === 'rejected' ? (reason === 'correct' ? 'acted' : 'dismissed') : null;

    if (engagement) {
      await trackInsightEngagement(userId, proposalId, engagement, topic);
    }
    await touchInterestProfile(userId);

    log.debug('proposal feedback recorded', { userId, proposalId, entityId, entityType, action, reason, topic });
  } catch (error) {
    // Fail-open: the learning store is never allowed to break a triage decision.
    log.warn('recordProposalFeedback failed (best-effort, ignored)', {
      userId,
      proposalId,
      proposalType,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
