/**
 * @file agent/src/sandbox/harvest.ts
 * @description Harvest a mission's durable essence BEFORE the container +
 * volume are reclaimed (L). The sandbox is ephemeral compute; the bundle is
 * the source of truth. We capture a git bundle (full history, no
 * node_modules) plus the .impulse logs/screenshots/verdict into a single
 * tarball copied to the host — typically a few MB vs the GB-scale volume.
 *
 * Findings/verdict already live on the mission doc + graph (E0/E1); this
 * preserves the code, history, and full run log so nothing of value is lost
 * when the volume is reclaimed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { resetWorkspaceGitControlPlane, runTrustedWorkspaceGit } from './git-control-plane.js';
import type { SandboxDriver, SandboxRef } from './types.js';

const CONTAINER_BUNDLE_PATH = '.impulse/repo.bundle';
const CONTAINER_HARVEST_PATH = '/tmp/harvest.tgz';

export interface HarvestBundleIntegrity {
  sha256: string;
  bytes: number;
}

export interface HarvestArtifactResult extends HarvestBundleIntegrity {
  bundlePath: string;
}

function hostBundlePath(hostHarvestDir: string, missionId: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(missionId) || missionId === '.' || missionId === '..') return null;
  return path.join(path.resolve(hostHarvestDir), `${missionId}.tgz`);
}

function cleanExecArgv(argv: string[]): string[] {
  return [
    '/usr/bin/env',
    '-i',
    'HOME=/nonexistent',
    'XDG_CONFIG_HOME=/nonexistent',
    'PATH=/usr/bin:/bin',
    'LANG=C',
    'LC_ALL=C',
    ...argv,
  ];
}

/** Read one regular file without following a final-component symlink. */
export async function readHarvestBundleIntegrity(bundlePath: string): Promise<HarvestBundleIntegrity | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    handle = await fs.promises.open(bundlePath, fs.constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || !Number.isSafeInteger(before.size)) return null;

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      );
      if (bytesRead <= 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat();
    const currentPath = await fs.promises.lstat(bundlePath);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      currentPath.dev !== after.dev ||
      currentPath.ino !== after.ino ||
      currentPath.size !== after.size
    ) {
      return null;
    }
    return { sha256: hash.digest('hex'), bytes: after.size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseContainerIntegrity(digestOutput: string, sizeOutput: string): HarvestBundleIntegrity | null {
  const digest = digestOutput.trim().match(/^([a-f0-9]{64})(?:\s|$)/i)?.[1]?.toLowerCase();
  const bytes = Number(sizeOutput.trim());
  if (!digest || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return { sha256: digest, bytes };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Bundle the repo + .impulse inside the container and copy the tarball out
 * to `hostHarvestDir/<missionId>.tgz`. Returns the host path only after both
 * the in-container archive and copied host file have been verified. A null
 * result means callers MUST retain the volume and retry later.
 */
export async function harvestArtifact(
  driver: SandboxDriver,
  ref: SandboxRef,
  hostHarvestDir: string,
  missionId: string
): Promise<HarvestArtifactResult | null> {
  const bundlePath = hostBundlePath(hostHarvestDir, missionId);
  if (!bundlePath) return null;
  const harvestDirectory = path.dirname(bundlePath);
  const temporaryPath = path.join(
    harvestDirectory,
    `.${path.basename(bundlePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.mkdirSync(harvestDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(harvestDirectory, 0o700);
  } catch {
    return null;
  }

  try {
    // Mission code controls the repository. Replace hooks/config/alternates and
    // rebuild the index before asking Git to traverse it.
    await resetWorkspaceGitControlPlane(driver, ref);

    const cleared = await driver.exec(
      ref,
      ['/bin/rm', '-f', '--', CONTAINER_BUNDLE_PATH, CONTAINER_HARVEST_PATH],
      { user: 'node' }
    );
    if (cleared.code !== 0) return null;

    const bundled = await runTrustedWorkspaceGit(driver, ref, [
      'bundle',
      'create',
      CONTAINER_BUNDLE_PATH,
      '--all',
    ]);
    if (bundled.code !== 0) return null;

    const verifiedBundle = await runTrustedWorkspaceGit(driver, ref, [
      'bundle',
      'verify',
      CONTAINER_BUNDLE_PATH,
    ]);
    if (verifiedBundle.code !== 0) return null;

    // Structured argv + an empty environment means a mission-controlled shell
    // profile, PATH, tar alias, or HOME cannot execute during retention GC.
    const archived = await driver.exec(
      ref,
      cleanExecArgv(['/usr/bin/tar', '-czf', CONTAINER_HARVEST_PATH, '.impulse']),
      { timeoutMs: 120_000, user: 'node' }
    );
    if (archived.code !== 0) return null;

    const listed = await driver.exec(
      ref,
      cleanExecArgv(['/usr/bin/tar', '-tzf', CONTAINER_HARVEST_PATH]),
      { timeoutMs: 120_000, user: 'node' }
    );
    if (listed.code !== 0 || !listed.stdout.split('\n').includes(CONTAINER_BUNDLE_PATH)) return null;

    const [containerDigest, containerSize] = await Promise.all([
      driver.exec(
        ref,
        cleanExecArgv(['/usr/bin/sha256sum', '--', CONTAINER_HARVEST_PATH]),
        { timeoutMs: 120_000, user: 'node' }
      ),
      driver.exec(
        ref,
        cleanExecArgv(['/usr/bin/stat', '-c', '%s', '--', CONTAINER_HARVEST_PATH]),
        { timeoutMs: 120_000, user: 'node' }
      ),
    ]);
    if (containerDigest.code !== 0 || containerSize.code !== 0) return null;
    const expectedIntegrity = parseContainerIntegrity(containerDigest.stdout, containerSize.stdout);
    if (!expectedIntegrity) return null;

    // Copy to a unique sibling and atomically replace the final path only after
    // the host bytes match the source container. A failed retry never destroys
    // a previously verified bundle.
    await driver.copyOut(ref, CONTAINER_HARVEST_PATH, temporaryPath);
    const copiedIntegrity = await readHarvestBundleIntegrity(temporaryPath);
    if (
      !copiedIntegrity ||
      copiedIntegrity.sha256 !== expectedIntegrity.sha256 ||
      copiedIntegrity.bytes !== expectedIntegrity.bytes
    ) {
      return null;
    }

    const temporaryHandle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await fs.promises.rename(temporaryPath, bundlePath);
    await syncDirectory(harvestDirectory);

    const persistedIntegrity = await readHarvestBundleIntegrity(bundlePath);
    if (
      !persistedIntegrity ||
      persistedIntegrity.sha256 !== expectedIntegrity.sha256 ||
      persistedIntegrity.bytes !== expectedIntegrity.bytes
    ) {
      return null;
    }
    return { bundlePath, ...persistedIntegrity };
  } catch {
    return null;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}
