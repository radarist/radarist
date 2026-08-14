/** @jest-environment node */

export {};

jest.mock('server-only', () => ({}));

interface MockDocumentReference {
  readonly id: string;
  readonly path: string;
  readonly collectionPath: string;
}

interface MockFilter {
  readonly fieldPath: string;
  readonly operator: '==' | 'array-contains';
  readonly value: string;
}

interface MockStoredDocument {
  [field: string]: unknown;
}

const mockStore = new Map<string, Map<string, MockStoredDocument>>();
const mockQueryCalls: Array<{
  collectionPath: string;
  filters: readonly MockFilter[];
  afterId?: string;
  limit: number;
}> = [];
const mockCommittedChunks: Array<Array<{ kind: string; path: string; fieldPath?: string }>> = [];
const mockFailCommitNumbers = new Set<number>();
const mockRepeatCursorCollections = new Set<string>();
const mockOversizedPageCollections = new Set<string>();
let mockCommitNumber = 0;
let mockQueryFailure: ((collectionPath: string, filters: readonly MockFilter[]) => Error | undefined) | undefined;

function mockGetField(data: MockStoredDocument, fieldPath: string): unknown {
  return fieldPath.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, data);
}

function mockSetField(data: MockStoredDocument, fieldPath: string, value: unknown): void {
  const keys = fieldPath.split('.');
  let target: Record<string, unknown> = data;
  keys.slice(0, -1).forEach((key) => {
    const next = target[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  });
  target[keys[keys.length - 1]] = value;
}

function mockReference(collectionPath: string, id: string): MockDocumentReference {
  return { id, collectionPath, path: `${collectionPath}/${id}` };
}

class MockQuery {
  constructor(
    readonly collectionPath: string,
    readonly filters: readonly MockFilter[] = [],
    readonly pageLimit = Number.POSITIVE_INFINITY,
    readonly afterId?: string
  ) {}

  where(fieldPath: string, operator: '==' | 'array-contains', value: string): MockQuery {
    return new MockQuery(
      this.collectionPath,
      [...this.filters, { fieldPath, operator, value }],
      this.pageLimit,
      this.afterId
    );
  }

  orderBy(): MockQuery {
    return this;
  }

  limit(pageLimit: number): MockQuery {
    return new MockQuery(this.collectionPath, this.filters, pageLimit, this.afterId);
  }

  startAfter(cursor: { id: string }): MockQuery {
    return new MockQuery(this.collectionPath, this.filters, this.pageLimit, cursor.id);
  }

  async get(): Promise<{
    empty: boolean;
    docs: Array<{ id: string; ref: MockDocumentReference; data: () => MockStoredDocument }>;
  }> {
    mockQueryCalls.push({
      collectionPath: this.collectionPath,
      filters: this.filters,
      afterId: this.afterId,
      limit: this.pageLimit,
    });

    const queryError = mockQueryFailure?.(this.collectionPath, this.filters);
    if (queryError) throw queryError;

    const collection = mockStore.get(this.collectionPath) ?? new Map();
    const pageLimit = mockOversizedPageCollections.has(this.collectionPath)
      ? this.pageLimit + 1
      : this.pageLimit;
    const docs = [...collection.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(
        ([id]) =>
          !this.afterId ||
          mockRepeatCursorCollections.has(this.collectionPath) ||
          id.localeCompare(this.afterId) > 0
      )
      .filter(([, data]) =>
        this.filters.every(({ fieldPath, operator, value }) => {
          const fieldValue = mockGetField(data, fieldPath);
          return operator === '=='
            ? fieldValue === value
            : Array.isArray(fieldValue) && fieldValue.includes(value);
        })
      )
      .slice(0, pageLimit)
      .map(([id, data]) => ({
        id,
        ref: mockReference(this.collectionPath, id),
        data: () => data,
      }));

    return { empty: docs.length === 0, docs };
  }
}

class MockCollection extends MockQuery {
  doc(id: string): MockDocumentReference & { collection: (name: string) => MockCollection } {
    return {
      ...mockReference(this.collectionPath, id),
      collection: (name: string) => new MockCollection(`${this.collectionPath}/${id}/${name}`),
    };
  }
}

const mockDb = {
  collection: jest.fn((collectionPath: string) => new MockCollection(collectionPath)),
  runTransaction: jest.fn(
    async (
      apply: (transaction: {
        get: (reference: MockDocumentReference) => Promise<{
          exists: boolean;
          get: (fieldPath: string) => unknown;
        }>;
        delete: (reference: MockDocumentReference) => void;
        update: (
          reference: MockDocumentReference,
          fieldPath: string,
          operation: { operation: 'array-remove'; entityId: string }
        ) => void;
      }) => Promise<unknown>
    ) => {
      const operations: Array<
        | { kind: 'delete'; reference: MockDocumentReference }
        | {
            kind: 'array-remove';
            reference: MockDocumentReference;
            fieldPath: string;
            entityId: string;
          }
      > = [];
      const result = await apply({
        get: async (reference) => {
          const document = mockStore.get(reference.collectionPath)?.get(reference.id);
          return {
            exists: document !== undefined,
            get: (fieldPath) => (document ? mockGetField(document, fieldPath) : undefined),
          };
        },
        delete: (reference) => operations.push({ kind: 'delete', reference }),
        update: (reference, fieldPath, operation) =>
          operations.push({
            kind: 'array-remove',
            reference,
            fieldPath,
            entityId: operation.entityId,
          }),
      });

      mockCommitNumber += 1;
      mockCommittedChunks.push(
        operations.map((operation) => ({
          kind: operation.kind,
          path: operation.reference.path,
          ...('fieldPath' in operation ? { fieldPath: operation.fieldPath } : {}),
        }))
      );
      if (mockFailCommitNumbers.has(mockCommitNumber)) {
        throw new Error(`batch ${mockCommitNumber} failed`);
      }

      operations.forEach((operation) => {
        const collection = mockStore.get(operation.reference.collectionPath);
        if (operation.kind === 'delete') {
          collection?.delete(operation.reference.id);
          return;
        }

        const document = collection?.get(operation.reference.id);
        if (!document) throw new Error(`missing document ${operation.reference.path}`);
        const current = mockGetField(document, operation.fieldPath);
        mockSetField(
          document,
          operation.fieldPath,
          Array.isArray(current) ? current.filter((value) => value !== operation.entityId) : current
        );
      });

      return result;
    }
  ),
  batch: jest.fn(() => {
    const operations: Array<
      | { kind: 'delete'; reference: MockDocumentReference }
      | {
          kind: 'array-remove';
          reference: MockDocumentReference;
          fieldPath: string;
          entityId: string;
        }
    > = [];

    return {
      delete: jest.fn((reference: MockDocumentReference) => {
        operations.push({ kind: 'delete', reference });
      }),
      update: jest.fn(
        (
          reference: MockDocumentReference,
          fieldPath: string,
          operation: { operation: 'array-remove'; entityId: string }
        ) => {
          operations.push({
            kind: 'array-remove',
            reference,
            fieldPath,
            entityId: operation.entityId,
          });
        }
      ),
      commit: jest.fn(async () => {
        mockCommitNumber += 1;
        mockCommittedChunks.push(
          operations.map((operation) => ({
            kind: operation.kind,
            path: operation.reference.path,
            ...('fieldPath' in operation ? { fieldPath: operation.fieldPath } : {}),
          }))
        );
        if (mockFailCommitNumbers.has(mockCommitNumber)) {
          throw new Error(`batch ${mockCommitNumber} failed`);
        }

        operations.forEach((operation) => {
          const collection = mockStore.get(operation.reference.collectionPath);
          if (operation.kind === 'delete') {
            collection?.delete(operation.reference.id);
            return;
          }

          const document = collection?.get(operation.reference.id);
          if (!document) throw new Error(`missing document ${operation.reference.path}`);
          const current = mockGetField(document, operation.fieldPath);
          mockSetField(
            document,
            operation.fieldPath,
            Array.isArray(current) ? current.filter((value) => value !== operation.entityId) : current
          );
        });
      }),
    };
  }),
};

jest.mock('@/lib/firebase-admin', () => ({ db: mockDb }));
jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: jest.fn(() => '__name__') },
  FieldValue: {
    arrayRemove: jest.fn((entityId: string) => ({ operation: 'array-remove', entityId })),
  },
}));

const {
  adminApplyEntityReferenceCleanup,
  adminPlanEntityReferenceCleanup,
  adminPlanEntityReferenceCleanups,
} = require('../entity-reference-cleanup-admin');
const { EntityDeletionBlockedError } = require('../entity-deletion-reference-policy');

function seed(collectionPath: string, id: string, data: MockStoredDocument): void {
  const collection = mockStore.get(collectionPath) ?? new Map<string, MockStoredDocument>();
  collection.set(id, structuredClone(data));
  mockStore.set(collectionPath, collection);
}

function stored(collectionPath: string, id: string): MockStoredDocument | undefined {
  return mockStore.get(collectionPath)?.get(id);
}

describe('entity-reference-cleanup-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockQueryCalls.length = 0;
    mockCommittedChunks.length = 0;
    mockFailCommitNumbers.clear();
    mockRepeatCursorCollections.clear();
    mockOversizedPageCollections.clear();
    mockCommitNumber = 0;
    mockQueryFailure = undefined;
  });

  it('removes every live Company reference while preserving delegated notes, history, and unrelated rows', async () => {
    seed('companies', 'company-1', { name: 'Source' });
    seed('companies/company-1/contacts', 'contact-1', { companyId: 'company-1' });
    seed('companies/company-1/notes', 'note-1', { companyId: 'company-1' });
    seed('company-blip-relationships', 'join-1', { companyId: 'company-1' });
    seed('company-blip-relationships', 'join-other', { companyId: 'company-2' });
    seed('technologies', 'tech-1', { linkedCompanies: ['company-1', 'company-2'] });
    seed('prototypes', 'prototype-1', { linkedCompanies: ['company-1'] });
    seed('use-cases', 'use-case-1', { companyIds: ['company-1', 'company-2'] });
    seed('signals', 'signal-1', {
      linkedEntities: { companies: ['company-1', 'company-2'] },
      importedAs: { id: 'company-1', type: 'company' },
    });
    seed('signals', 'signal-other', { linkedEntities: { companies: ['company-2'] } });

    const plan = await adminPlanEntityReferenceCleanup('company', 'company-1');

    expect(mockCommittedChunks).toHaveLength(0);
    await expect(adminApplyEntityReferenceCleanup(plan)).resolves.toEqual({
      ownedReferencesDeleted: 2,
      liveReferencesRemoved: 4,
      delegatedReferences: 1,
      batchesCommitted: 1,
    });

    expect(stored('companies', 'company-1')).toBeDefined();
    expect(stored('companies/company-1/contacts', 'contact-1')).toBeUndefined();
    expect(stored('companies/company-1/notes', 'note-1')).toBeDefined();
    expect(stored('company-blip-relationships', 'join-1')).toBeUndefined();
    expect(stored('company-blip-relationships', 'join-other')).toBeDefined();
    expect(stored('technologies', 'tech-1')?.linkedCompanies).toEqual(['company-2']);
    expect(stored('prototypes', 'prototype-1')?.linkedCompanies).toEqual([]);
    expect(stored('use-cases', 'use-case-1')?.companyIds).toEqual(['company-2']);
    expect(mockGetField(stored('signals', 'signal-1')!, 'linkedEntities.companies')).toEqual(['company-2']);
    expect(mockGetField(stored('signals', 'signal-1')!, 'importedAs.id')).toBe('company-1');
    expect(mockGetField(stored('signals', 'signal-other')!, 'linkedEntities.companies')).toEqual(['company-2']);
    expect(mockQueryCalls).toContainEqual(
      expect.objectContaining({ collectionPath: 'companies/company-1/notes' })
    );
  });

  it('returns the shared bounded blocker error before planning any Org Unit mutation', async () => {
    for (let index = 11; index >= 0; index -= 1) {
      seed('org-units', `child-${String(index).padStart(2, '0')}`, { parentId: 'org-1' });
    }
    seed('initiatives', 'initiative-1', { ownerOrgUnitId: 'org-1' });
    seed('painPoints', 'pain-1', { affectedOrgUnitIds: ['org-1'] });

    let caught: unknown;
    try {
      await adminPlanEntityReferenceCleanup('orgUnit', 'org-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EntityDeletionBlockedError);
    expect(caught).toMatchObject({
      code: 'entity-deletion-blocked',
      entityType: 'orgUnit',
      entityId: 'org-1',
      totalBlockers: 13,
      blockers: [
        {
          collection: 'org-units',
          fieldPath: 'parentId',
          count: 12,
          sampleDocumentIds: Array.from({ length: 10 }, (_, index) =>
            `child-${String(index).padStart(2, '0')}`
          ),
        },
        {
          collection: 'initiatives',
          fieldPath: 'ownerOrgUnitId',
          count: 1,
          sampleDocumentIds: ['initiative-1'],
        },
      ],
    });
    expect(mockCommittedChunks).toHaveLength(0);
    expect(stored('painPoints', 'pain-1')?.affectedOrgUnitIds).toEqual(['org-1']);
  });

  it('paginates beyond 450 and recovers safely after a later cleanup batch fails', async () => {
    seed('strategies', 'strategy-1', { name: 'Source' });
    for (let index = 0; index < 451; index += 1) {
      seed('prototypes', `prototype-${String(index).padStart(3, '0')}`, {
        linkedStrategies: ['strategy-1', 'strategy-other'],
      });
    }
    seed('prototypes', 'prototype-unrelated', { linkedStrategies: ['strategy-other'] });

    const plan = await adminPlanEntityReferenceCleanup('strategy', 'strategy-1');
    mockFailCommitNumbers.add(2);

    await expect(adminApplyEntityReferenceCleanup(plan)).rejects.toThrow('batch 2 failed');

    const remainingAfterFailure = [...(mockStore.get('prototypes')?.values() ?? [])].filter((document) =>
      (document.linkedStrategies as string[]).includes('strategy-1')
    );
    expect(remainingAfterFailure).toHaveLength(1);
    expect(mockCommittedChunks.map((chunk) => chunk.length)).toEqual([450, 1]);
    expect(stored('strategies', 'strategy-1')).toBeDefined();

    mockFailCommitNumbers.clear();
    const retryPlan = await adminPlanEntityReferenceCleanup('strategy', 'strategy-1');
    await adminApplyEntityReferenceCleanup(retryPlan);

    const remainingAfterRetry = [...(mockStore.get('prototypes')?.values() ?? [])].filter((document) =>
      (document.linkedStrategies as string[]).includes('strategy-1')
    );
    expect(remainingAfterRetry).toHaveLength(0);
    expect(mockCommittedChunks.map((chunk) => chunk.length)).toEqual([450, 1, 1]);
    expect(stored('prototypes', 'prototype-unrelated')?.linkedStrategies).toEqual(['strategy-other']);
    expect(
      mockQueryCalls.filter(
        (call) =>
          call.collectionPath === 'prototypes' &&
          call.filters.some(
            (filter) =>
              filter.fieldPath === 'linkedStrategies' &&
              filter.operator === 'array-contains' &&
              filter.value === 'strategy-1'
          )
      )
    ).toHaveLength(3);
  });

  it('partitions bulk preflight failures by exact ID without writing', async () => {
    seed('companies/good/contacts', 'contact-1', { companyId: 'good' });
    seed('companies/bad/contacts', 'contact-2', { companyId: 'bad' });
    mockQueryFailure = (collectionPath) =>
      collectionPath === 'companies/bad/contacts' ? new Error('contacts query unavailable') : undefined;

    await expect(adminPlanEntityReferenceCleanups('company', ['good', 'bad'])).resolves.toMatchObject({
      planned: [{ entityType: 'company', entityId: 'good' }],
      failed: [{ id: 'bad', error: expect.objectContaining({ message: 'contacts query unavailable' }) }],
    });
    expect(mockCommittedChunks).toHaveLength(0);
    expect(stored('companies/good/contacts', 'contact-1')).toBeDefined();
    expect(stored('companies/bad/contacts', 'contact-2')).toBeDefined();
  });

  it('rejects a repeated cursor page before any cleanup write', async () => {
    for (let index = 0; index < 450; index += 1) {
      seed('prototypes', `prototype-${String(index).padStart(3, '0')}`, {
        linkedStrategies: ['strategy-1'],
      });
    }
    mockRepeatCursorCollections.add('prototypes');

    await expect(adminPlanEntityReferenceCleanup('strategy', 'strategy-1')).rejects.toThrow(
      'pagination made no progress'
    );
    expect(mockCommittedChunks).toHaveLength(0);
  });

  it('fails closed when a query adapter violates the 450-document page bound', async () => {
    for (let index = 0; index < 451; index += 1) {
      seed('prototypes', `prototype-${String(index).padStart(3, '0')}`, {
        linkedStrategies: ['strategy-1'],
      });
    }
    mockOversizedPageCollections.add('prototypes');

    await expect(adminPlanEntityReferenceCleanup('strategy', 'strategy-1')).rejects.toThrow(
      'query exceeded its bound'
    );
    expect(mockCommittedChunks).toHaveLength(0);
  });

  it('rejects an empty entity ID before querying Firestore', async () => {
    await expect(adminPlanEntityReferenceCleanup('company', '   ')).rejects.toThrow(
      'requires a non-empty entity ID'
    );
    expect(mockQueryCalls).toHaveLength(0);
    expect(mockCommittedChunks).toHaveLength(0);
  });

  it('preserves a join row reassigned after planning and reports replay as no new mutations', async () => {
    seed('company-blip-relationships', 'join-1', { companyId: 'company-1' });

    const plan = await adminPlanEntityReferenceCleanup('company', 'company-1');
    seed('company-blip-relationships', 'join-1', { companyId: 'company-2' });

    await expect(adminApplyEntityReferenceCleanup(plan)).resolves.toEqual({
      ownedReferencesDeleted: 0,
      liveReferencesRemoved: 0,
      delegatedReferences: 0,
      batchesCommitted: 0,
    });
    expect(stored('company-blip-relationships', 'join-1')).toEqual({ companyId: 'company-2' });

    await expect(adminApplyEntityReferenceCleanup(plan)).resolves.toMatchObject({
      ownedReferencesDeleted: 0,
      liveReferencesRemoved: 0,
      batchesCommitted: 0,
    });
  });
});
