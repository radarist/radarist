/**
 * @file lib/__tests__/operation-accounting-marker-repository.test.ts
 * @description ARUN-022 — durable parent accounting marker repository.
 *
 * Covers: the marker upserts to a deterministic owner-scoped slot; `accountingState`
 * is DERIVED from the counts (never trusted); reads are owner-scoped.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock } from './helpers/firebase-admin-mock';
import { deriveParentAccountingMarkerId } from '../schemas/operation-accounting-marker';
import { sanitizeForFirestore } from '../firestore-sanitize';
import type { CreateParentAccountingMarkerInput } from '../schemas/operation-accounting-marker';

const { adminMock } = createFirebaseAdminMock();

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

const {
  upsertParentAccountingMarker,
  getParentAccountingMarker,
  getParentAccountingState,
} = require('../operation-accounting-marker-repository');

function input(overrides: Partial<CreateParentAccountingMarkerInput> = {}): CreateParentAccountingMarkerInput {
  return {
    owner: 'workspace-abc',
    parentType: 'verification',
    correlationId: 'inngest-run-1',
    batchId: 'vr-1',
    expected: 2,
    written: 2,
    replayed: 0,
    conflicted: 0,
    failed: 0,
    occurredAt: '2026-07-22T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
});

describe('upsertParentAccountingMarker', () => {
  it('writes to the deterministic owner-scoped slot and derives a complete state', async () => {
    const marker = await upsertParentAccountingMarker(input());
    const expectedId = deriveParentAccountingMarkerId(input());
    expect(adminMock.collection).toHaveBeenCalledWith('operationAccountingMarkers');
    expect(adminMock.doc).toHaveBeenCalledWith(expectedId);
    expect(adminMock.set).toHaveBeenCalledTimes(1);
    expect(marker.accountingState).toBe('complete');
    expect(marker.id).toBe(expectedId);
    expect(typeof marker.recordedAt).toBe('string');
  });

  it('derives an INCOMPLETE state when a capture conflicted or failed (never trusts a caller state)', async () => {
    const marker = await upsertParentAccountingMarker(input({ written: 1, conflicted: 1 }));
    expect(marker.accountingState).toBe('incomplete');
    const written = adminMock.set.mock.calls[0][0];
    expect(written.accountingState).toBe('incomplete');
  });

  it('rejects a count set that does not partition expected (fails before write)', async () => {
    await expect(upsertParentAccountingMarker(input({ expected: 9 }))).rejects.toThrow();
    expect(adminMock.set).not.toHaveBeenCalled();
  });
});

describe('getParentAccountingMarker — owner-scoped, per-batch', () => {
  it('returns the batch marker for its owner; a different owner reads a different (empty) slot → null', async () => {
    const stored = sanitizeForFirestore({
      ...input(),
      accountingState: 'complete',
      id: deriveParentAccountingMarkerId(input()),
      recordedAt: '2026-07-22T09:05:00.000Z',
    });
    // Only the owner's own deterministic slot holds the doc; another owner derives a
    // different id → an empty slot (the default not-exists), so it fails closed.
    adminMock.docGet.mockResolvedValueOnce({ exists: true, data: () => stored });
    const mine = await getParentAccountingMarker('workspace-abc', 'verification', 'inngest-run-1', 'vr-1');
    expect(mine?.accountingState).toBe('complete');
    expect(await getParentAccountingMarker('workspace-other', 'verification', 'inngest-run-1', 'vr-1')).toBeNull();
  });

  it('returns null when the marker is absent', async () => {
    adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });
    expect(await getParentAccountingMarker('workspace-abc', 'verification', 'missing', 'vr-1')).toBeNull();
  });
});

describe('getParentAccountingState — whole-of-parent roll-up (terminal truth)', () => {
  it('rolls up every batch and stays incomplete while ANY batch loss is unresolved', async () => {
    const lost = sanitizeForFirestore({
      ...input({ batchId: 'b1', expected: 2, written: 1, conflicted: 1 }),
      accountingState: 'incomplete',
      id: deriveParentAccountingMarkerId(input({ batchId: 'b1' })),
      recordedAt: '2026-07-22T09:05:00.000Z',
    });
    const ok = sanitizeForFirestore({
      ...input({ batchId: 'b2', expected: 1, written: 1 }),
      accountingState: 'complete',
      id: deriveParentAccountingMarkerId(input({ batchId: 'b2' })),
      recordedAt: '2026-07-22T09:06:00.000Z',
    });
    adminMock.get.mockResolvedValue({ docs: [ok, lost].map((d) => ({ id: d.id, data: () => d })) });
    const state = await getParentAccountingState('workspace-abc', 'verification', 'inngest-run-1');
    expect(adminMock.where).toHaveBeenCalledWith('correlationId', '==', 'inngest-run-1');
    expect(state).toMatchObject({ accountingState: 'incomplete', batchCount: 2, conflicted: 1, written: 2 });
  });

  it('returns null when the parent has no markers', async () => {
    adminMock.get.mockResolvedValue({ docs: [] });
    expect(await getParentAccountingState('workspace-abc', 'verification', 'none')).toBeNull();
  });
});
