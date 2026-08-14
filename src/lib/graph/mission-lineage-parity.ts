/**
 * @file lib/graph/mission-lineage-parity.ts
 * @description GRAPH-030 — make the Neo4j lineage of a mission agree with the
 * mission's CANONICAL terminal outcome, after the fact.
 *
 * ## The divergence this closes
 *
 * `run-agent-mission` resolves one memoized terminal decision and then, in
 * order: writes the Reflection, finalizes the Episode, writes the AgentRun, and
 * writes the Mission. Every one of those steps consumes the same decision, so
 * while the handler runs to completion the four stores agree.
 *
 * The hole is what happens when a step AFTER the graph writes fails
 * permanently. `create-reflection` has already stored `success: true` and
 * `finalize-episode` has already set `status: 'completed'`; then `write-agent-run`
 * or `update-mission-results` throws, retries are exhausted, and `onFailure`
 * writes a `failed` Mission plus a reconciled failed AgentRun. Firestore now says
 * failed and Neo4j still says completed — which is exactly the retained TEST-027
 * evidence: *"stored failed Mission and AgentRun outcomes, but Neo4j retained a
 * completed Episode and `AgentReflection.success = true`."*
 *
 * Firestore and Neo4j are separate systems; there is no cross-database
 * transaction to reach for. What there IS is a durable canonical answer (the
 * Mission doc) and an idempotent repair that drives the graph to it. That is what
 * this module is.
 *
 * ## Rules it holds to
 *
 * - **Canonical-driven, never inferred.** The caller passes the outcome it just
 *   persisted as canonical. This module never re-derives the outcome from graph
 *   state, because the graph state is the thing being corrected.
 * - **Downgrade-only for success claims.** A `completed` Episode may be moved to
 *   `failed`, and a `success: true` Reflection to `false`. The reverse is never
 *   performed here: promoting a failed lineage to success on the strength of a
 *   repair pass is precisely the fabrication the row forbids.
 * - **First terminal instant preserved.** `endedAt` is never rewritten, so the
 *   real end of work survives the correction and a replay cannot walk it forward.
 * - **Idempotent.** A second pass over already-corrected lineage performs no
 *   write and reports `already-consistent`, so an Inngest retry of `onFailure`
 *   cannot churn the graph.
 * - **Never destructive.** A Reflection whose success claim was wrong is
 *   corrected in place and stamped with the reconciliation, not deleted. The fact
 *   that the agent *generated* a positive reflection is itself evidence worth
 *   keeping.
 */

import 'server-only';

import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { isUnsuccessfulDomainOutcome, type DomainOutcome } from '@/lib/observability/terminal-outcome';

const log = createLogger('graph/mission-lineage-parity');

/** Marker recorded on corrected nodes so a repair is auditable, not silent. */
export const LINEAGE_RECONCILIATION_VERSION = 'mission-lineage-parity-v1';

/**
 * Whether a canonical outcome PROVES the Episode must be terminal-`failed`.
 *
 * Note what this deliberately does NOT do: derive a `completed` status. The
 * Episode vocabulary (`active` / `completed` / `failed` / `abandoned`) is coarser
 * than `DomainOutcome`, and the mapping is only one-way total. `partial` is the
 * proof: a mission that timed out and recovered a checkpoint is canonically
 * `status: 'failed', partial: true`, and its Episode is finalized `failed` — while
 * a mission that delivered and was then trimmed to a partial artifact would be
 * `completed`. `partial` alone therefore cannot decide the coarse status; only the
 * mission's own finalizer, which holds the real terminal status, can.
 *
 * So this predicate answers only the question the repair pass actually needs, and
 * everything it cannot prove routes to `refused-upgrade`. The finer value always
 * travels separately as `missionOutcome`, which is what makes exact parity
 * assertable without forking the status enum.
 */
export function requiresFailedEpisodeStatus(outcome: DomainOutcome): boolean {
  return isUnsuccessfulDomainOutcome(outcome) || outcome === 'cancelled';
}

/**
 * Whether a Reflection's `success` flag may claim true for this outcome.
 *
 * `partial` may: recovered output is real work, and the mission runner only ever
 * writes a reflection for a canonically completed run in the first place.
 */
export function reflectionSuccessForDomainOutcome(outcome: DomainOutcome): boolean {
  return !requiresFailedEpisodeStatus(outcome);
}

/**
 * What the reconciliation did — reported, never guessed.
 *
 * `already-consistent` and `no-lineage` are both legitimate: the first means the
 * graph already agreed, the second that this mission has no graph lineage to
 * correct (Neo4j was unavailable when the Episode would have been created, or the
 * mission is intentionally non-agent work).
 */
export interface MissionLineageReconciliation {
  outcome: DomainOutcome;
  episode: 'corrected' | 'already-consistent' | 'no-lineage' | 'refused-upgrade';
  reflectionsCorrected: number;
  reflectionsInspected: number;
}

/**
 * Drive a mission's Neo4j lineage to `outcome`.
 *
 * Throws on a Neo4j failure so the caller can decide: `onFailure` logs and
 * continues (the Mission is already authoritative and a later pass can retry),
 * while an acceptance test asserts the throw rather than a silent success.
 */
export async function reconcileMissionLineageOutcome(params: {
  missionId: string;
  outcome: DomainOutcome;
  /** Bounded diagnostic stored on corrected nodes. */
  reason?: string;
}): Promise<MissionLineageReconciliation> {
  const { missionId, outcome } = params;
  const mustFail = requiresFailedEpisodeStatus(outcome);
  const targetStatus: 'completed' | 'failed' = mustFail ? 'failed' : 'completed';
  const targetReflectionSuccess = reflectionSuccessForDomainOutcome(outcome);
  const reason = params.reason?.slice(0, 200) ?? null;

  // A repair pass only ever REMOVES an unearned success claim. Asking it to
  // promote failed lineage to completed is refused outright rather than
  // partially honoured, so a caller cannot use it to manufacture a green run.
  // (The success direction is owned by `finalizeMissionEpisode`, which runs
  // inside the mission's own memoized step and has the real result to hand.)
  if (!mustFail) {
    const inspected = await runReadTransaction<{ episodes: number; reflections: number }>(
      `OPTIONAL MATCH (e:Episode {missionId: $missionId})
       WITH collect(e) AS episodes
       OPTIONAL MATCH (r:AgentReflection {missionId: $missionId})
       RETURN size([x IN episodes WHERE x IS NOT NULL]) AS episodes,
              count(r) AS reflections`,
      { missionId }
    );
    const episodes = inspected.records[0]?.episodes ?? 0;
    log.warn('Refused to upgrade mission graph lineage to a success claim', { missionId, outcome, episodes });
    return {
      outcome,
      episode: episodes > 0 ? 'refused-upgrade' : 'no-lineage',
      reflectionsCorrected: 0,
      reflectionsInspected: inspected.records[0]?.reflections ?? 0,
    };
  }

  const result = await runWriteTransaction<{
    episodesFound: number;
    episodesCorrected: number;
    priorStatuses: string[];
    reflectionsInspected: number;
    reflectionsCorrected: number;
  }>(
    // ONE transaction, so an operator never observes a half-corrected lineage.
    //
    // Every set of nodes to change is snapshotted into a list by a `WITH` BEFORE
    // the `FOREACH` that changes it. That ordering is what makes the returned
    // counters exact: `size(toCorrect)` is the number of nodes that genuinely
    // needed correcting, not a re-count of post-write state (which would report
    // an already-consistent replay as a fresh correction).
    //
    // The lock/REMOVE pair on each Episode is the same terminal-lock idiom
    // `completeEpisode`/`failEpisode` use in episodes.ts, so a concurrent
    // finalization serializes against this transaction instead of interleaving
    // with it. Episodes are collected as a LIST rather than matched row-wise, so
    // a mission that somehow carries duplicate Episodes is fully corrected in
    // one pass instead of producing a row per duplicate.
    `OPTIONAL MATCH (e:Episode {missionId: $missionId})
     WITH collect(e) AS collected
     WITH [x IN collected WHERE x IS NOT NULL] AS episodes
     FOREACH (ep IN episodes |
       SET ep.__radaristEpisodeTerminalLock = randomUUID()
       REMOVE ep.__radaristEpisodeTerminalLock
     )
     WITH episodes,
          [x IN episodes WHERE coalesce(x.status, '') <> $targetStatus] AS episodesToCorrect,
          [x IN episodes | coalesce(x.status, '')] AS priorStatuses
     FOREACH (ep IN episodesToCorrect |
       SET ep.status = $targetStatus,
           ep.missionOutcome = $outcome,
           ep.outcomeReconciledAt = datetime(),
           ep.outcomeReconciledFrom = coalesce(ep.status, ''),
           ep.outcomeReconciliationVersion = $version,
           ep.outcomeReconciliationReason = $reason,
           ep.endedAt = coalesce(ep.endedAt, datetime())
     )
     FOREACH (ep IN [x IN episodes WHERE x.missionOutcome IS NULL] |
       SET ep.missionOutcome = $outcome
     )
     WITH episodes, priorStatuses, size(episodesToCorrect) AS episodesCorrected
     OPTIONAL MATCH (r:AgentReflection {missionId: $missionId})
     WITH episodes, priorStatuses, episodesCorrected, collect(r) AS collectedReflections
     WITH episodes, priorStatuses, episodesCorrected,
          [x IN collectedReflections WHERE x IS NOT NULL] AS reflections
     WITH episodes, priorStatuses, episodesCorrected, reflections,
          [x IN reflections WHERE coalesce(x.success, false) <> $targetReflectionSuccess] AS reflectionsToCorrect
     FOREACH (ref IN reflectionsToCorrect |
       SET ref.success = $targetReflectionSuccess,
           ref.outcome = $outcome,
           ref.outcomeReconciledAt = datetime(),
           ref.outcomeReconciliationVersion = $version,
           ref.outcomeReconciliationReason = $reason
     )
     FOREACH (ref IN [x IN reflections WHERE x.outcome IS NULL] |
       SET ref.outcome = $outcome
     )
     RETURN size(episodes) AS episodesFound,
            episodesCorrected AS episodesCorrected,
            priorStatuses AS priorStatuses,
            size(reflections) AS reflectionsInspected,
            size(reflectionsToCorrect) AS reflectionsCorrected`,
    {
      missionId,
      targetStatus,
      targetReflectionSuccess,
      outcome,
      version: LINEAGE_RECONCILIATION_VERSION,
      reason,
    }
  );

  const record = result.records[0];
  const episodesFound = record?.episodesFound ?? 0;
  const reconciliation: MissionLineageReconciliation = {
    outcome,
    episode:
      episodesFound === 0 ? 'no-lineage' : (record?.episodesCorrected ?? 0) > 0 ? 'corrected' : 'already-consistent',
    reflectionsCorrected: record?.reflectionsCorrected ?? 0,
    reflectionsInspected: record?.reflectionsInspected ?? 0,
  };

  log.info('Mission graph lineage reconciled to canonical outcome', {
    missionId,
    outcome,
    episode: reconciliation.episode,
    priorEpisodeStatuses: record?.priorStatuses ?? [],
    reflectionsCorrected: reconciliation.reflectionsCorrected,
    reflectionsInspected: reconciliation.reflectionsInspected,
  });

  return reconciliation;
}
