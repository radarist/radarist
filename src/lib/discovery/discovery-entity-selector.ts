/**
 * @file discovery/discovery-entity-selector.ts
 * @description The dimension-agnostic candidate selector — and the FIRST reader of
 * the InterestProfile posterior. It only comes online here, in P1a, AFTER the
 * read-side bias defenses, so the posterior is defended the moment it is consumed
 * (BIAS-FIX-1/3).
 *
 * Scoring: `score = baseScore + explorationDelta`, where
 *   - baseScore = the topic's learned weight (0 when unseen), and
 *   - explorationDelta = explorationRate · inverseFrequency(topic), keeping
 *     under-explored topics visible so the loop never collapses onto a few winners.
 *
 * Deviation (recorded): the plan's δ also has an `inverseRecency` factor. We fold
 * recency into the engagement-count frequency proxy for v0.1.0 — a topic's
 * (acted+dismissed) count IS its proposal frequency, and an unseen topic gets the
 * max δ. This keeps δ deterministic without threading per-topic timestamps.
 *
 * BEHAVIORAL STEERING (A1, 2026-06-25): approve/reject now folds into the entity's TAG
 * topic — `recordProposalFeedback` → `resolveEntityTopic` derives the SAME tag topic this
 * selector scores on (`scoreCandidate` over `meaningfulTags`). So the behavioral posterior
 * and the candidate ranking share one key-space, and approve/reject genuinely re-ranks
 * per-sub-topic (no longer the old disjoint `entityType:proposalType` key).
 *
 * Server-only. CANDIDATE SCOPING is by RADAR: when a `radarId` is given, the
 * technology candidates are the radar's placed technologies (joined through
 * `radarPlacements` → `technologyId`). `quadrantId` is a RadarPlacement field, not
 * a Technology field, so the old `technologies.quadrantId` filter found nothing on
 * real data; this joins through the placement instead. With no `radarId` (or a
 * non-technology type, which has no placements) it topic-ranks the whole collection.
 */
import 'server-only';
import { createLogger } from '@/lib/logger';
import { getInterestProfile } from '@/lib/graph/interest-profile';
import { getProposedAssessments } from '@/lib/proposed-assessments-admin';
import { getProposedEntities } from '@/lib/proposed-entities-admin';
import { getProposedRelations } from '@/lib/proposed-relations-admin';
import { getEffectivePreferences, seedInterestProfile } from './cold-start';
import { getDiscoveryConfig } from './discovery-config';
import { deriveTopicFromTags, meaningfulTags, normalizeTopicKey } from './candidate-topic';
import type { DiscoveryScoutViewContext } from './scout-ui';
import type { SupportedEntityType } from '@/lib/schemas/proposed-entity';

const log = createLogger('discovery/discovery-entity-selector');

export interface DiscoveryCandidate {
  entityId: string;
  entityName: string;
  entityType: SupportedEntityType;
  topic: string;
  baseScore: number;
  explorationDelta: number;
  score: number;
  source: string;
}

export interface SelectDiscoveryEntitiesOptions {
  entityType: SupportedEntityType;
  /** Radar to scope technology candidates to (join via radarPlacements). Empty → topic-rank the whole collection. */
  radarId?: string;
  userId: string;
  limit: number;
  /**
   * Bounded current-view context (GRAPH-045): candidates whose entityId or
   * meaningful tags match get FOCUS_MATCH_BOOST so the on-demand scout ranks
   * what the user is looking at first. Absent → pure posterior ranking.
   */
  focus?: DiscoveryScoutViewContext;
}

/**
 * Additive score boost for a view-focused candidate. Learned weights are bounded
 * to [-0.5, 1] and explorationDelta to explorationRate ∈ [0, 1], so 10 strictly
 * dominates: every focus-matched candidate ranks above every unmatched one,
 * while the posterior still orders candidates WITHIN each group. Exclusions
 * (pending/approved/already-evaluated) are applied before scoring and are never
 * overridden by focus.
 */
export const FOCUS_MATCH_BOOST = 10;

const COLLECTION_BY_ENTITY_TYPE: Record<SupportedEntityType, string> = {
  technology: 'technologies',
  useCase: 'use-cases',
  painPoint: 'painPoints',
  company: 'companies',
  prototype: 'prototypes',
};

const SELECTOR_SOURCE = 'interest-selector';

/**
 * Score a candidate on its BEST-matching interest topic: the meaningful tag (the same
 * multi-tag, stopword-filtered set `deriveInterestFromBehavior` seeds on) with the highest
 * learned weight. This keeps the READ key-space identical to the SEED/feedback key-space —
 * a candidate is weighted if ANY of its real tags was explored/approved, not just its first
 * tag. Falls back to the kebab primary tag (then entityType) for display when nothing matches.
 */
function scoreCandidate(
  data: Record<string, unknown>,
  entityType: SupportedEntityType,
  weightByTopic: Map<string, number>
): { topic: string; baseScore: number } {
  let topic = deriveTopicFromTags(data.tags, entityType);
  let baseScore = 0;
  for (const t of meaningfulTags(data.tags)) {
    const w = weightByTopic.get(t) ?? 0;
    if (w > baseScore) {
      baseScore = w;
      topic = t;
    }
  }
  return { topic, baseScore };
}

/**
 * Rank candidate entities of `entityType` (scoped to `radarId` for technology) by
 * the user's interest posterior plus an exploration bonus. A fresh user with no
 * InterestProfile is seeded with the broad cold-start prior in-line (M18) and
 * ranked in the same run, so the scout never silently dispatches nothing.
 */
export async function selectDiscoveryEntities(options: SelectDiscoveryEntitiesOptions): Promise<DiscoveryCandidate[]> {
  const { entityType, radarId, userId, limit, focus } = options;

  // Focus sets from the (already clamped) view context. Topics arrive as raw view
  // tags — normalize them into the selector's topic key-space so 'Graph DB' from a
  // node property matches the 'graph-db' meaningful tag.
  const focusEntityIds = new Set(focus?.focusEntityIds ?? []);
  const focusTopics = new Set((focus?.focusTopics ?? []).map(normalizeTopicKey).filter(Boolean));

  const profile = await getInterestProfile(userId);
  if (!profile) {
    // M18: a fresh user has no InterestProfile yet. Rather than fail-closed to
    // [] (silently dispatching nothing — the doc-comment promised cold-start
    // seeding but nothing ever called it), seed the broad prior NOW and proceed
    // in the SAME run. getEffectivePreferences below already fails toward the
    // broad prior, so selection is well-defined the moment the profile exists.
    // Best-effort seed: seedInterestProfile never throws, so a seed failure just
    // leaves the profile absent next cycle — it never blocks this selection.
    log.info('no interest profile — seeding cold-start prior and proceeding', { userId });
    await seedInterestProfile(userId);
  }

  const prefs = await getEffectivePreferences(userId);
  const weightByTopic = new Map(prefs.map((p) => [p.topic, p.weight]));
  const countByTopic = new Map(prefs.map((p) => [p.topic, (p.actedCount ?? 0) + (p.dismissedCount ?? 0)]));
  const { explorationRate } = getDiscoveryConfig();

  // Exclusion: entities already in-flight (pending) or already acted on (approved).
  // Rejected/dismissed are deliberately NOT permanently excluded — the write-layer
  // 30-day REJECTION_RETENTION_MS dedup prevents immediate re-proposal.
  //
  // These reads GATE REAL BUILD-MISSION SPEND, so a read failure must PROPAGATE (throw),
  // NEVER fail-open to "no exclusions" — that would re-dispatch every already-evaluated
  // candidate and flood triage with duplicate, paid-for evaluations (the worst-case is a
  // missing index permanently disabling exclusions). Same throw-don't-mask contract as the
  // radar join below. There is intentionally no try/catch here.
  const excluded = new Set<string>();
  const assessments = await getProposedAssessments();
  for (const a of assessments) {
    if (a.technologyId && (a.status === 'pending' || a.status === 'approved')) excluded.add(a.technologyId);
  }
  const proposedEntities = await getProposedEntities();
  for (const e of proposedEntities) if (e.appliedEntityId) excluded.add(e.appliedEntityId);
  // Already-evaluated entities: a completed evaluation stages a Document—evaluates→entity
  // relation (the structured signal for non-technology evals, which write no assessment).
  // Query by relationType ONLY (single-field, auto-indexed — a relationType + status `in`
  // composite query would FAILED_PRECONDITION on a fresh deploy) and filter status in memory.
  // An entity whose verdict is already sitting in triage is intentionally not re-evaluated.
  const evaluateRelations = await getProposedRelations({ relationType: 'evaluates' });
  for (const r of evaluateRelations) {
    if (r.relationType === 'evaluates' && (r.status === 'pending' || r.status === 'approved')) {
      excluded.add(r.targetId);
    }
  }

  // Build the candidate universe. RADAR-SCOPED for technology (join radarPlacements
  // → technologyId via the radar admin twin); otherwise topic-rank the whole collection.
  //
  // CONTRACT: the radar join is intentionally NOT wrapped in try/catch. A genuinely
  // empty radar returns [] (→ a legitimate 'no-candidates' sweep); a Firestore READ
  // FAILURE must THROW and propagate to the Inngest step's onFailure, NOT be swallowed
  // to []. Do not "make it consistent" with the exclusion-read's catch-and-degrade
  // above — folding a read failure into 'no-candidates' would silently dark the loop.
  let candidateData: Array<{ id: string; data: Record<string, unknown> }>;
  if (entityType === 'technology' && radarId) {
    const { adminGetTechnologiesWithPlacementsForRadar } = await import('@/lib/radars-admin');
    const techs = await adminGetTechnologiesWithPlacementsForRadar(radarId);
    candidateData = techs.map((t) => ({ id: t.id, data: t as unknown as Record<string, unknown> }));
  } else {
    const { db } = await import('@/lib/firebase-admin');
    const snap = await db.collection(COLLECTION_BY_ENTITY_TYPE[entityType]).get();
    candidateData = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  }

  const candidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const { id: entityId, data } of candidateData) {
    if (excluded.has(entityId) || seen.has(entityId)) continue;
    seen.add(entityId);

    const { topic, baseScore } = scoreCandidate(data, entityType, weightByTopic);
    const count = countByTopic.get(topic) ?? 0;
    const explorationDelta = explorationRate * (1 / (1 + count));
    const focused =
      focusEntityIds.has(entityId) ||
      (focusTopics.size > 0 && meaningfulTags(data.tags).some((t) => focusTopics.has(t)));
    const score = baseScore + explorationDelta + (focused ? FOCUS_MATCH_BOOST : 0);

    candidates.push({
      entityId,
      entityName: (data.name as string) ?? (data.title as string) ?? entityId,
      entityType,
      topic,
      baseScore,
      explorationDelta,
      score,
      source: SELECTOR_SOURCE,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

/**
 * Back-compat alias used by the P1b sweep. One implementation, two names.
 * Defaults entityType to 'technology' (the flagship dimension).
 */
export const selectBenchmarkCandidates = (
  opts: Omit<SelectDiscoveryEntitiesOptions, 'entityType'> & { entityType?: SupportedEntityType }
): Promise<DiscoveryCandidate[]> => selectDiscoveryEntities({ ...opts, entityType: opts.entityType ?? 'technology' });
