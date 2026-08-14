/**
 * Shared mock helper for `@/lib/firebase-admin` (admin SDK chainable API).
 *
 * Mirrors the surface we actually use: `db.collection(...).doc(...).set/get/update/delete`
 * and `db.collection(...).where(...).orderBy(...).limit(...).get()`.
 *
 * Each chain leaf returns a jest.fn() so tests can drive return values and
 * inspect call args. Example:
 *
 *   const { adminMock } = createFirebaseAdminMock();
 *   jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
 *
 *   adminMock.get.mockResolvedValue({ docs: [], empty: true });
 *   adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
 *
 * The mock is intentionally permissive (every chain returns `this`) — tests
 * that care about ordering should assert on the specific spies (collection,
 * doc, set, etc.) directly.
 */

export function createFirebaseAdminMock() {
  // Collection-level operations (used in chains).
  const set = jest.fn().mockResolvedValue(undefined);
  const update = jest.fn().mockResolvedValue(undefined);
  const del = jest.fn().mockResolvedValue(undefined);
  // `doc(...).get()` — returns a DocumentSnapshot.
  const docGet = jest.fn().mockResolvedValue({
    exists: false,
    data: () => null,
    id: 'doc-id',
    ref: {},
  });
  // `collection(...).orderBy/where/limit/get()` — returns a QuerySnapshot.
  const get = jest.fn().mockResolvedValue({
    empty: true,
    size: 0,
    docs: [],
  });

  // --- Sub-collection support (e.g. reports/{id}/versions, DISC-014) --------
  // A doc can open a subcollection: docRef.collection('versions'). It has its
  // own query chain + `get` spy (`subGet`) so a test can drive the subcollection
  // read independently of the top-level `get`. `.doc()` with an id returns a
  // stable ref (with its own `subDocGet`) for point reads; `.doc()` with no id
  // returns a fresh ref (unique id) for creating new docs — matching the admin
  // SDK auto-id behaviour that version capture relies on.
  const subGet = jest.fn().mockResolvedValue({ empty: true, size: 0, docs: [] });
  const subDocGet = jest.fn().mockResolvedValue({ exists: false, data: () => null, id: 'sub-doc' });
  const subDocRef = { get: subDocGet, set: jest.fn(), update: jest.fn(), delete: jest.fn() };
  let subDocCounter = 0;
  const subCollectionRef: Record<string, jest.Mock> & { get: jest.Mock } = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    startAfter: jest.fn(),
    select: jest.fn(),
    get: subGet,
    doc: jest.fn((id?: string) => (id ? subDocRef : { id: `sub-${++subDocCounter}` })),
    add: jest.fn(),
  };
  for (const m of ['where', 'orderBy', 'limit', 'startAfter', 'select']) {
    (subCollectionRef[m] as jest.Mock).mockReturnValue(subCollectionRef);
  }

  // Doc reference — terminates chain at doc.
  const docRef = {
    get: docGet,
    set,
    update,
    delete: del,
    collection: jest.fn(() => subCollectionRef),
  };

  // Query-builder methods all return the collection ref so chains work.
  // `doc()` is the only call that switches to the doc ref.
  const collectionRef: Record<string, jest.Mock> & {
    get: jest.Mock;
  } = {
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    startAfter: jest.fn(),
    select: jest.fn(),
    doc: jest.fn().mockReturnValue(docRef),
    get,
    add: jest.fn(),
  };
  // Chain methods that should return `this` after construction.
  for (const m of ['where', 'orderBy', 'limit', 'startAfter', 'select']) {
    (collectionRef[m] as jest.Mock).mockReturnValue(collectionRef);
  }

  const collection = jest.fn().mockReturnValue(collectionRef);

  const transactionGet = jest.fn(async (reference: { get: () => Promise<unknown> }) => reference.get());
  const transactionSet = jest.fn().mockResolvedValue(undefined);
  const transactionUpdate = jest.fn().mockResolvedValue(undefined);
  const transactionDelete = jest.fn().mockResolvedValue(undefined);
  const transaction = {
    get: transactionGet,
    set: transactionSet,
    update: transactionUpdate,
    delete: transactionDelete,
  };
  const runTransaction = jest.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction));
  const recursiveDelete = jest.fn().mockResolvedValue(undefined);

  const db = { collection, runTransaction, recursiveDelete };

  return {
    adminMock: {
      db,
      // Spies — exposed for test assertions.
      collection,
      doc: collectionRef.doc as jest.Mock,
      where: collectionRef.where as jest.Mock,
      orderBy: collectionRef.orderBy as jest.Mock,
      limit: collectionRef.limit as jest.Mock,
      get,
      docGet,
      set,
      update,
      delete: del,
      runTransaction,
      recursiveDelete,
      transactionGet,
      transactionSet,
      transactionUpdate,
      transactionDelete,
      // Sub-collection spies (DISC-014 report versions).
      subCollection: docRef.collection as jest.Mock,
      subGet,
      subDocGet,
      subDocRef,
      subDoc: subCollectionRef.doc as jest.Mock,
      subSelect: subCollectionRef.select as jest.Mock,
      subOrderBy: subCollectionRef.orderBy as jest.Mock,
    },
  };
}

/**
 * Build a fake QuerySnapshot from an array of doc payloads. Each entry
 * accepts an `id` field that gets mapped to the doc id, and the rest is
 * returned by `.data()`.
 */
export function fakeQuerySnapshot<T extends { id?: string }>(docs: T[]) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: docs.map((d) => {
      // A matched doc's ref must also support a transactional re-read
      // (tx.get(ref) → ref.get()) and a `versions` subcollection, so the
      // upsert update path (now transactional, DISC-014) works against it.
      const versionsRef: Record<string, jest.Mock> = {
        orderBy: jest.fn(),
        limit: jest.fn(),
        select: jest.fn(),
        where: jest.fn(),
        get: jest.fn().mockResolvedValue({ empty: true, size: 0, docs: [] }),
        doc: jest.fn((id?: string) =>
          id
            ? {
                get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
                set: jest.fn(),
                update: jest.fn(),
              }
            : { id: 'ver-new' }
        ),
      };
      for (const m of ['orderBy', 'limit', 'select', 'where']) {
        (versionsRef[m] as jest.Mock).mockReturnValue(versionsRef);
      }
      const ref = {
        get: jest.fn().mockResolvedValue({ exists: true, id: d.id ?? 'doc-id', data: () => d }),
        update: jest.fn(),
        delete: jest.fn(),
        set: jest.fn(),
        collection: jest.fn(() => versionsRef),
      };
      return { id: d.id ?? 'doc-id', data: () => d, ref, exists: true };
    }),
  };
}

/** Fake DocumentSnapshot helper. */
export function fakeDocSnapshot<T>(data: T | null, id = 'doc-id') {
  return {
    exists: data !== null,
    id,
    data: () => data,
    ref: { update: jest.fn(), delete: jest.fn(), set: jest.fn() },
  };
}
