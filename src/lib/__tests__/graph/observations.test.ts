/**
 * Unit tests for aggregateObservationScore (pure function — no I/O).
 *
 * @phase Smart Defense Minister — Task 1
 * @jest-environment node
 */

jest.mock('../../graph/neo4j-client', () => ({
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

import { runReadTransaction, runWriteTransaction } from '../../graph/neo4j-client';
import { aggregateObservationScore, getObservationsForEntity, recordObservation } from '../../graph/observations';
import { createMissionObservationId } from '../../graph/observation-identity';
import type { Observation } from '../../graph/observations';
import neo4j from 'neo4j-driver';

const mockRunWriteTransaction = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;
const mockRunReadTransaction = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;

function obs(verdict: 'confirming' | 'contradicting' | 'inconclusive', daysAgo: number): Observation {
  return {
    id: `obs-${Math.random()}`,
    entityId: 'ent-1',
    sourceUrl: `https://example.com/${Math.random()}`,
    verdict,
    agentType: 'scout',
    observedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe('aggregateObservationScore', () => {
  it('returns sparse when no observations exist', () => {
    const result = aggregateObservationScore([]);
    expect(result.sparse).toBe(true);
    if (result.sparse) expect(result.observationCount).toBe(0);
  });

  it('returns sparse when total weight is below 1.0', () => {
    // Two old observations (180+ days = 0.1 weight each) → 0.2 total
    const result = aggregateObservationScore([obs('confirming', 200), obs('confirming', 250)]);
    expect(result.sparse).toBe(true);
  });

  it('returns verified when 2+ recent confirming observations dominate', () => {
    const result = aggregateObservationScore([obs('confirming', 5), obs('confirming', 10), obs('confirming', 20)]);
    expect(result.sparse).toBe(false);
    if (!result.sparse) {
      expect(result.smartScore.score).toBe(100);
      expect(result.smartScore.status).toBe('verified');
      expect(result.smartScore.observationCount).toBe(3);
    }
  });

  it('returns disputed when contradicting outweighs confirming', () => {
    const result = aggregateObservationScore([obs('confirming', 5), obs('contradicting', 5), obs('contradicting', 10)]);
    expect(result.sparse).toBe(false);
    if (!result.sparse) {
      expect(result.smartScore.score).toBeLessThan(50);
      expect(result.smartScore.status).toBe('disputed');
    }
  });

  it('weights observations by recency (recent confirming + old contradicting → score still high)', () => {
    const result = aggregateObservationScore([
      obs('confirming', 5), // weight 1.0
      obs('contradicting', 200), // weight 0.1
    ]);
    expect(result.sparse).toBe(false);
    if (!result.sparse) {
      // weightedConfirming=1.0, weightedContradicting=0.1, score = 1.0/1.1 = 91%
      expect(result.smartScore.score).toBeGreaterThanOrEqual(85);
    }
  });

  it('ignores inconclusive observations in the score (but counts them in observationCount)', () => {
    const result = aggregateObservationScore([obs('confirming', 5), obs('inconclusive', 10), obs('inconclusive', 15)]);
    if (!result.sparse) {
      expect(result.smartScore.observationCount).toBe(3);
      expect(result.smartScore.score).toBe(100);
    }
  });
});

describe('getObservationsForEntity bounds', () => {
  beforeEach(() => {
    mockRunReadTransaction.mockReset();
  });

  it('applies the caller bound at the database boundary', async () => {
    mockRunReadTransaction.mockResolvedValue({ records: [], summary: {} as never });

    await getObservationsForEntity('entity-1', 90, 250);

    const [cypher, params] = mockRunReadTransaction.mock.calls[0];
    expect(cypher).toContain('LIMIT $limit');
    expect(params).toMatchObject({ entityId: 'entity-1', limit: neo4j.int(100) });
  });

  it('preserves the unbounded internal verifier read when no limit is requested', async () => {
    mockRunReadTransaction.mockResolvedValue({ records: [], summary: {} as never });

    await getObservationsForEntity('entity-1', 180);

    const [cypher, params] = mockRunReadTransaction.mock.calls[0];
    expect(cypher).not.toContain('LIMIT $limit');
    expect(params).not.toHaveProperty('limit');
  });
});

describe('recordObservation idempotency', () => {
  const input = {
    entityId: 'entity-1',
    sourceUrl: 'https://example.com/evidence',
    verdict: 'confirming' as const,
    agentType: 'scout' as const,
    missionId: 'mission-1',
    observedAt: '2026-07-13T10:00:00.000Z',
  };
  const id = createMissionObservationId(input);

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunWriteTransaction.mockResolvedValue({
      records: [
        {
          id,
          observedAt: input.observedAt,
          createdAt: '2026-07-13T10:00:01.000Z',
          payloadMatches: true,
          logicalMatchCount: 0,
        },
      ],
      summary: {} as never,
    });
  });

  it('matches the target before MERGE and persists the deterministic ID', async () => {
    await expect(recordObservation(input)).resolves.toMatchObject({ id, observedAt: input.observedAt });

    const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
    expect(cypher.indexOf('MATCH (target')).toBeLessThan(cypher.indexOf('MERGE (o:Observation'));
    expect(cypher).toContain('__radaristObservationWriteLock');
    expect(cypher).toContain('logicalMatches[0].id');
    expect(cypher).toContain('target:RadarPlacement');
    expect(cypher).toContain('payloadMatches');
    expect(cypher).toContain('o.memoryLane = $memoryLane');
    expect(params).toMatchObject({
      id,
      missionId: 'mission-1',
      memoryLane: 'mission',
      provenanceKind: 'mission-source',
    });
  });

  it('returns the original stored timestamps when a delivery is retried', async () => {
    const first = await recordObservation(input);
    const replay = await recordObservation({ ...input, observedAt: '2026-07-13T10:05:00.000Z' });

    expect(replay.id).toBe(first.id);
    expect(replay.observedAt).toBe(input.observedAt);
    expect(replay.createdAt).toBe(first.createdAt);
  });

  it('rejects an ID that was not derived from the mission identity', async () => {
    await expect(recordObservation({ ...input, id: 'obs-mission-v1-wrong' })).rejects.toThrow(
      'does not match its mission/entity/source identity'
    );
    expect(mockRunWriteTransaction).not.toHaveBeenCalled();
  });

  it('fails when the target Entity is missing without reporting a synthetic success', async () => {
    mockRunWriteTransaction.mockResolvedValueOnce({ records: [], summary: {} as never });
    await expect(recordObservation(input)).rejects.toThrow('target is missing/non-unique');
  });

  it('fails closed when an existing ID has conflicting immutable payload', async () => {
    mockRunWriteTransaction.mockResolvedValueOnce({
      records: [
        {
          id,
          observedAt: input.observedAt,
          createdAt: '2026-07-13T10:00:01.000Z',
          payloadMatches: false,
          logicalMatchCount: 1,
        },
      ],
      summary: {} as never,
    });
    await expect(recordObservation(input)).rejects.toThrow('identity conflict');
  });

  it('returns an adopted pre-upgrade random ID instead of creating another logical vote', async () => {
    mockRunWriteTransaction.mockResolvedValueOnce({
      records: [
        {
          id: 'obs-legacy-random',
          observedAt: input.observedAt,
          createdAt: '2026-07-12T10:00:01.000Z',
          payloadMatches: true,
          logicalMatchCount: 1,
        },
      ],
      summary: {} as never,
    });

    await expect(recordObservation(input)).resolves.toMatchObject({ id: 'obs-legacy-random' });
  });

  it('rejects caller-supplied IDs outside the mission lane', async () => {
    await expect(
      recordObservation({
        id: 'obs-mission-v1-reserved',
        entityId: 'entity-1',
        sourceUrl: 'https://example.com/manual',
        verdict: 'inconclusive',
        agentType: 'manual',
      })
    ).rejects.toThrow('require a mission identity');
    expect(mockRunWriteTransaction).not.toHaveBeenCalled();
  });

  it('labels non-mission verification observations as standalone', async () => {
    await recordObservation({
      entityId: 'entity-1',
      sourceUrl: 'https://example.com/manual',
      verdict: 'inconclusive',
      agentType: 'manual',
    });

    expect(mockRunWriteTransaction.mock.calls[0][1]).toMatchObject({
      missionId: null,
      memoryLane: 'verification-standalone',
      provenanceKind: 'source-verification',
    });
  });
});
