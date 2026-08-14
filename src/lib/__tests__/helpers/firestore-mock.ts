/**
 * Shared Firestore mock utility for unit tests.
 *
 * Provides a reusable mock of `firebase/firestore` functions that
 * can be imported into test files instead of duplicating the mock factory.
 *
 * Usage:
 * ```typescript
 * import { createFirestoreMocks, createMockDocSnapshot, createMockQuerySnapshot } from './helpers/firestore-mock';
 *
 * const mocks = createFirestoreMocks();
 * jest.mock('firebase/firestore', () => mocks.factory);
 * ```
 */

export function createFirestoreMocks() {
  const collection = jest.fn();
  const doc = jest.fn();
  const getDocs = jest.fn();
  const getDoc = jest.fn();
  const setDoc = jest.fn();
  const updateDoc = jest.fn();
  const deleteDoc = jest.fn();
  const query = jest.fn();
  const where = jest.fn();
  const orderBy = jest.fn();
  const limit = jest.fn();
  const runTransaction = jest.fn();

  return {
    collection,
    doc,
    getDocs,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy,
    limit,
    runTransaction,
    factory: {
      __esModule: true,
      collection,
      doc,
      getDocs,
      getDoc,
      setDoc,
      updateDoc,
      deleteDoc,
      query,
      where,
      orderBy,
      limit,
      runTransaction,
    },
  };
}

/**
 * Create a mock Firestore document snapshot.
 */
export function createMockDocSnapshot<T extends object>(
  data: T | null,
  id?: string
) {
  return {
    exists: () => data !== null,
    data: () => data,
    id: id ?? (data as Record<string, unknown>)?.id ?? 'mock-id',
  };
}

/**
 * Create a mock Firestore query snapshot.
 */
export function createMockQuerySnapshot<T extends object>(docs: T[]) {
  return {
    docs: docs.map((d) => ({
      data: () => d,
      id: (d as Record<string, unknown>).id ?? 'mock-id',
      exists: () => true,
    })),
    size: docs.length,
    empty: docs.length === 0,
    forEach: (cb: (doc: { data: () => T; id: string }) => void) => {
      docs.forEach((d) =>
        cb({
          data: () => d,
          id: (d as Record<string, unknown>).id as string ?? 'mock-id',
        })
      );
    },
  };
}
