/** @jest-environment node */

jest.mock('../neo4j-client', () => ({ runReadTransaction: jest.fn() }));

import { runReadTransaction } from '../neo4j-client';
import {
  AGENT_RUN_MEMORY_LIVENESS_CYPHER,
  MISSION_MEMORY_LIVENESS_CYPHER,
  PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER,
  evaluateGraphMemoryLiveness,
  readGraphMemoryLiveness,
} from '../memory-liveness';

const mockedRead = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;

describe('graph memory liveness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not treat empty denominators as healthy coverage', () => {
    const result = evaluateGraphMemoryLiveness({
      mission: { total: 0, eligible: 0, grouped: 0, provenanceComplete: 0 },
      proactiveSweep: { total: 987, eligible: 0, grouped: 0, provenanceComplete: 0 },
      agentRuns: { total: 62, eligible: 0, linked: 0 },
    });

    expect(result.mission).toMatchObject({
      groupingCoveragePct: null,
      provenanceCoveragePct: null,
      alive: false,
    });
    expect(result.proactiveSweep).toMatchObject({
      total: 987,
      eligible: 0,
      groupingCoveragePct: null,
      alive: false,
    });
    expect(result.agentRuns).toMatchObject({
      total: 62,
      eligible: 0,
      linkageCoveragePct: null,
      alive: false,
    });
  });

  it('requires complete grouping and provenance in both supported observation lanes', () => {
    const result = evaluateGraphMemoryLiveness({
      mission: { total: 3, eligible: 2, grouped: 2, provenanceComplete: 1 },
      proactiveSweep: { total: 9, eligible: 4, grouped: 3, provenanceComplete: 4 },
      agentRuns: { total: 8, eligible: 2, linked: 1 },
    });

    expect(result.mission).toMatchObject({ groupingCoveragePct: 100, provenanceCoveragePct: 50, alive: false });
    expect(result.proactiveSweep).toMatchObject({
      groupingCoveragePct: 75,
      provenanceCoveragePct: 100,
      alive: false,
    });
    expect(result.agentRuns).toMatchObject({ linkageCoveragePct: 50, alive: false });
  });

  it('reads the three lane-specific denominators without counting standalone history as eligible', async () => {
    mockedRead
      .mockResolvedValueOnce({
        records: [{ total: 4, eligible: 1, grouped: 1, provenanceComplete: 1 }],
        summary: {},
      } as never)
      .mockResolvedValueOnce({
        records: [{ total: 988, eligible: 1, grouped: 1, provenanceComplete: 1 }],
        summary: {},
      } as never)
      .mockResolvedValueOnce({
        records: [{ total: 64, eligible: 2, linked: 2 }],
        summary: {},
      } as never);

    await expect(readGraphMemoryLiveness()).resolves.toEqual({
      mission: expect.objectContaining({ total: 4, eligible: 1, alive: true }),
      proactiveSweep: expect.objectContaining({ total: 988, eligible: 1, alive: true }),
      agentRuns: expect.objectContaining({ total: 64, eligible: 2, alive: true }),
    });
    expect(mockedRead).toHaveBeenNthCalledWith(1, MISSION_MEMORY_LIVENESS_CYPHER);
    expect(mockedRead).toHaveBeenNthCalledWith(2, PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER);
    expect(mockedRead).toHaveBeenNthCalledWith(3, AGENT_RUN_MEMORY_LIVENESS_CYPHER);
  });

  it('pins supported topology and provenance predicates in the read-only queries', () => {
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain('observation.missionId IS NOT NULL');
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain('[:CONTAINS]');
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain('[:OBSERVES]');
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain("observation.memoryLane = 'mission'");
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain('observation.correlationId = observation.missionId');
    expect(MISSION_MEMORY_LIVENESS_CYPHER).toContain("observation.provenanceKind = 'mission-source'");
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain("agentType: 'sweep-cycle'");
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain('observation.sweepId IS NOT NULL');
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain('observation.gapIndex IS NOT NULL');
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain(
      "observation.memoryLane = 'proactive-sweep'"
    );
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain(
      'observation.correlationId = observation.sweepId'
    );
    expect(PROACTIVE_SWEEP_MEMORY_LIVENESS_CYPHER).toContain(
      "observation.provenanceKind = 'sweep-gap'"
    );
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain('run.correlationId IS NOT NULL');
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain('[:EXECUTED_DURING]');
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain('owners[0].userId = run.userId');
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain('owners[0].agentName = run.agentName');
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain(
      '(owners[0].memoryLane IS NULL OR owners[0].memoryLane = run.memoryLane)'
    );
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain(
      '(owners[0].correlationId IS NULL OR owners[0].correlationId = run.correlationId)'
    );
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain("run.correlationKind = 'mission'");
    expect(AGENT_RUN_MEMORY_LIVENESS_CYPHER).toContain("run.correlationKind = 'sweep'");
  });
});
