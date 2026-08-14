/** @jest-environment node */

export {};

jest.mock('server-only', () => ({}));

const mockDeleteDocument = jest.fn();
const mockUpdateDocument = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn();
const mockCollection = jest.fn((collectionName: string) => ({
  doc: jest.fn((id: string) => ({
    id,
    collectionName,
    delete: mockDeleteDocument,
    update: mockUpdateDocument,
  })),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: mockCollection,
    batch: jest.fn(() => ({ delete: mockBatchDelete, commit: mockBatchCommit })),
  },
}));

const mockDeleteLinks = jest.fn();
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminDeleteLinksForEntity: mockDeleteLinks,
}));

const mockDeleteNotes = jest.fn();
jest.mock('@/lib/entity-notes-cleanup-admin', () => ({
  adminDeleteAllEntityNotes: mockDeleteNotes,
}));

const mockDeleteRelations = jest.fn();
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: mockDeleteRelations,
}));

const mockRequestDeletion = jest.fn();
const mockRequestDeletions = jest.fn();
const mockBestEffortSync = jest.fn();
jest.mock('@/lib/entity-sync-server', () => ({
  requestEntityGraphDeletionServer: mockRequestDeletion,
  requestEntityGraphDeletionsServer: mockRequestDeletions,
  triggerEntityGraphSyncBestEffortServer: mockBestEffortSync,
}));

const mockPlanReferenceCleanup = jest.fn(async (entityType: string, entityId: string) => ({
  entityType,
  entityId,
  mutations: [],
}));
const mockPlanReferenceCleanups = jest.fn(
  async (
    entityType: string,
    entityIds: string[]
  ): Promise<{
    planned: Array<{ entityType: string; entityId: string; mutations: never[] }>;
    failed: Array<{ id: string; error: unknown }>;
  }> => ({
    planned: entityIds.map((entityId) => ({ entityType, entityId, mutations: [] })),
    failed: [],
  })
);
const mockApplyReferenceCleanup = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-reference-cleanup-admin', () => ({
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE: 450,
  adminPlanEntityReferenceCleanup: mockPlanReferenceCleanup,
  adminPlanEntityReferenceCleanups: mockPlanReferenceCleanups,
  adminApplyEntityReferenceCleanup: mockApplyReferenceCleanup,
}));

jest.mock('@/lib/entity-sync', () => ({ triggerEntitySync: jest.fn() }));
jest.mock('@/lib/entity-factory-admin', () => ({ adminCreateEntity: jest.fn() }));
jest.mock('@/lib/schemas/company', () => ({
  validateCreateCompanyWithNormalize: jest.fn((value) => value),
  validateUpdateCompanyWithNormalize: jest.fn((value) => value),
}));
jest.mock('@/lib/fuzzy-search', () => ({ fuzzySearch: jest.fn((values) => values) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { adminDeleteCompaniesBulk, adminDeleteCompany, adminUpdateCompany } = require('../companies-admin');

describe('companies-admin durable deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteDocument.mockResolvedValue(undefined);
    mockUpdateDocument.mockResolvedValue(undefined);
    mockBatchCommit.mockResolvedValue(undefined);
    mockDeleteLinks.mockResolvedValue(0);
    mockDeleteNotes.mockResolvedValue(0);
    mockDeleteRelations.mockResolvedValue(0);
    mockRequestDeletion.mockResolvedValue(undefined);
    mockRequestDeletions.mockImplementation(async (_type: string, ids: string[]) => ({
      acknowledged: ids,
      failed: [],
    }));
    mockBestEffortSync.mockResolvedValue(false);
  });

  it('waits for a durable best-effort outcome without rejecting a committed update', async () => {
    await expect(adminUpdateCompany('company-1', { name: 'Updated' })).resolves.toBeUndefined();

    expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
    expect(mockBestEffortSync).toHaveBeenCalledWith('company', 'company-1', 'update');
    expect(mockUpdateDocument.mock.invocationCallOrder[0]).toBeLessThan(mockBestEffortSync.mock.invocationCallOrder[0]);
  });

  it('requires a graph handoff before single-delete cascade mutations', async () => {
    await adminDeleteCompany('company-1');

    expect(mockPlanReferenceCleanup).toHaveBeenCalledWith('company', 'company-1');
    expect(mockRequestDeletion).toHaveBeenCalledWith('company', 'company-1');
    expect(mockPlanReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequestDeletion.mock.invocationCallOrder[0]
    );
    expect(mockRequestDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteRelations.mock.invocationCallOrder[0]
    );
    expect(mockDeleteRelations.mock.invocationCallOrder[0]).toBeLessThan(
      mockApplyReferenceCleanup.mock.invocationCallOrder[0]
    );
    expect(mockApplyReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteDocument.mock.invocationCallOrder[0]
    );
  });

  it('performs no single-delete cascade mutation when handoff fails', async () => {
    mockRequestDeletion.mockRejectedValueOnce(new Error('handoff failed'));

    await expect(adminDeleteCompany('company-1')).rejects.toThrow('handoff failed');

    expect(mockDeleteRelations).not.toHaveBeenCalled();
    expect(mockApplyReferenceCleanup).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('performs no handoff or mutation when reference preflight fails', async () => {
    mockPlanReferenceCleanup.mockRejectedValueOnce(new Error('reference query failed'));

    await expect(adminDeleteCompany('company-1')).rejects.toThrow('reference query failed');

    expect(mockRequestDeletion).not.toHaveBeenCalled();
    expect(mockApplyReferenceCleanup).not.toHaveBeenCalled();
    expect(mockDeleteRelations).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('retains the parent after established cascades when reference cleanup apply fails', async () => {
    mockApplyReferenceCleanup.mockRejectedValueOnce(new Error('reference batch failed'));

    await expect(adminDeleteCompany('company-1')).rejects.toThrow('reference batch failed');

    expect(mockRequestDeletion).toHaveBeenCalledWith('company', 'company-1');
    expect(mockDeleteLinks).toHaveBeenCalledWith('company', 'company-1');
    expect(mockDeleteRelations).toHaveBeenCalledWith('company-1');
    expect(mockDeleteNotes).toHaveBeenCalledWith('companies', 'company-1');
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('excludes a failed bulk preflight ID from graph handoff and later mutations', async () => {
    mockPlanReferenceCleanups.mockResolvedValueOnce({
      planned: [{ entityType: 'company', entityId: 'good', mutations: [] }],
      failed: [{ id: 'bad', error: new Error('reference query failed') }],
    });

    await expect(adminDeleteCompaniesBulk(['good', 'bad'])).resolves.toEqual({
      deleted: 1,
      failed: ['bad'],
      relationsDeleted: 0,
    });

    expect(mockRequestDeletions).toHaveBeenCalledWith('company', ['good']);
    expect(mockApplyReferenceCleanup).toHaveBeenCalledTimes(1);
    expect(mockApplyReferenceCleanup.mock.calls[0][0]).toMatchObject({ entityId: 'good' });
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
  });

  it('bulk-deletes only acknowledged IDs after their graph handoffs', async () => {
    mockRequestDeletions.mockResolvedValueOnce({
      acknowledged: ['company-1'],
      failed: [{ id: 'company-2', error: new Error('handoff failed') }],
    });
    mockDeleteRelations.mockResolvedValue(2);

    const result = await adminDeleteCompaniesBulk(['company-1', 'company-2']);

    expect(result).toEqual({ deleted: 1, failed: ['company-2'], relationsDeleted: 2 });
    expect(mockRequestDeletions.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteRelations.mock.invocationCallOrder[0]
    );
    expect(mockDeleteRelations).toHaveBeenCalledTimes(1);
    expect(mockDeleteRelations).toHaveBeenCalledWith('company-1');
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
    expect(mockBatchDelete.mock.calls[0][0]).toEqual(expect.objectContaining({
      id: 'company-1',
      collectionName: 'companies',
      delete: mockDeleteDocument,
    }));
  });

  it('performs no bulk cascade mutation when no handoff is acknowledged', async () => {
    mockRequestDeletions.mockResolvedValueOnce({
      acknowledged: [],
      failed: [
        { id: 'company-1', error: new Error('handoff failed') },
        { id: 'company-2', error: new Error('handoff failed') },
      ],
    });

    const result = await adminDeleteCompaniesBulk(['company-1', 'company-2']);

    expect(result).toEqual({
      deleted: 0,
      failed: ['company-1', 'company-2'],
      relationsDeleted: 0,
    });
    expect(mockDeleteRelations).not.toHaveBeenCalled();
    expect(mockBatchDelete).not.toHaveBeenCalled();
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });
});
