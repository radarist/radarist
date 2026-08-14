/**
 * @jest-environment node
 *
 * LOCAL-008 pure checkpoint tests. Every filesystem case uses a private temp
 * directory; no Firebase emulator, live profile, or Docker volume is touched.
 */
import { createHash } from 'crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  CHECKPOINT_MANIFEST_FILENAME,
  CHECKPOINT_MANIFEST_VERSION,
  FIREBASE_EXPORT_METADATA_FILENAME,
  GENERATIONS_DIRECTORY,
  INITIAL_CHECKPOINT_SCHEDULER_STATE,
  LATEST_POINTER_VERSION,
  MAX_CHECKPOINT_FUTURE_SKEW_MS,
  assertPromotionPathsShareFilesystem,
  buildCheckpointPromotionPlan,
  checkpointStageDirectoryName,
  classifyUtcCheckpoint,
  encodeCheckpointManifest,
  encodeLatestPointer,
  evaluateCheckpointDiskBudget,
  finishCheckpoint,
  hashFileStreaming,
  parseCheckpointManifest,
  planCheckpointRetention,
  quarantineDirectoryName,
  requestCheckpoint,
  selectNewestValidRecovery,
  utcDayKey,
  validateCheckpointGeneration,
  type CheckpointFileIdentity,
  type FirebaseCheckpointManifest,
  type RetentionGeneration,
} from '../lib/firebase-checkpoints';

const PROFILE = 'blank-test';
const PROJECT = 'demo-radarist-checkpoints';

interface CreatedGeneration {
  path: string;
  manifest: FirebaseCheckpointManifest;
  manifestSha256: string;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path: string, content: string | Buffer): Promise<void> {
  await privateDirectory(dirname(path));
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function createGeneration(
  profileRoot: string,
  id: string,
  completedAt: string,
  kind: 'rolling' | 'daily' = 'rolling'
): Promise<CreatedGeneration> {
  const generationPath = join(profileRoot, GENERATIONS_DIRECTORY, id);
  await privateDirectory(generationPath);
  const contents: Record<string, string> = {
    'auth_export/accounts.json': JSON.stringify({ users: [] }),
    'firestore_export/firestore_export.overall_export_metadata': 'firestore-export',
    'storage_export/storage-metadata.json': JSON.stringify({ files: [] }),
    [FIREBASE_EXPORT_METADATA_FILENAME]: JSON.stringify({
      version: 'test',
      auth: { version: 'test', path: 'auth_export/accounts.json' },
      firestore: {
        version: 'test',
        path: 'firestore_export/firestore_export.overall_export_metadata',
      },
      storage: { version: 'test', path: 'storage_export' },
    }),
  };
  const files: CheckpointFileIdentity[] = [];
  for (const relativePath of Object.keys(contents).sort((left, right) => left.localeCompare(right))) {
    const content = contents[relativePath];
    await privateFile(join(generationPath, relativePath), content);
    const buffer = Buffer.from(content);
    files.push({
      path: relativePath,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
  }
  const completedMs = Date.parse(completedAt);
  const manifest: FirebaseCheckpointManifest = {
    schemaVersion: CHECKPOINT_MANIFEST_VERSION,
    generationId: id,
    profile: PROFILE,
    projectId: PROJECT,
    kind,
    createdAt: new Date(completedMs - 60_000).toISOString(),
    completedAt,
    firebaseMetadataPath: FIREBASE_EXPORT_METADATA_FILENAME,
    components: {
      auth: { rootPath: 'auth_export' },
      firestore: { rootPath: 'firestore_export' },
      storage: { rootPath: 'storage_export' },
    },
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  const manifestPath = join(generationPath, CHECKPOINT_MANIFEST_FILENAME);
  await privateFile(manifestPath, encodeCheckpointManifest(manifest));
  const manifestSha256 = (await hashFileStreaming(manifestPath)).sha256;
  return { path: generationPath, manifest, manifestSha256 };
}

async function createLegacyExport(profileRoot: string): Promise<void> {
  await privateFile(join(profileRoot, 'auth_export/accounts.json'), '{}');
  await privateFile(
    join(profileRoot, 'firestore_export/firestore_export.overall_export_metadata'),
    'legacy-firestore'
  );
  await privateFile(join(profileRoot, 'storage_export/metadata.json'), '{}');
  await privateFile(
    join(profileRoot, FIREBASE_EXPORT_METADATA_FILENAME),
    JSON.stringify({
      auth: { path: 'auth_export/accounts.json' },
      firestore: { path: 'firestore_export/firestore_export.overall_export_metadata' },
      storage: { path: 'storage_export' },
    })
  );
}

describe('Firebase checkpoint manifest and atomic promotion contract', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'radarist-checkpoint-'));
    await chmod(root, 0o700);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('requires a deterministic complete Auth/Firestore/Storage identity', async () => {
    const created = await createGeneration(root, 'generation-001', '2026-07-18T10:00:00.000Z');
    expect(parseCheckpointManifest(created.manifest)).toEqual(created.manifest);

    const missingStorage = JSON.parse(JSON.stringify(created.manifest)) as Record<string, unknown>;
    delete (missingStorage.components as Record<string, unknown>).storage;
    expect(() => parseCheckpointManifest(missingStorage)).toThrow('Missing storage component identity');

    const unsorted = JSON.parse(JSON.stringify(created.manifest)) as FirebaseCheckpointManifest;
    unsorted.files.reverse();
    expect(() => parseCheckpointManifest(unsorted)).toThrow('files must be sorted');
  });

  it('produces same-parent promotion paths and an fsync-before-rename sequence', async () => {
    const manifestSha256 = 'a'.repeat(64);
    const plan = buildCheckpointPromotionPlan({
      profileRoot: root,
      generationId: 'generation-atomic',
      nonce: '0123456789abcdef',
      manifestSha256,
      completedAt: '2026-07-18T10:00:00.000Z',
    });
    expect(dirname(plan.stagePath)).toBe(plan.generationsRoot);
    expect(dirname(plan.finalPath)).toBe(plan.generationsRoot);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'fsync-export-files',
      'write-manifest-temp-exclusive',
      'fsync-manifest-temp',
      'rename-manifest-temp',
      'fsync-stage-directory',
      'rename-stage-directory',
      'fsync-generations-directory',
      'write-latest-temp-exclusive',
      'fsync-latest-temp',
      'rename-latest-temp',
      'fsync-profile-directory',
    ]);
    expect(JSON.parse(plan.latestContent)).toEqual({
      schemaVersion: LATEST_POINTER_VERSION,
      generationId: 'generation-atomic',
      manifestSha256,
      updatedAt: '2026-07-18T10:00:00.000Z',
    });

    await privateDirectory(plan.generationsRoot);
    await privateDirectory(plan.stagePath);
    await expect(assertPromotionPathsShareFilesystem(plan)).resolves.toBeUndefined();
  });

  it('rejects unsafe stage identities and keeps quarantine names path-safe', () => {
    expect(() => checkpointStageDirectoryName('../escape', '01234567')).toThrow('Unsafe checkpoint');
    expect(() => checkpointStageDirectoryName('valid', 'not-a-nonce')).toThrow('Stage nonce');
    expect(quarantineDirectoryName('../bad/id', 'hash-mismatch', '2026-07-18T10:00:00.000Z')).toBe(
      '.quarantine-20260718T100000000Z-hash-mismatch-.._bad_id'
    );
  });

  it('hashes file content as a stream without loading it through the API', async () => {
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0xab);
    const path = join(root, 'large-export.bin');
    await privateFile(path, content);
    await expect(hashFileStreaming(path)).resolves.toEqual({
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  });
});

describe('checkpoint scheduler, daily classification, retention, and disk budget', () => {
  it('coalesces every overlapping request into exactly one follow-up', () => {
    const first = requestCheckpoint(INITIAL_CHECKPOINT_SCHEDULER_STATE, '2026-07-18T10:00:00.000Z');
    const second = requestCheckpoint(first.state, '2026-07-18T10:01:00.000Z');
    const third = requestCheckpoint(second.state, '2026-07-18T10:02:00.000Z');
    expect([first.action, second.action, third.action]).toEqual(['start', 'coalesced', 'coalesced']);
    expect(third.state.pendingRequestCount).toBe(2);

    const followUp = finishCheckpoint(third.state, '2026-07-18T10:03:00.000Z');
    expect(followUp.action).toBe('start-coalesced');
    expect(followUp.state).toMatchObject({
      running: true,
      pendingRequestCount: 0,
      totalStarted: 2,
      totalCompleted: 1,
      totalCoalesced: 2,
    });
    const idle = finishCheckpoint(followUp.state, '2026-07-18T10:04:00.000Z');
    expect(idle.action).toBe('idle');
    expect(finishCheckpoint(idle.state, '2026-07-18T10:05:00.000Z')).toEqual({
      action: 'already-idle',
      state: idle.state,
    });
  });

  it('uses UTC days and emits at most one independently retained daily generation per day', () => {
    expect(utcDayKey('2026-07-18T23:59:59.999Z')).toBe('2026-07-18');
    expect(classifyUtcCheckpoint('2026-07-19T00:00:00.000Z', new Set(['2026-07-18']))).toEqual({
      kind: 'daily',
      utcDay: '2026-07-19',
    });
    expect(classifyUtcCheckpoint('2026-07-19T12:00:00.000Z', new Set(['2026-07-19']))).toEqual({
      kind: 'rolling',
      utcDay: '2026-07-19',
    });
  });

  it('hard-caps rolling history at 72 hours and 432 generations plus three distinct dailies', () => {
    const now = Date.parse('2026-07-18T12:00:00.000Z');
    const rolling: RetentionGeneration[] = Array.from({ length: 433 }, (_, index) => ({
      id: `rolling-${String(index).padStart(3, '0')}`,
      kind: 'rolling',
      completedAt: new Date(now - index * 60_000).toISOString(),
    }));
    const daily: RetentionGeneration[] = Array.from({ length: 4 }, (_, index) => ({
      id: `daily-${index}`,
      kind: 'daily',
      completedAt: new Date(now - index * 24 * 60 * 60 * 1_000).toISOString(),
    }));
    const duplicateDaily: RetentionGeneration = {
      id: 'daily-same-day-older',
      kind: 'daily',
      completedAt: new Date(now - 60_000).toISOString(),
    };
    const oldRolling: RetentionGeneration = {
      id: 'rolling-too-old',
      kind: 'rolling',
      completedAt: new Date(now - 72 * 60 * 60 * 1_000 - 1).toISOString(),
    };
    const plan = planCheckpointRetention(
      [...rolling, ...daily, duplicateDaily, oldRolling],
      new Date(now).toISOString(),
      { maxRolling: 10_000, rollingAgeMs: Number.MAX_SAFE_INTEGER, maxDaily: 100 }
    );
    expect(plan.keep.filter((generation) => generation.kind === 'rolling')).toHaveLength(432);
    expect(plan.keep.filter((generation) => generation.kind === 'daily')).toHaveLength(3);
    expect(plan.remove).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'rolling-432', reason: 'rolling-limit' }),
        expect.objectContaining({ id: 'rolling-too-old', reason: 'rolling-age' }),
        expect.objectContaining({ id: 'daily-same-day-older', reason: 'daily-duplicate' }),
        expect.objectContaining({ id: 'daily-3', reason: 'daily-limit' }),
      ])
    );
  });

  it('keeps the exact 72-hour boundary and rejects future generations', () => {
    const plan = planCheckpointRetention(
      [
        { id: 'boundary', kind: 'rolling', completedAt: '2026-07-15T12:00:00.000Z' },
        { id: 'future', kind: 'rolling', completedAt: '2026-07-18T12:00:00.001Z' },
      ],
      '2026-07-18T12:00:00.000Z'
    );
    expect(plan.keep.map((generation) => generation.id)).toEqual(['boundary']);
    expect(plan.remove).toEqual([]);
    expect(plan.quarantine).toEqual([
      expect.objectContaining({ id: 'future', reason: 'future-generation' }),
    ]);
  });

  it('fails closed instead of letting malformed policy values bypass hard caps', () => {
    expect(() =>
      planCheckpointRetention([], '2026-07-18T12:00:00.000Z', { maxRolling: Number.NaN })
    ).toThrow('finite non-negative');
    expect(() =>
      planCheckpointRetention([], '2026-07-18T12:00:00.000Z', { rollingAgeMs: -1 })
    ).toThrow('finite non-negative');
  });

  it('budgets for a full staged export, reserve, retention cap, and reclaim-before-write', () => {
    expect(
      evaluateCheckpointDiskBudget({
        freeBytes: 1_000,
        currentRetainedBytes: 800,
        reclaimableBytes: 500,
        estimatedFullExportBytes: 600,
        metadataOverheadBytes: 10,
        reserveBytes: 200,
        maxRetainedBytes: 1_000,
      })
    ).toEqual({
      allowed: true,
      reasons: [],
      pruneBeforeExport: true,
      requiredFreeBytes: 810,
      effectiveFreeBytes: 1_500,
      projectedRetainedBytes: 910,
    });
    expect(
      evaluateCheckpointDiskBudget({
        freeBytes: 100,
        currentRetainedBytes: 900,
        reclaimableBytes: 0,
        estimatedFullExportBytes: 600,
        metadataOverheadBytes: 10,
        reserveBytes: 200,
        maxRetainedBytes: 1_000,
      })
    ).toMatchObject({ allowed: false, reasons: ['free-space-reserve', 'profile-size-cap'] });
    expect(() =>
      evaluateCheckpointDiskBudget({
        freeBytes: Number.MAX_SAFE_INTEGER,
        currentRetainedBytes: 1,
        reclaimableBytes: 1,
        estimatedFullExportBytes: 1,
        metadataOverheadBytes: 0,
        reserveBytes: 1,
        maxRetainedBytes: Number.MAX_SAFE_INTEGER,
      })
    ).toThrow('safe integer range');
  });
});

describe('validated recovery selection', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'radarist-recovery-'));
    await chmod(root, 0o700);
    await privateDirectory(join(root, GENERATIONS_DIRECTORY));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('selects the deterministic newest valid generation even when LATEST is stale', async () => {
    const older = await createGeneration(root, 'generation-old', '2026-07-18T10:00:00.000Z');
    const newer = await createGeneration(root, 'generation-new', '2026-07-18T11:00:00.000Z');
    await privateFile(
      join(root, 'LATEST'),
      encodeLatestPointer({
        schemaVersion: LATEST_POINTER_VERSION,
        generationId: older.manifest.generationId,
        manifestSha256: older.manifestSha256,
        updatedAt: older.manifest.completedAt,
      })
    );
    const selected = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(selected.selected).toMatchObject({ type: 'verified', id: newer.manifest.generationId });
    expect(selected.latestPointer?.generationId).toBe(older.manifest.generationId);
    expect(selected.invalidCandidates).toEqual([]);
  });

  it('never selects a generation beyond the bounded future clock skew', async () => {
    const current = await createGeneration(root, 'generation-current', '2026-07-18T10:00:00.000Z');
    const tolerated = await createGeneration(
      root,
      'generation-tolerated-skew',
      new Date(Date.parse('2026-07-18T10:00:00.000Z') + MAX_CHECKPOINT_FUTURE_SKEW_MS).toISOString()
    );
    const future = await createGeneration(
      root,
      'generation-future',
      new Date(Date.parse('2026-07-18T10:00:00.000Z') + MAX_CHECKPOINT_FUTURE_SKEW_MS + 1).toISOString()
    );

    const selected = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
      now: '2026-07-18T10:00:00.000Z',
    });

    expect(selected.selected).toMatchObject({
      type: 'verified',
      id: tolerated.manifest.generationId,
    });
    expect(selected.validGenerations.map((generation) => generation.id)).toEqual([
      tolerated.manifest.generationId,
      current.manifest.generationId,
    ]);
    expect(selected.invalidCandidates).toEqual([
      expect.objectContaining({
        id: future.manifest.generationId,
        problems: [expect.objectContaining({ code: 'future-timestamp' })],
      }),
    ]);
  });

  it('rejects a corrupted newest generation and falls back without mutating either candidate', async () => {
    const older = await createGeneration(root, 'generation-good', '2026-07-18T10:00:00.000Z');
    const newer = await createGeneration(root, 'generation-corrupt', '2026-07-18T11:00:00.000Z');
    const corruptFile = join(newer.path, 'auth_export/accounts.json');
    await privateFile(corruptFile, JSON.stringify({ users: [1] }));
    const before = await readdir(join(root, GENERATIONS_DIRECTORY));

    const first = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    const second = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(first.selected).toMatchObject({ type: 'verified', id: older.manifest.generationId });
    expect(first.invalidCandidates).toEqual([
      expect.objectContaining({
        id: newer.manifest.generationId,
        problems: [expect.objectContaining({ code: 'size-mismatch' })],
      }),
    ]);
    expect(second.selected).toMatchObject({ type: 'verified', id: older.manifest.generationId });
    expect(await readdir(join(root, GENERATIONS_DIRECTORY))).toEqual(before);
  });

  it('rejects same-size hash corruption and path escapes', async () => {
    const corrupt = await createGeneration(root, 'generation-hash', '2026-07-18T10:00:00.000Z');
    const accountsPath = join(corrupt.path, 'auth_export/accounts.json');
    const original = await readFile(accountsPath);
    await privateFile(accountsPath, Buffer.alloc(original.length, 0x78));
    await expect(
      validateCheckpointGeneration(corrupt.path, {
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'hash-mismatch' });

    const escaped = await createGeneration(root, 'generation-escape', '2026-07-18T11:00:00.000Z');
    const raw = JSON.parse(
      await readFile(join(escaped.path, CHECKPOINT_MANIFEST_FILENAME), 'utf8')
    ) as FirebaseCheckpointManifest;
    raw.files[0].path = '../outside';
    await privateFile(join(escaped.path, CHECKPOINT_MANIFEST_FILENAME), JSON.stringify(raw));
    await expect(
      validateCheckpointGeneration(escaped.path, {
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'path-escape' });
  });

  it('rejects symlinks and group/world-writable checkpoint content', async () => {
    const symlinked = await createGeneration(root, 'generation-symlink', '2026-07-18T10:00:00.000Z');
    const target = join(root, 'outside.json');
    await privateFile(target, '{}');
    const accountsPath = join(symlinked.path, 'auth_export/accounts.json');
    await rm(accountsPath);
    await symlink(target, accountsPath);
    await expect(
      validateCheckpointGeneration(symlinked.path, {
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'symlink' });

    const writable = await createGeneration(root, 'generation-writable', '2026-07-18T11:00:00.000Z');
    await chmod(join(writable.path, 'storage_export/storage-metadata.json'), 0o666);
    await expect(
      validateCheckpointGeneration(writable.path, {
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'unsafe-permissions' });
  });

  it('rejects an unmanifested file and a non-private profile root', async () => {
    const unexpected = await createGeneration(root, 'generation-extra', '2026-07-18T10:00:00.000Z');
    await privateFile(join(unexpected.path, 'auth_export/untracked.json'), '{}');
    await expect(
      validateCheckpointGeneration(unexpected.path, {
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'unexpected-file' });

    await chmod(root, 0o755);
    await expect(
      selectNewestValidRecovery({
        profileRoot: root,
        expectedProfile: PROFILE,
        expectedProjectId: PROJECT,
      })
    ).rejects.toMatchObject({ code: 'unsafe-permissions' });
  });

  it('refuses a generations-directory symlink before discovering candidates', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'radarist-outside-generations-'));
    await chmod(outside, 0o700);
    await rm(join(root, GENERATIONS_DIRECTORY), { force: true, recursive: true });
    await symlink(outside, join(root, GENERATIONS_DIRECTORY));
    try {
      await expect(
        selectNewestValidRecovery({
          profileRoot: root,
          expectedProfile: PROFILE,
          expectedProjectId: PROJECT,
        })
      ).rejects.toMatchObject({ code: 'symlink' });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('never selects interrupted staging directories and tolerates a corrupt LATEST pointer', async () => {
    const valid = await createGeneration(root, 'generation-valid', '2026-07-18T10:00:00.000Z');
    const stageName = checkpointStageDirectoryName('generation-interrupted', '01234567');
    await privateDirectory(join(root, GENERATIONS_DIRECTORY, stageName));
    await privateFile(join(root, 'LATEST'), '{broken-json');
    const result = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(result.selected).toMatchObject({ type: 'verified', id: valid.manifest.generationId });
    expect(result.interruptedStages).toEqual([
      expect.objectContaining({ id: stageName, problems: [expect.objectContaining({ code: 'incomplete-stage' })] }),
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'corrupt-latest' })]);

    await privateFile(join(root, 'LATEST'), JSON.stringify({ schemaVersion: LATEST_POINTER_VERSION }));
    const malformedShape = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(malformedShape.diagnostics).toEqual([expect.objectContaining({ code: 'corrupt-latest' })]);
  });

  it('does not follow a symlinked LATEST pointer', async () => {
    const valid = await createGeneration(root, 'generation-valid', '2026-07-18T10:00:00.000Z');
    const outside = join(root, 'outside-latest.json');
    await privateFile(outside, JSON.stringify({ secret: true }));
    await symlink(outside, join(root, 'LATEST'));
    const result = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(result.selected).toMatchObject({ type: 'verified', id: valid.manifest.generationId });
    expect(result.latestPointer).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'symlink' })]);
  });

  it('recognizes a complete legacy export only as an unverified fallback', async () => {
    await createLegacyExport(root);
    const legacyOnly = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(legacyOnly.selected).toMatchObject({
      type: 'legacy',
      id: 'legacy-export',
      integrity: 'legacy-unverified',
    });

    const verified = await createGeneration(root, 'generation-verified', '2026-07-18T10:00:00.000Z');
    const withVerified = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(withVerified.selected).toMatchObject({ type: 'verified', id: verified.manifest.generationId });
  });

  it('rejects incomplete legacy metadata instead of treating an arbitrary directory as recoverable', async () => {
    await privateFile(
      join(root, FIREBASE_EXPORT_METADATA_FILENAME),
      JSON.stringify({ auth: { path: '../escape' }, firestore: {}, storage: {} })
    );
    const result = await selectNewestValidRecovery({
      profileRoot: root,
      expectedProfile: PROFILE,
      expectedProjectId: PROJECT,
    });
    expect(result.selected).toBeNull();
    expect(result.invalidCandidates).toEqual([
      expect.objectContaining({ id: 'legacy-export', problems: [expect.objectContaining({ code: 'path-escape' })] }),
    ]);
  });
});
