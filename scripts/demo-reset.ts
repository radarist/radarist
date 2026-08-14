#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { commandAvailable, DEMO_PROFILES } from './lib/local-demo';
import {
  deriveLocalRuntimePaths,
  parseLocalRuntimeProfileArg,
  type LocalRuntimeProfile,
} from './lib/local-runtime-profile';
import {
  assertFirebaseOnlyResetMarkerSafeToClear,
  clearFirebaseOnlyResetMarker,
  writeFirebaseOnlyResetMarker,
} from './lib/local-reset-marker';

export interface DemoResetTargets {
  readonly profile: LocalRuntimeProfile;
  readonly container: string;
  readonly migrationBackupContainer: string;
  readonly volumes: readonly string[];
  readonly directories: readonly string[];
}

export interface DemoResetOptions {
  readonly profile: LocalRuntimeProfile;
  readonly apply: boolean;
  readonly includeNeo4j: boolean;
  readonly firebaseOnly: boolean;
  readonly confirmedProfile?: string;
}

export interface DemoResetResult {
  readonly dryRun: boolean;
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
  readonly planned: readonly string[];
}

interface DemoResetRuntime {
  readonly dockerAvailable: () => boolean;
  readonly dockerCommand: (args: readonly string[]) => {
    ok: boolean;
    stderr: string;
    stdout?: string;
    missing?: boolean;
  };
  readonly pathExists: (path: string) => boolean;
  readonly removeDirectory: (path: string) => void;
}

const DEFAULT_RUNTIME: DemoResetRuntime = {
  dockerAvailable: () => commandAvailable('docker', ['info']),
  dockerCommand: (args) => {
    const result = spawnSync('docker', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr =
      (result.stderr || result.error?.message || '').trim().split('\n')[0] ||
      'unknown docker error';
    return {
      ok: result.status === 0,
      stderr,
      stdout: result.stdout.trim(),
      missing: /no such (object|container|volume)/i.test(stderr),
    };
  },
  pathExists: existsSync,
  removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
};

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === option) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`The ${option} option requires an explicit value.`);
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${option}=`)) {
      const value = argument.slice(option.length + 1);
      if (!value) throw new Error(`The ${option} option requires an explicit value.`);
      values.push(value);
    }
  }
  return values;
}

function countFlag(args: readonly string[], flag: string): number {
  return args.filter((argument) => argument === flag).length;
}

function assertKnownArguments(args: readonly string[]): void {
  const valueOptions = new Set(['--profile', '--confirm-profile']);
  const flags = new Set([
    '--apply',
    '--dry-run',
    '--include-neo4j',
    '--firebase-only',
    '--help',
    '-h',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (flags.has(argument)) continue;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if ([...valueOptions].some((option) => argument.startsWith(`${option}=`))) continue;
    throw new Error(`Unknown demo:reset argument: ${argument}`);
  }
}

/**
 * Parse the reset contract without touching disk or Docker. A bare invocation
 * is deliberately a dry run. Applying a reset requires the selected profile
 * name to be repeated exactly, so a typo or implicit default cannot destroy a
 * different workspace.
 */
export function parseDemoResetOptions(args: readonly string[]): DemoResetOptions {
  assertKnownArguments(args);
  const profile = parseLocalRuntimeProfileArg(args);
  const applyCount = countFlag(args, '--apply');
  const dryRunCount = countFlag(args, '--dry-run');
  const includeNeo4jCount = countFlag(args, '--include-neo4j');
  const firebaseOnlyCount = countFlag(args, '--firebase-only');
  const confirmationValues = optionValues(args, '--confirm-profile');

  if (applyCount > 1 || dryRunCount > 1 || includeNeo4jCount > 1 || firebaseOnlyCount > 1) {
    throw new Error('Specify each demo:reset flag at most once.');
  }
  if (applyCount > 0 && dryRunCount > 0) {
    throw new Error('Choose either --apply or --dry-run, not both.');
  }
  if (includeNeo4jCount > 0 && firebaseOnlyCount > 0) {
    throw new Error('Choose exactly one reset scope: --include-neo4j or --firebase-only.');
  }
  if (confirmationValues.length > 1) {
    throw new Error('Specify --confirm-profile exactly once.');
  }

  const apply = applyCount === 1;
  const confirmedProfile = confirmationValues[0];
  const hasExplicitProfile = args.some(
    (argument) => argument === '--profile' || argument.startsWith('--profile=')
  );
  if (apply && !hasExplicitProfile) {
    throw new Error('Destructive reset refused. Select --profile explicitly before using --apply.');
  }
  if (apply && confirmedProfile !== profile.name) {
    throw new Error(
      `Destructive reset refused. Repeat the exact selected profile with --confirm-profile ${profile.name}.`
    );
  }
  if (apply && includeNeo4jCount === 0 && firebaseOnlyCount === 0) {
    throw new Error(
      'Destructive reset refused. Choose --include-neo4j for a consistent whole-workspace reset or --firebase-only for intentional maintenance.'
    );
  }
  if (!apply && confirmedProfile !== undefined) {
    throw new Error('--confirm-profile is only valid together with --apply.');
  }

  return {
    profile,
    apply,
    includeNeo4j: includeNeo4jCount === 1,
    firebaseOnly: firebaseOnlyCount === 1,
    confirmedProfile,
  };
}

/**
 * Everything `demo:reset` may remove for one profile. The single filesystem
 * target is the canonical private profile root; it contains runtime state,
 * rolling checkpoints, and Firebase exports. No shared tmp directory appears
 * in this plan.
 */
export function deriveResetTargets(
  profileValue: unknown,
  repositoryRoot = process.cwd()
): DemoResetTargets {
  const profile = parseLocalRuntimeProfileArg(['--profile', String(profileValue)]);
  const demoProfile = DEMO_PROFILES[profile.name];
  const paths = deriveLocalRuntimePaths(repositoryRoot, profile.name);
  return {
    profile,
    container: demoProfile.neo4jContainer,
    migrationBackupContainer: `${demoProfile.neo4jContainer}-legacy-gds-migration`,
    volumes: ['data', 'logs', 'import', 'plugins'].map(
      (suffix) => `${demoProfile.neo4jVolumePrefix}_${suffix}`
    ),
    directories: [paths.root],
  };
}

function assertProfileDirectoryTarget(
  repositoryRoot: string,
  profile: LocalRuntimeProfile,
  target: string
): void {
  const dataRoot = resolve(repositoryRoot, 'emulator-data');
  const expected = resolve(dataRoot, profile.name);
  const absoluteTarget = resolve(target);
  const fromDataRoot = relative(dataRoot, absoluteTarget);
  if (
    absoluteTarget !== expected ||
    !fromDataRoot ||
    fromDataRoot === '..' ||
    fromDataRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromDataRoot)
  ) {
    throw new Error(`Refusing to remove a path outside the ${profile.name} profile root.`);
  }
  if (existsSync(dataRoot) && lstatSync(dataRoot).isSymbolicLink()) {
    throw new Error('Refusing to reset through a symbolic-link emulator-data root.');
  }
  if (existsSync(absoluteTarget) && lstatSync(absoluteTarget).isSymbolicLink()) {
    throw new Error(`Refusing to reset the symbolic-link ${profile.name} profile root.`);
  }
}

function formatDirectory(repositoryRoot: string, directory: string): string {
  const display = relative(repositoryRoot, directory);
  return display && !display.startsWith(`..${sep}`) && !isAbsolute(display)
    ? `./${display}`
    : directory;
}

export function runDemoReset(
  options: DemoResetOptions,
  repositoryRoot = process.cwd(),
  runtime: DemoResetRuntime = DEFAULT_RUNTIME
): DemoResetResult {
  if (options.apply && options.confirmedProfile !== options.profile.name) {
    throw new Error('Destructive reset refused because the profile confirmation does not match.');
  }
  if (options.apply && options.includeNeo4j === options.firebaseOnly) {
    throw new Error(
      'Destructive reset refused because exactly one explicit reset scope is required.'
    );
  }

  const targets = deriveResetTargets(options.profile.name, repositoryRoot);
  const runtimePaths = deriveLocalRuntimePaths(repositoryRoot, options.profile.name);
  const directoryLabels = targets.directories.map(
    (directory) => `Profile data ${formatDirectory(repositoryRoot, directory)}`
  );
  const neo4jLabels = options.includeNeo4j
    ? [
        `Neo4j container ${targets.container}`,
        `Neo4j migration backup container ${targets.migrationBackupContainer}`,
        ...targets.volumes.map((volume) => `Docker volume ${volume}`),
      ]
    : [];
  const planned = [...directoryLabels, ...neo4jLabels];

  if (!options.apply) {
    return { dryRun: true, removed: [], skipped: [], planned };
  }

  const removed: string[] = [];
  const skipped: string[] = [];

  // Validate every filesystem target before deleting anything, including an
  // independently opted-in graph container. A compromised profile path must
  // fail the whole plan before its first destructive action.
  if (options.firebaseOnly) {
    // Persist the cross-store warning outside the profile directory before
    // deleting it. Any interruption after this point therefore fails closed.
    writeFirebaseOnlyResetMarker(runtimePaths);
  }

  for (const directory of targets.directories) {
    assertProfileDirectoryTarget(repositoryRoot, targets.profile, directory);
  }
  if (runtime.pathExists(runtimePaths.processManifest)) {
    throw new Error(
      `Reset refused because the ${options.profile.name} runtime process manifest is present. Stop that local stack cleanly before resetting it.`
    );
  }
  if (runtime.pathExists(runtimePaths.runtimeLease)) {
    throw new Error(
      `Reset refused because the ${options.profile.name} runtime lease is present. Restart that profile to recover verified stale processes, then stop it cleanly before resetting it.`
    );
  }
  if (options.includeNeo4j) assertFirebaseOnlyResetMarkerSafeToClear(runtimePaths);

  // Neo4j deletion is an explicit reset scope. A Firebase-only maintenance
  // reset must never delete the long-lived local graph as an incidental side
  // effect.
  if (options.includeNeo4j) {
    if (!runtime.dockerAvailable()) {
      throw new Error('Reset requested Neo4j deletion, but Docker is not available. Nothing was removed.');
    }

    const ownership = `durable:${options.profile.name}`;
    const containerNames = [targets.container, targets.migrationBackupContainer];
    const containerInspections = new Map<
      string,
      ReturnType<DemoResetRuntime['dockerCommand']>
    >();
    for (const container of containerNames) {
      const inspection = runtime.dockerCommand([
        'container',
        'inspect',
        '--format',
        '{{index .Config.Labels "com.radarist.local-runtime"}}',
        container,
      ]);
      containerInspections.set(container, inspection);
      if (!inspection.ok && !inspection.missing) {
        throw new Error(
          `Could not preflight Neo4j container ${container}: ${inspection.stderr}. Nothing was removed.`
        );
      }
      if (inspection.ok && inspection.stdout !== ownership) {
        throw new Error(
          `Refusing unowned Neo4j container ${container}. Expected profile label ${ownership}. Nothing was removed.`
        );
      }
    }
    const existingVolumes: string[] = [];
    for (const volume of targets.volumes) {
      const inspection = runtime.dockerCommand([
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "com.radarist.local-runtime"}}',
        volume,
      ]);
      if (!inspection.ok && !inspection.missing) {
        throw new Error(
          `Could not preflight Docker volume ${volume}: ${inspection.stderr}. Nothing was removed.`
        );
      }
      if (inspection.ok && inspection.stdout !== ownership) {
        throw new Error(
          `Refusing unowned Docker volume ${volume}. Expected profile label ${ownership}. Nothing was removed.`
        );
      }
      if (inspection.ok) existingVolumes.push(volume);
    }

    // Preflight every volume referrer before the first destructive Docker
    // command. A later in-use failure must not be discovered after an earlier
    // container or volume was already removed.
    for (const volume of existingVolumes) {
      const referrers = runtime.dockerCommand([
        'ps',
        '--all',
        '--filter',
        `volume=${volume}`,
        '--format',
        '{{.Names}}',
      ]);
      if (!referrers.ok) {
        throw new Error(
          `Could not preflight Docker volume referrers for ${volume}: ${referrers.stderr}. Nothing was removed.`
        );
      }
      const names = (referrers.stdout ?? '')
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean);
      const foreign = names.filter((name) => !containerNames.includes(name));
      const unverified = names.filter(
        (name) => !containerInspections.get(name)?.ok
      );
      if (foreign.length > 0 || unverified.length > 0) {
        throw new Error(
          `Refusing to remove Docker volume ${volume}; it is referenced by an unexpected container. Nothing was removed.`
        );
      }
    }

    for (const container of containerNames) {
      const inspection = containerInspections.get(container)!;
      if (inspection.ok) {
        const containerResult = runtime.dockerCommand(['rm', '-f', container]);
        if (containerResult.ok) {
          removed.push(
            container === targets.container
              ? `Neo4j container ${container}`
              : `Neo4j migration backup container ${container}`
          );
        } else {
          throw new Error(
            `Could not remove Neo4j container ${container}: ${containerResult.stderr}. Firebase profile data was preserved.`
          );
        }
      } else {
        skipped.push(
          container === targets.container
            ? `Neo4j container ${container} (not present)`
            : `Neo4j migration backup container ${container} (not present)`
        );
      }
    }

    for (const volume of targets.volumes) {
      if (existingVolumes.includes(volume)) {
        const volumeResult = runtime.dockerCommand(['volume', 'rm', volume]);
        if (volumeResult.ok) removed.push(`Docker volume ${volume}`);
        else {
          throw new Error(
            `Could not remove Docker volume ${volume}: ${volumeResult.stderr}. Firebase profile data was preserved.`
          );
        }
      } else {
        skipped.push(`Docker volume ${volume} (not present)`);
      }
    }
  }

  for (const directory of targets.directories) {
    const label = `Profile data ${formatDirectory(repositoryRoot, directory)}`;
    if (!runtime.pathExists(directory)) {
      skipped.push(`${label} (not present)`);
      continue;
    }
    runtime.removeDirectory(directory);
    removed.push(label);
  }

  if (options.includeNeo4j) clearFirebaseOnlyResetMarker(runtimePaths);

  return { dryRun: false, removed, skipped, planned };
}

function printUsage(): void {
  console.log(`Usage: npm run demo:reset -- [--profile default|selftest] [options]

Preview is the default. No data is removed without --apply and an exact
profile confirmation.

Options:
  --dry-run                         Preview the selected profile reset (default)
  --apply                           Perform the reset
  --confirm-profile <profile>       Required with --apply; must match exactly
  --include-neo4j                   Also remove that profile's container/volumes
  --firebase-only                   Intentionally reset Firebase while preserving Neo4j

Examples:
  npm run demo:reset -- --profile selftest
  npm run demo:reset -- --profile selftest --apply --confirm-profile selftest --firebase-only
  npm run demo:reset -- --profile selftest --apply --confirm-profile selftest --include-neo4j

Apply requires one explicit scope. --firebase-only removes only
./emulator-data/<profile>, which contains Firebase exports, checkpoints, and
runtime files. It writes a profile-bound marker that blocks every durable
Firebase launcher until a guarded --include-neo4j reset removes the preserved
graph and clears the marker. The env file and every other profile are always
left untouched.`);
}

function printResult(options: DemoResetOptions, result: DemoResetResult): void {
  console.log(`[demo:reset] Profile: ${options.profile.name}`);
  console.log(
    options.includeNeo4j
      ? '[demo:reset] Scope: Firebase profile data + explicitly selected Neo4j data'
      : '[demo:reset] Scope: Firebase profile data only (Neo4j preserved)'
  );
  if (result.dryRun) {
    console.log('[demo:reset] DRY RUN - nothing was removed. Planned targets:');
    for (const item of result.planned) console.log(`  - ${item}`);
    console.log(
      `[demo:reset] Apply with --apply --confirm-profile ${options.profile.name} and exactly one of --include-neo4j or --firebase-only`
    );
    return;
  }

  console.log(`[demo:reset] Removed (${result.removed.length}):`);
  for (const item of result.removed) console.log(`  - ${item}`);
  if (result.removed.length === 0) console.log('  (nothing)');
  console.log(`[demo:reset] Skipped (${result.skipped.length}):`);
  for (const item of result.skipped) console.log(`  - ${item}`);
  if (result.skipped.length === 0) console.log('  (nothing)');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const options = parseDemoResetOptions(args);
  const result = runDemoReset(options);
  printResult(options, result);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[demo:reset] Failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
