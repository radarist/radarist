/** @jest-environment node */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  checkpointBudgetFromEnvironment,
  cleanupCheckpointQuarantine,
  createFirebaseCheckpoint,
  describeCheckpointContract,
  prepareFirebaseCheckpointRecovery,
  resolveCheckpointIntervalMs,
} from '../lib/firebase-checkpoint-runtime';

function writeExport(root: string, marker: string): void {
  mkdirSync(join(root, 'auth_export'), { recursive: true });
  mkdirSync(join(root, 'firestore_export'), { recursive: true });
  mkdirSync(join(root, 'storage_export', 'blobs'), { recursive: true });
  writeFileSync(join(root, 'auth_export', 'accounts.json'), JSON.stringify([{ localId: marker }]));
  writeFileSync(join(root, 'firestore_export', 'data.bin'), `firestore:${marker}`);
  writeFileSync(join(root, 'storage_export', 'blobs', 'asset.bin'), Buffer.from(`storage:${marker}`));
  writeFileSync(
    join(root, 'firebase-export-metadata.json'),
    JSON.stringify({
      auth: { path: 'auth_export/accounts.json' },
      firestore: { path: 'firestore_export/data.bin' },
      storage: { path: 'storage_export' },
    })
  );
}

describe('Firebase checkpoint runtime integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'radarist-checkpoint-runtime-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the checkpoint interval from env with a strict bounded override (TEST-024 soak)', () => {
    expect(resolveCheckpointIntervalMs({})).toBe(DEFAULT_CHECKPOINT_INTERVAL_MS);
    expect(resolveCheckpointIntervalMs({ RADARIST_CHECKPOINT_INTERVAL_MS: '5000' })).toBe(5_000);
    expect(resolveCheckpointIntervalMs({ RADARIST_CHECKPOINT_INTERVAL_MS: '600000' })).toBe(600_000);
    for (const bad of ['4999', '0', '-1', 'abc', '1.5', '3600001', '']) {
      expect(() => resolveCheckpointIntervalMs({ RADARIST_CHECKPOINT_INTERVAL_MS: bad })).toThrow(
        /checkpoint interval/i
      );
    }
  });

  it('parses optional disk guards strictly and leaves defaults to the runtime', () => {
    expect(checkpointBudgetFromEnvironment({})).toEqual({});
    expect(
      checkpointBudgetFromEnvironment({
        RADARIST_CHECKPOINT_RESERVE_BYTES: '1048576',
        RADARIST_CHECKPOINT_MAX_RETAINED_BYTES: '1073741824',
      })
    ).toEqual({ reserveBytes: 1048576, maxRetainedBytes: 1073741824 });
    expect(() => checkpointBudgetFromEnvironment({ RADARIST_CHECKPOINT_RESERVE_BYTES: '1.5' })).toThrow(
      'positive base-10 integer'
    );
    expect(() => checkpointBudgetFromEnvironment({ RADARIST_CHECKPOINT_MAX_RETAINED_BYTES: ' 100' })).toThrow(
      'positive base-10 integer'
    );
  });

  it('exports, hashes, atomically promotes, and selects a complete generation', async () => {
    const times = [new Date('2026-07-18T12:00:00Z'), new Date('2026-07-18T12:00:01Z')];
    const checkpoint = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => times.shift() ?? new Date('2026-07-18T12:00:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'operator-uid');
      },
    });

    expect(checkpoint.manifest.components).toEqual({
      auth: { rootPath: 'auth_export' },
      firestore: { rootPath: 'firestore_export' },
      storage: { rootPath: 'storage_export' },
    });
    expect(checkpoint.manifest.kind).toBe('daily');
    expect(checkpoint.manifest.files.map((file) => file.path)).toContain('storage_export/blobs/asset.bin');
    const recovery = await prepareFirebaseCheckpointRecovery({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
    });
    expect(recovery.selected?.id).toBe(checkpoint.id);
  });

  it('classifies a checkpoint by durable completion time when an export crosses UTC midnight', async () => {
    const baselineTimes = [new Date('2026-07-18T12:00:00.000Z'), new Date('2026-07-18T12:00:01.000Z')];
    await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => baselineTimes.shift() ?? new Date('2026-07-18T12:00:01.000Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'july-18-daily');
      },
    });
    const times = [new Date('2026-07-18T23:59:59.900Z'), new Date('2026-07-19T00:00:00.100Z')];
    const checkpoint = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => times.shift() ?? new Date('2026-07-19T00:00:00.100Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'midnight-crossing');
      },
    });

    expect(checkpoint.manifest.createdAt).toBe('2026-07-18T23:59:59.900Z');
    expect(checkpoint.manifest.completedAt).toBe('2026-07-19T00:00:00.100Z');
    expect(checkpoint.manifest.kind).toBe('daily');
  });

  it('keeps a corrupt newest generation out of recovery and quarantines it', async () => {
    const times = [new Date('2026-07-18T12:00:00Z'), new Date('2026-07-18T12:00:01Z')];
    const checkpoint = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => times.shift() ?? new Date('2026-07-18T12:00:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'operator-uid');
      },
    });
    writeFileSync(join(checkpoint.path, 'storage_export', 'blobs', 'asset.bin'), 'corrupt');

    const recovery = await prepareFirebaseCheckpointRecovery({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => new Date('2026-07-18T12:10:00Z'),
    });
    expect(recovery.selected).toBeNull();
    expect(recovery.invalidCandidates[0]?.problems[0]?.code).toMatch(/size-mismatch|hash-mismatch/);
    expect(existsSync(checkpoint.path)).toBe(false);
    expect(readdirSync(join(root, 'quarantine'))).toHaveLength(1);
  });

  it('quarantines a future-dated generation instead of recovering it', async () => {
    const times = [new Date('2026-07-18T12:10:00Z'), new Date('2026-07-18T12:10:01Z')];
    const checkpoint = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => times.shift() ?? new Date('2026-07-18T12:10:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'future');
      },
    });

    const recovery = await prepareFirebaseCheckpointRecovery({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => new Date('2026-07-18T12:00:00Z'),
    });

    expect(recovery.selected).toBeNull();
    expect(recovery.invalidCandidates).toEqual([
      expect.objectContaining({
        id: checkpoint.id,
        problems: [expect.objectContaining({ code: 'future-timestamp' })],
      }),
    ]);
    expect(readdirSync(join(root, 'generations'))).toEqual([]);
    expect(readdirSync(join(root, 'quarantine'))).toHaveLength(1);
  });

  it('refuses automatic recovery from an unhashed legacy export without deleting it', async () => {
    writeExport(root, 'legacy-unverified');

    await expect(
      prepareFirebaseCheckpointRecovery({
        profileRoot: root,
        profile: 'selftest',
        projectId: 'demo-radarist-selftest',
        now: () => new Date('2099-07-18T12:00:00Z'),
      })
    ).rejects.toThrow(/unhashed legacy Firebase export/);

    expect(existsSync(join(root, 'firebase-export-metadata.json'))).toBe(true);
    expect(existsSync(join(root, 'auth_export', 'accounts.json'))).toBe(true);
    expect(existsSync(join(root, 'firestore_export', 'data.bin'))).toBe(true);
    expect(existsSync(join(root, 'storage_export', 'blobs', 'asset.bin'))).toBe(true);
  });

  it('preserves an expired selected baseline until a replacement is promoted', async () => {
    const firstTimes = [new Date('2026-07-14T12:00:00Z'), new Date('2026-07-14T12:00:01Z')];
    const daily = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => firstTimes.shift() ?? new Date('2026-07-14T12:00:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'daily');
      },
    });
    const secondTimes = [new Date('2026-07-14T12:10:00Z'), new Date('2026-07-14T12:10:01Z')];
    const rolling = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => secondTimes.shift() ?? new Date('2026-07-14T12:10:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'rolling');
      },
    });
    expect(rolling.manifest.kind).toBe('rolling');
    rmSync(daily.path, { recursive: true });

    await expect(
      createFirebaseCheckpoint({
        profileRoot: root,
        profile: 'selftest',
        projectId: 'demo-radarist-selftest',
        now: () => new Date('2026-07-18T12:00:00Z'),
        budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
        async exportTo(stagePath) {
          writeExport(stagePath, 'failed-replacement');
          throw new Error('simulated export failure');
        },
      })
    ).rejects.toThrow('simulated export failure');

    expect(existsSync(rolling.path)).toBe(true);
    expect(readdirSync(join(root, 'generations'))).toEqual([rolling.id]);
    const recovery = await prepareFirebaseCheckpointRecovery({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
    });
    expect(recovery.selected?.id).toBe(rolling.id);
  });

  it('counts root residue in the profile cap without deleting the selected baseline', async () => {
    const times = [new Date('2026-07-18T12:00:00Z'), new Date('2026-07-18T12:00:01Z')];
    const baseline = await createFirebaseCheckpoint({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => times.shift() ?? new Date('2026-07-18T12:00:01Z'),
      budget: { reserveBytes: 1, maxRetainedBytes: 256 * 1024 * 1024 },
      async exportTo(stagePath) {
        writeExport(stagePath, 'baseline');
      },
    });
    writeFileSync(join(root, 'operator-residue.bin'), Buffer.alloc(1024 * 1024));

    await expect(
      createFirebaseCheckpoint({
        profileRoot: root,
        profile: 'selftest',
        projectId: 'demo-radarist-selftest',
        now: () => new Date('2026-07-18T12:10:00Z'),
        budget: { reserveBytes: 1, maxRetainedBytes: 512 * 1024 },
        async exportTo(stagePath) {
          writeExport(stagePath, 'must-not-run');
        },
      })
    ).rejects.toThrow('profile-size-cap');

    expect(existsSync(baseline.path)).toBe(true);
    expect(readdirSync(join(root, 'generations'))).toEqual([baseline.id]);
  });

  it('bounds quarantine by entry count, age, and bytes', async () => {
    const quarantineRoot = join(root, 'quarantine');
    mkdirSync(quarantineRoot, { recursive: true });
    const current = new Date('2026-07-19T12:00:00Z');
    for (let index = 0; index < 20; index += 1) {
      const path = join(quarantineRoot, `.quarantine-${String(index).padStart(2, '0')}`);
      mkdirSync(path);
      writeFileSync(join(path, 'payload.bin'), Buffer.alloc(16));
      utimesSync(path, current, current);
    }
    const oversized = join(quarantineRoot, '.quarantine-oversized');
    mkdirSync(oversized);
    writeFileSync(join(oversized, 'payload.bin'), Buffer.alloc(1024));
    utimesSync(oversized, current, current);
    const expired = join(quarantineRoot, '.quarantine-expired');
    mkdirSync(expired);
    writeFileSync(join(expired, 'payload.bin'), Buffer.alloc(16));
    const old = new Date('2026-07-15T00:00:00Z');
    utimesSync(expired, old, old);

    const removed = cleanupCheckpointQuarantine(root, current.toISOString(), 512);

    expect(removed).toContain('.quarantine-expired');
    expect(removed).toContain('.quarantine-oversized');
    expect(readdirSync(quarantineRoot).length).toBeLessThanOrEqual(16);
  });

  it('removes owned LATEST temp residue but leaves unknown root data fail-closed', async () => {
    const latestTemp = join(root, '.LATEST.tmp-0123456789abcdef');
    const unknown = join(root, 'operator-data.bin');
    writeFileSync(latestTemp, 'interrupted-pointer');
    writeFileSync(unknown, 'do-not-delete');

    await prepareFirebaseCheckpointRecovery({
      profileRoot: root,
      profile: 'selftest',
      projectId: 'demo-radarist-selftest',
      now: () => new Date('2026-07-19T12:00:00Z'),
    });

    expect(existsSync(latestTemp)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
  });
});

describe('describeCheckpointContract', () => {
  it('describes the shipped default cadence and retention', () => {
    expect(describeCheckpointContract(DEFAULT_CHECKPOINT_INTERVAL_MS)).toBe(
      'attempts a verified full-generation checkpoint every 10 min (retains 72h rolling + 3 daily)'
    );
  });

  it('reports the overridden cadence rather than a hard-coded ten minutes', () => {
    // The soak override must not make the launcher banner state a false cadence.
    expect(describeCheckpointContract(5_000)).toContain('every 5s');
    expect(describeCheckpointContract(60_000)).toContain('every 1 min');
  });

  it('refuses a non-positive or non-integer interval', () => {
    expect(() => describeCheckpointContract(0)).toThrow(/positive integer/);
    expect(() => describeCheckpointContract(-1)).toThrow(/positive integer/);
    expect(() => describeCheckpointContract(1.5)).toThrow(/positive integer/);
  });
});
