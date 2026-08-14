/**
 * @file seed-demo-scale.test.ts
 * @description Task 16 (A1) regression guard: DEMO_RELATIONS.confidence must
 * live on the SAME 0-100 scale as everything else in the Relation Write
 * Contract (r.confidence in Neo4j, Relation.confidence in Firestore).
 *
 * Prior to this task, DEMO_RELATIONS carried a 0-1 display-scale confidence
 * that the Neo4j-sync mapper multiplied by 100 (`Math.round(r.confidence *
 * 100)`) before writing to the graph — but `batch.set(doc(db, 'relations',
 * relation.id), relation)` wrote the RAW 0-1 value straight to Firestore,
 * which RelationsTab (and any other 0-100-scale consumer) renders as a
 * sub-1% badge. Storing the value on the 0-100 scale from the start fixes
 * both the graph AND the Firestore display bug in one move.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
  collection: jest.fn(),
  getDocs: jest.fn(),
  writeBatch: jest.fn(() => ({ set: jest.fn(), delete: jest.fn(), commit: jest.fn() })),
  doc: jest.fn(),
}));

jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn(),
}));
jest.mock('@/lib/graph/relation-assertion-sync', () => ({
  syncRelationAsAssertion: jest.fn(),
  syncRelationAsEdge: jest.fn(),
}));

import { DEMO_RELATIONS } from '../seed-demo';

describe('DEMO_RELATIONS confidence scale (Task 16 A1)', () => {
  it('DEMO_RELATIONS confidences are integers in [1,100]', () => {
    for (const relation of DEMO_RELATIONS) {
      expect(Number.isInteger(relation.confidence)).toBe(true);
      expect(relation.confidence).toBeGreaterThanOrEqual(1);
      expect(relation.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('none of the raw values look like a stray 0-1 fraction', () => {
    for (const relation of DEMO_RELATIONS) {
      expect(relation.confidence).toBeGreaterThan(1);
    }
  });
});
