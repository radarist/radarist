/**
 * @jest-environment node
 *
 * Tests for technology-admin's cascade delete graph-sync events.
 *
 * The dedicated placement sync function (`sync-placement-to-neo4j.ts`) only
 * listens to `app/radar-placement.sync.requested`, and the unified handler
 * explicitly SKIPS `radarPlacement` — so the technology cascade delete must
 * emit the dedicated event per deleted placement or Neo4j keeps orphan
 * placement nodes. These tests pin the emitted event names + payloads.
 */

// Make this file a module so the `mock*` consts are module-scoped (the
// module under test is pulled in via `require` — see the TDZ note below).
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['mock-id'] });
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: mockInngestSend } }));
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: mockInngestSend } }));
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  recordEntityGraphSyncAnchor: jest.fn().mockResolvedValue({}),
}));

const mockAdminDeleteRelationsForEntity = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: mockAdminDeleteRelationsForEntity,
}));

const mockAdminDeleteLinksForEntity = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminDeleteLinksForEntity: mockAdminDeleteLinksForEntity,
}));

const mockGraphHealthy = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/graph/neo4j-graph-service', () => ({
  getNeo4jGraphService: () => ({ isHealthy: mockGraphHealthy }),
}));

const mockDeleteEntityFromGraph = jest.fn().mockResolvedValue({ endpointsDeleted: 1 });
jest.mock('@/lib/graph/assertions', () => ({
  deleteEntityFromGraph: mockDeleteEntityFromGraph,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: jest.fn(() => '__name__') },
  FieldValue: { arrayRemove: jest.fn((value: string) => ({ _arrayRemove: value })) },
}));

// Admin-SDK mock with per-collection `.where(...).get()` routing:
// - radarPlacements → placements for the technology being deleted
// - relations → relation-cleanup queries per placement
// - technologies → doc-level get/delete for the technology itself
const mockCollectionGet: Record<string, jest.Mock> = {
  radarPlacements: jest.fn(),
  relations: jest.fn(),
  prototypes: jest.fn(),
  'use-cases': jest.fn(),
  painPoints: jest.fn(),
};
const mockDocGet = jest.fn();
const mockDocDelete = jest.fn().mockResolvedValue(undefined);
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);
// GRAPH-066 #3 — the technology cascade now runs inside a parent-deletion lease,
// which `set`s a lease document up front and `delete`s it afterwards. Its writes
// get their OWN mocks so the source-document delete assertions below keep
// counting only real entity deletes.
const mockLeaseSet = jest.fn().mockResolvedValue(undefined);
const mockLeaseDelete = jest.fn().mockResolvedValue(undefined);
const mockDocRef = jest.fn();
const LEASE_COLLECTION = 'placementParentDeletionLeases';
const mockTransactionGet = jest.fn();
const mockTransactionSet = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);
const mockAdminWhere = jest.fn();
const mockAdminOrderBy = jest.fn();
const mockAdminLimit = jest.fn();
const mockAdminStartAfter = jest.fn();
const mockBatchSet = jest.fn();
const mockDbBatch = jest.fn(() => ({
  delete: mockBatchDelete,
  update: mockBatchUpdate,
  set: mockBatchSet,
  commit: mockBatchCommit,
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((name: string) => {
      const ref: Record<string, unknown> = {
        doc: jest.fn((id: string) => {
          mockDocRef(name, id);
          return name === LEASE_COLLECTION
            ? { id, get: mockDocGet, set: mockLeaseSet, delete: mockLeaseDelete }
            : { id, get: mockDocGet, delete: mockDocDelete, update: mockDocUpdate };
        }),
        get: () => (mockCollectionGet[name] ? mockCollectionGet[name]() : Promise.resolve({ empty: true, docs: [] })),
      };
      ref.where = jest.fn((...args: unknown[]) => {
        mockAdminWhere(name, ...args);
        return ref;
      });
      ref.limit = jest.fn((...args: unknown[]) => {
        mockAdminLimit(name, ...args);
        return ref;
      });
      ref.orderBy = jest.fn((...args: unknown[]) => {
        mockAdminOrderBy(name, ...args);
        return ref;
      });
      ref.startAfter = jest.fn((...args: unknown[]) => {
        mockAdminStartAfter(name, ...args);
        return ref;
      });
      return ref;
    }),
    batch: mockDbBatch,
    // GRAPH-066 #3 — the placement cascade pre-reads pair locks (CAS). Not owning
    // here, so locks aren't deleted; the delete events still fire (asserted below).
    getAll: jest.fn(async (...refs: unknown[]) => refs.map(() => ({ exists: false, data: () => undefined }))),
    runTransaction: jest.fn(
      async (callback: (transaction: { get: jest.Mock; set: jest.Mock; update: jest.Mock }) => Promise<unknown>) =>
        callback({ get: mockTransactionGet, set: mockTransactionSet, update: mockTransactionUpdate })
    ),
  },
}));

// `require` (not `import`) so the jest.mock factories above can reference the
// `mock*` consts without a TDZ crash (see document-refresh-admin.test.ts).
const {
  adminCreateTechnology,
  adminDeleteTechnologyCompletely,
  adminDeleteTechnologyWithPlacements,
  adminDeleteTechnologiesCompletely,
} = require('../technology-admin');
const { recordEntityGraphSyncAnchor: mockRecordEntityGraphSyncAnchor } = jest.requireMock(
  '@/lib/entity-graph-sync-outbox-admin'
) as { recordEntityGraphSyncAnchor: jest.Mock };

/** Flush the floating `void fireTechnologySync(...)` promise. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('technology-admin cascade delete sync events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });
    mockBatchCommit.mockResolvedValue(undefined);
    mockDocDelete.mockResolvedValue(undefined);
    mockDocUpdate.mockResolvedValue(undefined);
    mockTransactionGet.mockResolvedValue({ empty: true, docs: [] });
    mockRecordEntityGraphSyncAnchor.mockResolvedValue({});
    mockAdminDeleteRelationsForEntity.mockResolvedValue(0);
    mockAdminDeleteLinksForEntity.mockResolvedValue(0);
    mockGraphHealthy.mockResolvedValue(true);
    mockDeleteEntityFromGraph.mockResolvedValue({ endpointsDeleted: 1 });
    mockCollectionGet.prototypes.mockResolvedValue({ empty: true, docs: [] });
    mockCollectionGet['use-cases'].mockResolvedValue({ empty: true, docs: [] });
    mockCollectionGet.painPoints.mockResolvedValue({ empty: true, docs: [] });
    // No relations attached to the placements.
    mockCollectionGet.relations.mockResolvedValue({ empty: true, docs: [] });
    // Technology doc exists.
    mockDocGet.mockResolvedValue({ exists: true, id: 'tech-1', data: () => ({ name: 'Tech One' }) });
  });

  it('anchors an unacknowledged Technology create without rejecting the committed entity', async () => {
    mockInngestSend.mockResolvedValueOnce({ ids: [] });

    await expect(
      adminCreateTechnology({
        name: 'Durable Technology',
        slug: 'durable-technology',
        description: 'Created before the queue acknowledgement failed',
        category: 'framework',
        tags: ['durability'],
        createdBy: 'user-1',
      })
    ).resolves.toMatchObject({ name: 'Durable Technology' });

    expect(mockTransactionSet).toHaveBeenCalledTimes(1);
    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'technology', operation: 'create' })
    );
  });

  it('exports the complete single-technology cascade for server callers', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });

    const result = await adminDeleteTechnologyCompletely('tech-1');

    expect(result).toMatchObject({
      success: true,
      placementsDeleted: 0,
      relationsDeleted: 0,
      neo4jDeleted: true,
    });
    expect(mockDocDelete).toHaveBeenCalledTimes(1);
    expect(mockDocDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteEntityFromGraph.mock.invocationCallOrder[0]
    );
  });

  it('uses the typed graph deletion contract for a complete technology delete', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result.succeeded).toBe(1);
    expect(mockDeleteEntityFromGraph).toHaveBeenCalledWith('tech-1', 'technology');
    expect(mockDocDelete).toHaveBeenCalled();
    expect(mockDocDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteEntityFromGraph.mock.invocationCallOrder[0]
    );
  });

  it('does not fast-delete Neo4j when the final admin source delete fails', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockDocDelete.mockRejectedValueOnce(new Error('source delete failed'));

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toEqual(['tech-1']);
    expect(mockDeleteEntityFromGraph).not.toHaveBeenCalled();
  });

  it('emits app/radar-placement.sync.requested with a delete payload per deleted placement', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({
      empty: false,
      docs: [
        { id: 'placement-a', data: () => ({ radarId: 'radar-1', technologyId: 'tech-1' }) },
        { id: 'placement-b', data: () => ({ radarId: 'radar-2', technologyId: 'tech-1' }) },
      ],
    });

    const placementsDeleted = await adminDeleteTechnologyWithPlacements('tech-1');
    expect(placementsDeleted).toBe(2);
    expect(mockAdminDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-1');

    // GRAPH-066 #8 — the lock-aware cascade emits a delete event per placement
    // (now carrying a durable deleteToken) via the dedicated handler.
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/radar-placement.sync.requested',
        data: expect.objectContaining({ placementId: 'placement-a', operation: 'delete' }),
      })
    );
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/radar-placement.sync.requested',
        data: expect.objectContaining({ placementId: 'placement-b', operation: 'delete' }),
      })
    );
    // Each placement delete now carries a durable delete token.
    const placementDeletes = mockInngestSend.mock.calls.filter(
      ([event]: [{ name: string }]) => event?.name === 'app/radar-placement.sync.requested'
    );
    expect(
      placementDeletes.every(([event]: [{ data: { deleteToken?: string } }]) => Boolean(event.data.deleteToken))
    ).toBe(true);

    // The unified handler skips radarPlacement — the cascade must never route
    // placement deletes through it.
    const unifiedCalls = mockInngestSend.mock.calls.filter(
      ([event]: [{ name: string }]) => event?.name === 'app/unified-entity.sync.requested'
    );
    expect(unifiedCalls).toHaveLength(0);
  });

  it('emits the dedicated technology delete sync keyed by technologyId', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({
      empty: false,
      docs: [{ id: 'placement-a', data: () => ({ radarId: 'radar-1', technologyId: 'tech-1' }) }],
    });

    await adminDeleteTechnologyWithPlacements('tech-1');
    await flushMicrotasks();

    const techCall = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/technology.sync.requested'
    );
    expect(techCall).toBeDefined();
    expect(techCall?.[0].data).toMatchObject({
      technologyId: 'tech-1',
      entityType: 'technology',
      operation: 'delete',
    });
  });

  it('emits no placement sync events when the technology has no placements', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });

    const placementsDeleted = await adminDeleteTechnologyWithPlacements('tech-1');
    await flushMicrotasks();

    expect(placementsDeleted).toBe(0);
    const placementCalls = mockInngestSend.mock.calls.filter(
      ([event]: [{ name: string }]) => event?.name === 'app/radar-placement.sync.requested'
    );
    expect(placementCalls).toHaveLength(0);
  });

  it('does not mutate placements or the source when technology graph handoff fails', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('handoff failed'));

    await expect(adminDeleteTechnologyWithPlacements('tech-1')).rejects.toThrow('handoff failed');

    expect(mockCollectionGet.radarPlacements).not.toHaveBeenCalled();
    expect(mockDocDelete).not.toHaveBeenCalled();
    expect(mockBatchDelete).not.toHaveBeenCalled();
  });

  it('retains the source when link cleanup fails after placement cleanup', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockAdminDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

    await expect(adminDeleteTechnologyWithPlacements('tech-1')).rejects.toThrow('link cleanup failed');

    expect(mockAdminDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-1');
    expect(mockDocDelete).not.toHaveBeenCalled();
  });

  it('removes Prototype, Use Case, and Pain Point reverse references before the source', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockCollectionGet.prototypes.mockResolvedValue({
      empty: false,
      docs: [{ id: 'proto-1', ref: 'proto-ref-1' }],
    });
    mockCollectionGet['use-cases'].mockResolvedValue({
      empty: false,
      docs: [{ id: 'use-case-1', ref: 'use-case-ref-1' }],
    });
    mockCollectionGet.painPoints.mockResolvedValue({
      empty: false,
      docs: [{ id: 'pain-1', ref: 'pain-ref-1' }],
    });

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result.succeeded).toBe(1);
    expect(mockAdminWhere).toHaveBeenCalledWith('prototypes', 'linkedTechnologies', 'array-contains', 'tech-1');
    expect(mockAdminWhere).toHaveBeenCalledWith('use-cases', 'radarTechnologyIds', 'array-contains', 'tech-1');
    expect(mockAdminWhere).toHaveBeenCalledWith('painPoints', 'linkedTechnologyIds', 'array-contains', 'tech-1');
    expect(mockBatchUpdate).toHaveBeenCalledWith('proto-ref-1', {
      linkedTechnologies: { _arrayRemove: 'tech-1' },
    });
    expect(mockBatchUpdate).toHaveBeenCalledWith('use-case-ref-1', {
      radarTechnologyIds: { _arrayRemove: 'tech-1' },
    });
    expect(mockBatchUpdate).toHaveBeenCalledWith('pain-ref-1', {
      linkedTechnologyIds: { _arrayRemove: 'tech-1' },
    });
    expect(mockBatchCommit.mock.invocationCallOrder.at(-1)).toBeLessThan(mockDocDelete.mock.invocationCallOrder[0]);
  });

  it('preflights all reverse-reference reads before writes and retains the source on query failure', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockCollectionGet.prototypes.mockResolvedValue({
      empty: false,
      docs: [{ id: 'proto-1', ref: 'proto-ref-1' }],
    });
    mockCollectionGet.painPoints.mockRejectedValueOnce(new Error('pain-point query failed'));

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result).toMatchObject({ succeeded: 0, failed: ['tech-1'] });
    expect(mockBatchUpdate).not.toHaveBeenCalled();
    expect(mockDocDelete).not.toHaveBeenCalled();
  });

  it('chunks reverse-reference writes below 500 and uses a document cursor', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    const firstPage = Array.from({ length: 450 }, (_, index) => ({
      id: `proto-${index}`,
      ref: `proto-ref-${index}`,
    }));
    mockCollectionGet.prototypes
      .mockResolvedValueOnce({ empty: false, docs: firstPage })
      .mockResolvedValueOnce({ empty: false, docs: [{ id: 'proto-450', ref: 'proto-ref-450' }] });

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result.succeeded).toBe(1);
    expect(mockBatchUpdate).toHaveBeenCalledTimes(451);
    expect(mockDbBatch).toHaveBeenCalledTimes(2);
    expect(mockAdminStartAfter).toHaveBeenCalledWith('prototypes', firstPage[449]);
  });

  it('retains the source when a reverse-reference batch commit fails and converges on retry', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockCollectionGet.prototypes.mockResolvedValue({
      empty: false,
      docs: [{ id: 'proto-1', ref: 'proto-ref-1' }],
    });
    mockBatchCommit.mockRejectedValueOnce(new Error('reference write failed'));

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result).toMatchObject({ succeeded: 0, failed: ['tech-1'] });
    expect(mockDocDelete).not.toHaveBeenCalled();

    const retry = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(retry).toMatchObject({ succeeded: 1, failed: [] });
    expect(mockDocDelete).toHaveBeenCalledTimes(1);
  });

  it('retains the source when the entity-document link cascade fails', async () => {
    mockCollectionGet.radarPlacements.mockResolvedValue({ empty: true, docs: [] });
    mockAdminDeleteLinksForEntity.mockRejectedValueOnce(new Error('link graph handoff failed'));

    const result = await adminDeleteTechnologiesCompletely(['tech-1']);

    expect(result).toMatchObject({ succeeded: 0, failed: ['tech-1'] });
    expect(mockAdminDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-1');
    expect(mockDocDelete).not.toHaveBeenCalled();
  });
});
