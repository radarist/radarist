/**
 * @file temporal-tools.test.ts
 * @description Tests for F.9 temporal AI tools — queryActiveEdges + getEntityTimeline.
 *
 * Exercises the tool executors with a mocked Neo4j read layer. The point is
 * to lock the shape of the answer the chat model sees: active-edge queries
 * filter out invalidated and rejected edges, timelines include both valid and
 * invalidated entries ordered by `t_valid`.
 */

jest.mock('@/lib/graph/neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

// The temporal-queries module also imports neo4j-client (already mocked above).
// getEntityTimeline itself stays real so we verify the real SQL → tool shape
// mapping, but the underlying Neo4j call is mocked.

import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { executeQueryActiveEdges, executeGetEntityTimeline, executeGetChangedSince } from '../temporal-tools';

const mockedRead = runReadTransaction as jest.Mock;

const readResult = <T>(records: T[]) => ({
  records,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

describe('executeQueryActiveEdges', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns active edges (t_invalidated IS NULL) for an entity', async () => {
    mockedRead.mockResolvedValueOnce(
      readResult([
        {
          relType: 'USES',
          direction: 'out',
          connectedEntityId: 'tech-2',
          connectedEntityName: 'Claude API',
          t_valid: '2026-03-01T00:00:00Z',
          t_observed: '2026-03-01T00:00:00Z',
        },
      ])
    );

    const r = await executeQueryActiveEdges({ entityId: 'tech-1' });

    expect(r.success).toBe(true);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toEqual({
      relType: 'USES',
      direction: 'out',
      connectedEntityId: 'tech-2',
      connectedEntityName: 'Claude API',
      t_valid: '2026-03-01T00:00:00Z',
      t_observed: '2026-03-01T00:00:00Z',
    });
    const [cypher, params] = mockedRead.mock.calls[0];
    expect(cypher).toContain('t_invalidated IS NULL');
    expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    expect(params.entityId).toBe('tech-1');
  });

  it('filters by predicate when provided and validates the predicate shape', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));

    await executeQueryActiveEdges({ entityId: 'tech-1', predicate: 'COMPETES_WITH' });

    const [cypher, params] = mockedRead.mock.calls[0];
    expect(cypher).toContain('[r:`COMPETES_WITH`]');
    expect(params.entityId).toBe('tech-1');
  });

  it('refuses unsafe predicates (Cypher injection guard)', async () => {
    const r = await executeQueryActiveEdges({ entityId: 'tech-1', predicate: 'USES; DROP' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/unsafe predicate/i);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('requires entityId', async () => {
    const r = await executeQueryActiveEdges({});
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/entityId/i);
  });
});

describe('executeGetEntityTimeline', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns timeline entries (including invalidated) for an entity', async () => {
    mockedRead.mockResolvedValueOnce(
      readResult([
        {
          relType: 'VENDOR',
          connectedEntityId: 'co-1',
          connectedEntityName: 'Anthropic',
          t_valid: '2024-01-01T00:00:00Z',
          t_observed: '2024-01-01T00:00:00Z',
          t_invalidated: '2025-06-01T00:00:00Z',
        },
        {
          relType: 'VENDOR',
          connectedEntityId: 'co-2',
          connectedEntityName: 'OpenAI',
          t_valid: '2025-06-01T00:00:00Z',
          t_observed: '2025-06-01T00:00:00Z',
          t_invalidated: null,
        },
      ])
    );

    const r = await executeGetEntityTimeline({ entityId: 'tech-1' });

    expect(r.success).toBe(true);
    expect(r.timeline).toHaveLength(2);
    expect(r.activeCount).toBe(1);
    expect(r.invalidatedCount).toBe(1);
    expect(r.timeline[0].t_invalidated).toBe('2025-06-01T00:00:00Z');
    expect(r.timeline[1].t_invalidated).toBeNull();
  });

  it('requires entityId', async () => {
    const r = await executeGetEntityTimeline({});
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/entityId/i);
  });

  it('reports 0/0 when the entity has no temporal edges', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));
    const r = await executeGetEntityTimeline({ entityId: 'tech-unknown' });
    expect(r.success).toBe(true);
    expect(r.timeline).toHaveLength(0);
    expect(r.activeCount).toBe(0);
    expect(r.invalidatedCount).toBe(0);
  });
});

describe('executeGetChangedSince', () => {
  beforeEach(() => jest.clearAllMocks());

  const changedRow = {
    sourceId: 'tech-1',
    targetId: 'co-1',
    relType: 'VENDOR',
    t_observed: '2026-06-10T00:00:00Z',
    t_valid: '2026-06-10T00:00:00Z',
    t_invalidated: null,
  };

  it('defaults to a ~7-day window and maps observed edges', async () => {
    mockedRead.mockResolvedValueOnce(readResult([changedRow]));

    const r = await executeGetChangedSince({});

    expect(r.success).toBe(true);
    expect(r.edges).toEqual([
      {
        sourceId: 'tech-1',
        targetId: 'co-1',
        relType: 'VENDOR',
        t_observed: '2026-06-10T00:00:00Z',
        t_invalidated: null,
      },
    ]);
    // `since` should be ~7 days before now (tolerance for test wall-clock drift).
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(new Date(r.since).getTime() - sevenDaysAgo)).toBeLessThan(60_000);
  });

  it('honors an explicit ISO `since`, passing it to the query', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));
    const since = '2026-01-01T00:00:00.000Z';

    const r = await executeGetChangedSince({ since });

    expect(r.success).toBe(true);
    expect(r.since).toBe(since);
    const [, params] = mockedRead.mock.calls[0];
    expect(params.since).toBe(since);
  });

  it('rejects an invalid `since` without querying', async () => {
    const r = await executeGetChangedSince({ since: 'not-a-date' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/invalid 'since'/i);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('reports an empty result cleanly', async () => {
    mockedRead.mockResolvedValueOnce(readResult([]));
    const r = await executeGetChangedSince({ sinceDays: 30 });
    expect(r.success).toBe(true);
    expect(r.edges).toHaveLength(0);
    expect(r.message).toMatch(/no relationships observed/i);
  });
});
