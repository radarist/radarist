/** @jest-environment node */

export {};

jest.mock('server-only', () => ({}));

const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn();
const mockGet = jest.fn();
const mockLimit = jest.fn(() => ({ get: mockGet }));
const mockNotesCollection = jest.fn(() => ({ limit: mockLimit }));
const mockParentDoc = jest.fn(() => ({ collection: mockNotesCollection }));
const mockParentCollection = jest.fn((_name: string) => ({ doc: mockParentDoc }));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => mockParentCollection(name),
    batch: jest.fn(() => ({ delete: mockBatchDelete, commit: mockBatchCommit })),
  },
}));

import { adminDeleteAllEntityNotes } from '../entity-notes-cleanup-admin';

describe('adminDeleteAllEntityNotes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('deletes every page and returns only the committed count', async () => {
    const first = Array.from({ length: 2 }, (_, index) => ({ ref: { id: `note-${index}` } }));
    const second = [{ ref: { id: 'note-2' } }];
    mockGet
      .mockResolvedValueOnce({ empty: false, size: first.length, docs: first })
      .mockResolvedValueOnce({ empty: false, size: second.length, docs: second })
      .mockResolvedValueOnce({ empty: true, size: 0, docs: [] });

    await expect(adminDeleteAllEntityNotes('companies', 'company-1')).resolves.toBe(3);

    expect(mockParentCollection).toHaveBeenCalledWith('companies');
    expect(mockParentDoc).toHaveBeenCalledWith('company-1');
    expect(mockNotesCollection).toHaveBeenCalledWith('notes');
    expect(mockLimit).toHaveBeenCalledWith(500);
    expect(mockBatchDelete).toHaveBeenCalledTimes(3);
    expect(mockBatchCommit).toHaveBeenCalledTimes(2);
  });

  it('propagates reads that cannot prove the subcollection is empty', async () => {
    mockGet.mockRejectedValueOnce(new Error('read failed'));

    await expect(adminDeleteAllEntityNotes('strategies', 'strategy-1')).rejects.toThrow('read failed');
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });

  it('does not report an uncommitted page when a batch fails', async () => {
    mockGet.mockResolvedValueOnce({ empty: false, size: 1, docs: [{ ref: { id: 'note-1' } }] });
    mockBatchCommit.mockRejectedValueOnce(new Error('commit failed'));

    await expect(adminDeleteAllEntityNotes('prototypes', 'prototype-1')).rejects.toThrow('commit failed');
  });
});
