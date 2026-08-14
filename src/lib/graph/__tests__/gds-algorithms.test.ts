/**
 * @file gds-algorithms.test.ts
 * @description Unit tests for the Louvain / nodeSimilarity / PageRank wrappers.
 *
 * Includes:
 * - GDS availability guard: a `RETURN gds.version()` probe (cached per
 *   process) so a missing plugin degrades with a clear error instead of an
 *   opaque `Unknown function` failure mid-algorithm.
 * - M7 wiring: algorithms must run against the per-run projection name that
 *   withProjection hands them (stats.graphName), not the fixed default.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

// The per-run projection name withProjection hands to the algorithm callback.
const RUN_GRAPH_NAME = 'kg-default-run42';

jest.mock('../gds-projections', () => ({
  __esModule: true,
  DEFAULT_GRAPH_NAME: 'kg-default',
  withProjection: jest.fn(
    async (
      _name: string,
      fn: (stats: { graphName: string; nodeCount: number; relationshipCount: number }) => Promise<unknown>
    ) => fn({ graphName: RUN_GRAPH_NAME, nodeCount: 100, relationshipCount: 200 })
  ),
}));

import * as neo4jClient from '../neo4j-client';
import * as projections from '../gds-projections';
import {
  runLouvainCommunity,
  detectDuplicateCandidates,
  runPersonalizedPageRankForUser,
  GdsUnavailableError,
  __resetGdsAvailabilityForTests,
} from '../gds-algorithms';

const mockedRead = neo4jClient.runReadTransaction as jest.Mock;
const mockedWrite = neo4jClient.runWriteTransaction as jest.Mock;
const mockedWithProjection = projections.withProjection as jest.Mock;

/** Queue the successful gds.version() probe every algorithm call makes first. */
function primeGdsProbe() {
  mockedRead.mockResolvedValueOnce({ records: [{ version: '2.6.0' }] });
}

/** Read calls excluding the availability probe. */
function readCallsExcludingProbe(): Array<[string, Record<string, unknown>]> {
  return mockedRead.mock.calls.filter(([c]) => !(c as string).includes('gds.version')) as Array<
    [string, Record<string, unknown>]
  >;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetGdsAvailabilityForTests();
});

describe('GDS availability guard', () => {
  it('throws GdsUnavailableError with install guidance when the gds.version() probe fails', async () => {
    mockedRead.mockRejectedValueOnce(new Error("Unknown function 'gds.version'"));

    await expect(runLouvainCommunity()).rejects.toThrow(GdsUnavailableError);
    // Nothing else should run — no projection lifecycle, no writes.
    expect(mockedWithProjection).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('names the plugin in the error message so operators know what to fix', async () => {
    mockedRead.mockRejectedValueOnce(new Error("Unknown function 'gds.version'"));
    await expect(runLouvainCommunity()).rejects.toThrow(/GDS plugin/i);
  });

  it('probes gds.version() only once per process (cached across calls)', async () => {
    primeGdsProbe();
    mockedWrite.mockResolvedValue({ records: [{ communityCount: 1, modularity: 0.5, nodesWritten: 10 }] });
    mockedRead.mockResolvedValue({ records: [] });

    await runLouvainCommunity();
    await runLouvainCommunity();

    const probes = mockedRead.mock.calls.filter(([c]) => (c as string).includes('gds.version'));
    expect(probes).toHaveLength(1);
  });

  it('does NOT cache a failed probe — a transient failure must not permanently disable GDS', async () => {
    mockedRead.mockRejectedValueOnce(new Error('connection reset'));
    await expect(runLouvainCommunity()).rejects.toThrow(GdsUnavailableError);

    primeGdsProbe();
    mockedWrite.mockResolvedValue({ records: [{ communityCount: 1, modularity: 0.5, nodesWritten: 10 }] });
    mockedRead.mockResolvedValue({ records: [] });

    await expect(runLouvainCommunity()).resolves.toBeDefined();
  });
});

describe('runLouvainCommunity', () => {
  it('runs gds.louvain.write and returns modularity + top communities', async () => {
    primeGdsProbe();
    mockedWrite.mockResolvedValue({
      records: [{ communityCount: 50, modularity: 0.72, nodesWritten: 2083 }],
    });
    mockedRead.mockResolvedValue({
      records: [
        { communityId: 100, size: 50 },
        { communityId: 200, size: 30 },
      ],
    });

    const result = await runLouvainCommunity({ topN: 2 });

    expect(result.communityCount).toBe(50);
    expect(result.modularity).toBeCloseTo(0.72);
    expect(result.nodesWritten).toBe(2083);
    expect(result.topCommunities).toHaveLength(2);

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('gds.louvain.write');
    expect(cypher).toContain("writeProperty: 'gdsCommunity'");
  });

  it('M7: runs against the per-run projection name from withProjection stats, not the fixed default', async () => {
    primeGdsProbe();
    mockedWrite.mockResolvedValue({
      records: [{ communityCount: 1, modularity: 0.5, nodesWritten: 10 }],
    });
    mockedRead.mockResolvedValue({ records: [] });

    await runLouvainCommunity();

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.graphName).toBe(RUN_GRAPH_NAME);
  });
});

describe('detectDuplicateCandidates', () => {
  it('applies the minDegree filter via GDS degreeCutoff', async () => {
    primeGdsProbe();
    mockedRead.mockResolvedValue({ records: [] });
    await detectDuplicateCandidates({ threshold: 0.9, minDegree: 5 });

    const [cypher, params] = readCallsExcludingProbe()[0];
    expect(cypher).toContain('gds.nodeSimilarity.stream');
    expect(cypher).toContain('similarityCutoff: $threshold');
    expect(cypher).toContain('degreeCutoff: toInteger($minDegree)');
    expect(params.threshold).toBe(0.9);
    expect(params.minDegree).toBe(5);
    // M7: streamed against the per-run projection.
    expect(params.graphName).toBe(RUN_GRAPH_NAME);
  });

  it('returns only same-label pairs', async () => {
    primeGdsProbe();
    mockedRead.mockResolvedValue({
      records: [
        { aId: 'a', aName: 'A', aLabel: 'Technology', bId: 'b', bName: 'B', bLabel: 'Technology', similarity: 0.95 },
      ],
    });
    const result = await detectDuplicateCandidates();
    expect(result).toHaveLength(1);
    expect(result[0].similarity).toBe(0.95);
    expect(result[0].aLabel).toBe('Technology');
    expect(result[0].bLabel).toBe('Technology');
  });
});

describe('runPersonalizedPageRankForUser', () => {
  it('personalizes with sourceNodes when seed ids resolve', async () => {
    primeGdsProbe();
    // 1st algorithm call: resolve seed ids
    mockedRead.mockResolvedValueOnce({
      records: [{ internalId: 42 }, { internalId: 43 }],
    });
    // 2nd algorithm call: pagerank stream
    mockedRead.mockResolvedValueOnce({
      records: [{ id: 'tech-1', name: 'Kubernetes', label: 'Technology', score: 0.5 }],
    });

    const result = await runPersonalizedPageRankForUser(['seed-1', 'seed-2'], { topN: 5 });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Kubernetes');

    const params2 = readCallsExcludingProbe()[1][1] as { config: { sourceNodes?: unknown[] }; graphName: string };
    expect(params2.config.sourceNodes).toHaveLength(2);
    // M7: streamed against the per-run projection.
    expect(params2.graphName).toBe(RUN_GRAPH_NAME);
  });

  it('falls back to global PageRank when no seed ids resolve', async () => {
    primeGdsProbe();
    mockedRead.mockResolvedValueOnce({ records: [] }); // empty seed resolution
    mockedRead.mockResolvedValueOnce({
      records: [{ id: 't1', name: 'T1', label: 'Technology', score: 0.1 }],
    });

    await runPersonalizedPageRankForUser(['ghost-id']);
    const params2 = readCallsExcludingProbe()[1][1] as { config: { sourceNodes?: unknown[] } };
    expect(params2.config.sourceNodes).toBeUndefined();
  });
});
