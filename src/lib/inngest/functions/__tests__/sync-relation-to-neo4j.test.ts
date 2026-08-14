/**
 * @file sync-relation-to-neo4j.test.ts
 * @description Contract test for the Claim-first sync path. Validates that
 * every create/update event lands through syncRelationAsAssertion (not via a
 * bare typed-edge MERGE) and that deletes remove the backing Claim too.
 */

// UNMASKED 2026-07-03 (H5): runReadTransaction used to be pinned to "always
// finds an edge" — hiding that the delete path early-returned without cleaning
// up the :Assertion/:Evidence when no typed edge matched the relationId
// (which Class B edges never carried pre-CRIT-1, and sub-75 proposals never
// have). Tests control the lookup result per-case now.
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(async () => ({ healthy: true })),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(async () => ({ records: [{ id: 'present' }] })),
}));
jest.mock('@/lib/graph/relation-assertion-sync', () => ({
  syncRelationAsAssertion: jest.fn(),
  syncRelationAsEdge: jest.fn(),
  deleteAssertionByRelationId: jest.fn(),
}));
jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
}));
// GRAPH-061: an EdgeVerificationResult is a standalone node keyed by relationId,
// so the relation teardown removes it explicitly after the edge is gone.
jest.mock('@/lib/graph/verification', () => ({
  deleteVerificationResultsForRelation: jest.fn(async () => 0),
}));

// Admin SDK fake: relation reads, durable delete markers, and compare-and-delete
// transactions share state so delete tests verify the marker lifecycle.
const relationFixture: { current: unknown } = { current: null };
const outboxFixture: { current: unknown } = { current: null };
const mockSyncRelationUpdate = jest.fn(async () => undefined);
type AdminRef = { collection: string; id: string; get: jest.Mock; update: jest.Mock };
const makeSnapshot = (value: unknown) => ({ exists: value !== null, data: () => value });
const mockRelationGet = jest.fn(async () => makeSnapshot(relationFixture.current));
const mockTransactionDelete = jest.fn((ref: AdminRef) => {
  if (ref.collection === 'relationSyncOutbox') outboxFixture.current = null;
});
const mockRunTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({
    get: jest.fn(async (ref: AdminRef) =>
      makeSnapshot(ref.collection === 'relationSyncOutbox' ? outboxFixture.current : relationFixture.current)
    ),
    delete: mockTransactionDelete,
  })
);
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collection: string) => ({
      doc: jest.fn((id: string) => ({
        collection,
        id,
        get: collection === 'relations' ? mockRelationGet : jest.fn(async () => makeSnapshot(outboxFixture.current)),
        update: mockSyncRelationUpdate,
      })),
    })),
    runTransaction: mockRunTransaction,
  },
}));
jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,

      execute: (data: any) =>
        handler({
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
  safeSendEvent: jest.fn(),
}));

import * as claimSync from '@/lib/graph/relation-assertion-sync';
import * as queryCache from '@/lib/graph/query-cache';
import { relationProjectionFingerprint } from '@/lib/graph/projection-reconciliation';
import { syncRelationToNeo4jJob, triggerBatchRelationSync, triggerRelationSync } from '../sync-relation-to-neo4j';

const mockedSyncAsClaim = claimSync.syncRelationAsAssertion as jest.Mock;
const mockedSyncAsEdge = claimSync.syncRelationAsEdge as jest.Mock;
const mockedDeleteClaim = claimSync.deleteAssertionByRelationId as jest.Mock;

describe('syncRelationToNeo4jJob — Claim-first contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    relationFixture.current = null;
    outboxFixture.current = null;
    mockRelationGet.mockImplementation(async () => makeSnapshot(relationFixture.current));
    // Default: entity-existence checks find their node (tests override per-case).
    const graph = jest.requireMock('@/lib/graph');
    (graph.runReadTransaction as jest.Mock).mockImplementation(async () => ({ records: [{ id: 'present' }] }));
    mockedSyncAsClaim.mockResolvedValue({
      claimId: 'claim-xyz',
      edgeType: 'USES',
      edgeCreated: true,
      claimCreated: true,
      evidenceCreated: 1,
    });
    mockedDeleteClaim.mockResolvedValue(1);
  });

  it('create operation delegates to syncRelationAsAssertion (never a bare MERGE)', async () => {
    relationFixture.current = {
      id: 'rel-1',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: 'LangChain forwards messages to Claude',
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    const r = await (syncRelationToNeo4jJob as any).execute({
      operation: 'create',
      relationId: 'rel-1',
    });

    expect(mockedSyncAsClaim).toHaveBeenCalledTimes(1);
    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.relationId).toBe('rel-1');
    expect(arg.subject).toEqual({ id: 'tech-1', type: 'technology', name: 'LangChain' });
    expect(arg.object).toEqual({ id: 'tech-2', type: 'technology', name: 'Claude API' });
    expect(arg.predicate).toBe('USES');
    expect(arg.confidence).toBe(88);
    // aiSuggested relation -> agent asserter
    expect(arg.assertedBy).toBe('agent:linker');
    expect(r.success).toBe(true);
    expect(r.operation).toBe('created');
  });

  it('preserves one strict correlation token through graph input, completion, and output', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    relationFixture.current = {
      id: 'rel-correlated',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    const result = await (syncRelationToNeo4jJob as any).execute({
      correlationId,
      operation: 'create',
      relationId: 'rel-correlated',
    });

    expect(mockedSyncAsClaim).toHaveBeenCalledWith(expect.objectContaining({ correlationId }));
    expect(jest.requireMock('../../client').inngest.send).toHaveBeenCalledWith({
      name: 'app/relation.sync.completed',
      data: expect.objectContaining({ correlationId, relationId: 'rel-correlated', operation: 'created' }),
    });
    expect(result).toEqual(expect.objectContaining({ success: true, correlationId, relationId: 'rel-correlated' }));
  });

  it('rejects malformed correlation text before any graph operation', async () => {
    await expect(
      (syncRelationToNeo4jJob as any).execute({
        correlationId: 'customer@example.test secret payload',
        operation: 'create',
        relationId: 'rel-invalid-correlation',
      })
    ).rejects.toThrow('Invalid relation sync correlation ID');

    expect(jest.requireMock('@/lib/graph').checkHealth).not.toHaveBeenCalled();
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();
  });

  it('skips reversed stale delivery before touching Neo4j, then projects the authoritative event', async () => {
    const staleCorrelationId = 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const currentCorrelationId = 'corr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const staleFingerprint = 'a'.repeat(64);
    const authoritativeSource = {
      id: 'rel-reversed',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      aiSuggested: true,
      claimStatus: 'proposed',
    };
    const currentFingerprint = relationProjectionFingerprint(authoritativeSource);
    relationFixture.current = {
      ...authoritativeSource,
      sourceCorrelationId: currentCorrelationId,
      sourceFingerprint: currentFingerprint,
    };

    const staleResult = await (syncRelationToNeo4jJob as any).execute({
      correlationId: staleCorrelationId,
      sourceFingerprint: staleFingerprint,
      operation: 'update',
      relationId: 'rel-reversed',
    });

    const graph = jest.requireMock('@/lib/graph');
    expect(staleResult).toMatchObject({ success: true, operation: 'skipped' });
    expect(graph.checkHealth).not.toHaveBeenCalled();
    expect(graph.runReadTransaction).not.toHaveBeenCalled();
    expect(graph.runWriteTransaction).not.toHaveBeenCalled();
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();

    const currentResult = await (syncRelationToNeo4jJob as any).execute({
      correlationId: currentCorrelationId,
      sourceFingerprint: currentFingerprint,
      operation: 'update',
      relationId: 'rel-reversed',
    });

    expect(currentResult).toMatchObject({
      success: true,
      operation: 'updated',
      correlationId: currentCorrelationId,
    });
    expect(mockedSyncAsClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: currentCorrelationId,
        sourceCorrelationId: currentCorrelationId,
        sourceFingerprint: currentFingerprint,
        relationId: 'rel-reversed',
      })
    );
  });

  it('forwards the authoritative source pair through the curated direct-edge path', async () => {
    const correlationId = 'corr_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const source = {
      id: 'rel-versioned-direct',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 90,
      aiSuggested: false,
      claimStatus: 'curated',
    };
    const sourceFingerprint = relationProjectionFingerprint(source);
    relationFixture.current = {
      ...source,
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    };

    await (syncRelationToNeo4jJob as any).execute({
      correlationId,
      sourceFingerprint,
      operation: 'update',
      relationId: source.id,
    });

    expect(mockedSyncAsEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        relationId: source.id,
        correlationId,
        sourceCorrelationId: correlationId,
        sourceFingerprint,
      })
    );
  });

  it.each([
    ['correlation', { sourceCorrelationId: 'private source metadata' }],
    ['valid correlation without a fingerprint', { sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000' }],
    ['fingerprint', { sourceFingerprint: 'not-a-source-fingerprint' }],
    [
      'valid fingerprint without a correlation',
      {
        sourceFingerprint: relationProjectionFingerprint({
          sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
          targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
          relationType: 'uses',
          confidence: 88,
          aiSuggested: true,
          claimStatus: 'proposed',
        }),
      },
    ],
    ['well-formed fingerprint/content mismatch', { sourceFingerprint: 'f'.repeat(64) }],
  ])('fails closed on malformed authoritative source %s before Neo4j access', async (_case, metadata) => {
    relationFixture.current = {
      id: 'rel-malformed-source',
      ...metadata,
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'update',
        relationId: 'rel-malformed-source',
      })
    ).rejects.toThrow(/source correlation metadata|source fingerprint|source version metadata/);

    const graph = jest.requireMock('@/lib/graph');
    expect(graph.checkHealth).not.toHaveBeenCalled();
    expect(graph.runReadTransaction).not.toHaveBeenCalled();
    expect(graph.runWriteTransaction).not.toHaveBeenCalled();
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();
  });

  it('retries when graph-driving content changes with the same updatedAt', async () => {
    relationFixture.current = {
      id: 'rel-version',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: 'before',
      aiSuggested: true,
      claimStatus: 'proposed',
      updatedAt: 100,
    };
    mockedSyncAsClaim.mockImplementationOnce(async () => {
      relationFixture.current = { ...(relationFixture.current as object), notes: 'after', updatedAt: 100 };
      return {
        claimId: 'claim-version',
        edgeType: 'USES',
        edgeCreated: true,
        claimCreated: true,
        evidenceCreated: 0,
      };
    });

    await expect(
      (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-version' })
    ).rejects.toThrow(/changed during graph mutation/);
  });

  it('compensates when the source is deleted during the graph write', async () => {
    relationFixture.current = {
      id: 'rel-deleted-race',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      aiSuggested: true,
      claimStatus: 'proposed',
      updatedAt: 100,
    };
    mockedSyncAsClaim.mockImplementationOnce(async () => {
      relationFixture.current = null;
      return {
        claimId: 'claim-deleted-race',
        edgeType: 'USES',
        edgeCreated: true,
        claimCreated: true,
        evidenceCreated: 0,
      };
    });

    const result = await (syncRelationToNeo4jJob as any).execute({
      operation: 'update',
      relationId: 'rel-deleted-race',
    });

    expect(result).toMatchObject({ success: true, operation: 'skipped' });
    expect(mockedDeleteClaim).toHaveBeenCalledWith('rel-deleted-race');
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).toHaveBeenCalledWith(
      expect.stringContaining('DELETE r'),
      { relationId: 'rel-deleted-race' }
    );
  });

  it('retries a delete/recreate race even when the timestamp is reused', async () => {
    const original = {
      id: 'rel-recreated-race',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: 'old generation',
      aiSuggested: true,
      claimStatus: 'proposed',
      updatedAt: 100,
    };
    relationFixture.current = original;
    mockedSyncAsClaim.mockImplementationOnce(async () => {
      relationFixture.current = null;
      return {
        claimId: 'claim-recreated-race',
        edgeType: 'USES',
        edgeCreated: true,
        claimCreated: true,
        evidenceCreated: 0,
      };
    });
    mockedDeleteClaim.mockImplementationOnce(async () => {
      relationFixture.current = { ...original, notes: 'new generation', updatedAt: 100 };
      return 1;
    });

    await expect(
      (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-recreated-race' })
    ).rejects.toThrow(/recreated during post-write cleanup/);
  });

  it.each([
    ['missing source', { targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Target' }, relationType: 'uses' }],
    [
      'unknown endpoint type',
      {
        sourceSnapshot: { id: 'a', type: 'unknown', name: 'Source' },
        targetSnapshot: { id: 'b', type: 'technology', name: 'Target' },
        relationType: 'uses',
      },
    ],
    [
      'unknown relation type',
      {
        sourceSnapshot: { id: 'a', type: 'company', name: 'Source' },
        targetSnapshot: { id: 'b', type: 'technology', name: 'Target' },
        relationType: 'teleports_to',
      },
    ],
  ])('fails closed on malformed authoritative topology: %s', async (_name, fixture) => {
    relationFixture.current = fixture;

    await expect(
      (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-malformed' })
    ).rejects.toThrow(/Malformed relation/);
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // B1 — distinct asserter identity: Relation.agentName threads through the
  // Firestore doc (re-read at load time) into the assertedBy string the sync
  // handler stamps onto the Assertion/edge. Only meaningful for aiSuggested
  // relations — curated (non-AI) relations always assert as 'user:system'
  // regardless of any stray agentName value on the doc.
  // --------------------------------------------------------------------------

  it('threads relation.agentName into assertedBy (agent:auto-linker)', async () => {
    relationFixture.current = {
      id: 'rel-agent-1',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 72,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
      agentName: 'auto-linker',
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-agent-1' });

    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.assertedBy).toBe('agent:auto-linker');
  });

  it('falls back to agent:linker when agentName is missing', async () => {
    relationFixture.current = {
      id: 'rel-agent-2',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 72,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
      // no agentName field
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-agent-2' });

    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.assertedBy).toBe('agent:linker');
  });

  it('ignores agentName for curated non-AI relations (user:system)', async () => {
    relationFixture.current = {
      id: 'rel-agent-3',
      sourceSnapshot: { id: 'c-1', type: 'company', name: 'Acme' },
      targetSnapshot: { id: 't-1', type: 'technology', name: 'Foo' },
      relationType: 'vendor',
      confidence: 100,
      notes: null,
      aiSuggested: false,
      claimStatus: 'curated',
      // stray agentName on a curated doc must never leak into assertedBy
      agentName: 'auto-linker',
    };
    mockedSyncAsEdge.mockResolvedValue({ edgeType: 'VENDOR', edgeCreated: true });

    await (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-agent-3' });

    expect(mockedSyncAsEdge.mock.calls[0][0].assertedBy).toBe('user:system');
  });

  it('curated non-AI relations bypass the Claim node (syncRelationAsEdge)', async () => {
    relationFixture.current = {
      id: 'rel-2',
      sourceSnapshot: { id: 'c-1', type: 'company', name: 'Acme' },
      targetSnapshot: { id: 't-1', type: 'technology', name: 'Foo' },
      relationType: 'vendor',
      confidence: 100,
      notes: null,
      aiSuggested: false,
      claimStatus: 'curated',
    };
    mockedSyncAsEdge.mockResolvedValue({ edgeType: 'VENDOR', edgeCreated: true });

    await (syncRelationToNeo4jJob as any).execute({
      operation: 'update',
      relationId: 'rel-2',
    });

    expect(mockedSyncAsEdge).toHaveBeenCalledTimes(1);
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
    expect(mockedSyncAsEdge.mock.calls[0][0].assertedBy).toBe('user:system');
  });

  // --------------------------------------------------------------------------
  // Task 16 (A1) — ingress normalization: legacy 0-1 Firestore confidence
  // values must be healed to the 0-100 contract before they reach Neo4j, or
  // every re-sync re-poisons an edge the migration already healed.
  // --------------------------------------------------------------------------

  it('normalizes legacy 0-1 Firestore confidence to 0-100 at sync ingress', async () => {
    relationFixture.current = {
      id: 'rel-legacy-01',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 0.85,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-legacy-01' });

    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.confidence).toBe(85);
  });

  it('passes an already-0-100 Firestore confidence through unchanged at sync ingress', async () => {
    relationFixture.current = {
      id: 'rel-already-100',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 85,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-already-100' });

    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.confidence).toBe(85);
  });

  it('proposed agent relations still get the Claim-first path', async () => {
    relationFixture.current = {
      id: 'rel-4',
      sourceSnapshot: { id: 'c-1', type: 'company', name: 'Acme' },
      targetSnapshot: { id: 't-1', type: 'technology', name: 'Foo' },
      relationType: 'vendor',
      confidence: 60,
      notes: 'agent-suggested — needs review',
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    await (syncRelationToNeo4jJob as any).execute({
      operation: 'create',
      relationId: 'rel-4',
    });

    expect(mockedSyncAsClaim).toHaveBeenCalledTimes(1);
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();
  });

  // M6 — edge writes must invalidate the in-memory query caches for BOTH
  // endpoints, or getNeighbors/findPath keep serving pre-write results for up
  // to the cache TTL.
  it('invalidates the query caches for source AND target after an edge write', async () => {
    relationFixture.current = {
      id: 'rel-5',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 90,
      notes: null,
      aiSuggested: false,
      claimStatus: 'curated',
    };
    const mockedInvalidate = queryCache.invalidateCachesForEntity as jest.Mock;
    (claimSync.syncRelationAsEdge as jest.Mock).mockResolvedValue({ edgeType: 'USES', edgeCreated: true });

    await (syncRelationToNeo4jJob as any).execute({
      operation: 'create',
      relationId: 'rel-5',
    });

    expect(mockedInvalidate).toHaveBeenCalledWith('tech-1');
    expect(mockedInvalidate).toHaveBeenCalledWith('tech-2');
  });

  it('invalidates the fresh endpoints when Firestore changes after the memoized load step', async () => {
    const oldGeneration = {
      id: 'rel-fresh-cache',
      sourceSnapshot: { id: 'tech-old-source', type: 'technology', name: 'Old source' },
      targetSnapshot: { id: 'tech-old-target', type: 'technology', name: 'Old target' },
      relationType: 'uses',
      confidence: 90,
      aiSuggested: false,
      claimStatus: 'curated',
    };
    const currentGeneration = {
      ...oldGeneration,
      sourceSnapshot: { id: 'tech-new-source', type: 'technology', name: 'New source' },
      targetSnapshot: { id: 'tech-new-target', type: 'technology', name: 'New target' },
    };
    relationFixture.current = currentGeneration;
    mockRelationGet
      .mockResolvedValueOnce(makeSnapshot(oldGeneration))
      .mockResolvedValue(makeSnapshot(currentGeneration));
    const mockedInvalidate = queryCache.invalidateCachesForEntity as jest.Mock;

    await (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-fresh-cache' });

    expect(mockedInvalidate).toHaveBeenCalledWith('tech-new-source');
    expect(mockedInvalidate).toHaveBeenCalledWith('tech-new-target');
    expect(mockedInvalidate).toHaveBeenCalledWith('tech-old-source');
    expect(mockedInvalidate).toHaveBeenCalledWith('tech-old-target');
  });

  it('cache invalidation failures never fail the sync (fire-and-forget)', async () => {
    relationFixture.current = {
      id: 'rel-6',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'A' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'B' },
      relationType: 'uses',
      confidence: 90,
      notes: null,
      aiSuggested: false,
      claimStatus: 'curated',
    };
    (queryCache.invalidateCachesForEntity as jest.Mock).mockImplementation(() => {
      throw new Error('cache exploded');
    });
    (claimSync.syncRelationAsEdge as jest.Mock).mockResolvedValue({ edgeType: 'USES', edgeCreated: true });

    const r = await (syncRelationToNeo4jJob as any).execute({
      operation: 'create',
      relationId: 'rel-6',
    });

    expect(r.success).toBe(true);
  });

  it('delete operation removes the backing Claim and then the edge', async () => {
    const r = await (syncRelationToNeo4jJob as any).execute({
      operation: 'delete',
      relationId: 'rel-3',
      sourceType: 'technology',
      targetType: 'company',
      relationType: 'vendor',
    });

    expect(mockedDeleteClaim).toHaveBeenCalledWith('rel-3');
    expect(r.operation).toBe('deleted');
    // Never calls syncRelationAsAssertion on delete.
    expect(mockedSyncAsClaim).not.toHaveBeenCalled();
  });

  it('clears the matching outbox marker only after graph deletion succeeds', async () => {
    outboxFixture.current = {
      relationId: 'rel-outbox-success',
      deleteToken: 'token-success',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 300001,
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-outbox-success',
        deleteToken: 'token-success',
      })
    ).resolves.toMatchObject({ success: true, operation: 'deleted' });

    expect(mockedDeleteClaim).toHaveBeenCalledWith('rel-outbox-success');
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionDelete).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'relationSyncOutbox', id: 'rel-outbox-success' })
    );
    expect(outboxFixture.current).toBeNull();
  });

  it('retains the outbox marker when graph deletion fails', async () => {
    const marker = {
      relationId: 'rel-outbox-failure',
      deleteToken: 'token-failure',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 300001,
      createdAt: 1,
      updatedAt: 1,
    };
    outboxFixture.current = marker;
    mockedDeleteClaim.mockRejectedValueOnce(new Error('Neo4j unavailable'));

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-outbox-failure',
        deleteToken: 'token-failure',
      })
    ).rejects.toThrow('Neo4j unavailable');

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(outboxFixture.current).toBe(marker);
  });

  it('rejects a malformed marker without touching graph data', async () => {
    const malformedMarker = {
      relationId: 'rel-malformed-marker',
      deleteToken: '',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 300001,
      createdAt: 1,
      updatedAt: 1,
    };
    outboxFixture.current = malformedMarker;

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-malformed-marker',
      })
    ).rejects.toThrow('Malformed relation delete outbox marker for rel-malformed-marker');

    expect(mockedDeleteClaim).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(outboxFixture.current).toBe(malformedMarker);
  });

  it('skips a stale token without deleting graph data or a newer marker', async () => {
    const marker = {
      relationId: 'rel-stale-token',
      deleteToken: 'token-new',
      operation: 'delete',
      status: 'pending',
      attempt: 1,
      nextAttemptAt: 300002,
      createdAt: 2,
      updatedAt: 2,
    };
    outboxFixture.current = marker;

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-stale-token',
        deleteToken: 'token-old',
      })
    ).resolves.toMatchObject({ success: true, operation: 'skipped' });

    expect(mockedDeleteClaim).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(outboxFixture.current).toBe(marker);
  });

  it('does not let a tokenless legacy event consume a current marker generation', async () => {
    const marker = {
      relationId: 'rel-tokenless-stale',
      deleteToken: 'token-current',
      operation: 'delete',
      status: 'pending',
      attempt: 2,
      nextAttemptAt: 300003,
      createdAt: 3,
      updatedAt: 3,
    };
    outboxFixture.current = marker;

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-tokenless-stale',
      })
    ).resolves.toMatchObject({ success: true, operation: 'skipped' });

    expect(mockedDeleteClaim).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(outboxFixture.current).toBe(marker);
  });

  it('revalidates a memoized delete load before retrying destructive graph work', async () => {
    outboxFixture.current = {
      relationId: 'rel-recreated-during-retry',
      deleteToken: 'token-before-retry',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 300001,
      createdAt: 1,
      updatedAt: 1,
    };
    mockedDeleteClaim.mockRejectedValueOnce(new Error('first graph attempt failed'));

    const completedSteps = new Map<string, unknown>();
    const step = {
      run: async (name: string, fn: () => Promise<unknown>) => {
        if (completedSteps.has(name)) return completedSteps.get(name);
        const result = await fn();
        completedSteps.set(name, result);
        return result;
      },
    };
    const executeAttempt = () =>
      (syncRelationToNeo4jJob as any).handler({
        event: {
          data: {
            operation: 'delete',
            relationId: 'rel-recreated-during-retry',
            deleteToken: 'token-before-retry',
          },
        },
        step,
      });

    await expect(executeAttempt()).rejects.toThrow('first graph attempt failed');
    relationFixture.current = {
      id: 'rel-recreated-during-retry',
      sourceSnapshot: { id: 'tech-new-1', type: 'technology', name: 'New A' },
      targetSnapshot: { id: 'tech-new-2', type: 'technology', name: 'New B' },
      relationType: 'uses',
    };

    await expect(executeAttempt()).resolves.toMatchObject({ success: true, operation: 'skipped' });
    expect(mockedDeleteClaim).toHaveBeenCalledTimes(1);
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
    expect(relationFixture.current).toMatchObject({ id: 'rel-recreated-during-retry' });
  });

  it('does not delete a recreated relation and retires its matching stale marker', async () => {
    relationFixture.current = {
      id: 'rel-recreated',
      sourceSnapshot: { id: 'tech-new-1', type: 'technology', name: 'New A' },
      targetSnapshot: { id: 'tech-new-2', type: 'technology', name: 'New B' },
      relationType: 'uses',
    };
    outboxFixture.current = {
      relationId: 'rel-recreated',
      deleteToken: 'token-old-generation',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 300001,
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(
      (syncRelationToNeo4jJob as any).execute({
        operation: 'delete',
        relationId: 'rel-recreated',
        deleteToken: 'token-old-generation',
      })
    ).resolves.toMatchObject({ success: true, operation: 'skipped' });

    expect(mockedDeleteClaim).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
    expect(mockTransactionDelete).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'relationSyncOutbox', id: 'rel-recreated' })
    );
    expect(outboxFixture.current).toBeNull();
  });

  it('H5: delete still removes the backing Assertion when NO typed edge matches the relationId', async () => {
    // Class B edges pre-CRIT-1 carried a random relationId and sub-75
    // proposals never materialize an edge at all — the edge lookup finds
    // nothing, but the :Assertion (+ :Evidence) MUST still be cleaned up.
    // deleteAssertionByRelationId is idempotent, so it runs unconditionally.
    const graph = jest.requireMock('@/lib/graph');
    (graph.runReadTransaction as jest.Mock).mockResolvedValue({ records: [] });

    const r = await (syncRelationToNeo4jJob as any).execute({
      operation: 'delete',
      relationId: 'rel-orphaned-assertion',
      sourceType: 'technology',
      targetType: 'company',
      relationType: 'vendor',
    });

    expect(mockedDeleteClaim).toHaveBeenCalledWith('rel-orphaned-assertion');
    // Edge cleanup still runs too (DELETE is a no-op when nothing matches).
    expect(graph.runWriteTransaction).toHaveBeenCalledWith(
      expect.stringContaining('DELETE r'),
      expect.objectContaining({ relationId: 'rel-orphaned-assertion' })
    );
    expect(r.operation).toBe('deleted');
  });

  // --------------------------------------------------------------------------
  // M2 — Class C: curated relations WITH structured evidence must route
  // through the Assertion path and carry that evidence into the graph.
  // --------------------------------------------------------------------------

  it('M2: curated relation WITH evidenceRefs routes through the Assertion path (Class C) and forwards evidence', async () => {
    relationFixture.current = {
      id: 'rel-c1',
      sourceSnapshot: { id: 'c-1', type: 'company', name: 'Acme' },
      targetSnapshot: { id: 't-1', type: 'technology', name: 'Foo' },
      relationType: 'vendor',
      confidence: 100,
      notes: 'curated with citation',
      aiSuggested: false,
      claimStatus: 'curated',
      evidenceRefs: [
        {
          id: 'ev-1',
          type: 'web_ref',
          snippet: 'Acme lists Foo as a supported vendor integration',
          url: 'https://acme.example/integrations',
          capturedAt: 1,
        },
      ],
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-c1' });

    expect(mockedSyncAsClaim).toHaveBeenCalledTimes(1);
    expect(mockedSyncAsEdge).not.toHaveBeenCalled();
    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.evidence).toHaveLength(1);
    expect(arg.evidence[0]).toMatchObject({
      sourceType: 'web_ref',
      snippet: 'Acme lists Foo as a supported vendor integration',
      sourceUrl: 'https://acme.example/integrations',
    });
  });

  it('M2: aiSuggested relation with evidenceRefs forwards them into the Class B assertion input', async () => {
    relationFixture.current = {
      id: 'rel-b-ev',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
      evidenceRefs: [{ id: 'ev-2', type: 'signal', snippet: 'observed in signal', signalId: 'sig-9', capturedAt: 1 }],
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-b-ev' });

    const arg = mockedSyncAsClaim.mock.calls[0][0];
    expect(arg.evidence).toEqual([
      expect.objectContaining({ sourceType: 'signal', snippet: 'observed in signal', signalId: 'sig-9' }),
    ]);
  });

  it('forwards entity_field evidence coordinates through the Relation-to-Assertion adapter', async () => {
    relationFixture.current = {
      id: 'rel-entity-evidence',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: null,
      aiSuggested: true,
      claimStatus: 'proposed',
      evidenceRefs: [
        {
          id: 'entity-ref-1',
          sourceKey: 'proposal:p1:entity_field:tech-1:hash',
          type: 'entity_field',
          snippet: 'The entity description names Claude API.',
          entityId: 'tech-1',
          entityType: 'technology',
          entityField: 'description',
          capturedAt: 1,
        },
      ],
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-entity-evidence' });

    expect(mockedSyncAsClaim.mock.calls[0][0].evidence).toEqual([
      expect.objectContaining({
        sourceType: 'entity_field',
        sourceKey: 'proposal:p1:entity_field:tech-1:hash',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      }),
    ]);
  });

  // --------------------------------------------------------------------------
  // M3 — the Class B/C sync must write the :Assertion id back onto the
  // Firestore Relation doc (Relation.claimId was documented "set after sync"
  // but never written; getRelationEvidence gated on it forever-false).
  // --------------------------------------------------------------------------

  it('M3: writes claimId back onto the Firestore relation doc after the Assertion sync', async () => {
    relationFixture.current = {
      id: 'rel-m3',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: 'notes',
      aiSuggested: true,
      claimStatus: 'proposed',
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'create', relationId: 'rel-m3' });

    expect(mockSyncRelationUpdate).toHaveBeenCalledWith({ claimId: 'claim-xyz' });
  });

  it('M3: skips the write-back when the relation doc already carries the same claimId', async () => {
    relationFixture.current = {
      id: 'rel-m3-idem',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
      confidence: 88,
      notes: 'notes',
      aiSuggested: true,
      claimStatus: 'proposed',
      claimId: 'claim-xyz',
    };

    await (syncRelationToNeo4jJob as any).execute({ operation: 'update', relationId: 'rel-m3-idem' });

    expect(mockSyncRelationUpdate).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // onFailure payload recovery (Inngest v3 envelope)
  // The internal `inngest/function.failed` event nests the ORIGINAL event at
  // event.data.event — reading event.data.relationId directly yields
  // undefined. These tests pin the extractFailureEventData unwrap.
  // --------------------------------------------------------------------------

  describe('onFailure', () => {
    const getOnFailure = () =>
      (syncRelationToNeo4jJob as any).config.onFailure as (args: {
        error: Error;
        event: { data: unknown };
      }) => Promise<void>;

    it('recovers relationId and operation from the nested v3 failure envelope', async () => {
      const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
      await getOnFailure()({
        error: new Error('neo4j down'),
        event: {
          data: {
            // Inngest v3 envelope: original event nested under `event`
            event: {
              name: 'app/relation.sync.requested',
              data: { correlationId, relationId: 'rel-9', operation: 'create' },
            },
            error: { message: 'neo4j down' },
          },
        },
      });

      const { inngest } = jest.requireMock('../../client');
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/relation.sync.failed',
        data: expect.objectContaining({
          correlationId,
          relationId: 'rel-9',
          operation: 'create',
          error: 'neo4j down',
        }),
      });
    });

    it("falls back to 'unknown' when the envelope carries no original event", async () => {
      await getOnFailure()({
        error: new Error('boom'),
        // Flat payload (no nested event) — must not crash, must not emit undefined ids
        event: { data: { relationId: 'rel-FLAT-IGNORED', operation: 'create' } },
      });

      const { inngest } = jest.requireMock('../../client');
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/relation.sync.failed',
        data: expect.objectContaining({
          relationId: 'unknown',
          operation: 'unknown',
        }),
      });
    });
  });
});

describe('triggerRelationSync correlation contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards a caller-provided valid token without regenerating it', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    await triggerRelationSync('rel-trigger', 'update', { correlationId });

    expect(jest.requireMock('../../client').safeSendEvent).toHaveBeenCalledWith(
      {
        name: 'app/relation.sync.requested',
        data: { correlationId, operation: 'update', relationId: 'rel-trigger' },
      },
      { logPrefix: '[relations]', silent: true }
    );
  });

  it('rejects a malformed caller token instead of forwarding arbitrary text', async () => {
    relationFixture.current = {
      id: 'rel-trigger',
      sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000',
      sourceFingerprint: 'e'.repeat(64),
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
    };
    await expect(
      triggerRelationSync('rel-trigger', 'update', { correlationId: 'private arbitrary text' })
    ).rejects.toThrow('Invalid correlation ID');
    expect(mockRelationGet).not.toHaveBeenCalled();
    expect(jest.requireMock('../../client').safeSendEvent).not.toHaveBeenCalled();
  });

  it('uses the authoritative source pair for batch repair events', async () => {
    const correlationId = 'corr_123e4567-e89b-42d3-a456-426614174000';
    const authoritativeSource = {
      id: 'rel-batch',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
      relationType: 'uses',
    };
    const sourceFingerprint = relationProjectionFingerprint(authoritativeSource);
    relationFixture.current = {
      ...authoritativeSource,
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    };
    jest.requireMock('../../client').safeSendEvent.mockResolvedValue(true);

    await expect(triggerBatchRelationSync(['rel-batch'])).resolves.toBe(1);

    expect(jest.requireMock('../../client').safeSendEvent).toHaveBeenCalledWith(
      {
        name: 'app/relation.sync.requested',
        data: {
          correlationId,
          sourceFingerprint,
          operation: 'update',
          relationId: 'rel-batch',
        },
      },
      { logPrefix: '[relations]', silent: true }
    );
  });
});
