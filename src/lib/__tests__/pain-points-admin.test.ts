/** @jest-environment node */

export {};

const mockDeleteDocument = jest.fn().mockResolvedValue(undefined);
const mockCollectionGet = jest.fn().mockResolvedValue({ docs: [] });
const mockDocGet = jest.fn().mockResolvedValue({ exists: false });
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      get: mockCollectionGet,
      doc: jest.fn(() => ({
        delete: mockDeleteDocument,
        get: mockDocGet,
      })),
    })),
  },
}));

const mockDeleteLinks = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminDeleteLinksForEntity: mockDeleteLinks,
}));

const mockDeleteNotes = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-notes-cleanup-admin', () => ({
  adminDeleteAllEntityNotes: mockDeleteNotes,
}));

jest.mock('@/lib/entity-factory-admin', () => ({
  adminCreateEntity: jest.fn(),
}));

jest.mock('@/lib/entity-factory', () => {
  throw new Error('pain-points-admin must not import the Firebase client entity factory');
});
jest.mock('@/lib/firebase', () => {
  throw new Error('pain-points-admin must not import the Firebase client runtime');
});
jest.mock('firebase/firestore', () => {
  throw new Error('pain-points-admin must not import firebase/firestore');
});

const mockTriggerEntitySync = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/entity-sync', () => ({
  triggerEntitySync: mockTriggerEntitySync,
}));

const mockRequestEntityGraphDeletion = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/entity-sync-server', () => ({
  requestEntityGraphDeletionServer: mockRequestEntityGraphDeletion,
}));

const mockPlanReferenceCleanup = jest.fn(async (entityType: string, entityId: string) => ({
  entityType,
  entityId,
  mutations: [],
}));
const mockApplyReferenceCleanup = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-reference-cleanup-admin', () => ({
  adminPlanEntityReferenceCleanup: mockPlanReferenceCleanup,
  adminApplyEntityReferenceCleanup: mockApplyReferenceCleanup,
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockDeleteRelations = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: mockDeleteRelations,
}));

const { adminDeletePainPoint } = require('../pain-points-admin');
const { adminGetPainPoints, adminGetPainPointById } = require('../pain-points-admin');

describe('adminDeletePainPoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteRelations.mockResolvedValue(0);
    mockDeleteLinks.mockResolvedValue(0);
    mockDeleteNotes.mockResolvedValue(0);
    mockDeleteDocument.mockResolvedValue(undefined);
    mockTriggerEntitySync.mockResolvedValue(undefined);
    mockRequestEntityGraphDeletion.mockResolvedValue(undefined);
  });

  it('requires the graph handoff before relations and the entity document', async () => {
    await adminDeletePainPoint('pain-1');

    expect(mockDeleteRelations).toHaveBeenCalledWith('pain-1');
    expect(mockDeleteDocument).toHaveBeenCalledTimes(1);
    expect(mockPlanReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]
    );
    expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteRelations.mock.invocationCallOrder[0]
    );
    expect(mockDeleteRelations.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteDocument.mock.invocationCallOrder[0]);
    expect(mockDeleteRelations.mock.invocationCallOrder[0]).toBeLessThan(
      mockApplyReferenceCleanup.mock.invocationCallOrder[0]
    );
    expect(mockApplyReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteDocument.mock.invocationCallOrder[0]
    );
    expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('painPoint', 'pain-1');
  });

  it('does not delete the entity when relation cleanup fails', async () => {
    mockDeleteRelations.mockRejectedValueOnce(new Error('relation cascade failed'));

    await expect(adminDeletePainPoint('pain-1')).rejects.toThrow('relation cascade failed');

    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('painPoint', 'pain-1');
  });

  it('does not mutate relations or the source when the graph handoff fails', async () => {
    mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

    await expect(adminDeletePainPoint('pain-1')).rejects.toThrow('handoff failed');

    expect(mockDeleteRelations).not.toHaveBeenCalled();
    expect(mockApplyReferenceCleanup).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });
});

// UX-059 — Admin reads must expose the same normalized PainPoint shape as the
// browser reader so a sparse triage-created record never crashes consumers.
describe('adminGetPainPoints / adminGetPainPointById normalization (UX-059)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adminGetPainPoints normalizes sparse docs into a render-safe shape', async () => {
    const sparse = {
      id: 'painpoint-admin-sparse',
      slug: 'admin-sparse',
      title: 'Admin Sparse',
      description: 'A sparse admin pain point.',
      severity: 'medium',
      status: 'identified',
      category: 'operational',
      tags: ['scout'],
      createdAt: 1,
      updatedAt: 1,
    };
    mockCollectionGet.mockResolvedValueOnce({ docs: [{ data: () => sparse }] });

    const result = await adminGetPainPoints();
    expect(result).toHaveLength(1);
    expect(result[0].affectedOrgUnitIds).toEqual([]);
    expect(result[0].linkedPrototypeIds).toEqual([]);
    expect(result[0].linkedTechnologyIds).toEqual([]);
    expect(result[0].linkedInitiativeIds).toEqual([]);
    expect(result[0].tags).toEqual(['scout']);
    // The crash expression is safe.
    expect(result[0].affectedOrgUnitIds.length).toBe(0);
  });

  it('adminGetPainPointById normalizes a sparse single record', async () => {
    mockDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        id: 'painpoint-admin-single',
        slug: 'single-sparse',
        title: 'Single Sparse',
        description: 'A single sparse pain point.',
        severity: 'high',
        status: 'identified',
        category: 'customer',
        createdAt: 1,
        updatedAt: 1,
      }),
    });

    const pp = await adminGetPainPointById('painpoint-admin-single');
    expect(pp).not.toBeNull();
    expect(pp!.tags).toEqual([]);
    expect(pp!.affectedOrgUnitIds).toEqual([]);
  });

  it('adminGetPainPointById returns null when the doc is absent', async () => {
    mockDocGet.mockResolvedValueOnce({ exists: false });
    expect(await adminGetPainPointById('missing')).toBeNull();
  });

  it('normalizes the retained process category through Admin list and single reads', async () => {
    const legacy = {
      id: 'painpoint-admin-legacy-process',
      slug: 'admin-legacy-process',
      title: 'Admin Legacy Process',
      description: 'Stored before the canonical category vocabulary.',
      severity: 'medium',
      status: 'identified',
      category: 'process',
      source: { type: 'import' },
      createdAt: 1,
      updatedAt: 1,
    };
    mockCollectionGet.mockResolvedValueOnce({ docs: [{ data: () => legacy }] });
    mockDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => legacy,
    });

    const [listed] = await adminGetPainPoints();
    const single = await adminGetPainPointById(legacy.id);

    expect(listed.category).toBe('operational');
    expect(single?.category).toBe('operational');
    expect(listed.source).toEqual({ type: 'import' });
    expect(single?.source).toEqual({ type: 'import' });
  });

  it('preserves populated arrays exactly through Admin normalization', async () => {
    const populated = {
      id: 'painpoint-admin-full',
      slug: 'admin-full',
      title: 'Admin Full',
      description: 'A complete admin pain point.',
      severity: 'critical',
      status: 'resolved',
      category: 'operational',
      affectedOrgUnitIds: ['org-a', 'org-b'],
      linkedPrototypeIds: ['proto-1'],
      linkedTechnologyIds: ['tech-1', 'tech-2'],
      linkedInitiativeIds: ['init-1'],
      tags: ['a', 'b'],
      createdAt: 1,
      updatedAt: 1,
    };
    mockCollectionGet.mockResolvedValueOnce({ docs: [{ data: () => populated }] });

    const [pp] = await adminGetPainPoints();
    expect(pp.affectedOrgUnitIds).toEqual(['org-a', 'org-b']);
    expect(pp.linkedPrototypeIds).toEqual(['proto-1']);
    expect(pp.linkedTechnologyIds).toEqual(['tech-1', 'tech-2']);
    expect(pp.linkedInitiativeIds).toEqual(['init-1']);
    expect(pp.tags).toEqual(['a', 'b']);
  });
});
