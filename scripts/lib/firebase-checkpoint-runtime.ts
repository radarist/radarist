import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'fs';
import { basename, join, relative, resolve, sep } from 'path';
import {
  CHECKPOINT_MANIFEST_FILENAME,
  FIREBASE_COMPONENTS,
  FIREBASE_EXPORT_METADATA_FILENAME,
  GENERATIONS_DIRECTORY,
  LATEST_POINTER_FILENAME,
  MAX_DAILY_GENERATIONS,
  MAX_ROLLING_AGE_MS,
  assertPromotionPathsShareFilesystem,
  buildCheckpointPromotionPlan,
  classifyUtcCheckpoint,
  encodeCheckpointManifest,
  evaluateCheckpointDiskBudget,
  hashFileStreaming,
  planCheckpointRetention,
  quarantineDirectoryName,
  selectNewestValidRecovery,
  validateCheckpointGeneration,
  type CheckpointFileIdentity,
  type CheckpointGenerationKind,
  type FirebaseCheckpointComponent,
  type FirebaseCheckpointManifest,
  type RecoverySelection,
  type ValidatedCheckpointGeneration,
} from './firebase-checkpoints';

export const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000;
export const CHECKPOINT_INTERVAL_ENV = 'RADARIST_CHECKPOINT_INTERVAL_MS';
export const MIN_CHECKPOINT_INTERVAL_MS = 5_000;
export const MAX_CHECKPOINT_INTERVAL_MS = 60 * 60_000;

/**
 * Scheduler interval, overridable only through a strictly-bounded env value
 * (TEST-024 bounded wall-clock soak of the real scheduler). Unset keeps the
 * supported ten-minute contract.
 */
export function resolveCheckpointIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHECKPOINT_INTERVAL_ENV];
  if (raw === undefined) return DEFAULT_CHECKPOINT_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid checkpoint interval "${raw}": expected a positive integer of milliseconds.`);
  }
  const interval = Number(raw);
  if (interval < MIN_CHECKPOINT_INTERVAL_MS || interval > MAX_CHECKPOINT_INTERVAL_MS) {
    throw new Error(
      `Invalid checkpoint interval ${interval}: expected ${MIN_CHECKPOINT_INTERVAL_MS}-${MAX_CHECKPOINT_INTERVAL_MS} ms.`
    );
  }
  return interval;
}
/**
 * One-line durability contract for launcher banners. Derived from the live
 * interval and the retention constants so the banner cannot drift away from
 * the behaviour it describes.
 */
export function describeCheckpointContract(intervalMs: number): string {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Checkpoint contract interval must be a positive integer of milliseconds.');
  }
  const cadence = intervalMs % 60_000 === 0 ? `${intervalMs / 60_000} min` : `${Math.round(intervalMs / 1_000)}s`;
  const rollingHours = Math.round(MAX_ROLLING_AGE_MS / 3_600_000);
  return (
    `attempts a verified full-generation checkpoint every ${cadence} ` +
    `(retains ${rollingHours}h rolling + ${MAX_DAILY_GENERATIONS} daily)`
  );
}

export const DEFAULT_CHECKPOINT_RESERVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_PROFILE_CAP_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_ESTIMATE_BYTES = 128 * 1024 * 1024;
export const MAX_CHECKPOINT_QUARANTINE_ENTRIES = 16;
export const MAX_CHECKPOINT_QUARANTINE_AGE_MS = 72 * 60 * 60 * 1_000;
export const MAX_CHECKPOINT_QUARANTINE_BYTES = 512 * 1024 * 1024;

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive base-10 integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

export function checkpointBudgetFromEnvironment(env: NodeJS.ProcessEnv): Partial<FirebaseCheckpointBudget> {
  const reserveBytes = optionalPositiveInteger(
    env.RADARIST_CHECKPOINT_RESERVE_BYTES,
    'RADARIST_CHECKPOINT_RESERVE_BYTES'
  );
  const maxRetainedBytes = optionalPositiveInteger(
    env.RADARIST_CHECKPOINT_MAX_RETAINED_BYTES,
    'RADARIST_CHECKPOINT_MAX_RETAINED_BYTES'
  );
  return {
    ...(reserveBytes === undefined ? {} : { reserveBytes }),
    ...(maxRetainedBytes === undefined ? {} : { maxRetainedBytes }),
  };
}

interface FirebaseExportMetadataComponent {
  path: string;
}

export interface FirebaseCheckpointIdentity {
  profile: string;
  projectId: string;
}

export interface FirebaseCheckpointBudget {
  reserveBytes: number;
  maxRetainedBytes: number;
}

export interface CreateFirebaseCheckpointOptions extends FirebaseCheckpointIdentity {
  profileRoot: string;
  exportTo(stagePath: string): Promise<void>;
  now?: () => Date;
  budget?: Partial<FirebaseCheckpointBudget>;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Checkpoint directories must not be symlinks.');
  chmodSync(path, 0o700);
}

function chmodPrivateTree(root: string): void {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) throw new Error('Checkpoint exports must not contain symlinks.');
  chmodSync(root, entry.isDirectory() ? 0o700 : 0o600);
  if (!entry.isDirectory()) return;
  for (const name of readdirSync(root)) chmodPrivateTree(join(root, name));
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncTree(root: string): void {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) throw new Error('Checkpoint exports must not contain symlinks.');
  if (entry.isDirectory()) {
    for (const name of readdirSync(root)) fsyncTree(join(root, name));
  }
  fsyncPath(root);
}

function listFiles(root: string, current = root): string[] {
  const result: string[] = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error('Checkpoint exports must not contain symlinks.');
    if (entry.isDirectory()) result.push(...listFiles(root, absolute));
    else if (entry.isFile()) result.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error('Checkpoint exports may contain only directories and regular files.');
  }
  return result.sort();
}

function parseFirebaseExportMetadata(
  stagePath: string
): Record<FirebaseCheckpointComponent, FirebaseExportMetadataComponent> {
  const raw = JSON.parse(readFileSync(join(stagePath, FIREBASE_EXPORT_METADATA_FILENAME), 'utf8')) as Record<
    string,
    unknown
  >;
  const components = Object.fromEntries(
    FIREBASE_COMPONENTS.map((component) => {
      const value = raw[component];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Firebase export metadata is missing ${component}.`);
      }
      const componentPath = (value as Record<string, unknown>).path;
      if (typeof componentPath !== 'string' || !componentPath) {
        throw new Error(`Firebase export metadata is missing ${component}.path.`);
      }
      return [component, { path: componentPath }];
    })
  );
  return components as Record<FirebaseCheckpointComponent, FirebaseExportMetadataComponent>;
}

function componentRoot(componentPath: string): string {
  const normalized = componentPath.replaceAll('\\', '/');
  const [root] = normalized.split('/');
  if (!root || root === '.' || root === '..' || normalized.startsWith('/')) {
    throw new Error('Firebase component path is not a safe relative path.');
  }
  return root;
}

export async function buildCheckpointManifestFromExport(input: {
  stagePath: string;
  generationId: string;
  profile: string;
  projectId: string;
  kind: CheckpointGenerationKind;
  createdAt: string;
  completedAt: string;
}): Promise<FirebaseCheckpointManifest> {
  const stagePath = resolve(input.stagePath);
  const metadata = parseFirebaseExportMetadata(stagePath);
  const filePaths = listFiles(stagePath).filter((path) => path !== CHECKPOINT_MANIFEST_FILENAME);
  const files: CheckpointFileIdentity[] = [];
  for (const path of filePaths) {
    const digest = await hashFileStreaming(join(stagePath, ...path.split('/')));
    files.push({ path, ...digest });
  }
  const manifest: FirebaseCheckpointManifest = {
    schemaVersion: 1,
    generationId: input.generationId,
    profile: input.profile,
    projectId: input.projectId,
    kind: input.kind,
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    firebaseMetadataPath: FIREBASE_EXPORT_METADATA_FILENAME,
    components: {
      auth: { rootPath: componentRoot(metadata.auth.path) },
      firestore: { rootPath: componentRoot(metadata.firestore.path) },
      storage: { rootPath: componentRoot(metadata.storage.path) },
    },
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
  // Encoding performs the engine's complete structural validation.
  encodeCheckpointManifest(manifest);
  return manifest;
}

function writeExclusiveDurable(path: string, content: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

export async function promoteCheckpointGeneration(input: {
  profileRoot: string;
  stagePath: string;
  manifest: FirebaseCheckpointManifest;
  nonce: string;
}): Promise<ValidatedCheckpointGeneration> {
  const manifestContent = encodeCheckpointManifest(input.manifest);
  const manifestSha256 = createHash('sha256').update(manifestContent).digest('hex');
  const plan = buildCheckpointPromotionPlan({
    profileRoot: input.profileRoot,
    generationId: input.manifest.generationId,
    nonce: input.nonce,
    manifestSha256,
    completedAt: input.manifest.completedAt,
  });
  if (resolve(input.stagePath) !== plan.stagePath) throw new Error('Checkpoint stage identity changed.');
  if (existsSync(plan.finalPath)) throw new Error('Checkpoint generation already exists.');
  chmodPrivateTree(plan.stagePath);
  await assertPromotionPathsShareFilesystem(plan);
  fsyncTree(plan.stagePath);
  writeExclusiveDurable(plan.manifestTempPath, manifestContent);
  renameSync(plan.manifestTempPath, plan.stagedManifestPath);
  fsyncPath(plan.stagePath);
  renameSync(plan.stagePath, plan.finalPath);
  fsyncPath(plan.generationsRoot);
  writeExclusiveDurable(plan.latestTempPath, plan.latestContent);
  renameSync(plan.latestTempPath, plan.latestPath);
  fsyncPath(plan.profileRoot);
  return validateCheckpointGeneration(plan.finalPath, {
    expectedProfile: input.manifest.profile,
    expectedProjectId: input.manifest.projectId,
  });
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error('Checkpoint size scan refuses symlinks.');
  if (entry.isFile()) return entry.size;
  if (!entry.isDirectory()) return 0;
  return readdirSync(path).reduce((total, name) => total + directoryBytes(join(path, name)), 0);
}

function removeRuntimePath(root: string, candidate: string): void {
  if (!isContained(root, candidate) || resolve(root) === resolve(candidate)) {
    throw new Error('Checkpoint cleanup candidate escaped its owned root.');
  }
  rmSync(candidate, { recursive: true, force: true });
}

function cleanupCheckpointRootTemps(profileRoot: string): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(profileRoot)) {
    if (!/^\.LATEST\.tmp-[a-f0-9]{8,64}$/.test(name)) continue;
    removeRuntimePath(profileRoot, join(profileRoot, name));
    removed.push(name);
  }
  if (removed.length > 0) fsyncPath(profileRoot);
  return removed.sort();
}

export function cleanupCheckpointQuarantine(
  profileRoot: string,
  at: string,
  maxBytes = MAX_CHECKPOINT_QUARANTINE_BYTES
): string[] {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || new Date(atMs).toISOString() !== at) {
    throw new Error('Quarantine cleanup time must be a canonical ISO-8601 timestamp.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Quarantine byte limit must be a non-negative safe integer.');
  }
  const quarantineRoot = join(profileRoot, 'quarantine');
  if (!existsSync(quarantineRoot)) return [];
  const rootEntry = lstatSync(quarantineRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('Checkpoint quarantine must be a real directory.');
  }

  const candidates = readdirSync(quarantineRoot).map((name) => {
    const path = join(quarantineRoot, name);
    const entry = lstatSync(path);
    return {
      name,
      path,
      bytes: entry.isSymbolicLink() ? 0 : directoryBytes(path),
      modifiedAtMs: entry.mtimeMs,
      unsafe: entry.isSymbolicLink(),
    };
  });
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.name.localeCompare(left.name));

  let retainedEntries = 0;
  let retainedBytes = 0;
  const removed: string[] = [];
  for (const candidate of candidates) {
    const expired = atMs - candidate.modifiedAtMs > MAX_CHECKPOINT_QUARANTINE_AGE_MS;
    const exceedsCount = retainedEntries >= MAX_CHECKPOINT_QUARANTINE_ENTRIES;
    const exceedsBytes = retainedBytes + candidate.bytes > maxBytes;
    if (candidate.unsafe || expired || exceedsCount || exceedsBytes) {
      removeRuntimePath(quarantineRoot, candidate.path);
      removed.push(candidate.name);
      continue;
    }
    retainedEntries += 1;
    retainedBytes += candidate.bytes;
  }
  if (removed.length > 0) fsyncPath(quarantineRoot);
  return removed.sort();
}

export function applyCheckpointRetention(
  profileRoot: string,
  generations: readonly ValidatedCheckpointGeneration[],
  now: string,
  options: { preserveGenerationId?: string } = {}
): void {
  const plan = planCheckpointRetention(
    generations.map((generation) => ({
      id: generation.id,
      kind: generation.manifest.kind,
      completedAt: generation.manifest.completedAt,
    })),
    now
  );
  for (const candidate of plan.remove) {
    if (candidate.id === options.preserveGenerationId) continue;
    const path = join(profileRoot, GENERATIONS_DIRECTORY, candidate.id);
    if (!isContained(join(profileRoot, GENERATIONS_DIRECTORY), path)) {
      throw new Error('Retention candidate escaped the generations root.');
    }
    rmSync(path, { recursive: true, force: false });
  }
}

export function quarantineInvalidCheckpointCandidates(
  profileRoot: string,
  selection: RecoverySelection,
  at: string
): string[] {
  const generationsRoot = join(profileRoot, GENERATIONS_DIRECTORY);
  const canonicalGenerationsRoot = realpathSync(generationsRoot);
  const canonicalProfileRoot = realpathSync(profileRoot);
  const quarantineRoot = join(profileRoot, 'quarantine');
  const moved: string[] = [];
  const candidates = [...selection.invalidCandidates, ...selection.interruptedStages];
  for (const candidate of candidates) {
    if (!isContained(canonicalGenerationsRoot, candidate.path) || resolve(candidate.path) === canonicalProfileRoot) {
      continue;
    }
    const problem = candidate.problems[0]?.code ?? 'invalid-manifest';
    ensurePrivateDirectory(quarantineRoot);
    const baseTarget = join(quarantineRoot, quarantineDirectoryName(candidate.id, problem, at));
    let target = baseTarget;
    let suffix = 2;
    while (existsSync(target)) {
      target = `${baseTarget}-${suffix}`;
      suffix += 1;
    }
    renameSync(candidate.path, target);
    moved.push(basename(target));
  }
  if (moved.length > 0) {
    fsyncPath(quarantineRoot);
    fsyncPath(generationsRoot);
  }
  return moved;
}

export async function prepareFirebaseCheckpointRecovery(input: {
  profileRoot: string;
  profile: string;
  projectId: string;
  now?: () => Date;
}): Promise<RecoverySelection> {
  ensurePrivateDirectory(input.profileRoot);
  ensurePrivateDirectory(join(input.profileRoot, GENERATIONS_DIRECTORY));
  cleanupCheckpointRootTemps(input.profileRoot);
  const recoveryAt = (input.now ?? (() => new Date()))().toISOString();
  const selection = await selectNewestValidRecovery({
    profileRoot: input.profileRoot,
    expectedProfile: input.profile,
    expectedProjectId: input.projectId,
    now: recoveryAt,
  });
  if (selection.selected?.type === 'legacy') {
    throw new Error(
      'Found an unhashed legacy Firebase export. It was left untouched, but automatic recovery is refused because its file inventory cannot be verified.'
    );
  }
  quarantineInvalidCheckpointCandidates(input.profileRoot, selection, recoveryAt);
  cleanupCheckpointQuarantine(input.profileRoot, recoveryAt);
  return selection;
}

function safePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`${label} must be a positive integer.`);
  return candidate;
}

export async function createFirebaseCheckpoint(
  options: CreateFirebaseCheckpointOptions
): Promise<ValidatedCheckpointGeneration> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const nonce = randomBytes(8).toString('hex');
  const generationId = `cp-${createdAt.replace(/[-:.]/g, '')}-${nonce}`;
  const generationsRoot = join(options.profileRoot, GENERATIONS_DIRECTORY);
  ensurePrivateDirectory(options.profileRoot);
  ensurePrivateDirectory(generationsRoot);
  cleanupCheckpointRootTemps(options.profileRoot);
  const reserveBytes = safePositiveInteger(
    options.budget?.reserveBytes,
    DEFAULT_CHECKPOINT_RESERVE_BYTES,
    'checkpoint reserve'
  );
  const maxRetainedBytes = safePositiveInteger(
    options.budget?.maxRetainedBytes,
    DEFAULT_CHECKPOINT_PROFILE_CAP_BYTES,
    'checkpoint profile cap'
  );
  cleanupCheckpointQuarantine(
    options.profileRoot,
    createdAt,
    Math.min(MAX_CHECKPOINT_QUARANTINE_BYTES, Math.floor(maxRetainedBytes / 4))
  );
  const before = await selectNewestValidRecovery({
    profileRoot: options.profileRoot,
    expectedProfile: options.profile,
    expectedProjectId: options.projectId,
    now: createdAt,
  });
  quarantineInvalidCheckpointCandidates(options.profileRoot, before, createdAt);
  cleanupCheckpointQuarantine(
    options.profileRoot,
    createdAt,
    Math.min(MAX_CHECKPOINT_QUARANTINE_BYTES, Math.floor(maxRetainedBytes / 4))
  );
  // Never delete the last selected baseline before the replacement is fully
  // exported, verified, fsynced, and promoted. An old baseline is better than
  // no recovery point when the new export fails or disk pressure refuses it.
  applyCheckpointRetention(options.profileRoot, before.validGenerations, createdAt, {
    preserveGenerationId: before.selected?.type === 'verified' ? before.selected.id : undefined,
  });
  // Count every owned byte, including quarantine, interrupted stages, legacy
  // root exports, and pointer/temp residue. Unknown residue is never ignored or
  // deleted implicitly; it can only make the fail-closed budget refuse export.
  const retainedBytes = directoryBytes(options.profileRoot);
  const estimatedFullExportBytes = before.validGenerations[0]?.manifest.totalBytes ?? DEFAULT_CHECKPOINT_ESTIMATE_BYTES;
  const disk = statfsSync(options.profileRoot);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const budgetDecision = evaluateCheckpointDiskBudget({
    freeBytes,
    currentRetainedBytes: retainedBytes,
    reclaimableBytes: 0,
    estimatedFullExportBytes,
    reserveBytes,
    maxRetainedBytes,
  });
  if (!budgetDecision.allowed) {
    throw new Error(`Checkpoint refused by disk budget: ${budgetDecision.reasons.join(', ')}`);
  }

  const existingDailyDays = new Set(
    before.validGenerations
      .filter((generation) => generation.manifest.kind === 'daily')
      .map((generation) => generation.manifest.completedAt.slice(0, 10))
  );
  const stagePath = join(generationsRoot, `.stage-${generationId}-${nonce}`);
  const latestTempPath = join(options.profileRoot, `.${LATEST_POINTER_FILENAME}.tmp-${nonce}`);
  let promoted: ValidatedCheckpointGeneration;
  let completedAt: string;
  try {
    await options.exportTo(stagePath);
    if (!existsSync(stagePath)) throw new Error('Firebase export did not create its checkpoint stage.');
    chmodPrivateTree(stagePath);
    completedAt = now().toISOString();
    const { kind } = classifyUtcCheckpoint(completedAt, existingDailyDays);
    const manifest = await buildCheckpointManifestFromExport({
      stagePath,
      generationId,
      profile: options.profile,
      projectId: options.projectId,
      kind,
      createdAt,
      completedAt,
    });
    promoted = await promoteCheckpointGeneration({
      profileRoot: options.profileRoot,
      stagePath,
      manifest,
      nonce,
    });
  } catch (error) {
    if (existsSync(stagePath) || existsSync(latestTempPath)) {
      try {
        if (existsSync(stagePath)) {
          removeRuntimePath(generationsRoot, stagePath);
          fsyncPath(generationsRoot);
        }
        if (existsSync(latestTempPath)) {
          removeRuntimePath(options.profileRoot, latestTempPath);
          fsyncPath(options.profileRoot);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Checkpoint failed and its incomplete stage could not be removed.'
        );
      }
    }
    throw error;
  }
  const after = await selectNewestValidRecovery({
    profileRoot: options.profileRoot,
    expectedProfile: options.profile,
    expectedProjectId: options.projectId,
    now: completedAt,
  });
  applyCheckpointRetention(options.profileRoot, after.validGenerations, completedAt);
  return promoted;
}
