/**
 * GRAPH-056 — retiring an anchor is the one irreversible step in the recovery
 * contract. These cases pin that it happens only against the exact anchor the
 * caller proved converged, which is what stops a delayed v1 completion from
 * clearing a v2 debt.
 */

const transactionGet = jest.fn();
const transactionDelete = jest.fn();
const documentGet = jest.fn();
const docFactory = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({ doc: docFactory })),
    runTransaction: jest.fn(async (handler: (transaction: unknown) => Promise<unknown>) =>
      handler({ get: transactionGet, delete: transactionDelete })
    ),
  },
}));

import { buildEntityGraphSyncOutboxRecord, entityGraphSyncOutboxDocumentId } from '@/lib/entity-graph-sync-outbox';
import {
  clearConvergedEntityGraphSyncAnchor,
  readEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-admin';

const TIMESTAMP = 1_752_000_000_000;
const DOCUMENT_ID = entityGraphSyncOutboxDocumentId('company', 'company-1');

function anchorWithGeneration(generation: string, updatedAt = TIMESTAMP) {
  return {
    ...buildEntityGraphSyncOutboxRecord({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      generation,
      timestamp: TIMESTAMP,
    }),
    updatedAt,
  };
}

function snapshot(data: unknown | null) {
  return {
    exists: data !== null,
    id: DOCUMENT_ID,
    data: () => data,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  docFactory.mockReturnValue({ get: documentGet });
});

describe('clearing a converged anchor', () => {
  it('removes the anchor the caller settled', async () => {
    transactionGet.mockResolvedValue(snapshot(anchorWithGeneration('a'.repeat(32))));

    await expect(clearConvergedEntityGraphSyncAnchor('company', 'company-1', 'a'.repeat(32))).resolves.toBe(
      'cleared'
    );
    expect(transactionDelete).toHaveBeenCalledTimes(1);
  });

  it('leaves a replacement anchor in place even when both writes share one millisecond', async () => {
    // The v1/v2 race: a delayed completion settles the debt it observed, but a
    // later mutation has since failed its own handoff and rewritten the anchor.
    // Timestamps are intentionally identical: only the immutable generation
    // token may decide which debt the completion observed.
    transactionGet.mockResolvedValue(snapshot(anchorWithGeneration('b'.repeat(32), TIMESTAMP)));

    await expect(clearConvergedEntityGraphSyncAnchor('company', 'company-1', 'a'.repeat(32))).resolves.toBe(
      'superseded'
    );
    expect(transactionDelete).not.toHaveBeenCalled();
  });

  it('reports an already-absent anchor without deleting', async () => {
    transactionGet.mockResolvedValue(snapshot(null));

    await expect(clearConvergedEntityGraphSyncAnchor('company', 'company-1', 'a'.repeat(32))).resolves.toBe(
      'absent'
    );
    expect(transactionDelete).not.toHaveBeenCalled();
  });

  it('removes a malformed anchor rather than stranding the entity', async () => {
    // It cannot be proven settled, but reconciliation repairs from fingerprint
    // drift rather than from anchors, so removal cannot cost convergence —
    // whereas keeping it would report a pending sync forever.
    transactionGet.mockResolvedValue(snapshot({ entityType: 'company', attempt: 'not-a-number' }));

    await expect(clearConvergedEntityGraphSyncAnchor('company', 'company-1', 'a'.repeat(32))).resolves.toBe(
      'cleared'
    );
    expect(transactionDelete).toHaveBeenCalledTimes(1);
  });
});

describe('reading an anchor', () => {
  it('returns null when none exists', async () => {
    documentGet.mockResolvedValue(snapshot(null));
    await expect(readEntityGraphSyncAnchor('company', 'company-1')).resolves.toBeNull();
  });

  it('returns a well-formed anchor', async () => {
    documentGet.mockResolvedValue(snapshot(anchorWithGeneration('a'.repeat(32))));
    await expect(readEntityGraphSyncAnchor('company', 'company-1')).resolves.toMatchObject({
      entityId: 'company-1',
      generation: 'a'.repeat(32),
      updatedAt: TIMESTAMP,
    });
  });

  it('throws on a malformed anchor instead of reading it as settled', async () => {
    documentGet.mockResolvedValue(snapshot({ entityType: 'company', entityId: 'company-1', attempt: -5 }));
    await expect(readEntityGraphSyncAnchor('company', 'company-1')).rejects.toThrow(/Malformed/);
  });
});
