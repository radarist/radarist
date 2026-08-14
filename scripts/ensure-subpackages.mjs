#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SUBPACKAGES = ['agent'];
export function parseOptions(args) {
  const requested = [];
  let force = false, dryRun = false, help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--package') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('`--package` requires a package name.');
      requested.push(value);
    } else if (arg.startsWith('--package=')) requested.push(arg.slice('--package='.length));
    else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else throw new Error('Unknown argument: ' + arg);
  }
  const packages = requested.length ? [...new Set(requested)] : [...SUBPACKAGES];
  const unknown = packages.filter((pkg) => !SUBPACKAGES.includes(pkg));
  if (unknown.length) throw new Error('Unknown sub-package: ' + unknown.join(', ') + '. Choose from: ' + SUBPACKAGES.join(', ') + '.');
  return { packages, force, dryRun, help };
}
export function ensureSubpackages(options) {
  if (options.help) {
    console.log('Usage: node scripts/ensure-subpackages.mjs [--package=<name>] [--force] [--dry-run]');
    console.log('Packages: ' + SUBPACKAGES.join(', '));
    return;
  }
  console.log('[ensure-subpackages] selected: ' + options.packages.join(', '));
  for (const pkg of options.packages) {
  const dir = join(ROOT, pkg);
  if (!existsSync(join(dir, 'package.json'))) throw new Error(pkg + ': package.json is missing from this checkout.');
  if (!existsSync(join(dir, 'package-lock.json'))) throw new Error(pkg + ': package-lock.json is required');
  if (existsSync(join(dir, 'node_modules')) && !options.force) continue;
  if (options.dryRun) { console.log('[ensure-subpackages] ' + pkg + ': would run `npm ci`.'); continue; }
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(pkg + ': npm ci failed');
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { ensureSubpackages(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error('[ensure-subpackages] ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
}
