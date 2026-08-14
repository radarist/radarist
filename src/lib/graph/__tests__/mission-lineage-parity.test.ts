/**
 * @jest-environment node
 *
 * GRAPH-030 — reconciling Neo4j mission lineage to the canonical terminal
 * outcome.
 *
 * The reproduced mismatch: `run-agent-mission` writes the Reflection and
 * finalizes the Episode BEFORE it writes the AgentRun and the Mission. When a
 * later step fails permanently, `onFailure` persists a `failed` Mission while
 * Neo4j still holds a `completed` Episode and `AgentReflection.success = true`.
 *
 * These tests pin the repair's contract: downgrade-only, idempotent,
 * endedAt-preserving, and never destructive.
 */

jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { runReadTransaction, runWriteTransaction } from '@/lib/graph/neo4j-client';
import {
  LINEAGE_RECONCILIATION_VERSION,
  reconcileMissionLineageOutcome,
  reflectionSuccessForDomainOutcome,
  requiresFailedEpisodeStatus,
} from '../mission-lineage-parity';

const mockWrite = runWriteTransaction as jest.Mock;
const mockRead = runReadTransaction as jest.Mock;

function writeRecords(record: Record<string, unknown>) {
  return { records: [record], summary: { counters: {} } };
}

describe('requiresFailedEpisodeStatus', () => {
  it('proves a failed Episode for every non-delivery outcome', () => {
    expect(requiresFailedEpisodeStatus('failed')).toBe(true);
    expect(requiresFailedEpisodeStatus('preflight-failed')).toBe(true);
    expect(requiresFailedEpisodeStatus('provider-fatal')).toBe(true);
    expect(requiresFailedEpisodeStatus('cancelled')).toBe(true);
  });

  it('refuses to prove a coarse status it cannot derive', () => {
    // `partial` is the reason this predicate is one-way: a timed-out mission that
    // recovered a checkpoint is canonically `failed` + partial, so `partial`
    // alone cannot decide the Episode's coarse status.
    expect(requiresFailedEpisodeStatus('partial')).toBe(false);
    expect(requiresFailedEpisodeStatus('success')).toBe(false);
    expect(requiresFailedEpisodeStatus('skipped')).toBe(false);
  });

  it('lets a partial reflection keep its success claim', () => {
    expect(reflectionSuccessForDomainOutcome('partial')).toBe(true);
    expect(reflectionSuccessForDomainOutcome('failed')).toBe(false);
    expect(reflectionSuccessForDomainOutcome('cancelled')).toBe(false);
  });
});

describe('reconcileMissionLineageOutcome', () => {
  beforeEach(() => jest.clearAllMocks());

  it('corrects a completed Episode and a success reflection to the failed outcome', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 1,
        episodesCorrected: 1,
        priorStatuses: ['completed'],
        reflectionsInspected: 1,
        reflectionsCorrected: 1,
      })
    );

    const result = await reconcileMissionLineageOutcome({
      missionId: 'mission-123',
      outcome: 'failed',
      reason: 'agent-run-persistence-failed',
    });

    expect(result).toEqual({
      outcome: 'failed',
      episode: 'corrected',
      reflectionsCorrected: 1,
      reflectionsInspected: 1,
    });

    const [cypher, params] = mockWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toEqual(
      expect.objectContaining({
        missionId: 'mission-123',
        targetStatus: 'failed',
        targetReflectionSuccess: false,
        outcome: 'failed',
        version: LINEAGE_RECONCILIATION_VERSION,
        reason: 'agent-run-persistence-failed',
      })
    );
    // The first terminal instant is the real end of work; a correction must not
    // walk it forward, so endedAt is only ever coalesced.
    expect(cypher).toContain('ep.endedAt = coalesce(ep.endedAt, datetime())');
    expect(cypher).not.toContain('ep.endedAt = datetime()');
    // Corrections are auditable, not silent.
    expect(cypher).toContain('ep.outcomeReconciledFrom');
    expect(cypher).toContain('ep.outcomeReconciliationVersion = $version');
    // Never destructive: a wrong reflection is corrected in place, and the fact
    // that the agent generated it stays in the graph.
    expect(cypher).not.toMatch(/\bDELETE\b/);
    expect(cypher).not.toMatch(/\bDETACH\b/);
  });

  it('refuses to upgrade failed lineage into a success claim', async () => {
    mockRead.mockResolvedValue(writeRecords({ episodes: 1, reflections: 2 }));

    const result = await reconcileMissionLineageOutcome({ missionId: 'mission-123', outcome: 'success' });

    expect(result).toEqual({
      outcome: 'success',
      episode: 'refused-upgrade',
      reflectionsCorrected: 0,
      reflectionsInspected: 2,
    });
    // The refusal is a READ. Nothing is written, so a repair pass can never be
    // used to manufacture a green run.
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('reports no-lineage rather than inventing an Episode', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 0,
        episodesCorrected: 0,
        priorStatuses: [],
        reflectionsInspected: 0,
        reflectionsCorrected: 0,
      })
    );

    const result = await reconcileMissionLineageOutcome({ missionId: 'mission-none', outcome: 'failed' });

    expect(result.episode).toBe('no-lineage');
    const [cypher] = mockWrite.mock.calls[0] as [string];
    // A missing Episode must not be created by the repair pass.
    expect(cypher).not.toMatch(/\bCREATE\b/);
    expect(cypher).not.toMatch(/\bMERGE\b/);
  });

  it('is idempotent — a second pass reports already-consistent with no correction', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 1,
        episodesCorrected: 0,
        priorStatuses: ['failed'],
        reflectionsInspected: 1,
        reflectionsCorrected: 0,
      })
    );

    const result = await reconcileMissionLineageOutcome({ missionId: 'mission-123', outcome: 'failed' });

    expect(result).toEqual({
      outcome: 'failed',
      episode: 'already-consistent',
      reflectionsCorrected: 0,
      reflectionsInspected: 1,
    });
  });

  it('drives a cancelled mission to failed lineage', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 1,
        episodesCorrected: 1,
        priorStatuses: ['active'],
        reflectionsInspected: 0,
        reflectionsCorrected: 0,
      })
    );

    await reconcileMissionLineageOutcome({ missionId: 'mission-cancelled', outcome: 'cancelled' });

    const [, params] = mockWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.targetStatus).toBe('failed');
    expect(params.outcome).toBe('cancelled');
    expect(params.targetReflectionSuccess).toBe(false);
  });

  it('bounds the stored reason so a provider error cannot bloat the graph', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 1,
        episodesCorrected: 1,
        priorStatuses: ['completed'],
        reflectionsInspected: 0,
        reflectionsCorrected: 0,
      })
    );

    await reconcileMissionLineageOutcome({
      missionId: 'mission-123',
      outcome: 'failed',
      reason: 'x'.repeat(500),
    });

    const [, params] = mockWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(String(params.reason)).toHaveLength(200);
  });

  it('binds null rather than undefined when no reason is supplied', async () => {
    mockWrite.mockResolvedValue(
      writeRecords({
        episodesFound: 1,
        episodesCorrected: 0,
        priorStatuses: ['failed'],
        reflectionsInspected: 0,
        reflectionsCorrected: 0,
      })
    );

    await reconcileMissionLineageOutcome({ missionId: 'mission-123', outcome: 'failed' });

    const [, params] = mockWrite.mock.calls[0] as [string, Record<string, unknown>];
    // Neo4j rejects undefined parameters; null is the explicit "no reason".
    expect(params.reason).toBeNull();
  });

  it('propagates a Neo4j failure instead of reporting a false success', async () => {
    mockWrite.mockRejectedValue(new Error('neo4j unavailable'));

    await expect(reconcileMissionLineageOutcome({ missionId: 'mission-123', outcome: 'failed' })).rejects.toThrow(
      'neo4j unavailable'
    );
  });
});
