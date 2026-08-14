/**
 * @file agent-reflections.ts
 * @description Reflection-based agent learning — stores and retrieves mission reflections.
 *
 * Task 3.11: After each mission, a lightweight reflection is generated and stored.
 * Before the next mission, recent reflections are injected into the system prompt.
 *
 * Pattern: Mission → Reflection → Neo4j → Next mission reads reflections → Better performance
 */

import neo4j from 'neo4j-driver';
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { limitSchema } from './validation';
import { createLogger } from '@/lib/logger';
import { isDomainOutcome, type DomainOutcome } from '@/lib/observability/terminal-outcome';

const log = createLogger('graph/agent-reflections');

export interface AgentReflection {
  id: string;
  agentName: string;
  episodeId?: string;
  missionId?: string;
  learnings: string;
  toolsUsed: string[];
  success: boolean;
  /**
   * GRAPH-030 — the canonical business outcome this reflection belongs to. The
   * boolean `success` cannot distinguish a checkpoint-recovered partial from a
   * clean delivery, and cross-store parity has to assert that difference.
   */
  outcome?: DomainOutcome;
  createdAt: number;
}

/**
 * GRAPH-030 — one durable Reflection identity per mission.
 *
 * The pre-fix id was `ref-<Date.now()>-<random>`, written with `CREATE`. That is
 * not replay-safe: an Inngest step that stored the node and then failed before
 * returning re-runs on retry and creates a SECOND reflection for the same
 * mission, so a parity check over "the reflection for mission X" has two answers
 * and the mission's learning history double-counts. A mission-derived id with
 * `MERGE` gives exactly one node per mission, whatever the retry pattern.
 *
 * Reflections not tied to a mission keep a random identity — there is nothing
 * stable to derive one from, and inventing a shared key would collapse unrelated
 * reflections into one node.
 */
export function reflectionIdForMission(missionId: string): string {
  return `ref-mission-v1-${missionId}`;
}

/**
 * Store a reflection for a mission.
 *
 * Idempotent for mission-scoped reflections: the same mission always addresses
 * the same node, and a re-run refreshes its content rather than appending a
 * duplicate. `createdAt` is preserved on re-run so the first observation instant
 * survives.
 */
export async function createReflection(params: {
  agentName: string;
  episodeId?: string;
  missionId?: string;
  learnings: string;
  toolsUsed: string[];
  success: boolean;
  /** Canonical outcome; when absent, only the boolean `success` is recorded. */
  outcome?: DomainOutcome;
}): Promise<{ id: string }> {
  const id = params.missionId
    ? reflectionIdForMission(params.missionId)
    : `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Date.now();

  try {
    await runWriteTransaction(
      `MERGE (r:AgentReflection { id: $id })
       ON CREATE SET r.createdAt = $createdAt
       SET r.agentName = $agentName,
           r.episodeId = $episodeId,
           r.missionId = $missionId,
           r.learnings = $learnings,
           r.toolsUsed = $toolsUsed,
           r.success = $success,
           r.outcome = $outcome`,
      {
        id,
        agentName: params.agentName,
        learnings: params.learnings,
        toolsUsed: params.toolsUsed,
        success: params.success,
        outcome: params.outcome ?? null,
        episodeId: params.episodeId ?? null,
        missionId: params.missionId ?? null,
        createdAt,
      }
    );
    log.debug('Reflection stored', { id, agentName: params.agentName, outcome: params.outcome });
    return { id };
  } catch (error) {
    log.error('Failed to create reflection', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Query recent reflections for an agent.
 * Used to inject learnings into the system prompt before a mission.
 *
 * Critical rule: never mutate the system prompt mid-session.
 * Reflections are injected only at mission start, not during tool execution.
 */
export async function queryRecentReflections(params: {
  agentName: string;
  limit?: number;
}): Promise<AgentReflection[]> {
  const safeLimit = limitSchema.parse(params.limit ?? 5);

  try {
    const result = await runReadTransaction<AgentReflection & { outcome?: unknown }>(
      `MATCH (r:AgentReflection { agentName: $agentName })
       RETURN r.id AS id, r.agentName AS agentName, r.episodeId AS episodeId,
              r.missionId AS missionId, r.learnings AS learnings,
              r.toolsUsed AS toolsUsed, r.success AS success, r.outcome AS outcome,
              r.createdAt AS createdAt
       ORDER BY r.createdAt DESC
       LIMIT $limit`,
      { agentName: params.agentName, limit: neo4j.int(safeLimit) }
    );
    // Legacy nodes carry no outcome, and a hand-edited one could carry anything;
    // only the closed vocabulary is surfaced so a prompt block can never quote a
    // fabricated outcome back to an agent.
    return result.records.map(({ outcome, ...rest }) => ({
      ...rest,
      ...(isDomainOutcome(outcome) ? { outcome } : {}),
    }));
  } catch (error) {
    log.error('Failed to query reflections', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

/**
 * Build a prompt augmentation block from recent reflections.
 * Inject this at mission start (never mid-session).
 */
export function buildReflectionPromptBlock(reflections: AgentReflection[]): string {
  if (reflections.length === 0) return '';

  const lines = reflections.map((r) => {
    const outcome = r.success ? 'SUCCESS' : 'FAILURE';
    return `- [${outcome}] ${r.learnings}`;
  });

  return `\n## Recent lessons from past missions:\n${lines.join('\n')}\n`;
}
