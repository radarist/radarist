/**
 * ARUN-022 — live Admin-SDK durable parent accounting marker against a REAL
 * Firestore emulator (no mocks). Proves TERMINAL TRUTH of receipt-loss recording:
 *   - a batch marker upserts to its per-batch slot, read back owner-scoped;
 *   - INDEPENDENT batches under one parent both persist (concurrent-safe);
 *   - loss→success ordering: an earlier batch's loss is NOT erased by a later
 *     complete batch — the whole-of-parent roll-up stays incomplete;
 *   - `accountingState` is derived, never trusted; reads fail closed across owners.
 *
 * @jest-environment node
 */

import { db as adminDb } from '@/lib/firebase-admin';
import {
  upsertParentAccountingMarker,
  getParentAccountingMarker,
  getParentAccountingState,
} from '@/lib/operation-accounting-marker-repository';
import { deriveParentAccountingMarkerId } from '@/lib/schemas/operation-accounting-marker';

const COLLECTION = 'operationAccountingMarkers';
const OWNER = 'workspace-marker-emulator';
const written = new Set<string>();

async function mark(
  correlationId: string,
  batchId: string,
  counts: { expected: number; written: number; replayed: number; conflicted: number; failed: number }
) {
  const marker = await upsertParentAccountingMarker({
    owner: OWNER,
    parentType: 'verification',
    correlationId,
    batchId,
    ...counts,
    occurredAt: '2026-07-22T09:00:00.000Z',
  });
  written.add(marker.id);
  return marker;
}

afterAll(async () => {
  await Promise.all(
    [...written].map((id) =>
      adminDb
        .collection(COLLECTION)
        .doc(id)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb.terminate();
});

describe('operation-accounting-marker repository (live emulator)', () => {
  it('upserts a per-batch marker and reads it back owner-scoped', async () => {
    const correlationId = 'marker-complete';
    const marker = await mark(correlationId, 'b1', {
      expected: 2,
      written: 2,
      replayed: 0,
      conflicted: 0,
      failed: 0,
    });
    expect(marker.accountingState).toBe('complete');

    const read = await getParentAccountingMarker(OWNER, 'verification', correlationId, 'b1');
    expect(read?.accountingState).toBe('complete');
    expect(read?.id).toBe(
      deriveParentAccountingMarkerId({ owner: OWNER, parentType: 'verification', correlationId, batchId: 'b1' })
    );
    // Fail closed across owners.
    expect(await getParentAccountingMarker('workspace-other', 'verification', correlationId, 'b1')).toBeNull();
  });

  it('loss→success ordering: an earlier batch loss is NOT erased by a later complete batch', async () => {
    const correlationId = 'marker-loss-then-success';
    // Batch 1 loses a receipt (conflict) → incomplete.
    await mark(correlationId, 'b1', { expected: 2, written: 1, replayed: 0, conflicted: 1, failed: 0 });
    // Batch 2, an INDEPENDENT later flush, is complete.
    await mark(correlationId, 'b2', { expected: 1, written: 1, replayed: 0, conflicted: 0, failed: 0 });

    // The whole-of-parent roll-up stays INCOMPLETE — the earlier loss survives.
    const state = await getParentAccountingState(OWNER, 'verification', correlationId);
    expect(state?.accountingState).toBe('incomplete');
    expect(state?.batchCount).toBe(2);
    expect(state?.conflicted).toBe(1);
    expect(state?.written).toBe(2);
  });

  it('concurrent independent batches under one parent BOTH persist (no erasure)', async () => {
    const correlationId = 'marker-concurrent';
    await Promise.all([
      mark(correlationId, 'c1', { expected: 1, written: 1, replayed: 0, conflicted: 0, failed: 0 }),
      mark(correlationId, 'c2', { expected: 1, written: 0, replayed: 0, conflicted: 0, failed: 1 }),
    ]);
    const state = await getParentAccountingState(OWNER, 'verification', correlationId);
    expect(state?.batchCount).toBe(2);
    // The failed batch keeps the parent incomplete despite the other succeeding.
    expect(state?.accountingState).toBe('incomplete');
    expect(state?.failed).toBe(1);
  });

  it('a re-flush of the SAME batch is idempotent (same slot, not a new batch)', async () => {
    const correlationId = 'marker-idempotent';
    await mark(correlationId, 'same', { expected: 1, written: 1, replayed: 0, conflicted: 0, failed: 0 });
    await mark(correlationId, 'same', { expected: 1, written: 0, replayed: 1, conflicted: 0, failed: 0 });
    const state = await getParentAccountingState(OWNER, 'verification', correlationId);
    expect(state?.batchCount).toBe(1); // one slot, not two
  });
});
