#!/usr/bin/env tsx
/**
 * Collect a redacted support bundle (SEC-013).
 *
 *   npm run support:bundle -- [--out reports/support-bundle.txt] [extra files…]
 *
 * Redacts every collected file, re-scans the redacted result, and REFUSES to
 * write anything if a credential survived. Use this instead of tarring runtime
 * directories by hand: ad-hoc archives can accidentally expose local
 * credentials and authentication headers.
 */
import * as path from 'path';

import './load-env-local';
import { DEFAULT_SUPPORT_FILES, collectSupportBundle, writeSupportBundle } from './lib/support-bundle';

function parseArgs(argv: readonly string[]): { outputPath: string; files: string[] } {
  const files: string[] = [];
  let outputPath = path.join('reports', 'support-bundle.txt');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--out' || arg === '-o') {
      const next = argv[i + 1];
      if (!next) throw new Error('--out requires a path');
      outputPath = next;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      outputPath = arg.slice('--out='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { outputPath, files };
}

function main(): void {
  const { outputPath, files } = parseArgs(process.argv.slice(2));
  const targets = files.length > 0 ? files : [...DEFAULT_SUPPORT_FILES];

  const result = collectSupportBundle(targets);
  if (result.entries.length === 0) {
    process.stdout.write(
      `No readable diagnostic files among: ${targets.join(', ')}\n` +
        result.skipped.map((s) => `  - ${s.label}: ${s.reason}`).join('\n') +
        '\n'
    );
    process.exitCode = 1;
    return;
  }

  try {
    const { bytes } = writeSupportBundle(result, outputPath, new Date().toISOString());
    process.stdout.write(
      `Wrote redacted support bundle: ${outputPath} (${bytes} bytes, ${result.entries.length} file(s))\n`
    );
    for (const skipped of result.skipped) {
      process.stdout.write(`  skipped ${skipped.label}: ${skipped.reason}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

main();
