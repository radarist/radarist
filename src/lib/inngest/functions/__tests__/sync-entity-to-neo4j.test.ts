/**
 * @file sync-entity-to-neo4j.test.ts
 * @description Tests for the unified entity sync job.
 *
 * M6 — the in-memory graph query caches (neighbors/path/business) must be
 * invalidated for an entity after its node is upserted or deleted, otherwise
 * readers keep serving pre-write results for up to the cache TTL.
 * Invalidation is fire-and-forget: it must NEVER fail the sync.
 *
 * Post-M1 contract (decision D2): events are identifier-only — the handler
 * ALWAYS loads the entity doc from the Firestore admin SDK; there is no
 * inline-payload fast path.
 */

const mockEntityFixture: { current: Record<string, unknown> | null } = { current: null };
const mockStepRun = jest.fn(async (_name: string, fn: () => unknown) => fn());
jest.mock('@/lib/graph/signal-projection-policy-admin', () => ({
  loadSignalProjectionDecision: jest.fn(async () => ({
    eligible: true,
    reason: 'approved-or-imported',
    references: [],
  })),
}));

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(async () => ({ healthy: true })),
  deleteEntityFromGraph: jest.fn(async () => ({
    assertionsDeleted: 0,
    evidenceDeleted: 0,
    projectionsDeleted: 0,
    chunksDeleted: 0,
    endpointsDeleted: 1,
  })),
  runWriteTransaction: jest.fn(async (query: string) => ({
    records: query.includes('missingStrategyIds')
      ? [{
          missingStrategyIds: [],
          missingPainPointIds: [],
          strategiesProjected: 0,
          painPointsProjected: 0,
          strategyEdgesRemoved: 0,
          painPointEdgesRemoved: 0,
        }]
      : [],
  })),
}));
jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
}));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: true, dimensions: 768 })),
}));
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  captureEntityTagConceptIdsFromNeo4j: jest.fn(async () => []),
  reconcileEntityTagConcepts: jest.fn(async () => ({
    tags: [],
    concepts: [],
    conceptIds: [],
    addedConceptIds: [],
    removedConceptIds: [],
    conceptIdsChanged: false,
  })),
  reconcileConceptEntityCounts: jest.fn(async () => []),
  projectEntityTagConceptsToNeo4j: jest.fn(async () => ({ relationshipsCreated: 0, countReceipts: [] })),
}));
jest.mock('../../initiative-dependent-replay', () => ({
  loadDependentInitiativeIds: jest.fn(async () => []),
  buildInitiativeDependencyReplayEvent: jest.fn(),
}));
// The handler admin-loads the entity doc (no inline payload — M1/D2).
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockEntityFixture.current !== null,
          data: () => mockEntityFixture.current,
        })),
      })),
    })),
  },
}));
jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,

      execute: (data: unknown) =>
        handler({
          event: { data },
          step: { run: mockStepRun },
        }),
    })),
    send: jest.fn(),
  },
  safeSendEvent: jest.fn(),
}));

import * as queryCache from '@/lib/graph/query-cache';
import * as embeddingSync from '@/lib/graph/embedding-sync';
import {
  captureEntityTagConceptIdsFromNeo4j,
  reconcileConceptEntityCounts,
} from '@/lib/graph/entity-tag-concept-projection';
import { loadSignalProjectionDecision } from '@/lib/graph/signal-projection-policy-admin';
import { deleteEntityFromGraph } from '@/lib/graph';
import { syncUnifiedEntityToNeo4jJob } from '../sync-entity-to-neo4j';

const mockedInvalidate = queryCache.invalidateCachesForEntity as jest.Mock;
const mockedScheduleEmbed = embeddingSync.scheduleEntityEmbed as jest.Mock;
const mockLoadSignalProjectionDecision = loadSignalProjectionDecision as jest.Mock;

describe('syncUnifiedEntityToNeo4jJob — Signal projection eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (jest.requireMock('../../client').inngest.send as jest.Mock).mockResolvedValue({ ids: ['accepted'] });
    mockEntityFixture.current = { id: 'sig-policy', title: 'Policy fixture', status: 'Rejected' };
    mockLoadSignalProjectionDecision.mockResolvedValue({
      eligible: true,
      reason: 'approved-or-imported',
      references: [],
    });
  });

  it('removes an inbox-only Signal instead of writing graph noise', async () => {
    mockEntityFixture.current = {
      id: 'sig-policy',
      title: 'Policy fixture',
      status: 'Rejected',
      conceptIds: ['concept-derived', 'concept-shared'],
    };
    (captureEntityTagConceptIdsFromNeo4j as jest.Mock).mockResolvedValue([
      'concept-explicit',
      'concept-shared',
    ]);
    mockLoadSignalProjectionDecision.mockResolvedValue({
      eligible: false,
      reason: 'inbox-only',
      references: [],
    });

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'signal',
      entityId: 'sig-policy',
    });

    expect(result).toMatchObject({ success: true, skipped: 'projection-ineligible' });
    expect(captureEntityTagConceptIdsFromNeo4j).toHaveBeenCalledWith('sig-policy');
    expect(deleteEntityFromGraph).toHaveBeenCalledWith('sig-policy', 'signal');
    expect(reconcileConceptEntityCounts).toHaveBeenCalledWith([
      'concept-derived',
      'concept-shared',
      'concept-explicit',
    ]);
    expect(mockedInvalidate).toHaveBeenCalledWith('sig-policy');
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).not.toHaveBeenCalled();
  });

  it('restores the Signal before durably replaying references that raced a downgrade', async () => {
    const mockedSend = jest.requireMock('../../client').inngest.send as jest.Mock;
    mockedSend.mockResolvedValue({ ids: ['accepted'] });
    mockLoadSignalProjectionDecision
      .mockResolvedValueOnce({ eligible: false, reason: 'inbox-only', references: [] })
      .mockResolvedValueOnce({
        eligible: true,
        reason: 'reference-required',
        references: [
          { id: 'rel-race', kind: 'relation-endpoint' },
          { id: 'link-race', kind: 'document-link' },
        ],
      })
      .mockResolvedValueOnce({
        eligible: true,
        reason: 'reference-required',
        references: [
          { id: 'rel-race', kind: 'relation-endpoint' },
          { id: 'link-race', kind: 'document-link' },
        ],
      });

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'signal',
      entityId: 'sig-policy',
    });

    expect(result).toMatchObject({ success: true, referenceReplays: expect.any(Array) });
    expect(deleteEntityFromGraph).toHaveBeenCalledWith('sig-policy', 'signal');
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^signal-reference-replay:/),
      name: 'app/relation.sync.requested',
      data: { operation: 'update', relationId: 'rel-race' },
    }));
    expect(mockedSend).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^signal-reference-replay:/),
      name: 'app/entity-document-link.sync.requested',
      data: { operation: 'update', linkId: 'link-race' },
    }));
  });

  it('fails retryably at the exact unaccepted reference after restoring the Signal', async () => {
    const mockedSend = jest.requireMock('../../client').inngest.send as jest.Mock;
    mockedSend.mockResolvedValueOnce({ ids: ['accepted'] }).mockResolvedValueOnce({ ids: [] });
    mockLoadSignalProjectionDecision
      .mockResolvedValueOnce({ eligible: false, reason: 'inbox-only', references: [] })
      .mockResolvedValueOnce({
        eligible: true,
        reason: 'reference-required',
        references: [
          { id: 'rel-race', kind: 'relation-endpoint' },
          { id: 'link-race', kind: 'document-link' },
        ],
      })
      .mockResolvedValueOnce({
        eligible: true,
        reason: 'reference-required',
        references: [
          { id: 'rel-race', kind: 'relation-endpoint' },
          { id: 'link-race', kind: 'document-link' },
        ],
      });

    await expect(
      (syncUnifiedEntityToNeo4jJob as any).execute({
        operation: 'update',
        entityType: 'signal',
        entityId: 'sig-policy',
      })
    ).rejects.toThrow('accepted no document-link replay');
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledTimes(2);
  });

  it('retains a rejected Signal required by a relation endpoint', async () => {
    mockLoadSignalProjectionDecision.mockResolvedValue({
      eligible: true,
      reason: 'reference-required',
      references: [{ id: 'rel-1', kind: 'relation-endpoint' }],
    });

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'signal',
      entityId: 'sig-policy',
    });

    expect(result.success).toBe(true);
    expect(deleteEntityFromGraph).not.toHaveBeenCalled();
    expect(jest.requireMock('@/lib/graph').runWriteTransaction).toHaveBeenCalled();
    expect(jest.requireMock('../../client').inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^signal-reference-replay:/),
        name: 'app/relation.sync.requested',
        data: { operation: 'update', relationId: 'rel-1' },
      })
    );
  });
});

describe('syncUnifiedEntityToNeo4jJob — cache invalidation (M6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntityFixture.current = null;
  });

  it('invalidates the query caches for the entity after a successful upsert', async () => {
    mockEntityFixture.current = { id: 'comp-1', name: 'Acme' };

    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'company',
      entityId: 'comp-1',
    });

    expect(r.success).toBe(true);
    expect(mockedInvalidate).toHaveBeenCalledWith('comp-1');
  });

  it('invalidates the query caches after a delete', async () => {
    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'delete',
      entityType: 'company',
      entityId: 'comp-9',
    });

    expect(r.success).toBe(true);
    expect(mockedInvalidate).toHaveBeenCalledWith('comp-9');
    expect(deleteEntityFromGraph).toHaveBeenCalledWith('comp-9', 'company');
  });

  it('cache invalidation failures never fail the sync (fire-and-forget)', async () => {
    mockEntityFixture.current = { id: 'comp-2', name: 'Boom Inc' };
    mockedInvalidate.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'company',
      entityId: 'comp-2',
    });

    expect(r.success).toBe(true);
  });

  it('skips entity types that have dedicated sync functions without touching the cache', async () => {
    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'technology',
      entityId: 'tech-1',
    });

    expect(r.skipped).toBe(true);
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });
});

describe('syncUnifiedEntityToNeo4jJob — incremental entity embedding (P5-C)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntityFixture.current = null;
  });

  it('schedules an embedding refresh for a Company after a successful upsert', async () => {
    mockEntityFixture.current = {
      id: 'comp-1',
      name: 'Acme',
      description: 'Industrial-grade anvils and rocket skates for the discerning coyote.',
    };

    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'company',
      entityId: 'comp-1',
    });

    expect(r.success).toBe(true);
    expect(mockedScheduleEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'comp-1',
        label: 'Company',
        name: 'Acme',
        description: 'Industrial-grade anvils and rocket skates for the discerning coyote.',
      })
    );
  });

  it('schedules an embedding refresh for a Signal (title-based name) after create', async () => {
    mockEntityFixture.current = {
      id: 'sig-1',
      title: 'K8s adoption spike',
      description: 'Multiple enterprise platform teams announced Kubernetes migrations this quarter.',
    };

    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'create',
      entityType: 'signal',
      entityId: 'sig-1',
    });

    expect(r.success).toBe(true);
    expect(mockedScheduleEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'sig-1', label: 'Signal', name: 'K8s adoption spike' })
    );
  });

  it('does not schedule embedding for non-embeddable labels (strategy)', async () => {
    mockEntityFixture.current = { id: 'strat-1', name: 'Cloud First', description: 'x'.repeat(80) };

    await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'strategy',
      entityId: 'strat-1',
    });

    expect(mockedScheduleEmbed).not.toHaveBeenCalled();
  });

  it('does not schedule embedding on delete', async () => {
    await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'delete',
      entityType: 'company',
      entityId: 'comp-9',
    });

    expect(mockedScheduleEmbed).not.toHaveBeenCalled();
  });

  it('embedding scheduling problems never fail the sync (fire-and-forget)', async () => {
    mockEntityFixture.current = { id: 'comp-2', name: 'Boom Inc', description: 'x'.repeat(80) };
    mockedScheduleEmbed.mockImplementation(() => {
      throw new Error('embed scheduling exploded');
    });

    const r = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'company',
      entityId: 'comp-2',
    });

    expect(r.success).toBe(true);
  });
});

describe('syncUnifiedEntityToNeo4jJob — implicit-edge drift prune', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntityFixture.current = null;
  });

  // Implicit/structural edges (CHILD_OF/OWNED_BY/AFFECTS/LINKED_TO/RELATES_TO/…)
  // are re-derived from entity fields on every sync via MERGE. Without a prune,
  // changing an Initiative's owner (or removing an item from a linked array)
  // leaves the OLD edge forever — the sync accumulates stale edges on UPDATE.
  // Fix: delete the entity's implicit edges (relationId IS NULL = not a
  // contract-managed relation, so curated edges are preserved) before rebuild.
  it('prunes the entity’s implicit edges (relationId IS NULL) before rebuilding', async () => {
    mockEntityFixture.current = { id: 'init-1', name: 'Migrate DB', ownerOrgUnitId: 'ou-1' };
    const graph = jest.requireMock('@/lib/graph');

    await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'initiative',
      entityId: 'init-1',
    });

    const calls = (graph.runWriteTransaction as jest.Mock).mock.calls as Array<[string, Record<string, unknown>]>;
    const prune = calls.find(([q]) => /DELETE\s+r/.test(q) && /r\.relationId IS NULL/.test(q));

    expect(prune).toBeDefined();
    expect(prune?.[1]).toMatchObject({ entityId: 'init-1' });
  });

  it('does not prune on delete (the node is DETACH DELETEd wholesale)', async () => {
    const graph = jest.requireMock('@/lib/graph');

    await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'delete',
      entityType: 'initiative',
      entityId: 'init-9',
    });

    const calls = (graph.runWriteTransaction as jest.Mock).mock.calls as Array<[string, Record<string, unknown>]>;
    const prune = calls.find(([q]) => /DELETE\s+r/.test(q) && /r\.relationId IS NULL/.test(q));
    expect(prune).toBeUndefined();
  });
});

describe('syncUnifiedEntityToNeo4jJob — GRAPH-048 entity-created verification dispatch', () => {
  const send = jest.requireMock('../../client').inngest.send as jest.Mock;

  const verificationSends = () =>
    send.mock.calls.filter(([evt]) => evt?.name === 'app/entity.verification.requested');

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue({ ids: ['accepted'] });
    mockEntityFixture.current = { id: 'comp-1', name: 'Acme Corp', slug: 'acme-corp' };
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('fires exactly one verification event with a deterministic id when enabled and creating', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'create',
      entityType: 'company',
      entityId: 'comp-1',
    });

    expect(result.success).toBe(true);
    const sends = verificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toMatchObject({
      name: 'app/entity.verification.requested',
      data: { entityId: 'comp-1', entityType: 'company' },
    });
    expect(sends[0][0].id).toMatch(/^entity-create-verification:[0-9a-f]{64}$/);
    const stepNames = mockStepRun.mock.calls.map(([name]) => name);
    expect(stepNames.indexOf('dispatch-entity-verification')).toBeLessThan(stepNames.indexOf('send-completion'));
  });

  it('fires zero verification events when the Defense Minister flag is absent', async () => {
    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'create',
      entityType: 'company',
      entityId: 'comp-1',
    });

    expect(result.success).toBe(true);
    expect(verificationSends()).toHaveLength(0);
  });

  it('fires zero verification events for update operations even when enabled', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'update',
      entityType: 'company',
      entityId: 'comp-1',
    });

    expect(result.success).toBe(true);
    expect(verificationSends()).toHaveLength(0);
  });

  it('fires zero verification events for unsupported internal entity types', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    mockEntityFixture.current = { id: 'strategy-1', title: 'Internal strategy' };

    const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
      operation: 'create',
      entityType: 'strategy',
      entityId: 'strategy-1',
    });

    expect(result.success).toBe(true);
    expect(verificationSends()).toHaveLength(0);
    expect(mockStepRun.mock.calls.map(([name]) => name)).not.toContain('dispatch-entity-verification');
  });

  it('fails the attempt when the verification send is rejected', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    send.mockImplementation((evt: { name?: string }) =>
      evt?.name === 'app/entity.verification.requested'
        ? Promise.reject(new Error('inngest down'))
        : Promise.resolve({ ids: ['accepted'] })
    );

    await expect(
      (syncUnifiedEntityToNeo4jJob as any).execute({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
      })
    ).rejects.toThrow('inngest down');
    expect(send.mock.calls.some(([event]) => event?.name === 'app/entity.sync.completed')).toBe(false);
  });

  it('fails the attempt when Inngest acknowledges no verification event', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    send.mockImplementation((evt: { name?: string }) =>
      Promise.resolve({ ids: evt?.name === 'app/entity.verification.requested' ? [] : ['accepted'] })
    );

    await expect(
      (syncUnifiedEntityToNeo4jJob as any).execute({
        operation: 'create',
        entityType: 'company',
        entityId: 'comp-1',
      })
    ).rejects.toThrow('Inngest accepted no entity verification event for comp-1');
    expect(send.mock.calls.some(([event]) => event?.name === 'app/entity.sync.completed')).toBe(false);
  });
});
