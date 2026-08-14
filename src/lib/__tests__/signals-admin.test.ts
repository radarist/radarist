/**
 * @file signals-admin.test.ts
 * @description Locks the narrow admin-SDK read used by `trends.ts`
 * (and by extension the daily-pipeline Inngest function). Drift here
 * will reproduce the 2026-05-14 failure where the trend step crashed
 * with "Failed to fetch signals by status Validated" because the
 * server caller was reaching the client SDK.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock, fakeDocSnapshot, fakeQuerySnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();

// The shared admin mock doesn't model `db.batch()` — add a minimal batch
// spy so the cascade-delete paths (adminDeleteSignals) can be exercised.
const batchDelete = jest.fn();
const batchCommit = jest.fn().mockResolvedValue(undefined);
const batch = jest.fn(() => ({ delete: batchDelete, commit: batchCommit }));
(adminMock.db as unknown as { batch: jest.Mock }).batch = batch;

// Relation cascades re-read each candidate and its triple lock in a transaction
// before deleting. Model that narrow admin-SDK surface so this suite exercises
// the real lock-aware cascade instead of silently taking its error fallback.
const transactionGet = jest.fn().mockResolvedValue(fakeDocSnapshot(null));
const transactionDelete = jest.fn();
const transactionUpdate = jest.fn();
const transactionSet = jest.fn();
const runTransaction = jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
  callback({ get: transactionGet, delete: transactionDelete, update: transactionUpdate, set: transactionSet })
);
(adminMock.db as unknown as { runTransaction: jest.Mock }).runTransaction = runTransaction;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/firebase', () => {
  throw new Error('signals-admin must not import the Firebase client runtime');
});

const deleteLinksForEntity = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminDeleteLinksForEntity: deleteLinksForEntity,
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// Stub the server-safe graph-sync trigger (dynamically imported inside
// adminDeleteSignals) so tests don't fan out to Inngest.
const triggerEntitySync = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/entity-sync', () => ({ triggerEntitySync }));

// adminUpdateSignal (called by adminApproveSignal/adminRejectSignal) dynamically imports the
// Inngest client to fire the best-effort graph-sync event — stub it so those tests don't hit
// the network.
const inngestSend = jest.fn().mockResolvedValue({ ids: ['test-event-id'] });
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: inngestSend } }));

// steerSignalInterest (T27) — the shared interest-steering helper adminApproveSignal /
// adminRejectSignal fold into when a feedbackUserId is supplied. Dynamically imported inside
// signals-admin.ts, mocked here so these tests assert the WIRING (called with the right
// signal/vote/userId/reason) without dragging in the real discovery/graph-preferences chain.
const steerSignalInterest = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/signals/feedback', () => ({ steerSignalInterest }));

// Lazy-load via require so the module's `import { db }` resolves
// AFTER `adminMock` is initialised (same hoist trap as
// radars-admin.test.ts).
const {
  adminGetSignalsByStatus,
  adminGetArchivedSignals,
  adminDeleteSignals,
  adminCleanupArchivedSignals,
  adminApproveSignal,
  adminRejectSignal,
  adminArchiveSignals,
  adminRestoreSignals,
} = require('../signals-admin');

describe('adminGetSignalsByStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the signals collection with the requested status', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 's1', status: 'Validated', detectedAt: 100 },
        { id: 's2', status: 'Validated', detectedAt: 200 },
      ])
    );
    const out = await adminGetSignalsByStatus('Validated');
    expect(adminMock.where).toHaveBeenCalledWith('status', '==', 'Validated');
    expect(out).toHaveLength(2);
  });

  it('sorts results by detectedAt desc (newest first)', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 's-old', status: 'Validated', detectedAt: 100 },
        { id: 's-new', status: 'Validated', detectedAt: 300 },
        { id: 's-mid', status: 'Validated', detectedAt: 200 },
      ])
    );
    const out = await adminGetSignalsByStatus('Validated');
    expect(out.map((s: { id: string }) => s.id)).toEqual(['s-new', 's-mid', 's-old']);
  });

  it('honors maxResults', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 's1', status: 'Validated', detectedAt: 100 },
        { id: 's2', status: 'Validated', detectedAt: 200 },
        { id: 's3', status: 'Validated', detectedAt: 300 },
      ])
    );
    const out = await adminGetSignalsByStatus('Validated', 2);
    expect(out).toHaveLength(2);
  });

  it('rethrows with a friendly message on failure', async () => {
    adminMock.get.mockRejectedValueOnce(new Error('Network error'));
    await expect(adminGetSignalsByStatus('Validated')).rejects.toThrow(/Failed to fetch signals by status Validated/);
  });
});

describe('adminGetArchivedSignals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the signals collection filtered to Archived', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([{ id: 'a1', status: 'Archived', detectedAt: 100, metadata: { archivedAt: 500 } }])
    );
    const out = await adminGetArchivedSignals();
    expect(adminMock.where).toHaveBeenCalledWith('status', '==', 'Archived');
    expect(out).toHaveLength(1);
  });

  it('sorts by metadata.archivedAt desc, falling back to detectedAt', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 'a-old', status: 'Archived', detectedAt: 1, metadata: { archivedAt: 100 } },
        { id: 'a-new', status: 'Archived', detectedAt: 1, metadata: { archivedAt: 300 } },
        { id: 'a-fallback', status: 'Archived', detectedAt: 250 }, // no archivedAt → uses detectedAt
      ])
    );
    const out = await adminGetArchivedSignals();
    expect(out.map((s: { id: string }) => s.id)).toEqual(['a-new', 'a-fallback', 'a-old']);
  });

  it('honors maxResults', async () => {
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([
        { id: 'a1', status: 'Archived', detectedAt: 100, metadata: { archivedAt: 100 } },
        { id: 'a2', status: 'Archived', detectedAt: 200, metadata: { archivedAt: 200 } },
        { id: 'a3', status: 'Archived', detectedAt: 300, metadata: { archivedAt: 300 } },
      ])
    );
    const out = await adminGetArchivedSignals(2);
    expect(out).toHaveLength(2);
  });

  it('rethrows with a friendly message on failure', async () => {
    adminMock.get.mockRejectedValueOnce(new Error('boom'));
    await expect(adminGetArchivedSignals()).rejects.toThrow(/Failed to fetch archived signals/);
  });
});

describe('adminDeleteSignals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cascade-deletes relations, batch-deletes signals, and syncs each id', async () => {
    // Two relation queries (source + target) per signal id → return empty for both.
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([]));

    const result = await adminDeleteSignals(['s1', 's2']);

    expect(deleteLinksForEntity).toHaveBeenCalledWith('signal', 's1');
    expect(deleteLinksForEntity).toHaveBeenCalledWith('signal', 's2');
    // Relations queried by both source and target snapshot id.
    expect(adminMock.where).toHaveBeenCalledWith('sourceSnapshot.id', '==', 's1');
    expect(adminMock.where).toHaveBeenCalledWith('targetSnapshot.id', '==', 's1');
    // Signal docs batch-deleted + committed.
    expect(batchDelete).toHaveBeenCalledTimes(2);
    expect(batchCommit).toHaveBeenCalled();
    // Graph sync fired per deleted signal.
    expect(triggerEntitySync).toHaveBeenCalledWith('signal', 's1', 'delete');
    expect(triggerEntitySync).toHaveBeenCalledWith('signal', 's2', 'delete');
    expect(result).toEqual({ deleted: 2, failed: [], relationsDeleted: 0 });
  });

  it('counts cascade-deleted relations (deduped across source/target)', async () => {
    // For the single id: source query returns r1+r2, target query returns r2+r3.
    // Dedup → r1, r2, r3 = 3 relations deleted.
    adminMock.get
      .mockResolvedValueOnce(fakeQuerySnapshot([{ id: 'r1' }, { id: 'r2' }])) // source
      .mockResolvedValueOnce(fakeQuerySnapshot([{ id: 'r2' }, { id: 'r3' }])); // target
    transactionGet
      .mockResolvedValueOnce(
        fakeDocSnapshot({ sourceSnapshot: { id: 's1' }, targetSnapshot: { id: 't1' }, relationType: 'uses' }, 'r1')
      )
      .mockResolvedValueOnce(
        fakeDocSnapshot({ sourceSnapshot: { id: 's1' }, targetSnapshot: { id: 't2' }, relationType: 'uses' }, 'r2')
      )
      .mockResolvedValueOnce(
        fakeDocSnapshot({ sourceSnapshot: { id: 's1' }, targetSnapshot: { id: 't3' }, relationType: 'uses' }, 'r3')
      );

    const result = await adminDeleteSignals(['s1']);
    expect(result.relationsDeleted).toBe(3);
    expect(result.deleted).toBe(1);
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(transactionDelete).toHaveBeenCalledTimes(3);
    expect(transactionSet).toHaveBeenCalledTimes(3);
    expect(inngestSend.mock.calls.map(([event]) => event.data.relationId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('records the batch ids as failed when the signal-doc commit throws', async () => {
    adminMock.get.mockResolvedValue(fakeQuerySnapshot([])); // no relations
    // First commit calls are the (empty) relation batches — but relations are
    // empty so no relation batch runs; the signal-doc commit is the failing one.
    batchCommit.mockRejectedValueOnce(new Error('commit failed'));

    const result = await adminDeleteSignals(['s1']);
    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual(['s1']);
  });

  it('retains the exact signal when document-link cleanup fails', async () => {
    deleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

    const result = await adminDeleteSignals(['s1']);

    expect(result).toEqual({ deleted: 0, failed: ['s1'], relationsDeleted: 0 });
    expect(batchDelete).not.toHaveBeenCalled();
  });

  it('retains the exact signal when relation cleanup cannot be read', async () => {
    adminMock.get.mockRejectedValueOnce(new Error('relation read failed'));

    const result = await adminDeleteSignals(['s1']);

    expect(result).toEqual({ deleted: 0, failed: ['s1'], relationsDeleted: 0 });
    expect(batchDelete).not.toHaveBeenCalled();
  });
});

describe('adminCleanupArchivedSignals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('early-returns { deleted: 0, failed: [] } when nothing is past the cutoff', async () => {
    const now = Date.now();
    // Archived very recently → inside the retention window, not deleted.
    adminMock.get.mockResolvedValueOnce(
      fakeQuerySnapshot([{ id: 'fresh', status: 'Archived', detectedAt: now, metadata: { archivedAt: now } }])
    );
    const result = await adminCleanupArchivedSignals(90);
    expect(result).toEqual({ deleted: 0, failed: [] });
    // No batch deletes attempted.
    expect(batchCommit).not.toHaveBeenCalled();
  });

  it('deletes signals archived before the cutoff and returns { deleted, failed }', async () => {
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago
    // getArchivedSignals → one stale signal; subsequent relation queries empty.
    adminMock.get
      .mockResolvedValueOnce(
        fakeQuerySnapshot([{ id: 'stale', status: 'Archived', detectedAt: old, metadata: { archivedAt: old } }])
      )
      .mockResolvedValue(fakeQuerySnapshot([])); // relation lookups

    const result = await adminCleanupArchivedSignals(90);
    expect(result).toEqual({ deleted: 1, failed: [] });
    expect(triggerEntitySync).toHaveBeenCalledWith('signal', 'stale', 'delete');
  });

  it('wraps fetch failures in a friendly message', async () => {
    adminMock.get.mockRejectedValueOnce(new Error('db down'));
    await expect(adminCleanupArchivedSignals(30)).rejects.toThrow(/Failed to cleanup archived signals/);
  });
});

// =============================================================================
// T27 — the LIVE admin approve/reject services (used by the AI chat executors) learn.
// Previously these skipped the interest-steering posterior entirely; only the triage-UI
// thumbs path (submitSignalFeedback) recorded it. `options.feedbackUserId`, when supplied,
// folds the approve/reject into the SAME `steerSignalInterest` helper a thumbs vote uses.
// =============================================================================
describe('adminApproveSignal — interest-steering (T27)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', feedback: undefined }),
      id: 'sig1',
      ref: {},
    });
  });

  it('with feedbackUserId records the same posterior move as a thumbs-up', async () => {
    await adminApproveSignal('sig1', 'Looks promising', { feedbackUserId: 'user-1' });

    expect(adminMock.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Approved' }));
    expect(steerSignalInterest).toHaveBeenCalledTimes(1);
    const [signalArg, voteArg, userIdArg, reasonArg] = steerSignalInterest.mock.calls[0];
    expect(signalArg).toMatchObject({ id: 'sig1' });
    expect(voteArg).toBe('up');
    expect(userIdArg).toBe('user-1');
    expect(reasonArg).toBe('Looks promising');
  });

  it('no feedbackUserId (agent principal) → no posterior write, approval still succeeds', async () => {
    await expect(adminApproveSignal('sig1', 'notes')).resolves.toBeUndefined();
    expect(adminMock.update).toHaveBeenCalled();
    expect(steerSignalInterest).not.toHaveBeenCalled();
  });

  it('approval still succeeds even when steerSignalInterest rejects (best-effort)', async () => {
    steerSignalInterest.mockRejectedValueOnce(new Error('posterior write failed'));
    await expect(adminApproveSignal('sig1', 'notes', { feedbackUserId: 'user-1' })).resolves.toBeUndefined();
  });

  it('re-approving an already-Approved signal records no additional posterior feedback', async () => {
    // Seed the signal as already Approved
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', status: 'Approved', feedback: { vote: 'up' } }),
      id: 'sig1',
      ref: {},
    });

    await adminApproveSignal('sig1', 'additional notes', { feedbackUserId: 'user-1' });

    // Status update still happens (idempotent write, no error)
    expect(adminMock.update).toHaveBeenCalled();
    // But steering is NOT called — double-counting guard prevents re-firing the posterior
    expect(steerSignalInterest).not.toHaveBeenCalled();
  });
});

describe('adminRejectSignal — interest-steering (T27)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', feedback: undefined }),
      id: 'sig1',
      ref: {},
    });
  });

  it('with feedbackUserId records the same posterior move as a thumbs-down', async () => {
    await adminRejectSignal('sig1', 'Not relevant', { feedbackUserId: 'user-1' });

    expect(adminMock.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Rejected' }));
    expect(steerSignalInterest).toHaveBeenCalledTimes(1);
    const [signalArg, voteArg, userIdArg, reasonArg] = steerSignalInterest.mock.calls[0];
    expect(signalArg).toMatchObject({ id: 'sig1' });
    expect(voteArg).toBe('down');
    expect(userIdArg).toBe('user-1');
    expect(reasonArg).toBe('Not relevant');
  });

  it('no feedbackUserId (agent principal) → no posterior write, rejection still succeeds', async () => {
    await expect(adminRejectSignal('sig1', 'Not relevant')).resolves.toBeUndefined();
    expect(steerSignalInterest).not.toHaveBeenCalled();
  });

  it('rejection still succeeds even when steerSignalInterest rejects (best-effort)', async () => {
    steerSignalInterest.mockRejectedValueOnce(new Error('posterior write failed'));
    await expect(adminRejectSignal('sig1', 'Not relevant', { feedbackUserId: 'user-1' })).resolves.toBeUndefined();
  });

  it('re-rejecting an already-Rejected signal records no additional posterior feedback', async () => {
    // Seed the signal as already Rejected
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', status: 'Rejected', feedback: { vote: 'down' } }),
      id: 'sig1',
      ref: {},
    });

    await adminRejectSignal('sig1', 'still not relevant', { feedbackUserId: 'user-1' });

    // Status update still happens (idempotent write, no error)
    expect(adminMock.update).toHaveBeenCalled();
    // But steering is NOT called — double-counting guard prevents re-firing the posterior
    expect(steerSignalInterest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// B1 — cross-path posterior double-count fix. The admin path (this file) and the thumbs path
// (`steerSignalInterest`'s guard in signals/feedback.ts) used to guard on DIFFERENT idempotency
// keys (status vs feedback.vote), so an AI-approve followed by a same-direction human thumbs
// vote crossed the two guards and recorded the posterior twice. Fixed by stamping
// `feedback.vote` here, in the SAME write as the status change, whenever steering actually
// fires — giving both paths one shared idempotency key.
// =============================================================================
describe('adminApproveSignal — B1 feedback.vote stamping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', feedback: undefined }),
      id: 'sig1',
      ref: {},
    });
  });

  it('admin approve with feedbackUserId stamps feedback.vote so a later same-direction thumbs vote cannot double-count', async () => {
    await adminApproveSignal('sig1', 'Looks promising', { feedbackUserId: 'user-1' });

    expect(adminMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Approved',
        feedback: expect.objectContaining({
          vote: 'up',
          votedBy: 'user-1',
          includedInFeedbackLoop: true,
          reason: 'Looks promising',
        }),
      })
    );
  });

  it('admin approve WITHOUT feedbackUserId leaves feedback.vote unset', async () => {
    await adminApproveSignal('sig1', 'notes');

    expect(adminMock.update).toHaveBeenCalledTimes(1);
    const [payload] = adminMock.update.mock.calls[0];
    expect(payload.feedback).toBeUndefined();
  });

  it('re-approving an already-Approved signal (steering skipped) leaves feedback.vote unset in the update payload', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', status: 'Approved', feedback: { vote: 'up' } }),
      id: 'sig1',
      ref: {},
    });

    await adminApproveSignal('sig1', 'additional notes', { feedbackUserId: 'user-1' });

    const [payload] = adminMock.update.mock.calls[0];
    expect(payload.feedback).toBeUndefined();
  });
});

describe('adminRejectSignal — B1 feedback.vote stamping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 'sig1', feedback: undefined }),
      id: 'sig1',
      ref: {},
    });
  });

  it('admin reject with feedbackUserId stamps feedback.vote so a later same-direction thumbs vote cannot double-count', async () => {
    await adminRejectSignal('sig1', 'Not relevant', { feedbackUserId: 'user-1' });

    expect(adminMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Rejected',
        feedback: expect.objectContaining({
          vote: 'down',
          votedBy: 'user-1',
          includedInFeedbackLoop: true,
          reason: 'Not relevant',
        }),
      })
    );
  });

  it('admin reject WITHOUT feedbackUserId leaves feedback.vote unset', async () => {
    await adminRejectSignal('sig1', 'Not relevant');

    const [payload] = adminMock.update.mock.calls[0];
    expect(payload.feedback).toBeUndefined();
  });
});

describe('adminArchiveSignals — DISC-010 admin twin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('archives a non-archived signal: sets Archived + stamps archivedAt/previousStatus', async () => {
    // Both reads (adminGetSignalById + adminUpdateSignal.ref.get) see the same doc.
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 's1', status: 'Validated', detectedAt: 100, metadata: { url: 'x' } }),
      id: 's1',
      ref: {},
    });

    const result = await adminArchiveSignals(['s1'], 'cleanup');

    expect(result).toEqual({ archived: 1, failed: [] });
    expect(adminMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Archived',
        metadata: expect.objectContaining({
          url: 'x',
          archiveReason: 'cleanup',
          previousStatus: 'Validated',
        }),
      })
    );
  });

  it('is idempotent: an already-Archived signal is skipped, never re-written', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 's2', status: 'Archived', detectedAt: 100 }),
      id: 's2',
      ref: {},
    });

    const result = await adminArchiveSignals(['s2']);

    expect(result).toEqual({ archived: 0, failed: [] });
    expect(adminMock.update).not.toHaveBeenCalled();
  });

  it('reports a missing id as failed instead of throwing', async () => {
    adminMock.docGet.mockResolvedValue({ exists: false, data: () => null, id: 'gone', ref: {} });

    const result = await adminArchiveSignals(['gone']);

    expect(result).toEqual({ archived: 0, failed: ['gone'] });
    expect(adminMock.update).not.toHaveBeenCalled();
  });
});

describe('adminRestoreSignals — DISC-010 admin twin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('restores to previousStatus and strips the archive bookkeeping keys', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({
        id: 's1',
        status: 'Archived',
        detectedAt: 100,
        metadata: { url: 'x', archivedAt: 5, archiveReason: 'cleanup', previousStatus: 'Detected' },
      }),
      id: 's1',
      ref: {},
    });

    const result = await adminRestoreSignals(['s1']);

    expect(result).toEqual({ restored: 1, failed: [] });
    const [payload] = adminMock.update.mock.calls[0];
    expect(payload.status).toBe('Detected');
    expect(payload.metadata.url).toBe('x');
    expect(payload.metadata.restoredAt).toBeDefined();
    // Archive bookkeeping keys are dropped (Firestore update replaces the map).
    expect(payload.metadata.archivedAt).toBeUndefined();
    expect(payload.metadata.archiveReason).toBeUndefined();
    expect(payload.metadata.previousStatus).toBeUndefined();
  });

  it('falls back to Validated when previousStatus marker is missing', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 's3', status: 'Archived', detectedAt: 100, metadata: { archivedAt: 5 } }),
      id: 's3',
      ref: {},
    });

    const result = await adminRestoreSignals(['s3']);

    expect(result).toEqual({ restored: 1, failed: [] });
    expect(adminMock.update.mock.calls[0][0].status).toBe('Validated');
  });

  it('reports a non-archived signal as failed and never writes it', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ id: 's4', status: 'Validated', detectedAt: 100 }),
      id: 's4',
      ref: {},
    });

    const result = await adminRestoreSignals(['s4']);

    expect(result).toEqual({ restored: 0, failed: ['s4'] });
    expect(adminMock.update).not.toHaveBeenCalled();
  });
});
