#!/usr/bin/env npx tsx

import { auditE2ERuntimeManifest } from '../lib/e2e-runtime-manifest';

try {
  const receipt = auditE2ERuntimeManifest();
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  );
  process.exitCode = 1;
}
