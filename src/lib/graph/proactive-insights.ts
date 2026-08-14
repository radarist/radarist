/**
 * @file proactive-insights.ts
 * @description Proactive insight detection for the Impulse intelligence system.
 *
 * Detects user-relevant discoveries by cross-referencing AgentObservation nodes
 * with user EXPLORED edges. Creates ProactiveInsight nodes when matches are found.
 *
 * Core query pattern (from the design doc):
 *   MATCH (u:Session {userId: $userId})-[:EXPLORED]->(e)<-[:ABOUT]-(obs:AgentObservation)
 *   WHERE obs.timestamp > u.startedAt
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import neo4j from 'neo4j-driver';
import { currentEdgePredicate } from './current-edge-filter';
import { createHash } from 'crypto';
import { z } from 'zod';
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { getInsightAction } from './insight-actions';
import { rankObservationsByPreference } from './insight-ranking';
import { generateStructuredContent } from '@/lib/ai/client';
import { createLogger } from '@/lib/logger';
import { PROACTIVE_STANDALONE_MEMORY_LANE } from './memory-liveness';
import { CLAIM_RELATION_PREDICATES } from './relation-registry';
import {
  GROUNDED_COUNTER_EVIDENCE_FLOOR,
  PROACTIVE_INSIGHT_SURFACE_FLOOR,
  groundGraphPathEvidence,
  validateNarrativeHypothesisLanguage,
  type GroundedGraphPath,
  type InsightEpistemicKind,
} from './insight-grounding';

const log = createLogger('graph/proactive-insights');

// ============================================================================
// TYPES
// ============================================================================

export interface AgentObservation {
  id: string;
  agentType: string;
  observationType: 'discovery' | 'connection' | 'scoring_change' | 'pattern';
  title: string;
  summary: string;
  confidence: number;
  entityId: string;
  entityName: string;
  entityType: string;
  timestamp: string;
}

export interface ProactiveInsightNode {
  id: string;
  userId: string;
  type: 'discovery' | 'connection' | 'scoring_change' | 'pattern' | 'narrative';
  title: string;
  summary: string;
  agentName: string;
  confidenceScore: number;
  relatedEntities: Array<{ id: string; name: string; type: string }>;
  /**
   * For 'connection' insights: the newly-discovered entity at one end of the
   * graph path. The briefing UI prefers this over `relatedEntities[0]` (which
   * is collect()-ordered and non-deterministic).
   */
  observedEntityId?: string;
  /**
   * For 'connection' insights: the previously-explored entity at the other
   * end of the graph path. Stored so the UI can render a "see the connection
   * between X and Y" link instead of guessing.
   */
  exploredEntityId?: string;
  actionable: boolean;
  actionUrl?: string;
  actionLabel?: string;
  createdAt: string;
  consumed: boolean;
  /**
   * Whether the current user has liked (thumb-up'd) this insight. Defaults
   * to `false` for older insights and any node where the property is unset.
   * Surface for Option A's table to render the filled-thumb state.
   *
   * Phase 0 step 0.11 added this; Option A step A.1 lands the actual
   * toggle endpoints that flip the property.
   */
  liked: boolean;
  /**
   * Structured path data for the detail-page
   * "Why am I seeing this?" breadcrumb. Optional because pre-A.0 connection
   * insights (and all non-connection insights) won't have these set. Default
   * to `undefined` so callers can fall back to the human-readable `summary`
   * string when the structured form is missing.
   */
  relationshipTypes?: string[];
  sourceRelationTypes?: string[];
  relationshipDirections?: Array<'forward' | 'reverse'>;
  evidenceSummary?: string;
  groundingVersion?: string;
  epistemicKind?: InsightEpistemicKind;
  /** Path length 1, 2, or 3 (capped by `RELEVANCE_THRESHOLD`). */
  pathLength?: number;
  /**
   * Most recent EXPLORED-edge timestamp for the explored-end entity, as an
   * ISO string. Lets the UI render "you explored X 3 days ago" relatively.
   */
  exploredAt?: string;
}

export interface DetectionResult {
  insightsCreated: number;
  observationsMatched: number;
  userId: string;
}

/**
 * Thrown by `recordAgentObservation` when the target entity does not exist.
 * The MATCH-first Cypher (see below) makes this the ONLY failure mode for a
 * missing entity — no `:AgentObservation` node is created, so there is
 * nothing to orphan.
 */
export class ObservationTargetNotFoundError extends Error {
  readonly entityId: string;
  constructor(entityId: string) {
    super(`Cannot record agent observation: entity not found: ${entityId}`);
    this.name = 'ObservationTargetNotFoundError';
    this.entityId = entityId;
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default detection window: 24 hours */
const DEFAULT_DETECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default limit for insight retrieval */
const DEFAULT_INSIGHT_LIMIT = 20;

/**
 * Hard cap on ProactiveInsight nodes created per `detectInsightsForUser` run.
 *
 * Before US-5 (Stage 3 task 14) this loop created one insight per matched
 * observation with NO cap — a user who explored a busy area of the graph
 * could get dozens of insights in a single sweep. This is a defect fix, not
 * an optimization: the cap applies even when preference ranking itself
 * fails and the run falls back to confidence order (see below).
 */
const MAX_INSIGHTS_PER_RUN = 5;

// ============================================================================
// HELPERS
// ============================================================================

// Action-URL mapping lives in `lib/graph/insight-actions.ts` (Phase 0 step
// 0.4 of the 2026-05-13 briefing-pipeline cleanup) — single source of truth.

// ============================================================================
// OBSERVATION RECORDING
// ============================================================================

/**
 * Record an agent observation in Neo4j.
 *
 * Creates an AgentObservation node and an ABOUT edge to the entity it concerns.
 *
 * @param observation - The observation data (id is auto-generated)
 * @returns The created observation with its generated id
 */
const narrativeSchema = z
  .object({
    insight: z
      .object({
        title: z.string().trim().min(1).max(120).describe('a short, punchy hypothesis title'),
        narrative: z.string().trim().min(1).max(1_200).describe('2-4 sentences interpreting what the path may mean'),
        impact: z
          .string()
          .trim()
          .min(1)
          .max(800)
          .describe('the possible impact on the strategy, with explicit "because" reasoning'),
        confidence: z.number().finite().min(0).max(100).describe('0-100'),
      })
      .strict()
      .describe('the synthesized narrative insight'),
  })
  .strict();

interface ChainRow {
  strategyId: string;
  strategy: string;
  rel1: string;
  rel1SourceType: string | null;
  rel1RelationId: string | null;
  rel1AssertedBy: string | null;
  rel1ClaimStatus: string | null;
  rel1Confidence: number | null;
  rel1StartId: string;
  rel1EndId: string;
  midType: string;
  midId: string;
  mid: string;
  rel2: string;
  rel2SourceType: string | null;
  rel2RelationId: string | null;
  rel2AssertedBy: string | null;
  rel2ClaimStatus: string | null;
  rel2Confidence: number | null;
  rel2StartId: string;
  rel2EndId: string;
  endType: string;
  endId: string;
  end: string;
}

function directedPathSegment(
  from: { id: string; type: string; name: string },
  to: { id: string; type: string; name: string },
  predicate: string,
  edgeStartId: string,
  edgeEndId: string
): string | null {
  const fromLabel = `${from.type} "${from.name}"`;
  const toLabel = `${to.type} "${to.name}"`;
  if (edgeStartId === from.id && edgeEndId === to.id) {
    return `${fromLabel} -[${predicate}]-> ${toLabel}`;
  }
  if (edgeStartId === to.id && edgeEndId === from.id) {
    return `${fromLabel} <-[${predicate}]- ${toLabel}`;
  }
  return null;
}

function describeGroundedChain(chain: ChainRow, grounding: Extract<GroundedGraphPath, { ok: true }>): string | null {
  const first = directedPathSegment(
    { id: chain.strategyId, type: 'Strategy', name: chain.strategy },
    { id: chain.midId, type: chain.midType, name: chain.mid },
    grounding.sourceRelationTypes[0].toUpperCase(),
    chain.rel1StartId,
    chain.rel1EndId
  );
  const second = directedPathSegment(
    { id: chain.midId, type: chain.midType, name: chain.mid },
    { id: chain.endId, type: chain.endType, name: chain.end },
    grounding.sourceRelationTypes[1].toUpperCase(),
    chain.rel2StartId,
    chain.rel2EndId
  );
  if (!first || !second) return null;
  return `${first}; ${second}`;
}

/**
 * NARRATIVE insights — interpret the graph, don't just report a change. Finds 2-hop
 * semantic chains anchored on a Strategy (Strategy —rel→ X —rel→ Y), and has the model
 * INTERPRET each chain into a narrative with explicit impact-on-the-strategy reasoning
 * (the "signal → AI-agents → strategy ⇒ possible impact because…" story). Stored as
 * ProactiveInsight{type:'narrative'} (deterministic id → idempotent re-runs). Best-effort
 * per chain. Returns how many were created/refreshed.
 */
export async function generateNarrativeInsights(
  userId: string,
  opts: { limit?: number; recommendReports?: boolean } = {}
): Promise<number> {
  const limit = opts.limit ?? 3;
  const result = await runReadTransaction<ChainRow>(
    `MATCH (s:Strategy)-[r1]-(m)-[r2]-(e)
     WHERE NOT m:Insight AND NOT e:Insight AND NOT m:Session AND NOT e:Session
       AND ${currentEdgePredicate('r1')} AND ${currentEdgePredicate('r2')}
       AND type(r1) IN $semanticPredicates AND type(r2) IN $semanticPredicates
       AND s<>m AND m<>e AND s<>e
       AND s.id IS NOT NULL AND m.id IS NOT NULL AND e.id IS NOT NULL
       AND s.name IS NOT NULL AND m.name IS NOT NULL AND e.name IS NOT NULL
     RETURN s.id AS strategyId, s.name AS strategy,
            type(r1) AS rel1, r1.sourceRelationType AS rel1SourceType,
            r1.relationId AS rel1RelationId, r1.assertedBy AS rel1AssertedBy,
            r1.claimStatus AS rel1ClaimStatus,
            coalesce(r1.effectiveConfidence, r1.assertedConfidence, r1.confidence) AS rel1Confidence,
            startNode(r1).id AS rel1StartId, endNode(r1).id AS rel1EndId,
            labels(m)[0] AS midType, m.id AS midId, m.name AS mid,
            type(r2) AS rel2, r2.sourceRelationType AS rel2SourceType,
            r2.relationId AS rel2RelationId, r2.assertedBy AS rel2AssertedBy,
            r2.claimStatus AS rel2ClaimStatus,
            coalesce(r2.effectiveConfidence, r2.assertedConfidence, r2.confidence) AS rel2Confidence,
            startNode(r2).id AS rel2StartId, endNode(r2).id AS rel2EndId,
            labels(e)[0] AS endType, e.id AS endId, e.name AS end
     LIMIT $cap`,
    { cap: neo4j.int(limit * 3), semanticPredicates: [...CLAIM_RELATION_PREDICATES] }
  );

  const seen = new Set<string>();
  let created = 0;
  for (const c of result.records) {
    if (created >= limit) break;
    const grounding = groundGraphPathEvidence({
      predicates: [c.rel1, c.rel2],
      sourceRelationTypes: [c.rel1SourceType, c.rel2SourceType],
      relationIds: [c.rel1RelationId, c.rel2RelationId],
      assertedBy: [c.rel1AssertedBy, c.rel2AssertedBy],
      claimStatuses: [c.rel1ClaimStatus, c.rel2ClaimStatus],
      edgeConfidences: [c.rel1Confidence, c.rel2Confidence],
    });
    if (!grounding.ok) {
      log.warn('narrative insight evidence rejected (continuing)', {
        strategyId: c.strategyId,
        reason: grounding.reason,
      });
      continue;
    }

    const evidenceSummary = describeGroundedChain(c, grounding);
    if (!evidenceSummary) {
      log.warn('narrative insight path direction rejected (continuing)', { strategyId: c.strategyId });
      continue;
    }

    // Keep the pre-grounding identity so an existing narrative is refreshed
    // in place instead of duplicated on upgrade. Durable relation IDs are
    // stored as evidence and participate in the refreshed content contract.
    const key = `${c.strategyId}:${c.mid}:${c.end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let insight: z.infer<typeof narrativeSchema>['insight'];
    try {
      ({ insight } = await generateStructuredContent(
        `You are a strategy analyst. The reviewed graph contains this two-hop evidence path:\n${evidenceSummary}\nProvenance relation IDs: ${grounding.relationIds.join(', ')}.\nThis path proves graph proximity only, not a direct relationship, action, causation, funding, partnership, adoption, or ownership between its endpoints.${grounding.hasCounterEvidence ? '\nThe path includes competition or conflict semantics; treat that as counter-evidence to a positive interpretation.' : ''}\nWrite a possible interpretation and possible strategy impact. Put uncertainty or investigation language before any business action in the same sentence. Never use unqualified certainty such as will, must, proves, confirms, establishes, or guarantees. The application will label both as hypotheses. Return the "insight" object (title, narrative, impact, confidence 0-100).`,
        narrativeSchema,
        { temperature: 0.6 }
      ));
    } catch (err) {
      log.warn('narrative insight synthesis failed (continuing)', {
        strategyId: c.strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const languageValidation = validateNarrativeHypothesisLanguage(insight);
    if (!languageValidation.ok) {
      log.warn('narrative insight language rejected (continuing)', {
        strategyId: c.strategyId,
        reason: languageValidation.reason,
      });
      continue;
    }

    const id = createHash('sha256').update(`narrative:${userId}:${key}`).digest('hex').slice(0, 32);
    const counterEvidenceNote = grounding.hasCounterEvidence
      ? '\n\nCounter-evidence: the reviewed path contains competition or conflict semantics, so it cannot support a positive direct-action claim.'
      : '';
    const summary = `Observed graph path: ${evidenceSummary}.${counterEvidenceNote}\n\nInference (hypothesis): ${insight.narrative}\n\nPotential impact (hypothesis): ${insight.impact}`;
    const groundedConfidence = Math.max(0, Math.min(grounding.confidenceCeiling, insight.confidence / 100));
    await runWriteTransaction(
      `MERGE (pi:ProactiveInsight { id: $id })
       ON CREATE SET pi.userId=$userId, pi.type='narrative', pi.agentName='narrative-synthesizer',
         pi.actionable=true, pi.actionUrl=$actionUrl, pi.actionLabel='View strategy',
         pi.createdAt=$now, pi.consumed=false
       ON MATCH SET pi.refreshedAt=$now
       SET pi.title=$title, pi.summary=$summary, pi.confidenceScore=$confidence,
         pi.epistemicKind=$epistemicKind, pi.groundingVersion='predicate-path-v1',
         pi.evidenceSummary=$evidenceSummary, pi.evidenceRelationIds=$evidenceRelationIds,
         pi.evidenceAssertedBy=$evidenceAssertedBy, pi.evidenceEdgeConfidences=$evidenceEdgeConfidences,
         pi.relationshipTypes=$relationshipTypes,
         pi.sourceRelationTypes=$sourceRelationTypes, pi.pathLength=$pathLength,
         pi.hasCounterEvidence=$hasCounterEvidence
       WITH pi
       MATCH (s { id: $strategyId })
       MATCH (m { id: $midId })
       MATCH (e { id: $endId })
       MERGE (pi)-[:ABOUT]->(s)
       MERGE (pi)-[:ABOUT]->(m)
       MERGE (pi)-[:ABOUT]->(e)`,
      {
        id,
        userId,
        title: `Hypothesis: ${insight.title}`,
        summary,
        // confidenceScore is a 0–1 fraction across the insights surface (the UI renders ×100
        // as a %). The evidence path bounds model confidence: a two-hop path
        // cannot carry direct-edge certainty, and counter-evidence lowers it.
        confidence: groundedConfidence,
        epistemicKind: grounding.epistemicKind,
        evidenceSummary,
        evidenceRelationIds: grounding.relationIds,
        evidenceAssertedBy: grounding.assertedBy,
        evidenceEdgeConfidences: grounding.edgeConfidences,
        relationshipTypes: grounding.predicates,
        sourceRelationTypes: grounding.sourceRelationTypes,
        pathLength: grounding.predicates.length,
        hasCounterEvidence: grounding.hasCounterEvidence,
        // F75: use the canonical entity deep-link (sheet-param URL
        // /library/strategies?strategy=<id>). The old path-style
        // /library/strategies/<id> has no matching route and 404s.
        actionUrl: getInsightAction('strategy', c.strategyId).actionUrl ?? '/library/strategies',
        strategyId: c.strategyId,
        midId: c.midId,
        endId: c.endId,
        now: new Date().toISOString(),
      }
    );
    created += 1;

    // Proactive artifact recommendation: for each strategy-impact narrative, queue a
    // report recommendation in the inbox (deduped by the proposal key; never auto-runs).
    if (opts.recommendReports && groundedConfidence >= PROACTIVE_INSIGHT_SURFACE_FLOOR) {
      try {
        const { createProposedArtifactIfNotExists } = await import('@/lib/proposed-artifacts-admin');
        await createProposedArtifactIfNotExists({
          artifactKind: 'report',
          title: `Strategy-impact report: ${c.strategy}`,
          rationale: `Hypothesis grounded in a reviewed two-hop graph path: ${insight.impact}`,
          scope: { entityType: 'strategy', entityIds: [c.strategyId], query: c.strategy },
          confidence: groundedConfidence * 100,
          sourceUserId: userId,
        });
      } catch (recErr) {
        log.warn('narrative → report recommendation failed (continuing)', {
          strategyId: c.strategyId,
          error: recErr instanceof Error ? recErr.message : String(recErr),
        });
      }
    }
  }

  log.info('narrative insights generated', { userId, created });
  return created;
}

export async function recordAgentObservation(observation: Omit<AgentObservation, 'id'>): Promise<AgentObservation> {
  const id = crypto.randomUUID();

  try {
    const result = await runWriteTransaction<{
      id: string;
      agentType: string;
      observationType: string;
      title: string;
      summary: string;
      confidence: number;
      entityId: string;
      entityName: string;
      entityType: string;
      timestamp: string;
    }>(
      `MATCH (candidate {id: $entityId})
      WHERE candidate:Entity OR candidate:Technology OR candidate:Company OR
            candidate:UseCase OR candidate:PainPoint OR candidate:Strategy OR
            candidate:Signal OR candidate:Prototype OR candidate:Initiative OR
            candidate:OrgUnit OR candidate:Document OR candidate:RadarPlacement
      WITH collect(DISTINCT candidate) AS targets
      WHERE size(targets) = 1
      WITH targets[0] AS e
      CREATE (obs:AgentObservation {
        id: $id, agentType: $agentType, observationType: $observationType,
        title: $title, summary: $summary, confidence: $confidence,
        entityId: $entityId, entityName: $entityName, entityType: $entityType,
        timestamp: $timestamp, memoryLane: $memoryLane,
        provenanceKind: 'standalone-agent'
      })
      MERGE (obs)-[:ABOUT]->(e)
      RETURN obs.id AS id, obs.agentType AS agentType,
             obs.observationType AS observationType, obs.title AS title,
             obs.summary AS summary, obs.confidence AS confidence,
             obs.entityId AS entityId, obs.entityName AS entityName,
             obs.entityType AS entityType, obs.timestamp AS timestamp`,
      {
        id,
        agentType: observation.agentType,
        observationType: observation.observationType,
        title: observation.title,
        summary: observation.summary,
        confidence: observation.confidence,
        entityId: observation.entityId,
        entityName: observation.entityName,
        entityType: observation.entityType,
        timestamp: observation.timestamp,
        memoryLane: PROACTIVE_STANDALONE_MEMORY_LANE,
      }
    );

    const record = result.records[0];
    if (!record) {
      throw new ObservationTargetNotFoundError(observation.entityId);
    }
    const created: AgentObservation = {
      id: record.id,
      agentType: record.agentType,
      observationType: record.observationType as AgentObservation['observationType'],
      title: record.title,
      summary: record.summary,
      confidence: record.confidence,
      entityId: record.entityId,
      entityName: record.entityName,
      entityType: record.entityType,
      timestamp: record.timestamp,
    };

    try {
      const { ensureEdgesForNode } = await import('@/lib/graph/ensure-edges');
      await ensureEdgesForNode(created.id, 'AgentObservation', { entityId: observation.entityId });
    } catch {
      /* best-effort */
    }

    log.info('Agent observation recorded', {
      observationId: id,
      agentType: observation.agentType,
      entityId: observation.entityId,
    });

    return created;
  } catch (error) {
    log.error('Failed to record agent observation', error instanceof Error ? error : new Error(String(error)), {
      agentType: observation.agentType,
      entityId: observation.entityId,
    });
    throw error;
  }
}

/**
 * SKILL-043 — read back the agent observations recorded about one entity.
 *
 * `recordAgentObservation` had no entity-scoped reader. The only queries over
 * `:AgentObservation` were `detectInsightsForUser` (session-scoped, and it
 * consumes observations into insights rather than returning them) and
 * `dot-connector`'s single-id lookup. So five skills — `foresight`,
 * `scenario-planning`, `weak-signal-triage`, `graph-as-instrument` and
 * `brier-score-calibration` — write predictions, triggers and monitoring items
 * that nothing can ever ask for again. `brier-score-calibration` in particular
 * exists to score prior forecasts and had no population to score.
 *
 * Read-only and additive: no new store, no resolution state, no mutation. An
 * observation carries no owner of its own — it is a graph fact about a
 * platform-global entity — so this returns whatever the graph holds for that
 * entity, exactly as the write path recorded it.
 */
export async function getAgentObservationsForEntity(
  entityId: string,
  opts?: { sinceDays?: number; limit?: number }
): Promise<AgentObservation[]> {
  const sinceDays = opts?.sinceDays ?? 365;
  const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await runReadTransaction<{
    id: string;
    agentType: string;
    observationType: string;
    title: string;
    summary: string;
    confidence: number;
    entityId: string;
    entityName: string;
    entityType: string;
    timestamp: string;
  }>(
    `MATCH (obs:AgentObservation { entityId: $entityId })
     WHERE obs.timestamp >= $cutoff
     RETURN obs.id AS id, obs.agentType AS agentType,
            obs.observationType AS observationType, obs.title AS title,
            obs.summary AS summary, obs.confidence AS confidence,
            obs.entityId AS entityId, obs.entityName AS entityName,
            obs.entityType AS entityType, obs.timestamp AS timestamp
     ORDER BY obs.timestamp DESC
     LIMIT toInteger($limit)`,
    { entityId, cutoff, limit }
  );

  return result.records.map((record) => ({
    id: record.id,
    agentType: record.agentType,
    observationType: record.observationType as AgentObservation['observationType'],
    title: record.title,
    summary: record.summary,
    confidence: record.confidence,
    entityId: record.entityId,
    entityName: record.entityName,
    entityType: record.entityType,
    timestamp: record.timestamp,
  }));
}

// ============================================================================
// INSIGHT DETECTION
// ============================================================================

/** Shape returned from the matched observations query */
interface MatchedObservation {
  obsId: string;
  type: string;
  title: string;
  summary: string;
  agentName: string;
  confidence: number;
  entityId: string;
  entityName: string;
  entityType: string;
  timestamp: string;
}

function classifySourceObservation(obs: MatchedObservation): {
  epistemicKind: InsightEpistemicKind;
  title: string;
  summary: string;
  confidence: number;
} {
  const confidence = Math.max(0, Math.min(1, obs.confidence));
  if (obs.type === 'discovery' || obs.type === 'scoring_change') {
    return {
      epistemicKind: 'observation',
      title: `Source observation: ${obs.title}`,
      summary: `Observed by ${obs.agentName}: ${obs.summary}`,
      confidence,
    };
  }
  return {
    epistemicKind: 'inference',
    title: `Hypothesis: ${obs.title}`,
    summary: `Inference from ${obs.agentName}: ${obs.summary}`,
    confidence: Math.min(confidence, 0.5),
  };
}

/**
 * Detect proactive insights for a user by cross-referencing agent observations
 * with entities the user has explored.
 *
 * This is the core intelligence function that runs during the REFLECT step of
 * the sweep cycle. It finds AgentObservation nodes that are ABOUT entities the
 * user has EXPLORED, then creates ProactiveInsight nodes for each match.
 *
 * @param userId - The user to detect insights for
 * @param sinceMs - Time window in milliseconds (default: 24 hours)
 * @returns Detection result with counts
 */
export async function detectInsightsForUser(
  userId: string,
  sinceMs: number = DEFAULT_DETECTION_WINDOW_MS
): Promise<DetectionResult> {
  const since = new Date(Date.now() - sinceMs).toISOString();

  try {
    // Step 1: Query observations about entities the user has explored
    const matchResult = await runReadTransaction<MatchedObservation>(
      `MATCH (s:Session { userId: $userId })-[:EXPLORED]->(e)<-[:ABOUT]-(obs:AgentObservation)
       WHERE obs.timestamp > $since
       AND obs.agentType <> 'sweep-cycle'
       AND NOT EXISTS {
         MATCH (pi:ProactiveInsight { userId: $userId, sourceObservationId: obs.id })
       }
       RETURN DISTINCT obs.id AS obsId, obs.observationType AS type, obs.title AS title,
              obs.summary AS summary, obs.agentType AS agentName, obs.confidence AS confidence,
              obs.entityId AS entityId, obs.entityName AS entityName, obs.entityType AS entityType,
              obs.timestamp AS timestamp
       ORDER BY obs.confidence DESC`,
      { userId, since }
    );

    const matchedObservations = matchResult.records;
    const observationsMatched = matchedObservations.length;

    if (observationsMatched === 0) {
      log.debug('No matching observations for user', { userId });
      return { insightsCreated: 0, observationsMatched: 0, userId };
    }

    // Step 1.5: Re-rank by the user's per-topic preference posterior (boost
    // acted-on topics, floor heavily-dismissed ones — never remove) and cap
    // at MAX_INSIGHTS_PER_RUN. Dynamic-import both dependencies — same
    // precedent as `getInsightTopics` above (server-only Firestore reads
    // from a graph/ module). A ranking failure anywhere in this block must
    // not fail the whole run: fall back to confidence order, still capped.
    let toSurface: MatchedObservation[];
    try {
      const { getEffectivePreferences } = await import('@/lib/discovery/cold-start');
      const { resolveEntityTopic } = await import('@/lib/discovery/entity-topic');

      const preferences = await getEffectivePreferences(userId);

      // One bad Firestore read must not collapse the whole run — a failed
      // per-entity topic resolution degrades just that entity to neutral
      // (via the entityType fallback, which won't match any preference row).
      const topicEntries = await Promise.all(
        matchedObservations.map(async (obs) => {
          const topic = await resolveEntityTopic(obs.entityId, obs.entityType).catch(() => obs.entityType);
          return [obs.entityId, topic] as const;
        })
      );
      const topicByEntityId = new Map(topicEntries);

      toSurface = rankObservationsByPreference(matchedObservations, preferences, topicByEntityId, {
        cap: MAX_INSIGHTS_PER_RUN,
      });
    } catch (rankError) {
      log.warn('Preference ranking failed — falling back to confidence order (still capped)', {
        userId,
        error: rankError instanceof Error ? rankError.message : String(rankError),
      });
      toSurface = matchedObservations.slice(0, MAX_INSIGHTS_PER_RUN);
    }

    // Step 2: Create ProactiveInsight nodes for each surfaced observation
    let insightsCreated = 0;

    for (const obs of toSurface) {
      // Stable per (caller, source observation): concurrent/retried sweeps
      // converge on one durable card instead of racing two CREATE writes.
      const insightId = createHash('sha256')
        .update(`observation-insight:${userId}:${obs.obsId}`)
        .digest('hex')
        .slice(0, 32);
      const now = new Date().toISOString();
      const { actionUrl, actionLabel } = getInsightAction(obs.entityType, obs.entityId);
      const classified = classifySourceObservation(obs);

      try {
        const writeResult = await runWriteTransaction(
          `MATCH (e { id: $entityId })
          MERGE (pi:ProactiveInsight { id: $id })
          ON CREATE SET pi.createdAt = $now, pi.consumed = false
          SET pi.userId = $userId, pi.type = $type, pi.title = $title, pi.summary = $summary,
            pi.agentName = $agentName, pi.confidenceScore = $confidence, pi.actionable = true,
            pi.actionUrl = $actionUrl, pi.actionLabel = $actionLabel,
            pi.epistemicKind = $epistemicKind, pi.groundingVersion = 'agent-observation-v1',
            pi.sourceObservationId = $sourceObservationId, pi.refreshedAt = $now
          MERGE (pi)-[:ABOUT]->(e)`,
          {
            id: insightId,
            userId,
            type: obs.type,
            title: classified.title,
            summary: classified.summary,
            agentName: obs.agentName,
            confidence: classified.confidence,
            epistemicKind: classified.epistemicKind,
            actionUrl,
            actionLabel,
            now,
            entityId: obs.entityId,
            sourceObservationId: obs.obsId,
          }
        );

        // MERGE is intentionally replay-safe. Only the transaction that
        // actually creates the node may count or announce a new insight.
        if (writeResult.summary.counters.nodesCreated > 0) {
          insightsCreated++;
        }
      } catch (insightError) {
        log.error(
          'Failed to create insight for observation',
          insightError instanceof Error ? insightError : new Error(String(insightError)),
          { observationId: obs.obsId, entityId: obs.entityId }
        );
        // Continue processing remaining observations
      }
    }

    log.info('Insight detection complete', {
      userId,
      observationsMatched,
      insightsCreated,
    });

    // Emit insight.created event (best-effort, non-blocking)
    if (insightsCreated > 0) {
      try {
        const { emitAgentEvent } = await import('@/lib/agent-events');
        await emitAgentEvent({
          type: 'insight.created',
          userId,
          data: { insightsCreated, observationsMatched },
        });
      } catch {
        // Event emission must never break insight detection
      }
    }

    return { insightsCreated, observationsMatched, userId };
  } catch (error) {
    log.error('Failed to detect insights for user', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}

/**
 * Record a user-facing observation for each entity the user EXPLORED that was UPDATED
 * after they last viewed it — the "X has new info since you looked" signal.
 *
 * This is the SIGNAL that feeds {@link detectInsightsForUser}. It is deliberately
 * distinct from the sweep's own `sweep-cycle` bookkeeping observations (titles like
 * "Sweep: X (stale)"), which detectInsightsForUser de-noises out — so re-enabling
 * insight surfacing does not flood the briefing with internal sweep churn.
 *
 * Signal: `entity.updatedAt` (epoch ms) > `EXPLORED.firstViewedAt` (ISO → epochMillis).
 * Dedup: a given update fires once — `(entityId, agentType, sourceUpdatedAt)` guards
 * re-creation across sweep cycles. Throws on a write failure (the caller's REFLECT step
 * logs + isolates per-user); never swallows a failure into a misleading "no insights".
 *
 * @returns the number of `interest-watch` observations created this run.
 */
export async function observeWatchedEntityUpdates(userId: string): Promise<number> {
  const now = new Date().toISOString();
  // Collapse per entity ID (one row per id — robust to duplicate entity nodes sharing
  // an id) and compare against the MOST-RECENT view across the user's sessions
  // (max(lastViewedAt|firstViewedAt)) — NOT the first view — so a change the user has
  // already revisited-and-seen does not re-surface (mirrors dot-connector's precedent).
  // entityType IS NOT NULL: only entities that can resolve an action URL are surfaceable.
  const result = await runWriteTransaction<{ created: number }>(
    `MATCH (s:Session { userId: $userId })-[rel:EXPLORED]->(e)
     WHERE e.updatedAt IS NOT NULL AND e.entityType IS NOT NULL
     WITH e.id AS entityId, collect(e)[0] AS e,
          max(coalesce(rel.lastViewedAt, rel.firstViewedAt)) AS lastViewed
     WHERE lastViewed IS NOT NULL AND e.updatedAt > datetime(lastViewed).epochMillis
       AND NOT EXISTS {
         MATCH (o:AgentObservation { entityId: entityId, agentType: 'interest-watch' })
         WHERE o.sourceUpdatedAt = e.updatedAt
       }
     CREATE (o:AgentObservation {
       id: randomUUID(), agentType: 'interest-watch', observationType: 'update',
       title: '"' + coalesce(e.name, e.title, entityId) + '" has new info since you last viewed it',
       summary: 'An entity you explored was updated after your last visit — open it to see what changed.',
       confidence: 0.7, entityId: entityId, entityName: coalesce(e.name, e.title, entityId),
       entityType: e.entityType, sourceUpdatedAt: e.updatedAt, timestamp: $now
     })
     MERGE (o)-[:ABOUT]->(e)
     RETURN count(o) AS created`,
    { userId, now }
  );
  // runWriteTransaction already flattens Neo4j Integer → JS number (toNativeValue).
  const rec = result.records[0];
  if (!rec) {
    // A `RETURN count(o)` query must yield exactly one row; an empty result is a driver/
    // aggregation regression, not a legitimate zero — surface it rather than swallow.
    log.warn('observeWatchedEntityUpdates: count query returned no rows (unexpected)', { userId });
  }
  const created = Number(rec?.created ?? 0);
  log.info('Watched-entity update observations recorded', { userId, created });
  return created;
}

// ============================================================================
// INSIGHT RETRIEVAL
// ============================================================================

/** Shape returned from the insights query */
interface InsightRecord {
  id: string;
  type: string;
  title: string;
  summary: string;
  agentName: string;
  confidenceScore: number;
  actionable: boolean;
  actionUrl: string;
  actionLabel: string;
  createdAt: string;
  observedEntityId: string | null;
  exploredEntityId: string | null;
  liked: boolean | null;
  relationshipTypes: string[] | null;
  sourceRelationTypes: string[] | null;
  relationshipDirections: Array<'forward' | 'reverse'> | null;
  evidenceSummary: string | null;
  groundingVersion: string | null;
  epistemicKind: InsightEpistemicKind | null;
  pathLength: number | null;
  exploredAt: string | null;
  entities: Array<{ id: string; name: string; type: string }>;
}

/**
 * Get unconsumed proactive insights for a user.
 *
 * Retrieves ProactiveInsight nodes that have not been consumed yet,
 * along with their related entities via ABOUT edges.
 *
 * @param userId - The user to get insights for
 * @param limit - Maximum number of insights to return (default: 20)
 * @returns Array of proactive insight nodes
 */
export async function getInsightsForUser(
  userId: string,
  limit: number = DEFAULT_INSIGHT_LIMIT
): Promise<ProactiveInsightNode[]> {
  try {
    // Quality gate: even after the write-side
    // fixes (0.1–0.5), Neo4j still holds a backlog of low-quality rows from
    // pre-fix sweeps. These predicates are defence-in-depth — anything that
    // slips past the write side never reaches the UI:
    //
    //   - confidenceScore >= 0.4: matches the relevance threshold in the
    //     dot-connector. The sole exception is a fully grounded counter-
    //     evidence path at 0.35: its lower score is meaningful and its
    //     warning value should remain visible rather than be inflated.
    //   - actionUrl IS NOT NULL: new insights from `getInsightAction` use
    //     null to signal "no useful destination". Filter those out.
    //   - actionUrl <> '/library': legacy pre-0.4 default, equally useless.
    //
    // The plan originally also denied `agentName='sweep-cycle'` as
    // belt-and-braces against the bookkeeping leak that step 0.3 closed.
    // We dropped that predicate at step 0.9 after live verification: ALL
    // legitimate connectDots insights inherit `sweep-cycle` as their
    // agentName (because the dot-connector is invoked from the sweep, and
    // it copies the source observation's agent name into the insight). The
    // leak is closed at the write side — distinguishing legit dot-connector
    // output from REFLECT bookkeeping by agentName isn't possible. Trust
    // step 0.3.
    const result = await runReadTransaction<InsightRecord>(
      `MATCH (pi:ProactiveInsight { userId: $userId, consumed: false })
       WHERE (pi.confidenceScore >= ${PROACTIVE_INSIGHT_SURFACE_FLOOR}
         OR (pi.groundingVersion = 'predicate-path-v1'
           AND pi.epistemicKind = 'inference'
           AND pi.hasCounterEvidence = true
           AND pi.confidenceScore >= ${GROUNDED_COUNTER_EVIDENCE_FLOOR}))
         AND pi.actionUrl IS NOT NULL
         AND pi.actionUrl <> '/library'
       OPTIONAL MATCH (pi)-[:ABOUT]->(e)
       WITH pi, collect({ id: e.id, name: coalesce(e.name, e.title), type: e.entityType }) AS entities
       RETURN pi.id AS id, pi.type AS type, pi.title AS title, pi.summary AS summary,
              pi.agentName AS agentName, pi.confidenceScore AS confidenceScore,
              pi.actionable AS actionable, pi.actionUrl AS actionUrl,
              pi.actionLabel AS actionLabel, pi.createdAt AS createdAt,
              pi.observedEntityId AS observedEntityId,
              pi.exploredEntityId AS exploredEntityId,
              coalesce(pi.liked, false) AS liked,
              pi.relationshipTypes AS relationshipTypes,
              pi.sourceRelationTypes AS sourceRelationTypes,
              pi.relationshipDirections AS relationshipDirections,
              pi.evidenceSummary AS evidenceSummary,
              pi.groundingVersion AS groundingVersion,
              pi.epistemicKind AS epistemicKind,
              pi.pathLength AS pathLength,
              pi.exploredAt AS exploredAt,
              entities
       // Liked insights bubble up, then higher-confidence, then recent — so the
       // like/dismiss feedback actually RE-RANKS (was ordered by recency only).
       ORDER BY coalesce(pi.liked, false) DESC, pi.confidenceScore DESC, pi.createdAt DESC
       LIMIT $limit`,
      { userId, limit: neo4j.int(limit) }
    );

    return result.records.map((record) => ({
      id: record.id,
      userId,
      type: record.type as ProactiveInsightNode['type'],
      title: record.title,
      summary: record.summary,
      agentName: record.agentName,
      confidenceScore: record.confidenceScore,
      relatedEntities: (record.entities ?? []).filter((e: { id: string; name: string; type: string }) => e.id != null),
      observedEntityId: record.observedEntityId ?? undefined,
      exploredEntityId: record.exploredEntityId ?? undefined,
      actionable: record.actionable,
      actionUrl: record.actionUrl,
      actionLabel: record.actionLabel,
      createdAt: record.createdAt,
      consumed: false,
      liked: record.liked ?? false,
      relationshipTypes: record.relationshipTypes ?? undefined,
      sourceRelationTypes: record.sourceRelationTypes ?? undefined,
      relationshipDirections: record.relationshipDirections ?? undefined,
      evidenceSummary: record.evidenceSummary ?? undefined,
      groundingVersion: record.groundingVersion ?? undefined,
      epistemicKind: record.epistemicKind ?? undefined,
      pathLength: record.pathLength ?? undefined,
      exploredAt: record.exploredAt ?? undefined,
    }));
  } catch (error) {
    log.error('Failed to get insights for user', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}

// ============================================================================
// INSIGHT CONSUMPTION
// ============================================================================

/**
 * Mark a proactive insight as consumed.
 *
 * Sets the `consumed` flag to true and records the consumption timestamp.
 *
 * @param insightId - The insight to mark as consumed
 * @param userId - Owner uid (SEC-008); foreign/absent ids are the same no-op
 */
export async function markInsightConsumed(insightId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();

  try {
    await runWriteTransaction(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })
       SET pi.consumed = true, pi.consumedAt = $now`,
      { id: insightId, userId, now }
    );

    log.info('Insight marked as consumed', { insightId });
  } catch (error) {
    log.error('Failed to mark insight as consumed', error instanceof Error ? error : new Error(String(error)), {
      insightId,
    });
    throw error;
  }
}

/**
 * Soft-consume every pre-2026-05-13 connection insight in one pass.
 *
 * Background: the 2026-05-12 dot-connector fix restricted path traversal to
 * semantic relation types (USES, VENDOR, PARTNER, …) and started writing
 * `observedEntityId` / `exploredEntityId` on each insight. Insights created
 * before that change still live in Neo4j with paths through bookkeeping edges
 * (HAS_CONCEPT, ABOUT, EXPLORED) and look like agent hallucinations on the
 * UI. The absence of `observedEntityId` is the reliable staleness marker —
 * it's only set by the post-fix code path.
 *
 * The function flips `consumed=true` instead of deleting. The audit trail is
 * preserved and the next sweep cycle will produce a fresh batch of insights
 * through the new query path.
 *
 * Selection: `type='connection' AND consumed=false AND observedEntityId IS NULL`.
 *
 * Phase 0 step 0.2 of the briefing-pipeline cleanup plan (2026-05-13).
 *
 * @returns Number of insight nodes flipped.
 */
export async function purgeStaleConnectionInsights(): Promise<number> {
  const now = new Date().toISOString();
  try {
    const result = await runWriteTransaction<{ purged: number }>(
      `MATCH (pi:ProactiveInsight { type: 'connection', consumed: false })
       WHERE pi.observedEntityId IS NULL
       SET pi.consumed = true, pi.consumedAt = $now, pi.purgedReason = 'pre-2026-05-13-stale'
       RETURN count(pi) AS purged`,
      { now }
    );
    return result.records[0]?.purged ?? 0;
  } catch (error) {
    log.error('Failed to purge stale connection insights', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// ENGAGEMENT TOPIC DERIVATION
// ============================================================================

/**
 * Return the distinct entity types this insight is about.
 *
 * Used by the preference tracker on click/dismiss so the resulting Neo4j
 * UserPreference row is keyed by entity type (e.g. "technology", "company")
 * rather than by the action string. Without this, every preference write
 * collapses into one of two buckets ("clicked" / "dismissed") and the
 * per-topic weights can't actually bias future agent missions.
 *
 * Returns `[]` if the insight has no linked entities (orphan insight, edge
 * case) — caller should skip the preference write in that case rather than
 * failing the request. Neo4j errors are swallowed and reported as `[]` for
 * the same reason: a flaky read shouldn't 500 a user-facing engagement call.
 */
export async function getInsightEntityTypes(insightId: string, userId: string): Promise<string[]> {
  try {
    const result = await runReadTransaction<{ entityType: string | null }>(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })-[:ABOUT]->(e)
       WHERE e.entityType IS NOT NULL
       RETURN DISTINCT e.entityType AS entityType`,
      { id: insightId, userId }
    );

    return result.records.map((r) => r.entityType).filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch (error) {
    log.warn('Failed to read insight entity types — preference write will be skipped', {
      insightId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * The TAG TOPICS of an insight's subject entities — resolved via `resolveEntityTopic` so the
 * key-space matches the discovery selector's (A1). Use this (not getInsightEntityTypes, which
 * returns coarse 'technology'/'company' type strings disjoint from the selector) when an
 * insight like/dismiss should also STEER discovery, not just re-rank insights.
 */
export async function getInsightTopics(insightId: string, userId: string): Promise<string[]> {
  try {
    const result = await runReadTransaction<{ id: string; entityType: string }>(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })-[:ABOUT]->(e)
       WHERE e.id IS NOT NULL AND e.entityType IS NOT NULL
       RETURN DISTINCT e.id AS id, e.entityType AS entityType`,
      { id: insightId, userId }
    );
    const { resolveEntityTopic } = await import('@/lib/discovery/entity-topic');
    const topics = await Promise.all(result.records.map((r) => resolveEntityTopic(r.id, r.entityType)));
    return [...new Set(topics.filter((t) => typeof t === 'string' && t.length > 0))];
  } catch (error) {
    log.warn('Failed to read insight topics — preference write will be skipped', {
      insightId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ============================================================================
// CONSUMPTION WRITE OPERATIONS (Option A step A.2 — undo contract)
// ============================================================================

/**
 * Set the `consumed` boolean on an insight to the requested state and
 * return the prior values so the caller can decide whether to also write
 * (or roll back) the per-topic preference counters.
 *
 * Idempotency contract: a POST that retries must not double-
 * write. Prior-state read and SET happen in the same transaction.
 *
 * When `consumed: true` and `options.topics` is provided, the topics are
 * persisted as `pi.lastDismissWroteTopics` so a later DELETE can decrement
 * `dismissed_count` only on the rows the dismiss actually touched. When
 * `consumed: false`, the marker is cleared and its prior value is
 * returned in `previousTopics` (so the caller can roll back preferences).
 *
 * Bulk dismiss intentionally does NOT pass `options.topics` — per Q3 the
 * bulk path skips preference writes entirely.
 *
 * Ownership (SEC-008): the MATCH binds `userId`, so a foreign id and an
 * absent id are the identical `exists: false` miss.
 */
export async function setInsightConsumedState(
  insightId: string,
  consumed: boolean,
  userId: string,
  options: { topics?: string[] } = {}
): Promise<{
  exists: boolean;
  previousConsumed: boolean;
  previousTopics: string[];
}> {
  try {
    const result = await runWriteTransaction<{
      previousConsumed: boolean;
      previousTopics: string[] | null;
    }>(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })
       WITH pi,
            coalesce(pi.consumed, false) AS previousConsumed,
            coalesce(pi.lastDismissWroteTopics, []) AS previousTopics
       SET pi.consumed = $consumed,
           pi.consumedAt = CASE
             WHEN $consumed = true AND previousConsumed = false THEN $now
             WHEN $consumed = false THEN null
             ELSE pi.consumedAt
           END,
           pi.lastDismissWroteTopics = CASE
             WHEN $consumed = true THEN $topics
             ELSE null
           END
       RETURN previousConsumed AS previousConsumed, previousTopics AS previousTopics`,
      {
        id: insightId,
        userId,
        consumed,
        // Pass empty list when topics are undefined so the property write
        // is deterministic (null on undismiss, list on dismiss). Neo4j
        // can't store undefined.
        topics: options.topics ?? [],
        now: new Date().toISOString(),
      }
    );

    if (result.records.length === 0) {
      return { exists: false, previousConsumed: false, previousTopics: [] };
    }
    const record = result.records[0];
    return {
      exists: true,
      previousConsumed: !!record.previousConsumed,
      previousTopics: Array.isArray(record.previousTopics) ? record.previousTopics : [],
    };
  } catch (error) {
    log.error('Failed to set insight consumed state', error instanceof Error ? error : new Error(String(error)), {
      insightId,
      consumed,
    });
    throw error;
  }
}

/**
 * Bulk variant of `setInsightConsumedState` for the bulk-dismiss /
 * bulk-undismiss endpoints. No topic tracking: bulk
 * dismiss skips preference writes by design.
 *
 * Returns `changed`: the count of insights whose `consumed` flag actually
 * flipped state (a re-dismiss / re-undismiss of rows already in the target
 * state is a no-op on those rows). The list `insightIds` may freely
 * contain unknown OR foreign IDs; both are silently skipped by the same
 * uid-bound MATCH (SEC-008), so the response never reveals which was which.
 */
export async function bulkSetInsightsConsumed(
  insightIds: string[],
  consumed: boolean,
  userId: string
): Promise<{ changed: number }> {
  if (insightIds.length === 0) return { changed: 0 };
  try {
    const result = await runWriteTransaction<{ changed: number }>(
      `UNWIND $ids AS id
       MATCH (pi:ProactiveInsight { id: id, userId: $userId })
       WITH pi, coalesce(pi.consumed, false) AS previousConsumed
       WHERE previousConsumed <> $consumed
       SET pi.consumed = $consumed,
           pi.consumedAt = CASE WHEN $consumed = true THEN $now ELSE null END,
           pi.lastDismissWroteTopics = null
       RETURN count(pi) AS changed`,
      { ids: insightIds, consumed, userId, now: new Date().toISOString() }
    );
    const raw = result.records[0]?.changed ?? 0;
    // neo4j-driver returns counts as Neo4j Integer objects; flatten to JS number.
    const changed =
      typeof raw === 'object' && raw !== null && 'low' in (raw as Record<string, unknown>)
        ? (raw as { low: number }).low
        : (raw as number);
    return { changed };
  } catch (error) {
    log.error('Failed to bulk-set insights consumed state', error instanceof Error ? error : new Error(String(error)), {
      count: insightIds.length,
      consumed,
    });
    throw error;
  }
}

// ============================================================================
// ENGAGEMENT WRITE OPERATIONS (Option A step A.1)
// ============================================================================

/**
 * Set the `liked` boolean on an insight to the requested state and return
 * the prior value so the caller can detect a no-op vs a real transition.
 *
 * Idempotency contract: a POST that retries must not double-flip.
 * The prior-state read and the SET happen inside the same write transaction
 * so concurrent retries can't interleave. Callers compare `previousLiked`
 * with the requested `liked` to decide whether to also adjust the per-topic
 * `acted_count` — only the first successful transition writes to
 * UserPreference; retries are silent no-ops at the preference layer.
 *
 * `likedAt` is set to `datetime()` on the false → true transition, cleared
 * on true → false, and left untouched otherwise (so refreshing a still-liked
 * insight doesn't reset its sort-by-recent-likes timestamp).
 */
export async function setInsightLikedState(
  insightId: string,
  liked: boolean,
  userId: string
): Promise<{ exists: boolean; previousLiked: boolean }> {
  try {
    const result = await runWriteTransaction<{ previousLiked: boolean }>(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })
       WITH pi, coalesce(pi.liked, false) AS previousLiked
       SET pi.liked = $liked,
           pi.likedAt = CASE
             WHEN $liked = true AND previousLiked = false THEN datetime()
             WHEN $liked = false THEN null
             ELSE pi.likedAt
           END
       RETURN previousLiked AS previousLiked`,
      { id: insightId, liked, userId }
    );

    if (result.records.length === 0) {
      return { exists: false, previousLiked: false };
    }
    return { exists: true, previousLiked: !!result.records[0].previousLiked };
  } catch (error) {
    log.error('Failed to set insight liked state', error instanceof Error ? error : new Error(String(error)), {
      insightId,
      liked,
    });
    throw error;
  }
}

/**
 * Record a view of an insight from a specific session. Idempotent within
 * the (session, insight) pair: a second call from the same session is a
 * no-op and returns `recorded: false`.
 *
 * Implements the Q1 debouncing contract: opening the detail page counts as
 * positive engagement, but only once per browsing session. The sentinel is
 * a `:VIEWED_INSIGHT` edge with a `viewedAt` timestamp on first creation.
 * Subsequent calls match the existing edge and short-circuit before any
 * preference write fires (the caller checks `recorded`).
 *
 * Returns `exists: false` if either the session or the insight doesn't
 * exist — the route translates that into a 404 / 400.
 */
export async function recordInsightView(
  sessionId: string,
  insightId: string,
  userId: string
): Promise<{ exists: boolean; recorded: boolean }> {
  try {
    const result = await runWriteTransaction<{ isNew: boolean }>(
      `MATCH (s:Session { id: $sessionId })
       MATCH (pi:ProactiveInsight { id: $insightId, userId: $userId })
       OPTIONAL MATCH (s)-[existing:VIEWED_INSIGHT]->(pi)
       WITH s, pi, existing IS NULL AS isNew
       FOREACH (_ IN CASE WHEN isNew THEN [1] ELSE [] END |
         CREATE (s)-[:VIEWED_INSIGHT { viewedAt: datetime() }]->(pi)
       )
       RETURN isNew AS isNew`,
      { sessionId, insightId, userId }
    );

    if (result.records.length === 0) {
      return { exists: false, recorded: false };
    }
    return { exists: true, recorded: !!result.records[0].isNew };
  } catch (error) {
    log.error('Failed to record insight view', error instanceof Error ? error : new Error(String(error)), {
      sessionId,
      insightId,
    });
    throw error;
  }
}

/**
 * Fetch a single insight by ID with its related entities. Used by the
 * detail endpoint to render the "Why am I seeing this?" breadcrumb with
 * the structured path data persisted in A.0.
 *
 * Ownership (SEC-008): the read binds `userId` in the MATCH — the earlier
 * "intentionally global" posture (plan §7.5) is superseded by the
 * repository authorization baseline. A foreign id and an absent id are
 * the identical `null` miss, so existence never leaks across users.
 */
export async function getInsightById(insightId: string, userId: string): Promise<ProactiveInsightNode | null> {
  try {
    const result = await runReadTransaction<InsightRecord & { userId: string; consumed: boolean }>(
      `MATCH (pi:ProactiveInsight { id: $id, userId: $userId })
       OPTIONAL MATCH (pi)-[:ABOUT]->(e)
       WITH pi, collect({ id: e.id, name: coalesce(e.name, e.title), type: e.entityType }) AS entities
       RETURN pi.id AS id, pi.userId AS userId, pi.type AS type, pi.title AS title, pi.summary AS summary,
              pi.agentName AS agentName, pi.confidenceScore AS confidenceScore,
              pi.actionable AS actionable, pi.actionUrl AS actionUrl,
              pi.actionLabel AS actionLabel, pi.createdAt AS createdAt,
              coalesce(pi.consumed, false) AS consumed,
              pi.observedEntityId AS observedEntityId,
              pi.exploredEntityId AS exploredEntityId,
              coalesce(pi.liked, false) AS liked,
              pi.relationshipTypes AS relationshipTypes,
              pi.sourceRelationTypes AS sourceRelationTypes,
              pi.relationshipDirections AS relationshipDirections,
              pi.evidenceSummary AS evidenceSummary,
              pi.groundingVersion AS groundingVersion,
              pi.epistemicKind AS epistemicKind,
              pi.pathLength AS pathLength,
              pi.exploredAt AS exploredAt,
              entities`,
      { id: insightId, userId }
    );

    if (result.records.length === 0) return null;
    const record = result.records[0];
    return {
      id: record.id,
      userId: record.userId,
      type: record.type as ProactiveInsightNode['type'],
      title: record.title,
      summary: record.summary,
      agentName: record.agentName,
      confidenceScore: record.confidenceScore,
      relatedEntities: (record.entities ?? []).filter((e) => e.id != null),
      observedEntityId: record.observedEntityId ?? undefined,
      exploredEntityId: record.exploredEntityId ?? undefined,
      actionable: record.actionable,
      actionUrl: record.actionUrl,
      actionLabel: record.actionLabel,
      createdAt: record.createdAt,
      consumed: !!record.consumed,
      liked: record.liked ?? false,
      relationshipTypes: record.relationshipTypes ?? undefined,
      sourceRelationTypes: record.sourceRelationTypes ?? undefined,
      relationshipDirections: record.relationshipDirections ?? undefined,
      evidenceSummary: record.evidenceSummary ?? undefined,
      groundingVersion: record.groundingVersion ?? undefined,
      epistemicKind: record.epistemicKind ?? undefined,
      pathLength: record.pathLength ?? undefined,
      exploredAt: record.exploredAt ?? undefined,
    };
  } catch (error) {
    log.error('Failed to get insight by id', error instanceof Error ? error : new Error(String(error)), { insightId });
    throw error;
  }
}

// ============================================================================
// STATISTICS
// ============================================================================

/** Shape returned from the stats query */
interface InsightStatsRecord {
  total: number;
  unconsumed: number;
  lastDetectedAt: string | null;
}

/**
 * Get insight statistics for a user.
 *
 * Returns total insight count, unconsumed count, and the timestamp
 * of the most recently created insight.
 *
 * @param userId - The user to get stats for
 * @returns Insight statistics
 */
export async function getInsightStats(
  userId: string
): Promise<{ total: number; unconsumed: number; lastDetectedAt: string | null }> {
  try {
    const result = await runReadTransaction<InsightStatsRecord>(
      `MATCH (pi:ProactiveInsight { userId: $userId })
       RETURN count(pi) AS total,
              sum(CASE WHEN pi.consumed = false THEN 1 ELSE 0 END) AS unconsumed,
              max(pi.createdAt) AS lastDetectedAt`,
      { userId }
    );

    if (result.records.length === 0) {
      return { total: 0, unconsumed: 0, lastDetectedAt: null };
    }

    const record = result.records[0];
    return {
      total: record.total,
      unconsumed: record.unconsumed,
      lastDetectedAt: record.lastDetectedAt,
    };
  } catch (error) {
    log.error('Failed to get insight stats', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}
