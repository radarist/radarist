/** @jest-environment node */

export {};

jest.mock('server-only', () => ({}));

const mockDocDelete = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn();
const mockDoc = jest.fn((id: string) => ({ id, delete: mockDocDelete }));
const mockCollection = jest.fn((name: string) => ({ name, doc: mockDoc }));

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

const mockDeleteRelations = jest.fn();
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: mockDeleteRelations,
}));

const mockDeleteNotes = jest.fn();
jest.mock('@/lib/entity-notes-cleanup-admin', () => ({
  adminDeleteAllEntityNotes: mockDeleteNotes,
}));

const mockRequestDeletion = jest.fn();
const mockRequestDeletions = jest.fn();
jest.mock('@/lib/entity-sync-server', () => ({
  requestEntityGraphDeletionServer: mockRequestDeletion,
  requestEntityGraphDeletionsServer: mockRequestDeletions,
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

class MockEntitySyncDispatchError extends Error {}
jest.mock('@/lib/entity-sync', () => ({
  EntitySyncDispatchError: MockEntitySyncDispatchError,
  triggerEntitySync: jest.fn(),
}));
jest.mock('@/lib/entity-factory-admin', () => ({ adminCreateEntity: jest.fn() }));
jest.mock('@/lib/entity-factory', () => {
  throw new Error('Admin deletion helpers must not import the Firebase client entity factory');
});
jest.mock('@/lib/firebase', () => {
  throw new Error('Admin deletion helpers must not import the Firebase client runtime');
});
jest.mock('@/lib/schemas/company', () => ({
  validateCreateCompanyWithNormalize: jest.fn((value) => value),
  validateUpdateCompanyWithNormalize: jest.fn((value) => value),
}));
jest.mock('@/lib/fuzzy-search', () => ({ fuzzySearch: jest.fn((values) => values) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { adminDeleteCompany, adminDeleteCompaniesBulk } = require('../companies-admin');
const { adminDeleteStrategy, adminDeleteStrategies } = require('../strategies-admin');
const { adminDeleteUseCase, adminDeleteUseCases } = require('../use-cases-admin');
const { adminDeletePrototype, adminDeletePrototypes } = require('../prototypes-admin');
const { adminDeleteOrgUnit } = require('../org-units-admin');
const { adminDeleteInitiative } = require('../initiatives-admin');
const { adminDeletePainPoint } = require('../pain-points-admin');

describe('Admin entity deletion contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocDelete.mockResolvedValue(undefined);
    mockBatchCommit.mockResolvedValue(undefined);
    mockDeleteLinks.mockResolvedValue(0);
    mockDeleteRelations.mockResolvedValue(1);
    mockDeleteNotes.mockResolvedValue(0);
    mockRequestDeletion.mockResolvedValue(undefined);
    mockRequestDeletions.mockImplementation(async (_type: string, ids: string[]) => ({
      acknowledged: ids,
      failed: [],
    }));
  });

  it.each([
    ['company', 'company', 'companies', adminDeleteCompany],
    ['strategy', 'strategy', 'strategies', adminDeleteStrategy],
    ['use case', 'useCase', 'use-cases', adminDeleteUseCase],
    ['prototype', 'prototype', 'prototypes', adminDeletePrototype],
    ['org unit', 'orgUnit', 'org-units', adminDeleteOrgUnit],
    ['initiative', 'initiative', 'initiatives', adminDeleteInitiative],
    ['pain point', 'painPoint', 'painPoints', adminDeletePainPoint],
  ])(
    'orders %s deletion as graph handoff, links, relations, notes, parent',
    async (_name, entityType, collection, deleteEntity) => {
      await deleteEntity('entity-1');

      expect(mockPlanReferenceCleanup).toHaveBeenCalledWith(entityType, 'entity-1');
      expect(mockRequestDeletion).toHaveBeenCalledWith(entityType, 'entity-1');
      expect(mockApplyReferenceCleanup).toHaveBeenCalledTimes(1);
      expect(mockDeleteLinks).toHaveBeenCalledWith(entityType, 'entity-1');
      expect(mockDeleteRelations).toHaveBeenCalledWith('entity-1');
      expect(mockDeleteNotes).toHaveBeenCalledWith(collection, 'entity-1');
      expect(mockDocDelete).toHaveBeenCalledTimes(1);
      expect(mockPlanReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestDeletion.mock.invocationCallOrder[0]
      );
      expect(mockRequestDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteLinks.mock.invocationCallOrder[0]
      );
      expect(mockDeleteLinks.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteRelations.mock.invocationCallOrder[0]
      );
      expect(mockDeleteRelations.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteNotes.mock.invocationCallOrder[0]
      );
      expect(mockDeleteNotes.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyReferenceCleanup.mock.invocationCallOrder[0]
      );
      expect(mockApplyReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockDocDelete.mock.invocationCallOrder[0]
      );
    }
  );

  it.each([
    ['companies', 'company', adminDeleteCompaniesBulk],
    ['strategies', 'strategy', adminDeleteStrategies],
    ['use cases', 'useCase', adminDeleteUseCases],
    ['prototypes', 'prototype', adminDeletePrototypes],
  ])('bulk %s batches only IDs whose complete prerequisites succeed', async (_name, entityType, deleteEntities) => {
    mockDeleteLinks.mockImplementation(async (_type: string, id: string) => {
      if (id === 'bad') throw new Error('link cleanup failed');
      return 0;
    });
    mockDeleteRelations.mockResolvedValue(2);

    const result = await deleteEntities(['good', 'bad']);

    expect(mockRequestDeletions).toHaveBeenCalledWith(entityType, ['good', 'bad']);
    expect(result).toEqual({ deleted: 1, failed: ['bad'], relationsDeleted: 2 });
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
  });

  it('retains only the company whose relation cleanup fails', async () => {
    mockDeleteRelations.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('relation cleanup failed');
      return 3;
    });

    await expect(adminDeleteCompaniesBulk(['good', 'bad'])).resolves.toEqual({
      deleted: 1,
      failed: ['bad'],
      relationsDeleted: 3,
    });
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
  });

  it('retains only the use case whose note cleanup fails', async () => {
    mockDeleteNotes.mockImplementation(async (_collection: string, id: string) => {
      if (id === 'bad') throw new Error('note cleanup failed');
      return 0;
    });

    await expect(adminDeleteUseCases(['good', 'bad'])).resolves.toEqual({
      deleted: 1,
      failed: ['bad'],
      relationsDeleted: 1,
    });
    expect(mockBatchDelete).toHaveBeenCalledTimes(1);
  });

  it('reports all prepared prototype IDs when the parent batch fails', async () => {
    mockBatchCommit.mockRejectedValueOnce(new Error('parent batch failed'));

    await expect(adminDeletePrototypes(['p-1', 'p-2'])).resolves.toEqual({
      deleted: 0,
      failed: ['p-1', 'p-2'],
      relationsDeleted: 2,
    });
  });

  it('blocks an Org Unit before graph handoff or any mutation when preflight rejects', async () => {
    mockPlanReferenceCleanup.mockRejectedValueOnce(new Error('dependent records must be reassigned'));

    await expect(adminDeleteOrgUnit('org-1')).rejects.toThrow('dependent records must be reassigned');

    expect(mockRequestDeletion).not.toHaveBeenCalled();
    expect(mockApplyReferenceCleanup).not.toHaveBeenCalled();
    expect(mockDeleteLinks).not.toHaveBeenCalled();
    expect(mockDeleteRelations).not.toHaveBeenCalled();
    expect(mockDeleteNotes).not.toHaveBeenCalled();
    expect(mockDocDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['strategy', adminDeleteStrategy],
    ['prototype', adminDeletePrototype],
  ])('retains the %s cleanup failure as the public error cause', async (entityType, deleteEntity) => {
    const cause = new Error('reference preflight failed');
    mockPlanReferenceCleanup.mockRejectedValueOnce(cause);

    await expect(deleteEntity('entity-1')).rejects.toMatchObject({
      message: `Failed to delete ${entityType} entity-1`,
      cause,
    });
    expect(mockRequestDeletion).not.toHaveBeenCalled();
    expect(mockDocDelete).not.toHaveBeenCalled();
  });

  it('caps both bulk parent batches and graph handoff chunks at 450', async () => {
    const ids = Array.from({ length: 451 }, (_, index) => `company-${index}`);

    await expect(adminDeleteCompaniesBulk(ids)).resolves.toEqual({
      deleted: 451,
      failed: [],
      relationsDeleted: 451,
    });

    expect(mockPlanReferenceCleanups.mock.calls.map((call) => call[1].length)).toEqual([450, 1]);
    expect(mockRequestDeletions.mock.calls.map((call) => call[1].length)).toEqual([450, 1]);
    expect(mockBatchCommit).toHaveBeenCalledTimes(2);
    expect(mockBatchDelete).toHaveBeenCalledTimes(451);
  });
});
