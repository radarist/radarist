/**
 * Tests for the C5 edge-velocity emergence detector.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
}));

import * as neo4j from '../neo4j-client';
import { getEdgeVelocity, selectEmergent, detectEmergence } from '../emergence';
import type { EdgeVelocityRow } from '../emergence';

const mockedRead = neo4j.runReadTransaction as jest.Mock;

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

describe('getEdgeVelocity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRead.mockResolvedValue(records([]));
  });

  it('computes recentStart/priorStart as ISO strings with priorStart before recentStart', async () => {
    await getEdgeVelocity({ windowDays: 7 });

    expect(mockedRead).toHaveBeenCalledTimes(1);
    const [, params] = mockedRead.mock.calls[0];
    expect(typeof params.recentStart).toBe('string');
    expect(typeof params.priorStart).toBe('string');
    // Both parse as valid dates.
    expect(Number.isNaN(new Date(params.recentStart).getTime())).toBe(false);
    expect(Number.isNaN(new Date(params.priorStart).getTime())).toBe(false);
    // priorStart is strictly earlier than recentStart (2x the window back).
    expect(new Date(params.priorStart).getTime()).toBeLessThan(new Date(params.recentStart).getTime());
  });

  it('defaults entityId to null when not scoped', async () => {
    await getEdgeVelocity();
    const [, params] = mockedRead.mock.calls[0];
    expect(params.entityId).toBeNull();
  });

  it('counts only current, non-rejected relation facts', async () => {
    await getEdgeVelocity();
    const [cypher] = mockedRead.mock.calls[0];
    expect(cypher).toContain('r.t_invalidated IS NULL');
    expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
  });

  it('passes entityId through when scoping to a single entity', async () => {
    await getEdgeVelocity({ entityId: 'tech-1' });
    const [, params] = mockedRead.mock.calls[0];
    expect(params.entityId).toBe('tech-1');
  });

  it('maps query rows into EdgeVelocityRow shape', async () => {
    mockedRead.mockResolvedValueOnce(
      records([
        { entityId: 'tech-1', entityName: 'LangGraph', entityType: 'technology', recentCount: 6, priorCount: 2 },
      ])
    );

    const rows = await getEdgeVelocity();
    expect(rows).toEqual([
      { entityId: 'tech-1', entityName: 'LangGraph', entityType: 'technology', recentCount: 6, priorCount: 2 },
    ]);
  });

  it('propagates read failures rather than swallowing them', async () => {
    mockedRead.mockRejectedValueOnce(new Error('neo4j down'));
    await expect(getEdgeVelocity()).rejects.toThrow('neo4j down');
  });
});

describe('selectEmergent (pure)', () => {
  const row = (overrides: Partial<EdgeVelocityRow>): EdgeVelocityRow => ({
    entityId: 'e1',
    entityName: 'Entity One',
    entityType: 'technology',
    recentCount: 0,
    priorCount: 0,
    ...overrides,
  });

  it('keeps a row with recentCount 6 / priorCount 2 (acceleration 3x, clears both bars)', () => {
    const [found] = selectEmergent([row({ recentCount: 6, priorCount: 2 })]);
    expect(found).toBeDefined();
    expect(found.acceleration).toBe(3);
  });

  it('drops a row with recentCount 2 / priorCount 0 — fails the minEdges floor (default 3)', () => {
    const result = selectEmergent([row({ recentCount: 2, priorCount: 0 })]);
    expect(result).toEqual([]);
  });

  it('keeps a row with recentCount 4 / priorCount 0 — clamped prior of 1 gives acceleration 4x', () => {
    const [found] = selectEmergent([row({ recentCount: 4, priorCount: 0 })]);
    expect(found).toBeDefined();
    expect(found.acceleration).toBe(4);
  });

  it('drops a row that clears minEdges but not the acceleration bar', () => {
    // recentCount 5 >= minEdges 3, but priorCount 4 means acceleration = 5/4 = 1.25 < factor 2.
    const result = selectEmergent([row({ recentCount: 5, priorCount: 4 })]);
    expect(result).toEqual([]);
  });

  it('sorts by acceleration descending and truncates to limit', () => {
    const rows = [
      row({ entityId: 'low', recentCount: 6, priorCount: 3 }), // accel 2
      row({ entityId: 'high', recentCount: 8, priorCount: 1 }), // accel 8
      row({ entityId: 'mid', recentCount: 9, priorCount: 3 }), // accel 3
    ];
    const result = selectEmergent(rows, { limit: 2 });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityId)).toEqual(['high', 'mid']);
  });

  it('honours custom minEdges/accelerationFactor overrides', () => {
    const result = selectEmergent([row({ recentCount: 2, priorCount: 1 })], {
      minEdges: 2,
      accelerationFactor: 1,
    });
    expect(result).toHaveLength(1);
  });

  it('returns [] for an empty input', () => {
    expect(selectEmergent([])).toEqual([]);
  });
});

describe('detectEmergence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('composes getEdgeVelocity + selectEmergent end to end', async () => {
    mockedRead.mockResolvedValueOnce(
      records([
        { entityId: 'tech-1', entityName: 'LangGraph', entityType: 'technology', recentCount: 6, priorCount: 2 },
        { entityId: 'tech-2', entityName: 'Stale Tech', entityType: 'technology', recentCount: 1, priorCount: 1 },
      ])
    );

    const findings = await detectEmergence();
    expect(findings).toHaveLength(1);
    expect(findings[0].entityId).toBe('tech-1');
    expect(findings[0].acceleration).toBe(3);
  });

  it('scopes to a single entity via entityId and forwards threshold overrides', async () => {
    mockedRead.mockResolvedValueOnce(records([]));
    await detectEmergence({ entityId: 'tech-1', windowDays: 14, minEdges: 1, accelerationFactor: 1, limit: 1 });

    const [, params] = mockedRead.mock.calls[0];
    expect(params.entityId).toBe('tech-1');
    expect(params.windowDays).toBe(14);
  });
});
