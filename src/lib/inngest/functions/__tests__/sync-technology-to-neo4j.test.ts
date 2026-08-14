/**
 * @file sync-technology-to-neo4j.test.ts
 * @description Tests for the Technology sync job's incremental embedding wire
 * (P5-C): after a successful node upsert the handler must schedule a
 * fire-and-forget embedding refresh (key-guarded inside scheduleEntityEmbed),
 * and that scheduling must NEVER fail the sync.
 */

const mockTechFixture: { current: Record<string, unknown> | null } = { current: null };
const mockStepRun = jest.fn(async (_name: string, fn: () => unknown) => fn());

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(async () => ({ healthy: true })),
  deleteEntityFromGraph: jest.fn(async () => ({
    assertionsDeleted: 0,
    evidenceDeleted: 0,
    projectionsDeleted: 0,
    chunksDeleted: 0,
    endpointsDeleted: 1,
  })),
  runWriteTransaction: jest.fn(async () => ({
    records: [],
    summary: { counters: { relationshipsCreated: 0 } },
  })),
  runReadTransaction: jest.fn(async () => ({ records: [] })),
}));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: true, dimensions: 768 })),
}));
jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
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
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockTechFixture.current !== null,
          data: () => mockTechFixture.current,
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

import * as embeddingSync from '@/lib/graph/embedding-sync';
import * as queryCache from '@/lib/graph/query-cache';
import { deleteEntityFromGraph, runWriteTransaction } from '@/lib/graph';
import { syncTechnologyToNeo4jJob } from '../sync-technology-to-neo4j';

const mockedScheduleEmbed = embeddingSync.scheduleEntityEmbed as jest.Mock;
const mockedInvalidate = queryCache.invalidateCachesForEntity as jest.Mock;
const mockedRunWriteTransaction = runWriteTransaction as jest.Mock;

describe('syncTechnologyToNeo4jJob — incremental entity embedding (P5-C)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTechFixture.current = null;
  });

  it('schedules an embedding refresh after a successful technology upsert', async () => {
    mockTechFixture.current = {
      id: 'tech-1',
      name: 'Kubernetes',
      slug: 'kubernetes',
      description: 'Container orchestration platform for deploying and managing containers at scale.',
      createdBy: 'user-1',
    };

    const r = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-1',
    });

    expect(r.success).toBe(true);
    expect(mockedScheduleEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'tech-1',
        label: 'Technology',
        name: 'Kubernetes',
        description: 'Container orchestration platform for deploying and managing containers at scale.',
      })
    );
  });

  it('invalidates the query caches for the technology after a successful upsert (M6)', async () => {
    mockTechFixture.current = {
      id: 'tech-1',
      name: 'Kubernetes',
      slug: 'kubernetes',
      description: 'Container orchestration platform.',
      createdBy: 'user-1',
    };

    const r = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-1',
    });

    expect(r.success).toBe(true);
    // Without this, neighbor/path/business cache entries for the technology
    // stay stale after a property-only update until TTL/reconcile.
    expect(mockedInvalidate).toHaveBeenCalledWith('tech-1');
  });

  it('prunes only implicit links and preserves relation/assertion-owned edges', async () => {
    mockTechFixture.current = {
      id: 'tech-1',
      name: 'Kubernetes',
      slug: 'kubernetes',
      description: 'Container orchestration platform.',
      createdBy: 'user-1',
      linkedCompanies: ['company-1'],
      linkedUseCases: ['use-case-1'],
    };

    await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-1',
    });

    const queries = mockedRunWriteTransaction.mock.calls.map(([query]) => String(query));
    const companyPrune = queries.find((query) => query.includes('[r:DEVELOPED_BY]'));
    const useCasePrune = queries.find((query) => query.includes('[r:ENABLES]'));

    expect(companyPrune).toContain('r.relationId IS NULL AND r.claimId IS NULL');
    expect(useCasePrune).toContain('r.relationId IS NULL AND r.claimId IS NULL');
  });

  it('does not schedule embedding on delete', async () => {
    mockTechFixture.current = null;

    const r = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'delete',
      technologyId: 'tech-9',
    });

    expect(r.success).toBe(true);
    expect(mockedScheduleEmbed).not.toHaveBeenCalled();
    expect(deleteEntityFromGraph).toHaveBeenCalledWith('tech-9', 'technology');
  });

  it('does not schedule embedding when the technology is missing (skip path)', async () => {
    mockTechFixture.current = null;

    const r = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-gone',
    });

    expect(r.skipped).toBe(true);
    expect(mockedScheduleEmbed).not.toHaveBeenCalled();
  });

  it('embedding scheduling problems never fail the sync (fire-and-forget)', async () => {
    mockTechFixture.current = {
      id: 'tech-2',
      name: 'Neo4j',
      slug: 'neo4j',
      description: 'Native graph database with the Cypher query language and vector index support.',
      createdBy: 'user-1',
    };
    mockedScheduleEmbed.mockImplementation(() => {
      throw new Error('embed scheduling exploded');
    });

    const r = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-2',
    });

    expect(r.success).toBe(true);
  });
});

describe('syncTechnologyToNeo4jJob — GRAPH-048 entity-created verification dispatch', () => {
  const send = jest.requireMock('../../client').inngest.send as jest.Mock;

  const verificationSends = () =>
    send.mock.calls.filter(([evt]) => evt?.name === 'app/entity.verification.requested');

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue({ ids: ['accepted'] });
    mockTechFixture.current = {
      id: 'tech-1',
      name: 'Kubernetes',
      slug: 'kubernetes',
      description: 'Container orchestration.',
      createdBy: 'user-1',
    };
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('fires exactly one verification event with a deterministic id when enabled and creating', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';

    const result = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'create',
      technologyId: 'tech-1',
    });

    expect(result.success).toBe(true);
    const sends = verificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0][0]).toMatchObject({
      name: 'app/entity.verification.requested',
      data: { entityId: 'tech-1', entityType: 'technology' },
    });
    expect(sends[0][0].id).toMatch(/^entity-create-verification:[0-9a-f]{64}$/);
    const stepNames = mockStepRun.mock.calls.map(([name]) => name);
    expect(stepNames.indexOf('dispatch-entity-verification')).toBeLessThan(stepNames.indexOf('send-completion'));
  });

  it('fires zero verification events when the Defense Minister flag is absent', async () => {
    const result = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'create',
      technologyId: 'tech-1',
    });

    expect(result.success).toBe(true);
    expect(verificationSends()).toHaveLength(0);
  });

  it('fires zero verification events for update operations even when enabled', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';

    const result = await (syncTechnologyToNeo4jJob as any).execute({
      operation: 'update',
      technologyId: 'tech-1',
    });

    expect(result.success).toBe(true);
    expect(verificationSends()).toHaveLength(0);
  });

  it('fails the attempt when the verification send is rejected', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    send.mockImplementation((evt: { name?: string }) =>
      evt?.name === 'app/entity.verification.requested'
        ? Promise.reject(new Error('inngest down'))
        : Promise.resolve({ ids: ['accepted'] })
    );

    await expect(
      (syncTechnologyToNeo4jJob as any).execute({
        operation: 'create',
        technologyId: 'tech-1',
      })
    ).rejects.toThrow('inngest down');
    expect(send.mock.calls.some(([event]) => event?.name === 'app/technology.sync.completed')).toBe(false);
  });

  it('fails the attempt when Inngest acknowledges no verification event', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    send.mockImplementation((evt: { name?: string }) =>
      Promise.resolve({ ids: evt?.name === 'app/entity.verification.requested' ? [] : ['accepted'] })
    );

    await expect(
      (syncTechnologyToNeo4jJob as any).execute({
        operation: 'create',
        technologyId: 'tech-1',
      })
    ).rejects.toThrow('Inngest accepted no entity verification event for tech-1');
    expect(send.mock.calls.some(([event]) => event?.name === 'app/technology.sync.completed')).toBe(false);
  });
});
