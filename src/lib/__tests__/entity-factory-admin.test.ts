/**
 * @jest-environment node
 *
 * Tests for entity-factory-admin — the admin-SDK twin of createEntity.
 * Focused on the graph-sync event payloads: the technology sync handler
 * (sync-technology-to-neo4j.ts) destructures `technologyId` from the event
 * data, while the unified handler expects `entityId` (see entity-sync.ts).
 * These tests pin the payload field per entity type.
 */

// Make this file a module so the `mock*` consts are module-scoped (the
// module under test is pulled in via `require` — see the TDZ note below).
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// The admin factory must not cross into the Firebase client runtime.
jest.mock('@/lib/firebase', () => {
  throw new Error('entity-factory-admin must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('entity-factory-admin must not import firebase/firestore');
});

const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['mock-id'] });
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: mockInngestSend } }));
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: mockInngestSend } }));

// Admin-SDK mock: reads-before-writes transaction with an empty uniqueness
// query result (no existing entity → create path).
const mockTxGet = jest.fn();
const mockTxSet = jest.fn();
// Query-path (where().limit().get()) and doc-path (doc().update()) mocks, exposed
// module-scoped so adminGetEntityByField / adminUpdateEntity can be inspected.
const mockQueryGet = jest.fn();
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => {
      const ref: Record<string, jest.Mock> = {
        doc: jest.fn(() => ({
          set: jest.fn().mockResolvedValue(undefined),
          get: jest.fn(),
          update: jest.fn((...a: unknown[]) => mockDocUpdate(...a)),
          delete: jest.fn(),
        })),
      };
      ref.where = jest.fn(() => ref);
      ref.limit = jest.fn(() => ref);
      ref.get = jest.fn((...a: unknown[]) => mockQueryGet(...a));
      return ref;
    }),
    runTransaction: jest.fn(
      async (callback: (tx: { get: jest.Mock; set: jest.Mock; update: jest.Mock }) => Promise<unknown>) =>
        callback({ get: mockTxGet, set: mockTxSet, update: jest.fn() })
    ),
  },
}));

// `require` (not `import`) so the jest.mock factories above can reference the
// `mock*` consts without a TDZ crash (see document-refresh-admin.test.ts).
const { adminCreateEntity, adminGetEntityByField, adminUpdateEntity } = require('../entity-factory-admin');

describe('entity-factory-admin graph sync payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });
    mockTxGet.mockResolvedValue({ empty: true, docs: [] });
    mockQueryGet.mockResolvedValue({ empty: true, docs: [] });
    mockDocUpdate.mockResolvedValue(undefined);
  });

  it('sends app/technology.sync.requested keyed by technologyId for technologies', async () => {
    const result = await adminCreateEntity('technology', { name: 'Admin Sync Tech', description: 'test' });

    const call = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/technology.sync.requested'
    );
    expect(call).toBeDefined();
    expect(call?.[0].data).toMatchObject({
      technologyId: result.entity.id,
      entityType: 'technology',
      operation: 'create',
    });
    expect(call?.[0].data.entityId).toBeUndefined();
  });

  it('uses exactly one required server handoff after an admin create', async () => {
    const result = await adminCreateEntity('company', { name: 'Required Admin Company' }, { graphSync: 'required' });

    const syncCalls = mockInngestSend.mock.calls.filter(
      ([event]: [{ name: string }]) => event?.name === 'app/unified-entity.sync.requested'
    );
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0][0]).toEqual({
      name: 'app/unified-entity.sync.requested',
      data: {
        entityId: result.entity.id,
        entityType: 'company',
        operation: 'create',
      },
    });
  });

  it('sends no direct verification event even when Defense Minister is enabled (GRAPH-048)', async () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    try {
      await adminCreateEntity('company', { name: 'Admin Verify Move Test' });

      const verificationCalls = mockInngestSend.mock.calls.filter(
        ([event]: [{ name: string }]) => event?.name === 'app/entity.verification.requested'
      );
      // GRAPH-048: entity-created verification dispatches from the sync
      // workers (post graph-commit), not from the factory. The sync event
      // below is what carries the create to that boundary.
      expect(verificationCalls).toHaveLength(0);
      const syncCalls = mockInngestSend.mock.calls.filter(
        ([event]: [{ name: string }]) => event?.name === 'app/unified-entity.sync.requested'
      );
      expect(syncCalls).toHaveLength(1);
    } finally {
      delete process.env.DEFENSE_MINISTER_ENABLED;
    }
  });

  it('sends app/unified-entity.sync.requested keyed by entityId for other entity types', async () => {
    const result = await adminCreateEntity('company', { name: 'Admin Sync Co', description: 'test' });

    const call = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/unified-entity.sync.requested'
    );
    expect(call).toBeDefined();
    expect(call?.[0].data).toMatchObject({
      entityId: result.entity.id,
      entityType: 'company',
      operation: 'create',
    });
    expect(call?.[0].data.technologyId).toBeUndefined();
  });

  it('skipUniquenessCheck path also keys technology sync by technologyId', async () => {
    const result = await adminCreateEntity(
      'technology',
      { name: 'Admin Sync Tech Skip', description: 'test' },
      { skipUniquenessCheck: true }
    );

    const call = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/technology.sync.requested'
    );
    expect(call).toBeDefined();
    expect(call?.[0].data).toMatchObject({
      technologyId: result.entity.id,
      entityType: 'technology',
      operation: 'create',
    });
    expect(call?.[0].data.entityId).toBeUndefined();
  });
});

describe('adminGetEntityByField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryGet.mockResolvedValue({ empty: true, docs: [] });
  });

  it('returns null when no entity matches the field', async () => {
    mockQueryGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const result = await adminGetEntityByField('prototype', 'missionId', 'm-none');
    expect(result).toBeNull();
  });

  it('returns the matched doc merged with its id when one exists', async () => {
    mockQueryGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'proto-xyz', data: () => ({ name: 'Built thing', missionId: 'm-1' }) }],
    });
    const result = await adminGetEntityByField('prototype', 'missionId', 'm-1');
    expect(result).toEqual({ id: 'proto-xyz', name: 'Built thing', missionId: 'm-1' });
  });

  it('throws for an unknown entity type', async () => {
    await expect(adminGetEntityByField('nope', 'missionId', 'm-1')).rejects.toThrow();
  });
});

describe('adminUpdateEntity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInngestSend.mockResolvedValue({ ids: ['mock-id'] });
    mockDocUpdate.mockResolvedValue(undefined);
  });

  it('refreshes updatedAt + re-derives slug, and never rewrites id/createdAt', async () => {
    await adminUpdateEntity('prototype', 'proto-1', {
      id: 'IGNORED',
      createdAt: 111,
      name: 'Renamed Prototype',
      missionId: 'm-1',
    });

    expect(mockDocUpdate).toHaveBeenCalledTimes(1);
    const payload = mockDocUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ name: 'Renamed Prototype', missionId: 'm-1', slug: 'renamed-prototype' });
    expect(typeof payload.updatedAt).toBe('number');
    expect(payload.id).toBeUndefined();
    expect(payload.createdAt).toBeUndefined();
  });

  it('fires an update graph-sync event after the write', async () => {
    await adminUpdateEntity('company', 'co-1', { name: 'Acme', missionId: 'm-1' });

    const call = mockInngestSend.mock.calls.find(
      ([event]: [{ name: string }]) => event?.name === 'app/unified-entity.sync.requested'
    );
    expect(call?.[0].data).toMatchObject({ entityId: 'co-1', entityType: 'company', operation: 'update' });
  });

  it('throws for an unknown entity type', async () => {
    await expect(adminUpdateEntity('nope', 'x', { name: 'y' })).rejects.toThrow();
  });
});
