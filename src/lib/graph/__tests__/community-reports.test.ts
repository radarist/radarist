/**
 * Tests for the F2 community-report overlay.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

jest.mock('../gds-algorithms', () => ({
  __esModule: true,
  runLouvainCommunity: jest.fn(),
}));

jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateStructuredContent: jest.fn(),
}));

jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  recordAgentObservation: jest.fn(),
}));

import * as neo4j from '../neo4j-client';
import * as gds from '../gds-algorithms';
import * as ai from '@/lib/ai/client';
import * as proactiveInsights from '@/lib/graph/proactive-insights';
import { buildCommunityReports, queryCommunityReports } from '../community-reports';

const mockedRead = neo4j.runReadTransaction as jest.Mock;
const mockedWrite = neo4j.runWriteTransaction as jest.Mock;
const mockedLouvain = gds.runLouvainCommunity as jest.Mock;
const mockedGen = ai.generateStructuredContent as jest.Mock;
const mockedRecordObservation = proactiveInsights.recordAgentObservation as jest.Mock;

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

describe('buildCommunityReports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLouvain.mockResolvedValue({ communityCount: 5, modularity: 0.72, topCommunities: [] });
    mockedWrite.mockResolvedValue(records([]));
    // Default fallback for the new prior-report-membership read (C6): tests
    // that don't care about change detection queue exactly as many reads as
    // before (topN + members); this default absorbs the extra prior-read
    // call as "no prior reports", which is the safe, no-observations branch.
    mockedRead.mockResolvedValue(records([]));
  });

  it('skips communities smaller than minSize', async () => {
    mockedRead.mockResolvedValueOnce(records([])); // top communities query returns empty
    const r = await buildCommunityReports({ topN: 5, minSize: 10 });
    expect(r.reports).toEqual([]);
    expect(mockedGen).not.toHaveBeenCalled();
  });

  it('summarises each community and persists the report', async () => {
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 1, size: 20 }])) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'tech-1', name: 'LangChain', labels: ['Entity', 'Technology'] },
          { id: 'tech-2', name: 'LlamaIndex', labels: ['Entity', 'Technology'] },
        ])
      );
    mockedGen.mockResolvedValue({
      title: 'LLM Orchestration Frameworks',
      summary:
        'This community groups LangChain and LlamaIndex, both Python/TS frameworks for LLM orchestration and RAG.',
      themes: ['orchestration', 'RAG', 'python'],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2 });

    expect(r.reports).toHaveLength(1);
    expect(r.reports[0].title).toBe('LLM Orchestration Frameworks');
    expect(r.reports[0].memberIds).toEqual(['tech-1', 'tech-2']);
    expect(r.modularity).toBe(0.72);
    expect(mockedWrite).toHaveBeenCalled();
  });

  it('dryRun skips persistence', async () => {
    mockedRead.mockResolvedValueOnce(records([{ communityId: 9, size: 12 }])).mockResolvedValueOnce(
      records([
        { id: 'x', name: 'X', labels: ['Entity', 'Technology'] },
        { id: 'y', name: 'Y', labels: ['Entity'] },
      ])
    );
    mockedGen.mockResolvedValue({
      title: 'T',
      summary: 'a reasonably long summary of the community contents',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2, dryRun: true });
    expect(r.reports).toHaveLength(1);
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('continues past a single-community summary failure', async () => {
    mockedRead
      .mockResolvedValueOnce(
        records([
          { communityId: 1, size: 20 },
          { communityId: 2, size: 10 },
        ])
      ) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ) // members of community 1
      .mockResolvedValueOnce(
        records([
          { id: 'c', name: 'C', labels: ['Entity'] },
          { id: 'd', name: 'D', labels: ['Entity'] },
        ])
      ); // members of community 2
    mockedGen.mockRejectedValueOnce(new Error('Gemini throttled')).mockResolvedValueOnce({
      title: 'T2',
      summary: 'summary body at least thirty characters long to pass validation',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 2, minSize: 2 });
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0].communityId).toBe(2);
    // P3-B: the failure must be counted, not silently swallowed.
    expect(r.communitiesFailed).toBe(1);
  });

  // P3-B fail-loud (was the top warn-and-continue mask): Louvain failing with
  // nothing to fall back on used to warn + return zero reports while the
  // nightly cron reported success.
  it('throws when Louvain fails and no residual gdsCommunity labels exist', async () => {
    mockedLouvain.mockRejectedValue(new Error('GDS procedure not found'));
    mockedRead.mockResolvedValueOnce(records([])); // zero labeled communities
    await expect(buildCommunityReports({ topN: 5, minSize: 5 })).rejects.toThrow(/Louvain failed/);
  });

  it('proceeds on Louvain failure when residual gdsCommunity labels exist', async () => {
    mockedLouvain.mockRejectedValue(new Error('GDS hiccup'));
    mockedRead
      .mockResolvedValueOnce(records([{ n: 12 }])) // coverage probe on the failure path
      .mockResolvedValueOnce(records([{ communityId: 7, size: 12 }])) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ); // members
    mockedGen.mockResolvedValue({
      title: 'Residual community',
      summary: 'summary body at least thirty characters long to pass validation',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2 });
    expect(r.reports).toHaveLength(1);
    expect(r.modularity).toBeNull();
  });

  it('throws when every community summary fails (zero output must not look like success)', async () => {
    mockedRead
      .mockResolvedValueOnce(
        records([
          { communityId: 1, size: 20 },
          { communityId: 2, size: 10 },
        ])
      ) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ) // members of community 1
      .mockResolvedValueOnce(
        records([
          { id: 'c', name: 'C', labels: ['Entity'] },
          { id: 'd', name: 'D', labels: ['Entity'] },
        ])
      ); // members of community 2
    mockedGen.mockRejectedValue(new Error('Gemini down'));

    await expect(buildCommunityReports({ topN: 2, minSize: 2 })).rejects.toThrow(/all 2 community summaries failed/);
  });

  it('CRIT-3 unmask: throws when Louvain fails AND no gdsCommunity labels exist (total failure must not be masked)', async () => {
    mockedLouvain.mockRejectedValue(new Error("Unknown procedure 'gds.louvain.write'"));
    // gdsCommunity coverage probe: zero labelled nodes.
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await expect(buildCommunityReports({ topN: 3, minSize: 2 })).rejects.toThrow(/louvain/i);
    // No summaries and no persistence may happen on total failure.
    expect(mockedGen).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('proceeds on stale gdsCommunity labels when Louvain fails but prior labels exist', async () => {
    mockedLouvain.mockRejectedValue(new Error('GDS memory exhausted'));
    mockedRead
      .mockResolvedValueOnce(records([{ n: 12 }])) // gdsCommunity coverage probe
      .mockResolvedValueOnce(records([{ communityId: 3, size: 12 }])) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ); // members
    mockedGen.mockResolvedValue({
      title: 'Stale but usable',
      summary: 'summary body at least thirty characters long to pass validation',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2 });
    expect(r.reports).toHaveLength(1);
    expect(r.modularity).toBeNull();
  });

  it('prunes stale community reports whose ids are not in the current run', async () => {
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 5, size: 8 }])) // top communities
      .mockResolvedValueOnce(records([])) // prior reports
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ); // members
    mockedGen.mockResolvedValue({
      title: 'T',
      summary: 'a reasonably long summary of this community with useful substance',
      themes: [],
    });

    await buildCommunityReports({ topN: 1, minSize: 2 });

    // Last write call is the prune. It should DETACH DELETE reports
    // whose id is not in the keepIds list.
    const writeCalls = mockedWrite.mock.calls;
    const pruneCall = writeCalls[writeCalls.length - 1];
    expect(pruneCall[0]).toContain('DETACH DELETE');
    expect(pruneCall[0]).toContain('NOT cr.id IN $keepIds');
    expect(pruneCall[1].keepIds).toEqual(['community-report-5']);
  });

  it('dryRun does not prune', async () => {
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 9, size: 12 }])) // top communities
      .mockResolvedValueOnce(
        records([
          { id: 'x', name: 'X', labels: ['Entity'] },
          { id: 'y', name: 'Y', labels: ['Entity'] },
        ])
      ); // members
    mockedGen.mockResolvedValue({
      title: 'T',
      summary: 'a reasonably long summary for dry-run pruning verification',
      themes: [],
    });

    await buildCommunityReports({ topN: 1, minSize: 2, dryRun: true });

    // No write ever happens when dryRun.
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  // C6 — community membership-delta detection.
  it('reads prior report membership BEFORE pruning and records community-watch observations', async () => {
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 5, size: 8 }])) // top communities
      .mockResolvedValueOnce(records([{ communityId: 42, title: 'Old Title', memberIds: ['a', 'x'] }])) // prior report snapshot, read before the prune
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ); // members of communityId 5
    mockedGen.mockResolvedValue({
      title: 'New Title',
      summary: 'a reasonably long summary describing the shifted community contents',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2 });

    // intersection {a} = 1, union = 2+2-1 = 3 -> jaccard 1/3 (matched, < shiftedBelow -> shifted)
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].kind).toBe('shifted');
    expect(r.changeObservationsRecorded).toBe(1);

    expect(mockedRecordObservation).toHaveBeenCalledTimes(1);
    expect(mockedRecordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'community-watch',
        observationType: 'pattern',
        confidence: 0.7,
        entityType: 'community',
        entityId: 'a', // first memberId of `after` (the current report)
      })
    );

    // Order-sensitive: the prior-report read must happen strictly before the
    // prune (last write call) — once pruned, the prior membership is gone.
    const readCalls = mockedRead.mock.calls;
    const writeOrder = mockedWrite.mock.invocationCallOrder;
    const priorReadCall = readCalls.find((call) => call[0].includes('MATCH (cr:CommunityReport)'));
    expect(priorReadCall).toBeDefined();
    const priorReadOrder = mockedRead.mock.invocationCallOrder[readCalls.indexOf(priorReadCall!)];
    const pruneOrder = writeOrder[writeOrder.length - 1];
    expect(priorReadOrder).toBeLessThan(pruneOrder);
  });

  it('reads prior membership BEFORE any persistReport write (ID-reuse cannot self-match)', async () => {
    // Verify that the prior membership is read before ANY persist write, not
    // just before the prune. When Louvain reuses a communityId but shifts
    // membership, a post-persist read would return the newly-MERGEd report and
    // self-match at jaccard 1.0 (false negative).
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 5, size: 8 }])) // top communities
      .mockResolvedValueOnce(records([{ communityId: 5, title: 'Old Title', memberIds: ['a', 'b', 'c'] }])) // prior report snapshot, same ID
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
          { id: 'd', name: 'D', labels: ['Entity'] },
        ])
      ); // new members (c removed, d added)
    mockedGen.mockResolvedValue({
      title: 'New Title',
      summary: 'a reasonably long summary describing the updated community contents',
      themes: [],
    });

    await buildCommunityReports({ topN: 1, minSize: 2 });

    // Order-sensitive: the prior-report read (MATCH (cr:CommunityReport))
    // must have invocation index LOWER than the FIRST persist write
    // (MERGE (cr:CommunityReport). The prior membership must be captured
    // before the new report is written, otherwise ID reuse + membership shift
    // would self-match.
    const readCalls = mockedRead.mock.calls;
    const writeCalls = mockedWrite.mock.calls;
    const readOrder = mockedRead.mock.invocationCallOrder;
    const writeOrder = mockedWrite.mock.invocationCallOrder;

    const priorReadCall = readCalls.find((call) => call[0].includes('MATCH (cr:CommunityReport)'));
    const persistCall = writeCalls.find((call) => call[0].includes('MERGE (cr:CommunityReport'));

    expect(priorReadCall).toBeDefined();
    expect(persistCall).toBeDefined();

    const priorReadIdx = readCalls.indexOf(priorReadCall!);
    const persistIdx = writeCalls.indexOf(persistCall!);

    const priorReadInvocationOrder = readOrder[priorReadIdx];
    const persistInvocationOrder = writeOrder[persistIdx];

    expect(priorReadInvocationOrder).toBeLessThan(persistInvocationOrder);
  });

  it('skips change detection on dryRun', async () => {
    mockedRead.mockResolvedValueOnce(records([{ communityId: 5, size: 8 }])).mockResolvedValueOnce(
      records([
        { id: 'a', name: 'A', labels: ['Entity'] },
        { id: 'b', name: 'B', labels: ['Entity'] },
      ])
    );
    mockedGen.mockResolvedValue({
      title: 'New Title',
      summary: 'a reasonably long summary describing the dry-run community contents',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2, dryRun: true });

    expect(r.changes).toEqual([]);
    expect(r.changeObservationsRecorded).toBe(0);
    expect(mockedRecordObservation).not.toHaveBeenCalled();
    // Only the top-communities + members reads happen — prior-report read is guarded by !dryRun.
    expect(mockedRead).toHaveBeenCalledTimes(2);
  });

  it('records nothing on the first run (no prior reports)', async () => {
    mockedRead
      .mockResolvedValueOnce(records([{ communityId: 5, size: 8 }])) // top communities
      .mockResolvedValueOnce(records([])) // prior report snapshot: empty (first run)
      .mockResolvedValueOnce(
        records([
          { id: 'a', name: 'A', labels: ['Entity'] },
          { id: 'b', name: 'B', labels: ['Entity'] },
        ])
      ); // members
    mockedGen.mockResolvedValue({
      title: 'First Title',
      summary: 'a reasonably long summary describing the first-run community contents',
      themes: [],
    });

    const r = await buildCommunityReports({ topN: 1, minSize: 2 });

    // The pure matcher honestly reports the new community — but nothing is
    // reported as a first-run observation (everything would be 'new', which
    // would spam a fresh graph).
    expect(r.changes.some((c) => c.kind === 'new')).toBe(true);
    expect(r.changeObservationsRecorded).toBe(0);
    expect(mockedRecordObservation).not.toHaveBeenCalled();
  });
});

describe('queryCommunityReports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ranks reports by substring overlap and falls back to memberCount on ties', async () => {
    mockedRead.mockResolvedValue(
      records([
        {
          id: 'c1',
          communityId: 1,
          title: 'AI hardware accelerators',
          summary: 'Chips, accelerators, GPU vendors',
          themes: ['hardware'],
          memberCount: 30,
          memberIds: ['x'],
          modularity: 0.5,
          generatedAt: 0,
        },
        {
          id: 'c2',
          communityId: 2,
          title: 'Unrelated community',
          summary: 'no match here',
          themes: [],
          memberCount: 10,
          memberIds: [],
          modularity: 0.5,
          generatedAt: 0,
        },
      ])
    );

    const hits = await queryCommunityReports('accelerators', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('c1');
    // "accelerators" appears twice in the fixture (title + summary) so score=2
    expect(hits[0].score).toBe(2);
  });

  it('returns [] when no report matches', async () => {
    mockedRead.mockResolvedValue(records([]));
    const hits = await queryCommunityReports('x', 3);
    expect(hits).toEqual([]);
  });
});
