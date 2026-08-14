import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { LocalRuntimePaths } from './local-runtime-profile';

const RESET_STATE_DIRECTORY = '.reset-state';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function firebaseOnlyResetMarkerPath(paths: LocalRuntimePaths): string {
  return join(paths.dataRoot, RESET_STATE_DIRECTORY, `${paths.profileName}.firebase-only-reset`);
}

function assertContained(parent: string, candidate: string): void {
  const child = relative(resolve(parent), resolve(candidate));
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Firebase-only reset marker escaped the local runtime data root.');
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!pathEntryExists(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Firebase-only reset marker directory must be a real directory.');
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeFirebaseOnlyResetMarker(paths: LocalRuntimePaths): string {
  const marker = firebaseOnlyResetMarkerPath(paths);
  const markerDirectory = resolve(marker, '..');
  assertContained(paths.dataRoot, marker);
  ensurePrivateDirectory(paths.dataRoot);
  ensurePrivateDirectory(markerDirectory);
  if (pathEntryExists(marker)) {
    const entry = lstatSync(marker);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error('Firebase-only reset marker must be a regular file.');
    }
    return marker;
  }

  const descriptor = openSync(marker, 'wx', PRIVATE_FILE_MODE);
  try {
    writeFileSync(
      descriptor,
      `profile=${paths.profileName}\nreason=firebase-only-reset-preserved-graph\n`,
      'utf8'
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(marker, PRIVATE_FILE_MODE);
  fsyncDirectory(markerDirectory);
  return marker;
}

export function assertFirebaseOnlyResetMarkerAbsent(paths: LocalRuntimePaths): void {
  const marker = firebaseOnlyResetMarkerPath(paths);
  assertContained(paths.dataRoot, marker);
  if (!pathEntryExists(marker)) return;
  assertFirebaseOnlyResetMarkerSafeToClear(paths);
  throw new Error(
    `Profile ${paths.profileName} was reset with --firebase-only while its graph was preserved. ` +
      'Run the guarded whole-workspace reset with --include-neo4j before starting a durable Firebase workspace.'
  );
}

export function assertFirebaseOnlyResetMarkerSafeToClear(paths: LocalRuntimePaths): void {
  const marker = firebaseOnlyResetMarkerPath(paths);
  assertContained(paths.dataRoot, marker);
  if (!pathEntryExists(marker)) return;
  const entry = lstatSync(marker);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('Firebase-only reset marker is unsafe; refusing local workspace startup.');
  }
}

export function clearFirebaseOnlyResetMarker(paths: LocalRuntimePaths): void {
  const marker = firebaseOnlyResetMarkerPath(paths);
  const markerDirectory = resolve(marker, '..');
  assertContained(paths.dataRoot, marker);
  if (!pathEntryExists(marker)) return;
  assertFirebaseOnlyResetMarkerSafeToClear(paths);
  unlinkSync(marker);
  fsyncDirectory(markerDirectory);
}
