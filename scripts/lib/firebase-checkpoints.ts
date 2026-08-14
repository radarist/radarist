/**
 * Pure durability primitives for local Firebase emulator checkpoints.
 *
 * Firebase's CLI produces full exports. This module deliberately does not call
 * the CLI, schedule processes, or claim incremental-export support. It validates
 * completed full exports and describes the atomic filesystem operations a
 * single, externally-serialized writer must perform.
 */
import { createHash } from 'crypto';
import { createReadStream, type Stats } from 'fs';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';

export const CHECKPOINT_MANIFEST_VERSION = 1 as const;
export const LATEST_POINTER_VERSION = 1 as const;
export const CHECKPOINT_MANIFEST_FILENAME = 'radarist-checkpoint-manifest.json';
export const FIREBASE_EXPORT_METADATA_FILENAME = 'firebase-export-metadata.json';
export const LATEST_POINTER_FILENAME = 'LATEST';
export const GENERATIONS_DIRECTORY = 'generations';
export const MAX_ROLLING_GENERATIONS = 432;
export const MAX_ROLLING_AGE_MS = 72 * 60 * 60 * 1_000;
export const MAX_DAILY_GENERATIONS = 3;
export const MAX_CHECKPOINT_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export const FIREBASE_COMPONENTS = ['auth', 'firestore', 'storage'] as const;
export type FirebaseCheckpointComponent = (typeof FIREBASE_COMPONENTS)[number];
export type CheckpointGenerationKind = 'rolling' | 'daily';

export interface CheckpointFileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CheckpointComponentIdentity {
  /** Component root inside the Firebase export. */
  rootPath: string;
}

export interface FirebaseCheckpointManifest {
  schemaVersion: typeof CHECKPOINT_MANIFEST_VERSION;
  generationId: string;
  profile: string;
  projectId: string;
  kind: CheckpointGenerationKind;
  createdAt: string;
  completedAt: string;
  firebaseMetadataPath: typeof FIREBASE_EXPORT_METADATA_FILENAME;
  components: Record<FirebaseCheckpointComponent, CheckpointComponentIdentity>;
  files: CheckpointFileIdentity[];
  fileCount: number;
  totalBytes: number;
}

export interface LatestCheckpointPointer {
  schemaVersion: typeof LATEST_POINTER_VERSION;
  generationId: string;
  manifestSha256: string;
  updatedAt: string;
}

export type CheckpointProblemCode =
  | 'corrupt-latest'
  | 'firebase-metadata-invalid'
  | 'future-timestamp'
  | 'hash-mismatch'
  | 'identity-mismatch'
  | 'incomplete-components'
  | 'incomplete-stage'
  | 'invalid-manifest'
  | 'missing-file'
  | 'missing-manifest'
  | 'path-escape'
  | 'size-mismatch'
  | 'symlink'
  | 'unexpected-file'
  | 'unsafe-permissions';

export interface CheckpointProblem {
  code: CheckpointProblemCode;
  detail: string;
  path?: string;
}

export class CheckpointValidationError extends Error {
  constructor(
    readonly code: CheckpointProblemCode,
    message: string,
    readonly unsafePath?: string
  ) {
    super(message);
    this.name = 'CheckpointValidationError';
  }
}

function fail(code: CheckpointProblemCode, message: string, unsafePath?: string): never {
  throw new CheckpointValidationError(code, message, unsafePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = own(record, key);
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid-manifest', `${key} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = own(record, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid-manifest', `${key} must be a non-negative safe integer`);
  }
  return value;
}

function requireCanonicalTimestamp(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('invalid-manifest', `${field} must be a canonical ISO-8601 timestamp`);
  }
  return value;
}

function requireSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail('invalid-manifest', `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertSafeGenerationId(generationId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generationId) ||
    generationId === '.' ||
    generationId === '..' ||
    generationId.startsWith('.stage-')
  ) {
    fail('identity-mismatch', `Unsafe checkpoint generation id: ${generationId}`);
  }
  return generationId;
}

export function assertSafeRelativePath(input: string): string {
  if (
    input.length === 0 ||
    input.includes('\0') ||
    input.includes('\\') ||
    isAbsolute(input)
  ) {
    fail('path-escape', `Checkpoint path must be a portable relative path: ${input}`, input);
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('path-escape', `Checkpoint path escapes or is not normalized: ${input}`, input);
  }
  return input;
}

function parseComponentIdentity(value: unknown, name: FirebaseCheckpointComponent): CheckpointComponentIdentity {
  if (!isRecord(value)) {
    fail('incomplete-components', `Missing ${name} component identity`);
  }
  return { rootPath: assertSafeRelativePath(requireString(value, 'rootPath')) };
}

export function parseCheckpointManifest(value: unknown): FirebaseCheckpointManifest {
  if (!isRecord(value)) fail('invalid-manifest', 'Checkpoint manifest must be a JSON object');
  if (own(value, 'schemaVersion') !== CHECKPOINT_MANIFEST_VERSION) {
    fail('invalid-manifest', `Unsupported checkpoint manifest version: ${String(own(value, 'schemaVersion'))}`);
  }

  const generationId = assertSafeGenerationId(requireString(value, 'generationId'));
  const profile = requireString(value, 'profile');
  const projectId = requireString(value, 'projectId');
  const kind = own(value, 'kind');
  if (kind !== 'rolling' && kind !== 'daily') {
    fail('invalid-manifest', 'kind must be rolling or daily');
  }
  const createdAt = requireCanonicalTimestamp(requireString(value, 'createdAt'), 'createdAt');
  const completedAt = requireCanonicalTimestamp(requireString(value, 'completedAt'), 'completedAt');
  if (Date.parse(completedAt) < Date.parse(createdAt)) {
    fail('invalid-manifest', 'completedAt cannot precede createdAt');
  }
  if (own(value, 'firebaseMetadataPath') !== FIREBASE_EXPORT_METADATA_FILENAME) {
    fail('invalid-manifest', `firebaseMetadataPath must be ${FIREBASE_EXPORT_METADATA_FILENAME}`);
  }

  const rawComponents = own(value, 'components');
  if (!isRecord(rawComponents)) fail('incomplete-components', 'components must be an object');
  const components = {
    auth: parseComponentIdentity(own(rawComponents, 'auth'), 'auth'),
    firestore: parseComponentIdentity(own(rawComponents, 'firestore'), 'firestore'),
    storage: parseComponentIdentity(own(rawComponents, 'storage'), 'storage'),
  };
  if (new Set(FIREBASE_COMPONENTS.map((name) => components[name].rootPath)).size !== FIREBASE_COMPONENTS.length) {
    fail('incomplete-components', 'Auth, Firestore, and Storage roots must be distinct');
  }

  const rawFiles = own(value, 'files');
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    fail('invalid-manifest', 'files must contain the complete Firebase export inventory');
  }
  const files = rawFiles.map((entry, index): CheckpointFileIdentity => {
    if (!isRecord(entry)) fail('invalid-manifest', `files[${index}] must be an object`);
    return {
      path: assertSafeRelativePath(requireString(entry, 'path')),
      bytes: requireNonNegativeInteger(entry, 'bytes'),
      sha256: requireSha256(requireString(entry, 'sha256'), `files[${index}].sha256`),
    };
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail('invalid-manifest', 'files contains duplicate paths');
  if (paths.some((path, index) => index > 0 && compareLexical(paths[index - 1], path) >= 0)) {
    fail('invalid-manifest', 'files must be sorted by path for deterministic identity');
  }
  if (!paths.includes(FIREBASE_EXPORT_METADATA_FILENAME)) {
    fail('invalid-manifest', 'files must include Firebase export metadata');
  }

  const fileCount = requireNonNegativeInteger(value, 'fileCount');
  const totalBytes = requireNonNegativeInteger(value, 'totalBytes');
  if (fileCount !== files.length) fail('invalid-manifest', 'fileCount does not match files');
  if (totalBytes !== files.reduce((sum, file) => sum + file.bytes, 0)) {
    fail('invalid-manifest', 'totalBytes does not match files');
  }

  return {
    schemaVersion: CHECKPOINT_MANIFEST_VERSION,
    generationId,
    profile,
    projectId,
    kind,
    createdAt,
    completedAt,
    firebaseMetadataPath: FIREBASE_EXPORT_METADATA_FILENAME,
    components,
    files,
    fileCount,
    totalBytes,
  };
}

export function encodeCheckpointManifest(manifest: FirebaseCheckpointManifest): string {
  const validated = parseCheckpointManifest(manifest);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function parseLatestPointer(value: unknown): LatestCheckpointPointer {
  try {
    if (!isRecord(value)) fail('corrupt-latest', 'LATEST must be a JSON object');
    if (own(value, 'schemaVersion') !== LATEST_POINTER_VERSION) {
      fail('corrupt-latest', `Unsupported LATEST version: ${String(own(value, 'schemaVersion'))}`);
    }
    const generationId = assertSafeGenerationId(requireString(value, 'generationId'));
    const manifestSha256 = requireSha256(requireString(value, 'manifestSha256'), 'manifestSha256');
    const updatedAt = requireCanonicalTimestamp(requireString(value, 'updatedAt'), 'updatedAt');
    return { schemaVersion: LATEST_POINTER_VERSION, generationId, manifestSha256, updatedAt };
  } catch (error) {
    if (error instanceof CheckpointValidationError && error.code === 'corrupt-latest') throw error;
    fail(
      'corrupt-latest',
      `LATEST is invalid: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof CheckpointValidationError ? error.unsafePath : undefined
    );
  }
}

export function encodeLatestPointer(pointer: LatestCheckpointPointer): string {
  const validated = parseLatestPointer(pointer);
  return `${JSON.stringify(validated)}\n`;
}

export async function hashFileStreaming(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      const bytesChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += bytesChunk.length;
      hash.update(bytesChunk);
    });
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return { bytes, sha256: hash.digest('hex') };
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

function assertSafeMode(stats: Stats, path: string, privateRoot: boolean): void {
  const forbidden = privateRoot ? 0o077 : 0o022;
  if ((stats.mode & forbidden) !== 0) {
    fail(
      'unsafe-permissions',
      privateRoot
        ? `Checkpoint root must not grant group or other permissions: ${path}`
        : `Checkpoint content must not be group/world writable: ${path}`,
      path
    );
  }
}

async function assertOwned(stats: Stats, path: string, expectedUid: number | undefined): Promise<void> {
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    fail('unsafe-permissions', `Checkpoint path is not owned by uid ${expectedUid}: ${path}`, path);
  }
}

export async function validatePrivateCheckpointRoot(
  root: string,
  expectedUid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined
): Promise<string> {
  const absoluteRoot = resolve(root);
  const rootStats = await lstat(absoluteRoot);
  if (rootStats.isSymbolicLink()) fail('symlink', `Checkpoint root cannot be a symlink: ${absoluteRoot}`, absoluteRoot);
  if (!rootStats.isDirectory()) fail('path-escape', `Checkpoint root is not a directory: ${absoluteRoot}`, absoluteRoot);
  assertSafeMode(rootStats, absoluteRoot, true);
  await assertOwned(rootStats, absoluteRoot, expectedUid);
  return realpath(absoluteRoot);
}

async function validateExistingContainedPath(
  root: string,
  relativePath: string,
  expectedUid: number | undefined
): Promise<{ absolutePath: string; stats: Stats }> {
  const safePath = assertSafeRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, safePath);
  if (!isWithin(absoluteRoot, absolutePath)) fail('path-escape', `Path escapes checkpoint root: ${safePath}`, safePath);

  let cursor = absoluteRoot;
  for (const segment of safePath.split('/')) {
    cursor = join(cursor, segment);
    let entryStats: Stats;
    try {
      entryStats = await lstat(cursor);
    } catch {
      fail('missing-file', `Checkpoint path is missing: ${safePath}`, safePath);
    }
    if (entryStats.isSymbolicLink()) fail('symlink', `Checkpoint path contains a symlink: ${safePath}`, safePath);
    assertSafeMode(entryStats, cursor, false);
    await assertOwned(entryStats, cursor, expectedUid);
  }

  const resolved = await realpath(absolutePath);
  const resolvedRoot = await realpath(absoluteRoot);
  if (!isWithin(resolvedRoot, resolved)) fail('path-escape', `Resolved path escapes checkpoint root: ${safePath}`, safePath);
  return { absolutePath, stats: await stat(absolutePath) };
}

async function inventoryFiles(
  root: string,
  expectedUid: number | undefined,
  relativeDirectory = ''
): Promise<string[]> {
  const directory = relativeDirectory ? join(root, relativeDirectory) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareLexical(left.name, right.name))) {
    const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    assertSafeRelativePath(relativeEntry);
    const { absolutePath, stats: entryStats } = await validateExistingContainedPath(root, relativeEntry, expectedUid);
    if (entryStats.isDirectory()) {
      files.push(...(await inventoryFiles(root, expectedUid, relativeEntry)));
    } else if (entryStats.isFile()) {
      files.push(relativeEntry);
    } else {
      fail('symlink', `Unsupported checkpoint filesystem entry: ${absolutePath}`, relativeEntry);
    }
  }
  return files.sort(compareLexical);
}

function problemFrom(error: unknown, fallback: CheckpointProblemCode): CheckpointProblem {
  if (error instanceof CheckpointValidationError) {
    return { code: error.code, detail: error.message, path: error.unsafePath };
  }
  return { code: fallback, detail: error instanceof Error ? error.message : String(error) };
}

function firebaseComponentMetadata(value: unknown, component: FirebaseCheckpointComponent): Record<string, unknown> {
  if (!isRecord(value)) fail('firebase-metadata-invalid', 'Firebase export metadata must be an object');
  const componentValue = own(value, component);
  if (!isRecord(componentValue)) {
    fail('incomplete-components', `Firebase export metadata is missing ${component}`);
  }
  return componentValue;
}

async function validateFirebaseMetadata(
  generationRoot: string,
  manifest: FirebaseCheckpointManifest,
  expectedUid: number | undefined
): Promise<void> {
  const { absolutePath } = await validateExistingContainedPath(
    generationRoot,
    manifest.firebaseMetadataPath,
    expectedUid
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    fail('firebase-metadata-invalid', `Firebase export metadata is not valid JSON: ${String(error)}`);
  }
  for (const component of FIREBASE_COMPONENTS) {
    const componentMetadata = firebaseComponentMetadata(parsed, component);
    const metadataPath = own(componentMetadata, 'path');
    if (typeof metadataPath !== 'string') {
      fail('firebase-metadata-invalid', `Firebase ${component} metadata is missing its export path`);
    }
    const safeMetadataPath = assertSafeRelativePath(metadataPath);
    const componentRoot = manifest.components[component].rootPath;
    if (safeMetadataPath !== componentRoot && !safeMetadataPath.startsWith(`${componentRoot}/`)) {
      fail(
        'identity-mismatch',
        `Firebase ${component} metadata path does not match manifest root`,
        safeMetadataPath
      );
    }
    await validateExistingContainedPath(generationRoot, safeMetadataPath, expectedUid);
  }
}

export interface ValidatedCheckpointGeneration {
  type: 'verified';
  id: string;
  path: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: FirebaseCheckpointManifest;
}

export async function validateCheckpointGeneration(
  generationPath: string,
  options: { expectedProfile: string; expectedProjectId: string; expectedUid?: number }
): Promise<ValidatedCheckpointGeneration> {
  const expectedUid =
    options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const absoluteGeneration = resolve(generationPath);
  const generationStats = await lstat(absoluteGeneration);
  if (generationStats.isSymbolicLink()) fail('symlink', 'Generation directory cannot be a symlink', absoluteGeneration);
  if (!generationStats.isDirectory()) fail('invalid-manifest', 'Generation path is not a directory', absoluteGeneration);
  assertSafeMode(generationStats, absoluteGeneration, false);
  await assertOwned(generationStats, absoluteGeneration, expectedUid);

  const generationId = assertSafeGenerationId(absoluteGeneration.split(sep).at(-1) ?? '');
  const manifestPath = join(absoluteGeneration, CHECKPOINT_MANIFEST_FILENAME);
  let rawManifest: unknown;
  try {
    const manifestStats = await lstat(manifestPath);
    if (manifestStats.isSymbolicLink()) fail('symlink', 'Checkpoint manifest cannot be a symlink', manifestPath);
    assertSafeMode(manifestStats, manifestPath, false);
    await assertOwned(manifestStats, manifestPath, expectedUid);
    rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof CheckpointValidationError) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') fail('missing-manifest', `Missing ${CHECKPOINT_MANIFEST_FILENAME}`, manifestPath);
    fail('invalid-manifest', `Cannot read checkpoint manifest: ${String(error)}`, manifestPath);
  }
  const manifest = parseCheckpointManifest(rawManifest);
  if (manifest.generationId !== generationId) {
    fail('identity-mismatch', 'Manifest generationId does not match its directory', manifestPath);
  }
  if (manifest.profile !== options.expectedProfile || manifest.projectId !== options.expectedProjectId) {
    fail('identity-mismatch', 'Manifest profile/project does not match the requested local workspace', manifestPath);
  }

  for (const component of FIREBASE_COMPONENTS) {
    const componentPath = await validateExistingContainedPath(
      absoluteGeneration,
      manifest.components[component].rootPath,
      expectedUid
    );
    if (!componentPath.stats.isDirectory()) {
      fail('incomplete-components', `${component} root is not a directory`, componentPath.absolutePath);
    }
  }

  const actualFiles = (await inventoryFiles(absoluteGeneration, expectedUid)).filter(
    (file) => file !== CHECKPOINT_MANIFEST_FILENAME
  );
  const expectedFiles = manifest.files.map((file) => file.path);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const missing = expectedFiles.find((file) => !actualSet.has(file));
  if (missing) fail('missing-file', `Manifest file is missing: ${missing}`, missing);
  const unexpected = actualFiles.find((file) => !expectedSet.has(file));
  if (unexpected) fail('unexpected-file', `Unmanifested checkpoint file: ${unexpected}`, unexpected);

  for (const identity of manifest.files) {
    const { absolutePath, stats: fileStats } = await validateExistingContainedPath(
      absoluteGeneration,
      identity.path,
      expectedUid
    );
    if (!fileStats.isFile()) fail('missing-file', `Manifest path is not a regular file: ${identity.path}`, identity.path);
    if (fileStats.size !== identity.bytes) {
      fail('size-mismatch', `Size mismatch for ${identity.path}`, identity.path);
    }
    const digest = await hashFileStreaming(absolutePath);
    if (digest.bytes !== identity.bytes || digest.sha256 !== identity.sha256) {
      fail('hash-mismatch', `Hash mismatch for ${identity.path}`, identity.path);
    }
  }
  await validateFirebaseMetadata(absoluteGeneration, manifest, expectedUid);
  const manifestDigest = await hashFileStreaming(manifestPath);
  return {
    type: 'verified',
    id: generationId,
    path: absoluteGeneration,
    manifestPath,
    manifestSha256: manifestDigest.sha256,
    manifest,
  };
}

export function checkpointStageDirectoryName(generationId: string, nonce: string): string {
  assertSafeGenerationId(generationId);
  if (!/^[a-f0-9]{8,64}$/.test(nonce)) fail('identity-mismatch', 'Stage nonce must be 8-64 lowercase hex characters');
  return `.stage-${generationId}-${nonce}`;
}

export type PromotionStepKind =
  | 'fsync-export-files'
  | 'write-manifest-temp-exclusive'
  | 'fsync-manifest-temp'
  | 'rename-manifest-temp'
  | 'fsync-stage-directory'
  | 'rename-stage-directory'
  | 'fsync-generations-directory'
  | 'write-latest-temp-exclusive'
  | 'fsync-latest-temp'
  | 'rename-latest-temp'
  | 'fsync-profile-directory';

export interface CheckpointPromotionPlan {
  profileRoot: string;
  generationsRoot: string;
  stagePath: string;
  finalPath: string;
  stagedManifestPath: string;
  manifestTempPath: string;
  latestPath: string;
  latestTempPath: string;
  latestContent: string;
  steps: Array<{ kind: PromotionStepKind; from?: string; to?: string; path?: string }>;
}

export function buildCheckpointPromotionPlan(input: {
  profileRoot: string;
  generationId: string;
  nonce: string;
  manifestSha256: string;
  completedAt: string;
}): CheckpointPromotionPlan {
  const generationId = assertSafeGenerationId(input.generationId);
  const manifestSha256 = requireSha256(input.manifestSha256, 'manifestSha256');
  const completedAt = requireCanonicalTimestamp(input.completedAt, 'completedAt');
  const profileRoot = resolve(input.profileRoot);
  const generationsRoot = join(profileRoot, GENERATIONS_DIRECTORY);
  const stagePath = join(generationsRoot, checkpointStageDirectoryName(generationId, input.nonce));
  const finalPath = join(generationsRoot, generationId);
  const manifestTempPath = join(stagePath, `.${CHECKPOINT_MANIFEST_FILENAME}.tmp-${input.nonce}`);
  const stagedManifestPath = join(stagePath, CHECKPOINT_MANIFEST_FILENAME);
  const latestPath = join(profileRoot, LATEST_POINTER_FILENAME);
  const latestTempPath = join(profileRoot, `.${LATEST_POINTER_FILENAME}.tmp-${input.nonce}`);
  const latestContent = encodeLatestPointer({
    schemaVersion: LATEST_POINTER_VERSION,
    generationId,
    manifestSha256,
    updatedAt: completedAt,
  });
  return {
    profileRoot,
    generationsRoot,
    stagePath,
    finalPath,
    stagedManifestPath,
    manifestTempPath,
    latestPath,
    latestTempPath,
    latestContent,
    steps: [
      { kind: 'fsync-export-files', path: stagePath },
      { kind: 'write-manifest-temp-exclusive', path: manifestTempPath },
      { kind: 'fsync-manifest-temp', path: manifestTempPath },
      { kind: 'rename-manifest-temp', from: manifestTempPath, to: stagedManifestPath },
      { kind: 'fsync-stage-directory', path: stagePath },
      { kind: 'rename-stage-directory', from: stagePath, to: finalPath },
      { kind: 'fsync-generations-directory', path: generationsRoot },
      { kind: 'write-latest-temp-exclusive', path: latestTempPath },
      { kind: 'fsync-latest-temp', path: latestTempPath },
      { kind: 'rename-latest-temp', from: latestTempPath, to: latestPath },
      { kind: 'fsync-profile-directory', path: profileRoot },
    ],
  };
}

export async function assertPromotionPathsShareFilesystem(plan: CheckpointPromotionPlan): Promise<void> {
  const [stageStats, generationsStats, profileStats] = await Promise.all([
    stat(plan.stagePath),
    stat(plan.generationsRoot),
    stat(plan.profileRoot),
  ]);
  if (stageStats.dev !== generationsStats.dev || generationsStats.dev !== profileStats.dev) {
    fail('path-escape', 'Checkpoint stage, generation, and LATEST must share one filesystem');
  }
}

export interface CheckpointSchedulerState {
  running: boolean;
  runningSince: string | null;
  pendingSince: string | null;
  pendingRequestCount: number;
  totalStarted: number;
  totalCompleted: number;
  totalCoalesced: number;
}

export const INITIAL_CHECKPOINT_SCHEDULER_STATE: CheckpointSchedulerState = Object.freeze({
  running: false,
  runningSince: null,
  pendingSince: null,
  pendingRequestCount: 0,
  totalStarted: 0,
  totalCompleted: 0,
  totalCoalesced: 0,
});

export function requestCheckpoint(
  current: CheckpointSchedulerState,
  requestedAt: string
): { action: 'start' | 'coalesced'; state: CheckpointSchedulerState } {
  const timestamp = requireCanonicalTimestamp(requestedAt, 'requestedAt');
  if (!current.running) {
    return {
      action: 'start',
      state: {
        ...current,
        running: true,
        runningSince: timestamp,
        pendingSince: null,
        pendingRequestCount: 0,
        totalStarted: current.totalStarted + 1,
      },
    };
  }
  return {
    action: 'coalesced',
    state: {
      ...current,
      pendingSince: current.pendingSince ?? timestamp,
      pendingRequestCount: current.pendingRequestCount + 1,
      totalCoalesced: current.totalCoalesced + 1,
    },
  };
}

export function finishCheckpoint(
  current: CheckpointSchedulerState,
  finishedAt: string
): { action: 'idle' | 'start-coalesced' | 'already-idle'; state: CheckpointSchedulerState } {
  const timestamp = requireCanonicalTimestamp(finishedAt, 'finishedAt');
  if (!current.running) return { action: 'already-idle', state: current };
  const completed = current.totalCompleted + 1;
  if (current.pendingRequestCount > 0) {
    return {
      action: 'start-coalesced',
      state: {
        ...current,
        runningSince: timestamp,
        pendingSince: null,
        pendingRequestCount: 0,
        totalStarted: current.totalStarted + 1,
        totalCompleted: completed,
      },
    };
  }
  return {
    action: 'idle',
    state: {
      ...current,
      running: false,
      runningSince: null,
      pendingSince: null,
      pendingRequestCount: 0,
      totalCompleted: completed,
    },
  };
}

export function utcDayKey(timestamp: string): string {
  return requireCanonicalTimestamp(timestamp, 'timestamp').slice(0, 10);
}

export function classifyUtcCheckpoint(
  completedAt: string,
  existingDailyUtcDays: ReadonlySet<string>
): { kind: CheckpointGenerationKind; utcDay: string } {
  const utcDay = utcDayKey(completedAt);
  return { kind: existingDailyUtcDays.has(utcDay) ? 'rolling' : 'daily', utcDay };
}

export interface RetentionGeneration {
  id: string;
  kind: CheckpointGenerationKind;
  completedAt: string;
}

export type RetentionDeleteReason =
  | 'daily-duplicate'
  | 'daily-limit'
  | 'rolling-age'
  | 'rolling-limit';

export type RetentionQuarantineReason = 'future-generation';

export interface CheckpointRetentionPlan {
  keep: RetentionGeneration[];
  remove: Array<RetentionGeneration & { reason: RetentionDeleteReason }>;
  quarantine: Array<RetentionGeneration & { reason: RetentionQuarantineReason }>;
}

function newestFirst(left: RetentionGeneration, right: RetentionGeneration): number {
  const time = Date.parse(right.completedAt) - Date.parse(left.completedAt);
  return time !== 0 ? time : compareLexical(right.id, left.id);
}

export function planCheckpointRetention(
  generations: readonly RetentionGeneration[],
  now: string,
  requestedPolicy: { maxRolling?: number; rollingAgeMs?: number; maxDaily?: number } = {}
): CheckpointRetentionPlan {
  const nowMs = Date.parse(requireCanonicalTimestamp(now, 'now'));
  const boundedPolicyValue = (value: number | undefined, fallback: number, hardMaximum: number): number => {
    const candidate = value ?? fallback;
    if (!Number.isFinite(candidate) || candidate < 0) {
      throw new Error('Checkpoint retention policy values must be finite non-negative numbers');
    }
    return Math.min(hardMaximum, Math.trunc(candidate));
  };
  const maxRolling = boundedPolicyValue(
    requestedPolicy.maxRolling,
    MAX_ROLLING_GENERATIONS,
    MAX_ROLLING_GENERATIONS
  );
  const rollingAgeMs = boundedPolicyValue(
    requestedPolicy.rollingAgeMs,
    MAX_ROLLING_AGE_MS,
    MAX_ROLLING_AGE_MS
  );
  const maxDaily = boundedPolicyValue(
    requestedPolicy.maxDaily,
    MAX_DAILY_GENERATIONS,
    MAX_DAILY_GENERATIONS
  );
  const seenIds = new Set<string>();
  const normalized = generations.map((generation) => {
    assertSafeGenerationId(generation.id);
    if (seenIds.has(generation.id)) throw new Error(`Duplicate generation id: ${generation.id}`);
    seenIds.add(generation.id);
    requireCanonicalTimestamp(generation.completedAt, 'completedAt');
    return { ...generation };
  });
  const keep: RetentionGeneration[] = [];
  const remove: Array<RetentionGeneration & { reason: RetentionDeleteReason }> = [];
  const quarantine: Array<RetentionGeneration & { reason: RetentionQuarantineReason }> = [];

  const daily = normalized.filter((generation) => generation.kind === 'daily').sort(newestFirst);
  const dailyDays = new Set<string>();
  for (const generation of daily) {
    const generationMs = Date.parse(generation.completedAt);
    const day = utcDayKey(generation.completedAt);
    if (generationMs > nowMs) {
      quarantine.push({ ...generation, reason: 'future-generation' });
    } else if (dailyDays.has(day)) {
      remove.push({ ...generation, reason: 'daily-duplicate' });
    } else if (dailyDays.size >= maxDaily) {
      remove.push({ ...generation, reason: 'daily-limit' });
    } else {
      dailyDays.add(day);
      keep.push(generation);
    }
  }

  let rollingKept = 0;
  const rolling = normalized.filter((generation) => generation.kind === 'rolling').sort(newestFirst);
  for (const generation of rolling) {
    const generationMs = Date.parse(generation.completedAt);
    if (generationMs > nowMs) {
      quarantine.push({ ...generation, reason: 'future-generation' });
    } else if (nowMs - generationMs > rollingAgeMs) {
      remove.push({ ...generation, reason: 'rolling-age' });
    } else if (rollingKept >= maxRolling) {
      remove.push({ ...generation, reason: 'rolling-limit' });
    } else {
      rollingKept += 1;
      keep.push(generation);
    }
  }

  return {
    keep: keep.sort(newestFirst),
    remove: remove.sort(newestFirst),
    quarantine: quarantine.sort(newestFirst),
  };
}

export type DiskBudgetReason = 'free-space-reserve' | 'profile-size-cap';

export interface DiskBudgetDecision {
  allowed: boolean;
  reasons: DiskBudgetReason[];
  pruneBeforeExport: boolean;
  requiredFreeBytes: number;
  effectiveFreeBytes: number;
  projectedRetainedBytes: number;
}

function safeByteCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function safeByteSum(values: number[], field: string): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) throw new Error(`${field} exceeds the safe integer range`);
  return sum;
}

export function evaluateCheckpointDiskBudget(input: {
  freeBytes: number;
  currentRetainedBytes: number;
  reclaimableBytes: number;
  estimatedFullExportBytes: number;
  reserveBytes: number;
  maxRetainedBytes: number;
  metadataOverheadBytes?: number;
}): DiskBudgetDecision {
  const freeBytes = safeByteCount(input.freeBytes, 'freeBytes');
  const current = safeByteCount(input.currentRetainedBytes, 'currentRetainedBytes');
  const reclaimable = Math.min(current, safeByteCount(input.reclaimableBytes, 'reclaimableBytes'));
  const estimate = safeByteCount(input.estimatedFullExportBytes, 'estimatedFullExportBytes');
  const reserve = safeByteCount(input.reserveBytes, 'reserveBytes');
  const cap = safeByteCount(input.maxRetainedBytes, 'maxRetainedBytes');
  const overhead = safeByteCount(input.metadataOverheadBytes ?? 64 * 1_024, 'metadataOverheadBytes');
  const effectiveFreeBytes = safeByteSum([freeBytes, reclaimable], 'effectiveFreeBytes');
  const requiredFreeBytes = safeByteSum([estimate, overhead, reserve], 'requiredFreeBytes');
  const projectedRetainedBytes = safeByteSum(
    [current - reclaimable, estimate, overhead],
    'projectedRetainedBytes'
  );
  const reasons: DiskBudgetReason[] = [];
  if (effectiveFreeBytes < requiredFreeBytes) reasons.push('free-space-reserve');
  if (projectedRetainedBytes > cap) reasons.push('profile-size-cap');
  return {
    allowed: reasons.length === 0,
    reasons,
    pruneBeforeExport: reclaimable > 0 && (freeBytes < requiredFreeBytes || current + estimate + overhead > cap),
    requiredFreeBytes,
    effectiveFreeBytes,
    projectedRetainedBytes,
  };
}

export interface LegacyFirebaseExport {
  type: 'legacy';
  id: 'legacy-export';
  path: string;
  completedAt: string;
  integrity: 'legacy-unverified';
}

async function inspectLegacyExport(
  profileRoot: string,
  expectedUid: number | undefined
): Promise<LegacyFirebaseExport | null> {
  const metadataPath = join(profileRoot, FIREBASE_EXPORT_METADATA_FILENAME);
  let metadataStats: Stats;
  try {
    metadataStats = await lstat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (metadataStats.isSymbolicLink()) fail('symlink', 'Legacy Firebase metadata cannot be a symlink', metadataPath);
  assertSafeMode(metadataStats, metadataPath, false);
  await assertOwned(metadataStats, metadataPath, expectedUid);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    fail('firebase-metadata-invalid', `Legacy Firebase metadata is invalid: ${String(error)}`, metadataPath);
  }
  for (const component of FIREBASE_COMPONENTS) {
    const componentMetadata = firebaseComponentMetadata(parsed, component);
    const componentPath = own(componentMetadata, 'path');
    if (typeof componentPath !== 'string') {
      fail('firebase-metadata-invalid', `Legacy Firebase metadata lacks ${component}.path`, metadataPath);
    }
    await validateExistingContainedPath(profileRoot, componentPath, expectedUid);
  }
  return {
    type: 'legacy',
    id: 'legacy-export',
    path: resolve(profileRoot),
    completedAt: metadataStats.mtime.toISOString(),
    integrity: 'legacy-unverified',
  };
}

export interface InvalidRecoveryCandidate {
  id: string;
  path: string;
  problems: CheckpointProblem[];
}

export interface RecoverySelection {
  selected: ValidatedCheckpointGeneration | LegacyFirebaseExport | null;
  validGenerations: ValidatedCheckpointGeneration[];
  invalidCandidates: InvalidRecoveryCandidate[];
  interruptedStages: InvalidRecoveryCandidate[];
  diagnostics: CheckpointProblem[];
  latestPointer: LatestCheckpointPointer | null;
}

export async function selectNewestValidRecovery(input: {
  profileRoot: string;
  expectedProfile: string;
  expectedProjectId: string;
  expectedUid?: number;
  now?: string;
}): Promise<RecoverySelection> {
  const expectedUid =
    input.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  const profileRoot = await validatePrivateCheckpointRoot(input.profileRoot, expectedUid);
  const nowMs = Date.parse(requireCanonicalTimestamp(input.now ?? new Date().toISOString(), 'now'));
  const generationsRoot = join(profileRoot, GENERATIONS_DIRECTORY);
  const validGenerations: ValidatedCheckpointGeneration[] = [];
  const invalidCandidates: InvalidRecoveryCandidate[] = [];
  const interruptedStages: InvalidRecoveryCandidate[] = [];
  const diagnostics: CheckpointProblem[] = [];
  let entries: string[] = [];
  try {
    const generations = await validateExistingContainedPath(
      profileRoot,
      GENERATIONS_DIRECTORY,
      expectedUid
    );
    if (!generations.stats.isDirectory()) {
      fail('path-escape', 'Checkpoint generations path is not a directory', generations.absolutePath);
    }
    entries = (await readdir(generationsRoot)).sort(compareLexical);
  } catch (error) {
    const missingDirectory =
      error instanceof CheckpointValidationError && error.code === 'missing-file';
    if (!missingDirectory && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    const candidatePath = join(generationsRoot, entry);
    if (entry.startsWith('.stage-')) {
      interruptedStages.push({
        id: entry,
        path: candidatePath,
        problems: [{ code: 'incomplete-stage', detail: 'Interrupted staging directory is never recoverable' }],
      });
      continue;
    }
    try {
      assertSafeGenerationId(entry);
      const generation = await validateCheckpointGeneration(candidatePath, {
          expectedProfile: input.expectedProfile,
          expectedProjectId: input.expectedProjectId,
          expectedUid,
        });
      if (Date.parse(generation.manifest.completedAt) > nowMs + MAX_CHECKPOINT_FUTURE_SKEW_MS) {
        fail(
          'future-timestamp',
          `Checkpoint completedAt exceeds the allowed ${MAX_CHECKPOINT_FUTURE_SKEW_MS}ms clock skew`,
          candidatePath
        );
      }
      validGenerations.push(generation);
    } catch (error) {
      invalidCandidates.push({ id: entry, path: candidatePath, problems: [problemFrom(error, 'invalid-manifest')] });
    }
  }

  validGenerations.sort((left, right) => {
    const byTime = Date.parse(right.manifest.completedAt) - Date.parse(left.manifest.completedAt);
    return byTime !== 0 ? byTime : compareLexical(right.id, left.id);
  });

  let latestPointer: LatestCheckpointPointer | null = null;
  try {
    const latest = await validateExistingContainedPath(profileRoot, LATEST_POINTER_FILENAME, expectedUid);
    if (!latest.stats.isFile()) fail('corrupt-latest', 'LATEST is not a regular file', latest.absolutePath);
    latestPointer = parseLatestPointer(JSON.parse(await readFile(latest.absolutePath, 'utf8')));
    const pointed = validGenerations.find((generation) => generation.id === latestPointer?.generationId);
    if (!pointed || pointed.manifestSha256 !== latestPointer.manifestSha256) {
      diagnostics.push({
        code: 'corrupt-latest',
        detail: 'LATEST does not identify a validated generation; newest valid fallback will be used',
      });
      latestPointer = null;
    }
  } catch (error) {
    const missingPointer = error instanceof CheckpointValidationError && error.code === 'missing-file';
    if (!missingPointer && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(problemFrom(error, 'corrupt-latest'));
    }
  }

  let legacy: LegacyFirebaseExport | null = null;
  try {
    legacy = await inspectLegacyExport(profileRoot, expectedUid);
    if (legacy && Date.parse(legacy.completedAt) > nowMs + MAX_CHECKPOINT_FUTURE_SKEW_MS) {
      invalidCandidates.push({
        id: legacy.id,
        path: legacy.path,
        problems: [
          {
            code: 'future-timestamp',
            detail: `Legacy checkpoint timestamp exceeds the allowed ${MAX_CHECKPOINT_FUTURE_SKEW_MS}ms clock skew`,
            path: legacy.path,
          },
        ],
      });
      legacy = null;
    }
  } catch (error) {
    invalidCandidates.push({
      id: 'legacy-export',
      path: profileRoot,
      problems: [problemFrom(error, 'firebase-metadata-invalid')],
    });
  }
  // A hash-verified generation always outranks an unverified legacy export.
  const selected = validGenerations[0] ?? legacy;
  return {
    selected,
    validGenerations,
    invalidCandidates,
    interruptedStages,
    diagnostics,
    latestPointer,
  };
}

export function quarantineDirectoryName(
  candidateId: string,
  reason: CheckpointProblemCode,
  at: string
): string {
  const safeId = candidateId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
  const timestamp = requireCanonicalTimestamp(at, 'at').replace(/[-:.]/g, '');
  return `.quarantine-${timestamp}-${reason}-${safeId}`;
}
