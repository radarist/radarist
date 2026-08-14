#!/usr/bin/env npx tsx
import './load-env-local';

import {
  createOperatorNeo4jBackup,
  OPERATOR_BACKUP_CONFIRMATION,
  OPERATOR_RESTORE_CONFIRMATION,
  planOperatorNeo4jBackup,
  planOperatorBackupRestoreToDisposable,
  restoreOperatorBackupToDisposable,
  verifyOperatorBackupManifest,
} from './lib/operator-neo4j-backup';

interface CliOptions {
  mode: 'backup' | 'verify' | 'restore-disposable';
  value?: string;
  outputDir?: string;
  profileArgs: string[];
  dryRun: boolean;
}

function usage(): never {
  console.error(`Usage:
  npm run neo4j:backup:operator -- --backup <label> --profile <default|selftest> [--output-dir <directory>] --dry-run
  npm run neo4j:backup:operator -- --backup <label> --profile <default|selftest> [--output-dir <directory>]
  npm run neo4j:backup:operator -- --verify <manifest.json>
  npm run neo4j:backup:operator -- --restore-disposable <manifest.json> --profile <default|selftest> --dry-run
  npm run neo4j:backup:operator -- --restore-disposable <manifest.json> --profile <default|selftest>

Every mutating mode requires ONE explicit --profile selection. Shifted or
suffixed runtimes are selected with the same sanctioned overrides the
launcher used, e.g. RADARIST_LOCAL_RUNTIME_PORT_OFFSET=20 and
RADARIST_LOCAL_RUNTIME_NAME_SUFFIX=rc2; the command never assumes a graph.

Backup safety:
  Stop the app and Inngest dev server for the selected profile, then set
  NEO4J_OPERATOR_BACKUP_CONFIRM=${OPERATOR_BACKUP_CONFIRMATION}

Disposable restore safety:
  The selected profile must resolve to a proven disposable target (marker-
  named container and volumes); the protected default/retained identities
  are always rejected. Set
  NEO4J_OPERATOR_RESTORE_CONFIRM=${OPERATOR_RESTORE_CONFIRMATION}`);
  process.exit(2);
}

function parseArgs(args: string[]): CliOptions {
  let mode: CliOptions['mode'] | undefined;
  let value: string | undefined;
  let outputDir: string | undefined;
  let dryRun = false;
  const profileArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--backup' || arg === '--verify' || arg === '--restore-disposable') {
      if (mode) usage();
      mode = arg === '--backup' ? 'backup' : arg === '--verify' ? 'verify' : 'restore-disposable';
      value = args[index + 1];
      if (!value || value.startsWith('--')) usage();
      index += 1;
    } else if (arg === '--output-dir') {
      outputDir = args[index + 1];
      if (!outputDir || outputDir.startsWith('--')) usage();
      index += 1;
    } else if (arg === '--dry-run') {
      if (dryRun) usage();
      dryRun = true;
    } else if (arg === '--profile' || arg.startsWith('--profile=')) {
      profileArgs.push(arg);
      if (arg === '--profile') {
        const profileValue = args[index + 1];
        if (!profileValue || profileValue.startsWith('--')) usage();
        profileArgs.push(profileValue);
        index += 1;
      }
    } else {
      usage();
    }
  }
  if (!mode || !value || (mode !== 'backup' && outputDir) || (dryRun && mode === 'verify')) usage();
  return { mode, value, outputDir, profileArgs, dryRun };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'backup') {
    if (options.dryRun) {
      const plan = planOperatorNeo4jBackup(options.value!, options.profileArgs, options.outputDir);
      console.log(`[operator-backup] dry-run source: ${plan.target.container}`);
      console.log(`[operator-backup] dry-run volume: ${plan.target.dataVolume}`);
      console.log(`[operator-backup] dry-run writer ports: ${plan.writerPorts.join(',')}`);
      console.log(`[operator-backup] dry-run archive: ${plan.archivePath}`);
      console.log('[operator-backup] dry-run complete; no container, volume, or file was mutated');
      return;
    }
    const verified = createOperatorNeo4jBackup(options.value!, options.profileArgs, options.outputDir);
    console.log(`[operator-backup] profile: ${verified.manifest.profile.name}`);
    console.log(`[operator-backup] source: ${verified.manifest.source.container} (${verified.manifest.source.runtimeLabel})`);
    console.log(`[operator-backup] archive: ${verified.archivePath}`);
    console.log(`[operator-backup] manifest: ${verified.manifestPath}`);
    return;
  }
  if (options.mode === 'verify') {
    const verified = verifyOperatorBackupManifest(options.value!);
    console.log(`[operator-backup] verified: ${verified.manifestPath}`);
    console.log(`[operator-backup] sha256: ${verified.manifest.archive.sha256}`);
    return;
  }
  if (options.dryRun) {
    const plan = planOperatorBackupRestoreToDisposable(options.value!, options.profileArgs);
    console.log(`[operator-restore] dry-run target: ${plan.target.container}`);
    console.log(`[operator-restore] dry-run volume: ${plan.target.dataVolume}`);
    console.log(`[operator-restore] dry-run writer ports: ${plan.writerPorts.join(',')}`);
    console.log('[operator-restore] dry-run complete; no container or volume was mutated');
    return;
  }
  restoreOperatorBackupToDisposable(options.value!, options.profileArgs);
  console.log(`[operator-restore] restored and verified the selected disposable profile graph`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
