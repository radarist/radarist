/**
 * @jest-environment node
 *
 * ARUN-030 — the lineage audit that consumes `classifyMissionLineage`.
 *
 * Two properties matter most here, and both are about NOT lying:
 *  - it writes nothing (a repair pass that "resolves" absent records by writing
 *    them would manufacture lineage for work that never ran);
 *  - a Neo4j outage degrades it rather than turning every mission into a false gap.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockMissionsGet = jest.fn();
const mockAgentRunsGet = jest.fn();
const mockRunReadTransaction = jest.fn();
const writeSpies = { set: jest.fn(), update: jest.fn(), delete: jest.fn() };

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => {
      const query: Record<string, unknown> = {
        // Writes are wired to spies so the test can assert none happened.
        doc: () => writeSpies,
        set: writeSpies.set,
        update: writeSpies.update,
      };
      query.where = () => query;
      query.orderBy = () => query;
      query.limit = () => query;
      query.get = () => (name === 'missions' ? mockMissionsGet() : mockAgentRunsGet());
      return query;
    },
  },
}));

jest.mock('@/lib/graph/neo4j-client', () => ({
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
}));

import { auditMissionLineage, MAX_AUDITED_MISSIONS } from '../mission-lineage-audit-admin';
import { BUILD_RUNTIME_AGENT_NAME } from '../build-runtime-identity';

function missionDocs(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
}

describe('auditMissionLineage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunReadTransaction.mockResolvedValue({ records: [] });
    mockMissionsGet.mockResolvedValue(missionDocs([]));
    mockAgentRunsGet.mockResolvedValue({ empty: true, docs: [] });
  });

  it('never writes anything', async () => {
    mockMissionsGet.mockResolvedValue(
      missionDocs([{ id: 'm-1', data: { kind: 'research', agent: 'scout', status: 'completed' } }])
    );

    await auditMissionLineage();

    expect(writeSpies.set).not.toHaveBeenCalled();
    expect(writeSpies.update).not.toHaveBeenCalled();
    expect(writeSpies.delete).not.toHaveBeenCalled();
  });

  it('degrades instead of emitting false gaps when the graph is unavailable', async () => {
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));
    mockMissionsGet.mockResolvedValue(
      missionDocs([{ id: 'm-1', data: { kind: 'research', agent: 'scout', status: 'completed' } }])
    );

    const result = await auditMissionLineage();

    expect(result.graphAvailable).toBe(false);
    // Nothing is classified — without graph observations EVERY mission would look
    // incomplete, and a wall of false gaps is worse than an honest outage report.
    expect(result.inspected).toBe(0);
    expect(result.actionable).toEqual([]);
  });

  it('separates a genuinely missing AgentRun from an exempt build reflection', async () => {
    mockMissionsGet.mockResolvedValue(
      missionDocs([
        { id: 'm-build', data: { kind: 'build', agent: BUILD_RUNTIME_AGENT_NAME, status: 'failed' } },
        { id: 'm-scout', data: { kind: 'research', agent: 'scout', status: 'completed' } },
      ])
    );
    // Both have an Episode; neither has a Reflection.
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { missionId: 'm-build', episodeOutcome: 'failed', reflectionSuccess: null },
        { missionId: 'm-scout', episodeOutcome: 'success', reflectionSuccess: null },
      ],
    });
    // The build has an AgentRun; the scout mission does not.
    mockAgentRunsGet
      .mockResolvedValueOnce({ empty: false, docs: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ empty: true, docs: [] });

    const result = await auditMissionLineage();

    expect(result.inspected).toBe(2);
    // The build's absent reflection is by design — not work.
    expect(result.exempt).toBe(1);
    // The scout mission's absent AgentRun IS work.
    expect(result.incomplete).toBe(1);
    expect(result.actionable).toHaveLength(1);
    expect(result.actionable[0].missionId).toBe('m-scout');
    expect(result.actionable[0].missing).toContain('firestoreAgentRun');
  });

  it('surfaces a cross-store divergence as actionable', async () => {
    mockMissionsGet.mockResolvedValue(
      missionDocs([{ id: 'm-diverged', data: { kind: 'research', agent: 'creator', status: 'failed' } }])
    );
    mockRunReadTransaction.mockResolvedValue({
      records: [{ missionId: 'm-diverged', episodeOutcome: 'success', reflectionSuccess: true }],
    });
    mockAgentRunsGet.mockResolvedValue({ empty: false, docs: [{ id: 'run-1' }] });

    const result = await auditMissionLineage();

    expect(result.divergent).toBe(1);
    expect(result.actionable[0].divergences).toHaveLength(2);
  });

  it('bounds the scan and reports truncation rather than silently dropping rows', async () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({
      id: `m-${i}`,
      data: { kind: 'research', agent: 'scout', status: 'completed' },
    }));
    mockMissionsGet.mockResolvedValue(missionDocs(docs));
    mockRunReadTransaction.mockResolvedValue({
      records: docs.map((d) => ({ missionId: d.id, episodeOutcome: 'success', reflectionSuccess: true })),
    });
    mockAgentRunsGet.mockResolvedValue({ empty: false, docs: [{ id: 'run-1' }] });

    const result = await auditMissionLineage(3);

    expect(result.truncated).toBe(true);
    expect(result.inspected).toBe(3);
  });

  it('clamps an absurd limit to the ceiling', async () => {
    const result = await auditMissionLineage(10_000);
    expect(result.graphAvailable).toBe(true);
    expect(MAX_AUDITED_MISSIONS).toBe(200);
  });

  it('reports a Firestore failure without throwing into the reconciliation cycle', async () => {
    mockMissionsGet.mockRejectedValue(new Error('firestore offline'));
    const result = await auditMissionLineage();
    expect(result.inspected).toBe(0);
    expect(result.graphAvailable).toBe(true);
  });
});
