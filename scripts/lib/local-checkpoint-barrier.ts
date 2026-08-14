import { randomUUID } from 'crypto';

export const CHECKPOINT_BARRIER_COLLECTION = '__radaristRuntime';
export const CHECKPOINT_BARRIER_DOCUMENT = 'checkpointBarrier';
export const DEFAULT_CHECKPOINT_BARRIER_TTL_MS = 60_000;
export const DEFAULT_CHECKPOINT_DRAIN_MS = 300;

export interface CheckpointBarrierRecord {
  active: true;
  ownerId: string;
  profile: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface CheckpointBarrierStore {
  acquire(record: CheckpointBarrierRecord, now: Date): Promise<void>;
  release(ownerId: string): Promise<void>;
  close(): Promise<void>;
}

export interface CheckpointBarrierLease {
  ownerId: string;
  release(): Promise<void>;
}

export interface AcquireCheckpointBarrierOptions {
  profile: string;
  store: CheckpointBarrierStore;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  ttlMs?: number;
  drainMs?: number;
  ownerId?: string;
}

export type RestoredCheckpointBarrierDisposition = 'absent' | 'delete';

interface FirestoreTimestampLike {
  toDate(): Date;
}

function isFirestoreTimestampLike(value: unknown): value is FirestoreTimestampLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

/**
 * A checkpoint necessarily contains the barrier that protected its export.
 * A newly restored, otherwise-unowned emulator must remove exactly that
 * runtime residue before accepting its first checkpoint. Refuse malformed or
 * cross-profile records instead of turning this into a general delete helper.
 */
export function classifyRestoredCheckpointBarrier(
  data: Record<string, unknown> | undefined,
  expectedProfile: string
): RestoredCheckpointBarrierDisposition {
  if (!data) return 'absent';
  const startedAt = data.startedAt;
  const expiresAt = data.expiresAt;
  const startedDate = isFirestoreTimestampLike(startedAt) ? startedAt.toDate() : undefined;
  const expiresDate = isFirestoreTimestampLike(expiresAt) ? expiresAt.toDate() : undefined;
  if (
    data.active !== true ||
    data.profile !== expectedProfile ||
    typeof data.ownerId !== 'string' ||
    data.ownerId.length < 1 ||
    !(startedDate instanceof Date) ||
    !Number.isFinite(startedDate.getTime()) ||
    !(expiresDate instanceof Date) ||
    !Number.isFinite(expiresDate.getTime()) ||
    expiresDate <= startedDate
  ) {
    throw new Error('Restored checkpoint barrier does not match the selected local profile.');
  }
  return 'delete';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * Acquire the browser-write barrier and wait for already accepted writes to
 * drain before the launcher pauses its server/job process groups.
 */
export async function acquireCheckpointBarrier(
  options: AcquireCheckpointBarrierOptions
): Promise<CheckpointBarrierLease> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? delay;
  const ttlMs = options.ttlMs ?? DEFAULT_CHECKPOINT_BARRIER_TTL_MS;
  const drainMs = options.drainMs ?? DEFAULT_CHECKPOINT_DRAIN_MS;
  let closed = false;
  const closeStore = async () => {
    if (closed) return;
    closed = true;
    await options.store.close();
  };
  let acquired = false;
  const ownerId = options.ownerId ?? randomUUID();
  try {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= drainMs || ttlMs > 5 * 60_000) {
      throw new Error(
        'Checkpoint barrier TTL must exceed its drain window and be at most five minutes.'
      );
    }
    if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > 5_000) {
      throw new Error('Checkpoint barrier drain window must be between 0 and 5000ms.');
    }

    const startedAt = now();
    await options.store.acquire(
      {
        active: true,
        ownerId,
        profile: options.profile,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + ttlMs),
      },
      startedAt
    );
    acquired = true;
    await sleep(drainMs);
  } catch (error) {
    try {
      if (acquired) await options.store.release(ownerId);
    } finally {
      await closeStore();
    }
    throw error;
  }

  let released = false;
  return {
    ownerId,
    async release() {
      if (released) return;
      released = true;
      try {
        await options.store.release(ownerId);
      } finally {
        await closeStore();
      }
    },
  };
}

export function assertLoopbackCheckpointTarget(host: string, projectId: string): void {
  const [hostname, rawPort, ...extra] = host.trim().split(':');
  const port = Number(rawPort);
  if (
    extra.length > 0 ||
    !['127.0.0.1', 'localhost', '::1'].includes(hostname) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !projectId.startsWith('demo-')
  ) {
    throw new Error('Checkpoint barriers require an explicit loopback emulator and demo-* project.');
  }
}

/** Build the Admin-SDK adapter lazily so importing this module cannot target a live project. */
export async function createFirestoreCheckpointBarrierStore(
  host: string,
  projectId: string
): Promise<CheckpointBarrierStore> {
  assertLoopbackCheckpointTarget(host, projectId);
  process.env.FIRESTORE_EMULATOR_HOST = host;

  const [{ initializeApp, deleteApp }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const app = initializeApp({ projectId }, `radarist-checkpoint-${process.pid}-${randomUUID()}`);
  const db = getFirestore(app);
  const ref = db.collection(CHECKPOINT_BARRIER_COLLECTION).doc(CHECKPOINT_BARRIER_DOCUMENT);

  let closed = false;
  return {
    async acquire(record, now) {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(ref);
        if (current.exists) {
          const data = current.data();
          const expiresAt = data?.expiresAt?.toDate?.();
          if (data?.active === true && expiresAt instanceof Date && expiresAt > now) {
            throw new Error('Another checkpoint already owns the local write barrier.');
          }
        }
        transaction.set(ref, record);
      });
    },
    async release(ownerId) {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(ref);
        if (!current.exists || current.data()?.ownerId !== ownerId) return;
        transaction.delete(ref);
      });
    },
    async close() {
      if (!closed) {
        closed = true;
        await deleteApp(app);
      }
    },
  };
}

/** Remove only the profile-bound barrier imported from a verified checkpoint. */
export async function clearRestoredCheckpointBarrier(
  host: string,
  projectId: string,
  expectedProfile: string
): Promise<RestoredCheckpointBarrierDisposition> {
  assertLoopbackCheckpointTarget(host, projectId);
  process.env.FIRESTORE_EMULATOR_HOST = host;

  const [{ initializeApp, deleteApp }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const app = initializeApp({ projectId }, `radarist-checkpoint-restore-${process.pid}-${randomUUID()}`);
  try {
    const db = getFirestore(app);
    const ref = db.collection(CHECKPOINT_BARRIER_COLLECTION).doc(CHECKPOINT_BARRIER_DOCUMENT);
    return await db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const disposition = classifyRestoredCheckpointBarrier(
        current.exists ? current.data() : undefined,
        expectedProfile
      );
      if (disposition === 'delete') transaction.delete(ref);
      return disposition;
    });
  } finally {
    await deleteApp(app);
  }
}
