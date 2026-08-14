/** @jest-environment node */

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import {
  assertFirebaseOnlyResetMarkerAbsent,
  clearFirebaseOnlyResetMarker,
  firebaseOnlyResetMarkerPath,
  writeFirebaseOnlyResetMarker,
} from '../lib/local-reset-marker';
import { deriveLocalRuntimePaths } from '../lib/local-runtime-profile';

describe('Firebase-only reset consistency marker', () => {
  let repositoryRoot: string;

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'radarist-reset-marker-'));
  });

  afterEach(() => rmSync(repositoryRoot, { recursive: true, force: true }));

  it('blocks only the reset profile until a whole-workspace reset clears it', () => {
    const defaultPaths = deriveLocalRuntimePaths(repositoryRoot, 'default');
    const selftestPaths = deriveLocalRuntimePaths(repositoryRoot, 'selftest');

    const marker = writeFirebaseOnlyResetMarker(defaultPaths);
    expect(marker).toBe(firebaseOnlyResetMarkerPath(defaultPaths));
    expect(lstatSync(marker).mode & 0o777).toBe(0o600);
    expect(() => assertFirebaseOnlyResetMarkerAbsent(defaultPaths)).toThrow(
      /reset with --firebase-only/
    );
    expect(() => assertFirebaseOnlyResetMarkerAbsent(selftestPaths)).not.toThrow();

    clearFirebaseOnlyResetMarker(defaultPaths);
    expect(existsSync(marker)).toBe(false);
    expect(() => assertFirebaseOnlyResetMarkerAbsent(defaultPaths)).not.toThrow();
  });

  it('is idempotent and fails closed on a symlink marker', () => {
    const paths = deriveLocalRuntimePaths(repositoryRoot, 'default');
    const marker = writeFirebaseOnlyResetMarker(paths);
    expect(writeFirebaseOnlyResetMarker(paths)).toBe(marker);
    clearFirebaseOnlyResetMarker(paths);

    mkdirSync(join(paths.dataRoot, '.reset-state'), { recursive: true });
    symlinkSync(join(repositoryRoot, 'missing-target'), marker);
    expect(() => assertFirebaseOnlyResetMarkerAbsent(paths)).toThrow(/marker is unsafe/);
    expect(() => clearFirebaseOnlyResetMarker(paths)).toThrow(/marker is unsafe/);
  });

  it('guards every supported durable Firebase launcher at source', () => {
    for (const script of ['scripts/demo-full.ts', 'scripts/emulators-persist.ts']) {
      const source = readFileSync(resolve(process.cwd(), script), 'utf8');
      expect(source).toContain('assertFirebaseOnlyResetMarkerAbsent');
      expect(source).toMatch(
        /mode === 'durable'\) assertFirebaseOnlyResetMarkerAbsent|durabilityMode === 'durable'\) assertFirebaseOnlyResetMarkerAbsent/
      );
    }
  });
});
