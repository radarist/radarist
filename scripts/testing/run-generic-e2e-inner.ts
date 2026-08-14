#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runPlaywrightJsonLane } from './run-playwright-json-lane';

interface GenericModeContract {
  readonly minExpected: number;
  readonly maxSkipped: number;
  readonly playwrightArgs: readonly string[];
}

const CONTRACTS: Readonly<Record<string, GenericModeContract>> = Object.freeze({
  // The private source lane retains its established full-suite floor. Both
  // source and public supervisors select E2E_RUNTIME_LANE=generic, so the
  // reduced public floor is selected from the validated manifest schema below.
  full: { minExpected: 319, maxSkipped: 0, playwrightArgs: [] },
  smoke: { minExpected: 31, maxSkipped: 0, playwrightArgs: ['smoke', '--project=chromium'] },
});

const PUBLIC_GENERIC_FULL_CONTRACT: GenericModeContract = Object.freeze({
  minExpected: 46,
  maxSkipped: 0,
  playwrightArgs: [],
});

export function loadGenericRuntimeManifestSchemaVersion(root = process.cwd()): 2 | 3 {
  const path = resolve(root, 'tests/e2e/runtime-manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read generic E2E runtime manifest at ${path}: ${detail}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Generic E2E runtime manifest at ${path} must be an object`);
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 2 && schemaVersion !== 3) {
    throw new Error(
      `Generic E2E runtime manifest at ${path} has unsupported schemaVersion ${JSON.stringify(schemaVersion)}`
    );
  }
  return schemaVersion;
}

export function genericModeContract(
  mode: string | undefined,
  runtimeManifestSchemaVersion: number = loadGenericRuntimeManifestSchemaVersion()
): GenericModeContract {
  const contract = mode ? CONTRACTS[mode] : undefined;
  if (!contract) throw new Error('GENERIC_E2E_MODE must be full or smoke');
  if (runtimeManifestSchemaVersion !== 2 && runtimeManifestSchemaVersion !== 3) {
    throw new Error(`Generic E2E runtime manifest has unsupported schemaVersion ${runtimeManifestSchemaVersion}`);
  }
  if (mode === 'full' && runtimeManifestSchemaVersion === 3) return PUBLIC_GENERIC_FULL_CONTRACT;
  return contract;
}

export function runGenericE2EInner(mode = process.env.GENERIC_E2E_MODE): void {
  const contract = genericModeContract(mode);
  const seed = spawnSync('npm', ['run', 'e2e:generic:seed'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (seed.error) throw seed.error;
  if (seed.status !== 0) {
    throw new Error(`Generic E2E seed exited ${String(seed.status ?? seed.signal)}`);
  }

  runPlaywrightJsonLane({
    lane: `generic-${mode}`,
    config: 'playwright.config.ts',
    minExpected: contract.minExpected,
    maxSkipped: contract.maxSkipped,
    maxFlaky: 0,
    playwrightArgs: contract.playwrightArgs,
  });
}

if (require.main === module) {
  try {
    runGenericE2EInner();
  } catch (error) {
    process.stderr.write(`[generic-e2e] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
