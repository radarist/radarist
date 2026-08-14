/**
 * @jest-environment node
 */

jest.mock('../firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  arrayRemove: jest.fn((value: string) => ({ __arrayRemove: value })),
  collection: jest.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  documentId: jest.fn(() => '__name__'),
  getDocs: jest.fn(),
  limit: jest.fn((value: number) => ({ kind: 'limit', value })),
  orderBy: jest.fn((field: string) => ({ kind: 'orderBy', field })),
  query: jest.fn((source: unknown, ...constraints: unknown[]) => ({ source, constraints })),
  runTransaction: jest.fn(),
  startAfter: jest.fn((cursor: unknown) => ({ kind: 'startAfter', cursor })),
  where: jest.fn((field: string, operator: string, value: string) => ({
    kind: 'where',
    field,
    operator,
    value,
  })),
}));

import {
  arrayRemove,
  getDocs,
  runTransaction,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  applyEntityReferenceCleanup,
  EntityDeletionBlockedError,
  preflightEntityReferenceCleanup,
  preflightEntityReferenceCleanups,
} from '../entity-reference-cleanup';

const mockArrayRemove = arrayRemove as jest.Mock;
const mockGetDocs = getDocs as jest.Mock;
const mockStartAfter = startAfter as jest.Mock;
const mockWhere = where as jest.Mock;
const mockRunTransaction = runTransaction as jest.Mock;

interface MockTransaction {
  delete: jest.Mock;
  update: jest.Mock;
}

let transactions: MockTransaction[] = [];
const transactionDocumentOverrides = new Map<string, Record<string, unknown> | null>();

function reference(id: string): QueryDocumentSnapshot<DocumentData> {
  return {
    id,
    ref: { path: `fixtures/${id}` },
  } as unknown as QueryDocumentSnapshot<DocumentData>;
}

function snapshot(ids: readonly string[]) {
  return { docs: ids.map(reference), empty: ids.length === 0 };
}

function installSuccessfulTransactions(): void {
  mockRunTransaction.mockImplementation(async (_firestore: unknown, apply: (transaction: unknown) => unknown) => {
    const transaction: MockTransaction & { get: jest.Mock } = {
      get: jest.fn(async (documentReference: { path: string }) => {
        const override = transactionDocumentOverrides.get(documentReference.path);
        const data =
          override === undefined
            ? {
                companyId: 'company-1',
                linkedCompanies: ['company-1'],
                companyIds: ['company-1'],
                linkedInitiativeIds: ['initiative-1'],
                linkedStrategies: ['strategy-1'],
                'linkedEntities.companies': ['company-1'],
              }
            : override;
        return {
          exists: () => data !== null,
          get: (fieldPath: string) => data?.[fieldPath],
        };
      }),
      delete: jest.fn(),
      update: jest.fn(),
    };
    transactions.push(transaction);
    return apply(transaction);
  });
}

describe('entity-reference-cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocs.mockReset();
    mockRunTransaction.mockReset();
    transactions = [];
    transactionDocumentOverrides.clear();
    installSuccessfulTransactions();
  });

  it('preflights every Company target, preserves provenance, and mutates only matched live rows', async () => {
    mockGetDocs
      .mockResolvedValueOnce(snapshot(['note-1']))
      .mockResolvedValueOnce(snapshot(['contact-1']))
      .mockResolvedValueOnce(snapshot(['join-1']))
      .mockResolvedValueOnce(snapshot(['technology-1']))
      .mockResolvedValueOnce(snapshot(['prototype-1']))
      .mockResolvedValueOnce(snapshot(['use-case-1']))
      .mockResolvedValueOnce(snapshot(['signal-1']));

    const plan = await preflightEntityReferenceCleanup('company', 'company-1', db);

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalledWith('companyId', '==', 'company-1');
    expect(mockWhere).toHaveBeenCalledWith('linkedCompanies', 'array-contains', 'company-1');
    expect(mockWhere).toHaveBeenCalledWith('companyIds', 'array-contains', 'company-1');
    expect(mockWhere).toHaveBeenCalledWith('linkedEntities.companies', 'array-contains', 'company-1');
    expect(mockWhere).not.toHaveBeenCalledWith('importedAs.id', expect.anything(), expect.anything());

    const result = await applyEntityReferenceCleanup(plan, db);

    expect(result).toEqual({
      ownedReferencesDeleted: 2,
      liveReferencesRemoved: 4,
      delegatedReferences: 1,
      batchesCommitted: 1,
    });
    expect(transactions[0].delete).toHaveBeenCalledTimes(2);
    expect(transactions[0].delete).toHaveBeenCalledWith(expect.objectContaining({ path: 'fixtures/contact-1' }));
    expect(transactions[0].delete).toHaveBeenCalledWith(expect.objectContaining({ path: 'fixtures/join-1' }));
    expect(transactions[0].delete).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'fixtures/note-1' }));
    expect(transactions[0].update).toHaveBeenCalledTimes(4);
    expect(transactions[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'fixtures/signal-1' }),
      { 'linkedEntities.companies': { __arrayRemove: 'company-1' } }
    );
    expect(mockArrayRemove).toHaveBeenCalledTimes(4);
    expect(transactions[0].delete).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'fixtures/unrelated' }));
  });

  it('performs no cleanup write when the last preflight query fails', async () => {
    mockGetDocs
      .mockResolvedValueOnce(snapshot(['note-1']))
      .mockResolvedValueOnce(snapshot(['technology-1']))
      .mockResolvedValueOnce(snapshot(['prototype-1']))
      .mockResolvedValueOnce(snapshot(['join-1']))
      .mockRejectedValueOnce(new Error('signal query failed'));

    await expect(preflightEntityReferenceCleanup('useCase', 'use-case-1', db)).rejects.toThrow(
      'signal query failed'
    );

    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('isolates an exact ID failure during bounded bulk preflight', async () => {
    for (let index = 0; index < 7; index += 1) {
      mockGetDocs.mockResolvedValueOnce(snapshot([]));
    }

    const result = await preflightEntityReferenceCleanups('company', ['company-1', '   '], db);

    expect(result.prepared).toEqual([
      {
        id: 'company-1',
        plan: {
          entityType: 'company',
          entityId: 'company-1',
          ownedReferences: expect.any(Array),
          liveArrayReferences: expect.any(Array),
        },
      },
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: '   ', error: expect.any(Error) });
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('uses document cursors and keeps 451 live removals in 450/1 batches', async () => {
    const firstPage = Array.from({ length: 450 }, (_, index) => `prototype-${index}`);
    mockGetDocs
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot(firstPage))
      .mockResolvedValueOnce(snapshot(['prototype-450']))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([]));

    const plan = await preflightEntityReferenceCleanup('strategy', 'strategy-1', db);
    const result = await applyEntityReferenceCleanup(plan, db);

    expect(mockStartAfter).toHaveBeenCalledWith(expect.objectContaining({ id: 'prototype-449' }));
    expect(transactions.map((transaction) => transaction.update.mock.calls.length)).toEqual([450, 1]);
    expect(transactions.every((transaction) => transaction.update.mock.calls.length <= 450)).toBe(true);
    expect(result.liveReferencesRemoved).toBe(451);
  });

  it('rejects a duplicate cursor page before any cleanup write', async () => {
    const firstPage = Array.from({ length: 450 }, (_, index) => `prototype-${index}`);
    mockGetDocs
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot(firstPage))
      .mockResolvedValueOnce(snapshot(['prototype-449']));

    await expect(preflightEntityReferenceCleanup('strategy', 'strategy-1', db)).rejects.toThrow(
      'pagination made no progress'
    );
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('retains replay safety after a failed write batch', async () => {
    mockGetDocs
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot(['pain-1']))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot(['pain-1']));

    mockRunTransaction.mockRejectedValueOnce(new Error('commit failed'));

    const firstPlan = await preflightEntityReferenceCleanup('initiative', 'initiative-1', db);
    await expect(applyEntityReferenceCleanup(firstPlan, db)).rejects.toThrow('commit failed');

    const retryPlan = await preflightEntityReferenceCleanup('initiative', 'initiative-1', db);
    const retryResult = await applyEntityReferenceCleanup(retryPlan, db);

    expect(retryResult.liveReferencesRemoved).toBe(1);
    expect(transactions.at(-1)?.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'fixtures/pain-1' }),
      { linkedInitiativeIds: { __arrayRemove: 'initiative-1' } }
    );
  });

  it('returns bounded actionable Org Unit blockers without reading cleanup targets', async () => {
    const childIds = ['child-z', 'child-a', ...Array.from({ length: 10 }, (_, index) => `child-${index}`)];
    mockGetDocs
      .mockResolvedValueOnce(snapshot(childIds))
      .mockResolvedValueOnce(snapshot(['initiative-2', 'initiative-1']));

    let thrown: unknown;
    try {
      await preflightEntityReferenceCleanup('orgUnit', 'org-1', db);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EntityDeletionBlockedError);
    expect(thrown).toMatchObject({
      code: 'entity-deletion-blocked',
      entityType: 'orgUnit',
      entityId: 'org-1',
      totalBlockers: 14,
      blockers: [
        {
          collection: 'org-units',
          fieldPath: 'parentId',
          count: 12,
          reason: expect.stringContaining('reparented'),
        },
        {
          collection: 'initiatives',
          fieldPath: 'ownerOrgUnitId',
          count: 2,
          reason: expect.stringContaining('reassigned'),
        },
      ],
    });
    const blockerError = thrown as EntityDeletionBlockedError;
    expect(blockerError.blockers[0].sampleDocumentIds).toHaveLength(10);
    expect(blockerError.blockers[0].sampleDocumentIds).toEqual(
      [...blockerError.blockers[0].sampleDocumentIds].sort((left, right) => left.localeCompare(right))
    );
    expect(mockGetDocs).toHaveBeenCalledTimes(2);
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('does not delete a collection-query row that was reassigned after preflight', async () => {
    mockGetDocs
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot(['contact-1']))
      .mockResolvedValueOnce(snapshot(['join-1']))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([]));

    const plan = await preflightEntityReferenceCleanup('company', 'company-1', db);
    transactionDocumentOverrides.set('fixtures/join-1', { companyId: 'company-2' });

    await expect(applyEntityReferenceCleanup(plan, db)).resolves.toEqual({
      ownedReferencesDeleted: 1,
      liveReferencesRemoved: 0,
      delegatedReferences: 0,
      batchesCommitted: 1,
    });
    expect(transactions[0].delete).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'fixtures/contact-1' })
    );
    expect(transactions[0].delete).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'fixtures/join-1' })
    );
  });
});
