/** @jest-environment node */

jest.mock('../neo4j-client', () => ({
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

import { runReadTransaction, runWriteTransaction } from '../neo4j-client';
import { createSweepObservationId } from '../observation-identity';
import {
  recordSweepObservation,
  SweepObservationEpisodeUnavailableError,
  SweepObservationIdentityConflictError,
  type SweepObservationInput,
} from '../sweep-observations';

const mockedWrite = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;
const mockedRead = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;

const input: SweepObservationInput = {
  sweepId: 'sweep-123',
  episodeId: 'episode-123',
  gapIndex: 2,
  title: 'Sweep: Example (stale)',
  summary: 'Sweep cycle flagged Example: stale',
  confidence: 0.8,
  entityId: 'entity-123',
  entityName: 'Example',
  entityType: 'technology',
  timestamp: '2026-07-13T12:00:00.000Z',
};

function result(records: Record<string, unknown>[]) {
  return { records, summary: {} } as never;
}

describe('recordSweepObservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically converges the node, ABOUT edge, Episode link, and count', async () => {
    const id = createSweepObservationId(input);
    mockedWrite.mockResolvedValue(
      result([
        {
          id,
          agentType: 'sweep-cycle',
          observationType: 'discovery',
          title: input.title,
          summary: input.summary,
          confidence: input.confidence,
          entityId: input.entityId,
          entityName: input.entityName,
          entityType: input.entityType,
          timestamp: input.timestamp,
        },
      ])
    );

    await expect(recordSweepObservation(input)).resolves.toEqual({
      status: 'recorded',
      observation: expect.objectContaining({ id, entityId: input.entityId }),
    });

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedRead).not.toHaveBeenCalled();
    const [cypher, rawParams] = mockedWrite.mock.calls[0];
    const params = rawParams as Record<string, unknown>;
    expect(cypher).toContain('MERGE (observation:AgentObservation {id: $observationId})');
    expect(cypher).toContain('MERGE (observation)-[:ABOUT]->(target)');
    expect(cypher).toContain('MERGE (episode)-[contains:CONTAINS]->(observation)');
    expect(cypher).toContain('ON CREATE SET episode.observationCount');
    expect(cypher).toContain('__radaristSweepObservationLock');
    expect(cypher).toContain('size(existingEpisodes) = 1');
    expect(cypher).toContain('observation.memoryLane = $memoryLane');
    expect(cypher).toContain("observation.provenanceKind = 'sweep-gap'");
    expect(params.observationId).toBe(id);
    expect(params.memoryLane).toBe('proactive-sweep');
    expect((params.gapIndex as { toNumber(): number }).toNumber()).toBe(2);
  });

  it('fails closed when the required Episode is unavailable', async () => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ episodeCount: 0, targetCount: 1, observationCount: 0 }]));

    await expect(recordSweepObservation(input)).rejects.toBeInstanceOf(SweepObservationEpisodeUnavailableError);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2])('returns an explicit non-writing skip for target cardinality %s', async (targetCount) => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ episodeCount: 1, targetCount, observationCount: 0 }]));

    await expect(recordSweepObservation(input)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'target-unavailable',
    });
  });

  it('fails closed when the deterministic ID already has conflicting payload or topology', async () => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ episodeCount: 1, targetCount: 1, observationCount: 1 }]));

    await expect(recordSweepObservation(input)).rejects.toBeInstanceOf(SweepObservationIdentityConflictError);
  });

  it('recovers an exact already-linked terminal write without mutating it', async () => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead.mockResolvedValueOnce(
      result([
        {
          id: createSweepObservationId(input),
          agentType: 'sweep-cycle',
          observationType: 'discovery',
          sweepId: input.sweepId,
          gapIndex: input.gapIndex,
          title: input.title,
          summary: input.summary,
          confidence: input.confidence,
          entityId: input.entityId,
          entityName: input.entityName,
          entityType: input.entityType,
          timestamp: input.timestamp,
          memoryLane: 'proactive-sweep',
          correlationId: input.sweepId,
          provenanceKind: 'sweep-gap',
          targetIds: [input.entityId],
          ownerIds: [input.episodeId],
        },
      ])
    );

    await expect(recordSweepObservation(input)).resolves.toMatchObject({
      status: 'recorded',
      observation: { id: createSweepObservationId(input) },
    });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead.mock.calls[0][0]).not.toContain('SET ');
    expect(mockedRead.mock.calls[0][0]).not.toContain('MERGE ');
    expect(mockedRead.mock.calls[0][0]).toContain(
      'coalesce(observation.assertedConfidence, observation.confidence) AS confidence'
    );
  });

  it('does not recover a terminal write whose payload changed', async () => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead
      .mockResolvedValueOnce(
        result([
          {
            id: createSweepObservationId(input),
            agentType: 'sweep-cycle',
            observationType: 'discovery',
            sweepId: input.sweepId,
            gapIndex: input.gapIndex,
            title: input.title,
            summary: 'different',
            confidence: input.confidence,
            entityId: input.entityId,
          entityName: input.entityName,
          entityType: input.entityType,
          timestamp: input.timestamp,
          memoryLane: 'proactive-sweep',
          correlationId: input.sweepId,
          provenanceKind: 'sweep-gap',
          targetIds: [input.entityId],
          ownerIds: [input.episodeId],
          },
        ])
      )
      .mockResolvedValueOnce(result([{ episodeCount: 0, targetCount: 1, observationCount: 1 }]));

    await expect(recordSweepObservation(input)).rejects.toBeInstanceOf(SweepObservationEpisodeUnavailableError);
  });

  it('does not recover a terminal write with conflicting ownership provenance', async () => {
    mockedWrite.mockResolvedValue(result([]));
    mockedRead
      .mockResolvedValueOnce(
        result([
          {
            id: createSweepObservationId(input),
            agentType: 'sweep-cycle',
            observationType: 'discovery',
            sweepId: input.sweepId,
            gapIndex: input.gapIndex,
            title: input.title,
            summary: input.summary,
            confidence: input.confidence,
            entityId: input.entityId,
            entityName: input.entityName,
            entityType: input.entityType,
            timestamp: input.timestamp,
            memoryLane: 'mission',
            correlationId: 'other-sweep',
            provenanceKind: 'other',
            targetIds: [input.entityId],
            ownerIds: [input.episodeId],
          },
        ])
      )
      .mockResolvedValueOnce(result([{ episodeCount: 0, targetCount: 1, observationCount: 1 }]));

    await expect(recordSweepObservation(input)).rejects.toBeInstanceOf(SweepObservationEpisodeUnavailableError);
  });

  it('lets transient database failures escape for Inngest retry', async () => {
    const error = new Error('Neo4j transport failed');
    mockedWrite.mockRejectedValue(error);

    await expect(recordSweepObservation(input)).rejects.toBe(error);
    expect(mockedRead).not.toHaveBeenCalled();
  });
});
