/**
 * @file entity-notes.test.ts
 * @description Locks the generic entity-notes service (UX-002/003/004):
 * subcollection targeting under the parent entity, committed-value returns,
 * the updatedAt stamp on update, and error wrapping.
 *
 * @jest-environment node
 */

export {}; // make this file a module so its mock consts stay file-scoped

const mockGetDocs = jest.fn();
const mockSetDoc = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDeleteDoc = jest.fn();
const mockCollection = jest.fn((...args: unknown[]) => ({ __collection: args }));
const mockDoc = jest.fn((...args: unknown[]) => ({ __doc: args }));
const mockQuery = jest.fn((...args: unknown[]) => ({ __query: args }));
const mockOrderBy = jest.fn((...args: unknown[]) => ({ __orderBy: args }));

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  collection: mockCollection,
  doc: mockDoc,
  getDocs: mockGetDocs,
  setDoc: mockSetDoc,
  deleteDoc: mockDeleteDoc,
  updateDoc: mockUpdateDoc,
  query: mockQuery,
  orderBy: mockOrderBy,
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { getEntityNotes, createEntityNote, updateEntityNote, deleteEntityNote } = require('../entity-notes');

describe('getEntityNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the notes subcollection under the parent entity, newest first', async () => {
    mockGetDocs.mockResolvedValue({ docs: [{ data: () => ({ id: 'n1' }) }] });

    const notes = await getEntityNotes('prototypes', 'proto-1');

    expect(mockCollection).toHaveBeenCalledWith({}, 'prototypes', 'proto-1', 'notes');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(notes).toEqual([{ id: 'n1' }]);
  });

  it('wraps read failures in a friendly error', async () => {
    mockGetDocs.mockRejectedValue(new Error('boom'));
    await expect(getEntityNotes('strategies', 's-1')).rejects.toThrow('Failed to fetch notes for strategies/s-1');
  });
});

describe('createEntityNote', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes a note doc with equal createdAt/updatedAt and returns the committed note', async () => {
    mockSetDoc.mockResolvedValue(undefined);

    const note = await createEntityNote('use-cases', 'uc-1', 'hello', 'user-1');

    expect(mockDoc).toHaveBeenCalledWith({}, 'use-cases', 'uc-1', 'notes', note.id);
    expect(note.entityId).toBe('uc-1');
    expect(note.content).toBe('hello');
    expect(note.createdBy).toBe('user-1');
    expect(note.updatedAt).toBe(note.createdAt); // no "edited" marker on fresh notes
    const [, payload] = mockSetDoc.mock.calls[0];
    expect(payload).toEqual(note);
  });

  it('omits createdBy entirely when the author is unknown (Firestore rejects undefined)', async () => {
    mockSetDoc.mockResolvedValue(undefined);
    const note = await createEntityNote('prototypes', 'p-1', 'anon note');
    expect('createdBy' in note).toBe(false);
  });

  it('wraps write failures', async () => {
    mockSetDoc.mockRejectedValue(new Error('offline'));
    await expect(createEntityNote('prototypes', 'p-1', 'x')).rejects.toThrow(
      'Failed to create note for prototypes/p-1'
    );
  });
});

describe('updateEntityNote', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stamps updatedAt alongside content and returns the committed value', async () => {
    mockUpdateDoc.mockResolvedValue(undefined);
    const before = Date.now();

    const { updatedAt } = await updateEntityNote('strategies', 's-1', 'n-1', 'edited');

    expect(mockDoc).toHaveBeenCalledWith({}, 'strategies', 's-1', 'notes', 'n-1');
    const [, payload] = mockUpdateDoc.mock.calls[0];
    expect(payload.content).toBe('edited');
    expect(payload.updatedAt).toBe(updatedAt);
    expect(updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('wraps update failures', async () => {
    mockUpdateDoc.mockRejectedValue(new Error('nope'));
    await expect(updateEntityNote('strategies', 's-1', 'n-1', 'x')).rejects.toThrow('Failed to update note n-1');
  });
});

describe('deleteAllEntityNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes every note doc under the entity and returns the count', async () => {
    const refs = [{ ref: { __ref: 'a' } }, { ref: { __ref: 'b' } }];
    mockGetDocs.mockResolvedValue({ docs: refs, size: 2 });
    mockDeleteDoc.mockResolvedValue(undefined);

    const { deleteAllEntityNotes } = require('../entity-notes-cleanup');
    const database = {} as import('firebase/firestore').Firestore;
    const count = await deleteAllEntityNotes(database, 'prototypes', 'p-1');

    expect(count).toBe(2);
    expect(mockCollection).toHaveBeenCalledWith(database, 'prototypes', 'p-1', 'notes');
    expect(mockDeleteDoc).toHaveBeenCalledTimes(2);
  });

  it('propagates read failures so the parent entity is retained', async () => {
    mockGetDocs.mockRejectedValue(new Error('offline'));
    const { deleteAllEntityNotes } = require('../entity-notes-cleanup');
    const database = {} as import('firebase/firestore').Firestore;
    await expect(deleteAllEntityNotes(database, 'strategies', 's-1')).rejects.toThrow('offline');
  });

  it('propagates note deletion failures so the parent entity is retained', async () => {
    mockGetDocs.mockResolvedValue({ docs: [{ ref: { __ref: 'a' } }], size: 1 });
    mockDeleteDoc.mockRejectedValue(new Error('delete failed'));
    const { deleteAllEntityNotes } = require('../entity-notes-cleanup');
    const database = {} as import('firebase/firestore').Firestore;

    await expect(deleteAllEntityNotes(database, 'companies', 'c-1')).rejects.toThrow('delete failed');
  });
});

describe('deleteEntityNote', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the note doc under the parent entity', async () => {
    mockDeleteDoc.mockResolvedValue(undefined);
    await deleteEntityNote('prototypes', 'p-1', 'n-1');
    expect(mockDoc).toHaveBeenCalledWith({}, 'prototypes', 'p-1', 'notes', 'n-1');
    expect(mockDeleteDoc).toHaveBeenCalled();
  });

  it('wraps delete failures', async () => {
    mockDeleteDoc.mockRejectedValue(new Error('gone'));
    await expect(deleteEntityNote('prototypes', 'p-1', 'n-1')).rejects.toThrow('Failed to delete note n-1');
  });
});

// UX-024/025/026: the shared contract now also serves Org Units, Initiatives,
// and Pain Points. The parent value IS the Firestore collection name, and it is
// NOT uniform casing — `painPoints` is camelCase while the others are kebab-case
// (see the entity services). A typo would silently write notes to a phantom
// collection, so lock the exact subcollection path per new parent.
describe('library entity collections (UX-024/025/026)', () => {
  beforeEach(() => jest.clearAllMocks());

  const cases: Array<[string, string]> = [
    ['org-units', 'ou-1'],
    ['initiatives', 'init-1'],
    ['painPoints', 'pp-1'],
  ];

  it.each(cases)('reads notes under %s/%s/notes', async (parent, id) => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    await getEntityNotes(parent, id);
    expect(mockCollection).toHaveBeenCalledWith({}, parent, id, 'notes');
  });

  it.each(cases)('creates a note under %s/%s/notes', async (parent, id) => {
    mockSetDoc.mockResolvedValue(undefined);
    const note = await createEntityNote(parent, id, 'hello', 'user-1');
    expect(mockDoc).toHaveBeenCalledWith({}, parent, id, 'notes', note.id);
    expect(note.entityId).toBe(id);
  });

  it.each(cases)('deletes a note under %s/%s/notes', async (parent, id) => {
    mockDeleteDoc.mockResolvedValue(undefined);
    await deleteEntityNote(parent, id, 'n-1');
    expect(mockDoc).toHaveBeenCalledWith({}, parent, id, 'notes', 'n-1');
  });
});
