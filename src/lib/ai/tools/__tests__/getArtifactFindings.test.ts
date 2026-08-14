/**
 * @jest-environment node
 */

/**
 * @file Tests for getArtifactFindings (R — the read loop). The assistant
 * relies on the "most interesting" ranking and the artifact context to
 * report on evaluation/build findings.
 */

const mockListMissions = jest.fn();
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  listMissions: (...args: unknown[]) => mockListMissions(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

const { executeGetArtifactFindings } = require('../mission-tools');

function mission(over: Record<string, unknown>) {
  return {
    id: 'm',
    userId: 'u1',
    kind: 'build',
    status: 'completed',
    prompt: '# Mission: Evaluate Neo4j\n',
    createdAt: '2026-06-10T00:00:00.000Z',
    findings: [],
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('executeGetArtifactFindings', () => {
  it('ranks risk + verdict before benchmark + observation, and carries artifact context', async () => {
    mockListMissions.mockResolvedValue([
      mission({
        id: 'm-eval',
        artifactKind: 'evaluation',
        costUsd: 12,
        motivation: { sourceTechnologyId: 'tech-neo4j', useCaseIds: [], painPointIds: [], strategyIds: [] },
        findings: [
          { title: 'obs', detail: '', kind: 'observation' },
          { title: 'p99 latency', detail: '', kind: 'benchmark', metric: '12ms' },
          { title: 'license risk', detail: '', kind: 'risk' },
          { title: 'TRL 6 — trial', detail: '', kind: 'verdict', confidence: 82 },
        ],
      }),
    ]);
    const res = await executeGetArtifactFindings({}, 'u1');
    expect(res.totalArtifacts).toBe(1);
    expect(res.findings.map((f: { kind: string }) => f.kind)).toEqual(['risk', 'verdict', 'benchmark', 'observation']);
    const top = res.findings[0];
    expect(top.artifact).toMatchObject({
      missionId: 'm-eval',
      title: 'Evaluate Neo4j',
      artifactKind: 'evaluation',
      technologyId: 'tech-neo4j',
      costUsd: 12,
    });
  });

  it('excludes research missions and build missions without findings; honors the kind filter', async () => {
    mockListMissions.mockResolvedValue([
      mission({ id: 'm-research', kind: 'research', findings: [{ title: 'x', detail: '', kind: 'verdict' }] }),
      mission({ id: 'm-nofindings', kind: 'build', findings: [] }),
      mission({
        id: 'm-sol',
        kind: 'build',
        artifactKind: 'solution',
        findings: [{ title: 's', detail: '', kind: 'verdict' }],
      }),
      mission({
        id: 'm-eval',
        kind: 'build',
        artifactKind: 'evaluation',
        findings: [{ title: 'e', detail: '', kind: 'verdict' }],
      }),
    ]);
    const all = await executeGetArtifactFindings({}, 'u1');
    expect(all.totalArtifacts).toBe(2); // only the two build missions WITH findings

    const evalsOnly = await executeGetArtifactFindings({ kind: 'evaluation' }, 'u1');
    expect(evalsOnly.totalArtifacts).toBe(1);
    expect(evalsOnly.findings[0].artifact.missionId).toBe('m-eval');
  });

  it('requires an authenticated user', async () => {
    await expect(executeGetArtifactFindings({}, '')).rejects.toThrow(/authenticated/);
  });
});
