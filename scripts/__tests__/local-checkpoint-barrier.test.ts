/** @jest-environment node */

import {
  acquireCheckpointBarrier,
  assertLoopbackCheckpointTarget,
  classifyRestoredCheckpointBarrier,
  type CheckpointBarrierRecord,
  type CheckpointBarrierStore,
} from '../lib/local-checkpoint-barrier';

function fakeStore(): CheckpointBarrierStore & {
  acquired: CheckpointBarrierRecord[];
  released: string[];
  closes: number;
} {
  const acquired: CheckpointBarrierRecord[] = [];
  const released: string[] = [];
  return {
    acquired,
    released,
    closes: 0,
    async acquire(record) {
      acquired.push(record);
    },
    async release(ownerId) {
      released.push(ownerId);
    },
    async close() {
      this.closes += 1;
    },
  };
}

describe('local checkpoint write barrier', () => {
  const timestamp = (value: string) => ({ toDate: () => new Date(value) });

  it('deletes only a structurally valid barrier restored for the selected profile', () => {
    expect(classifyRestoredCheckpointBarrier(undefined, 'selftest')).toBe('absent');
    expect(
      classifyRestoredCheckpointBarrier(
        {
          active: true,
          ownerId: 'checkpoint-owner',
          profile: 'selftest',
          startedAt: timestamp('2026-07-18T12:00:00.000Z'),
          expiresAt: timestamp('2026-07-18T12:05:00.000Z'),
        },
        'selftest'
      )
    ).toBe('delete');
  });

  it.each([
    ['wrong profile', { active: true, ownerId: 'owner', profile: 'default' }],
    ['inactive', { active: false, ownerId: 'owner', profile: 'selftest' }],
    ['missing owner', { active: true, profile: 'selftest' }],
  ])('refuses restored barrier residue with %s', (_label, partial) => {
    expect(() =>
      classifyRestoredCheckpointBarrier(
        {
          ...partial,
          startedAt: timestamp('2026-07-18T12:00:00.000Z'),
          expiresAt: timestamp('2026-07-18T12:05:00.000Z'),
        },
        'selftest'
      )
    ).toThrow('does not match');
  });

  it('refuses invalid or non-forward restored barrier timestamps', () => {
    expect(() =>
      classifyRestoredCheckpointBarrier(
        {
          active: true,
          ownerId: 'owner',
          profile: 'selftest',
          startedAt: timestamp('invalid'),
          expiresAt: timestamp('2026-07-18T12:05:00.000Z'),
        },
        'selftest'
      )
    ).toThrow('does not match');
    expect(() =>
      classifyRestoredCheckpointBarrier(
        {
          active: true,
          ownerId: 'owner',
          profile: 'selftest',
          startedAt: timestamp('2026-07-18T12:05:00.000Z'),
          expiresAt: timestamp('2026-07-18T12:00:00.000Z'),
        },
        'selftest'
      )
    ).toThrow('does not match');
  });

  it('acquires, drains, and releases idempotently', async () => {
    const store = fakeStore();
    const sleeps: number[] = [];
    const now = new Date('2026-07-18T12:00:00.000Z');

    const lease = await acquireCheckpointBarrier({
      profile: 'workspace-a',
      store,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      ttlMs: 60_000,
      drainMs: 400,
      ownerId: 'checkpoint-owner',
    });

    expect(store.acquired).toEqual([
      {
        active: true,
        ownerId: 'checkpoint-owner',
        profile: 'workspace-a',
        startedAt: now,
        expiresAt: new Date('2026-07-18T12:01:00.000Z'),
      },
    ]);
    expect(sleeps).toEqual([400]);
    await lease.release();
    await lease.release();
    expect(store.released).toEqual(['checkpoint-owner']);
    expect(store.closes).toBe(1);
  });

  it('releases the barrier when draining fails', async () => {
    const store = fakeStore();
    await expect(
      acquireCheckpointBarrier({
        profile: 'workspace-a',
        store,
        ownerId: 'checkpoint-owner',
        sleep: async () => {
          throw new Error('interrupted');
        },
      })
    ).rejects.toThrow('interrupted');
    expect(store.released).toEqual(['checkpoint-owner']);
    expect(store.closes).toBe(1);
  });

  it('closes the Admin store when acquisition fails', async () => {
    const store = fakeStore();
    store.acquire = async () => {
      throw new Error('already owned');
    };

    await expect(
      acquireCheckpointBarrier({ profile: 'workspace-a', store })
    ).rejects.toThrow('already owned');
    expect(store.released).toEqual([]);
    expect(store.closes).toBe(1);
  });

  it('validates timing bounds', async () => {
    const ttlStore = fakeStore();
    await expect(
      acquireCheckpointBarrier({ profile: 'x', store: ttlStore, ttlMs: 100, drainMs: 100 })
    ).rejects.toThrow(/TTL/);
    expect(ttlStore.closes).toBe(1);
    const drainStore = fakeStore();
    await expect(
      acquireCheckpointBarrier({ profile: 'x', store: drainStore, drainMs: 5_001 })
    ).rejects.toThrow(/drain/);
    expect(drainStore.closes).toBe(1);
  });

  it.each([
    ['127.0.0.1:8080', 'demo-radarist'],
    ['localhost:18080', 'demo-radarist-test'],
  ])('accepts the disposable target %s', (host, project) => {
    expect(() => assertLoopbackCheckpointTarget(host, project)).not.toThrow();
  });

  it.each([
    ['firestore.googleapis.com:443', 'demo-radarist'],
    ['10.0.0.5:8080', 'demo-radarist'],
    ['127.0.0.1:8080', 'production-project'],
    ['127.0.0.1', 'demo-radarist'],
  ])('rejects the unsafe target %s / %s', (host, project) => {
    expect(() => assertLoopbackCheckpointTarget(host, project)).toThrow(/loopback emulator/);
  });
});
