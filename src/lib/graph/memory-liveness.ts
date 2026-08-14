import { runReadTransaction } from './neo4j-client';

export const MISSION_MEMORY_LANE = 'mission' as const;
export const PROACTIVE_SWEEP_MEMORY_LANE = 'proactive-sweep' as const;
export const PROACTIVE_STANDALONE_MEMORY_LANE = 'proactive-standalone' as const;
export const VERIFICATION_STANDALONE_MEMORY_LANE = 'verification-standalone' as const;

export type EpisodicMemoryLane = typeof MISSION_MEMORY_LANE | typeof PROACTIVE_SWEEP_MEMORY_LANE;

export function episodeMemoryLane(agentName: string): EpisodicMemoryLane {
  return agentName === 'sweep-cycle' ? PROACTIVE_SWEEP_MEMORY_LANE : MISSION_MEMORY_LANE;
}

export interface ObservationLaneCounts {
  total: number;
  eligible: number;
  grouped: number;
  provenanceComplete: number;
}

export interface AgentRunLineageCounts {
  total: number;
  eligible: number;
  linked: number;
}

export interface GraphMemoryLivenessCounts {
  mission: ObservationLaneCounts;
  proactiveSweep: ObservationLaneCounts;
  agentRuns: AgentRunLineageCounts;
}

export interface MeasuredObservationLane extends ObservationLaneCounts {
  groupingCoveragePct: number | null;
  provenanceCoveragePct: number | null;
  alive: boolean;
}

export interface MeasuredAgentRunLineage extends AgentRunLineageCounts {
  linkageCoveragePct: number | null;
  alive: boolean;
}

export interface GraphMemoryLiveness {
  mission: MeasuredObservationLane;
  proactiveSweep: MeasuredObservationLane;
  agentRuns: MeasuredAgentRunLineage;
}

export const MISSION_MEMORY_LIVENESS_CYPHER = `
  CALL { MATCH (node:Observation) RETURN count(node) AS total }
  CALL {
    MATCH (observation:Observation)
    WHERE observation.missionId IS NOT NULL
    OPTIONAL MATCH (owner:Episode)-[:CONTAINS]->(observation)
    WITH observation, collect(DISTINCT owner) AS owners
    OPTIONAL MATCH (observation)-[:OBSERVES]->(target)
    WITH observation, owners, collect(DISTINCT target) AS targets
    RETURN count(observation) AS eligible,
           count(CASE WHEN
             size(owners) = 1 AND owners[0].missionId = observation.missionId
           THEN 1 END) AS grouped,
           count(CASE WHEN
             observation.sourceUrl IS NOT NULL AND trim(toString(observation.sourceUrl)) <> ''
             AND observation.agentType IS NOT NULL
             AND observation.observedAt IS NOT NULL
             AND observation.memoryLane = 'mission'
             AND observation.correlationId = observation.missionId
             AND observation.provenanceKind = 'mission-source'
             AND size(targets) = 1 AND targets[0].id = observation.entityId
           THEN 1 END) AS provenanceComplete
  }
  RETURN total, eligible, grouped, provenanceComplete
`;

export const PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER = `
  CALL { MATCH (node:AgentObservation) RETURN count(node) AS total }
  CALL {
    MATCH (observation:AgentObservation {agentType: 'sweep-cycle'})
    WHERE observation.sweepId IS NOT NULL
    OPTIONAL MATCH (owner:Episode)-[:CONTAINS]->(observation)
    WITH observation, collect(DISTINCT owner) AS owners
    OPTIONAL MATCH (observation)-[:ABOUT]->(target)
    WITH observation, owners, collect(DISTINCT target) AS targets
    RETURN count(observation) AS eligible,
           count(CASE WHEN
             size(owners) = 1 AND owners[0].missionId = observation.sweepId
           THEN 1 END) AS grouped,
           count(CASE WHEN
             observation.gapIndex IS NOT NULL
             AND observation.timestamp IS NOT NULL
             AND observation.memoryLane = 'proactive-sweep'
             AND observation.correlationId = observation.sweepId
             AND observation.provenanceKind = 'sweep-gap'
             AND size(targets) = 1 AND targets[0].id = observation.entityId
           THEN 1 END) AS provenanceComplete
  }
  RETURN total, eligible, grouped, provenanceComplete
`;

export const AGENT_RUN_MEMORY_LIVENESS_CYPHER = `
  CALL { MATCH (node:AgentRun) RETURN count(node) AS total }
  CALL {
    MATCH (run:AgentRun)
    WHERE run.correlationId IS NOT NULL
    OPTIONAL MATCH (run)-[:EXECUTED_DURING]->(owner:Episode)
    WITH run, collect(DISTINCT owner) AS owners
    RETURN count(run) AS eligible,
           count(CASE WHEN
             size(owners) = 1
             AND owners[0].missionId = run.correlationId
             AND owners[0].userId = run.userId
             AND owners[0].agentName = run.agentName
             AND (owners[0].memoryLane IS NULL OR owners[0].memoryLane = run.memoryLane)
             AND (owners[0].correlationId IS NULL OR owners[0].correlationId = run.correlationId)
             AND (
               (run.correlationKind = 'mission' AND run.memoryLane = 'mission'
                 AND run.missionId = run.correlationId AND run.sweepId IS NULL)
               OR
               (run.correlationKind = 'sweep' AND run.memoryLane = 'proactive-sweep'
                 AND run.sweepId = run.correlationId AND run.missionId IS NULL)
             )
           THEN 1 END) AS linked
  }
  RETURN total, eligible, linked
`;

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function measureObservationLane(counts: ObservationLaneCounts): MeasuredObservationLane {
  return {
    ...counts,
    groupingCoveragePct: percent(counts.grouped, counts.eligible),
    provenanceCoveragePct: percent(counts.provenanceComplete, counts.eligible),
    alive:
      counts.eligible > 0 &&
      counts.grouped === counts.eligible &&
      counts.provenanceComplete === counts.eligible,
  };
}

export function evaluateGraphMemoryLiveness(counts: GraphMemoryLivenessCounts): GraphMemoryLiveness {
  return {
    mission: measureObservationLane(counts.mission),
    proactiveSweep: measureObservationLane(counts.proactiveSweep),
    agentRuns: {
      ...counts.agentRuns,
      linkageCoveragePct: percent(counts.agentRuns.linked, counts.agentRuns.eligible),
      alive: counts.agentRuns.eligible > 0 && counts.agentRuns.linked === counts.agentRuns.eligible,
    },
  };
}

/** Read only the explicitly supported episodic lanes; standalone observations remain visible in totals. */
export async function readGraphMemoryLiveness(): Promise<GraphMemoryLiveness> {
  const [mission, proactiveSweep, agentRuns] = await Promise.all([
    runReadTransaction<ObservationLaneCounts>(MISSION_MEMORY_LIVENESS_CYPHER),
    runReadTransaction<ObservationLaneCounts>(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER),
    runReadTransaction<AgentRunLineageCounts>(AGENT_RUN_MEMORY_LIVENESS_CYPHER),
  ]);
  return evaluateGraphMemoryLiveness({
    mission: mission.records[0] ?? { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
    proactiveSweep: proactiveSweep.records[0] ?? {
      total: 0,
      eligible: 0,
      grouped: 0,
      provenanceComplete: 0,
    },
    agentRuns: agentRuns.records[0] ?? { total: 0, eligible: 0, linked: 0 },
  });
}
