#!/usr/bin/env npx tsx

import { buildDemoEnv, parseProfileArg, readEnvFile, runCommand } from './lib/local-demo';

async function main(): Promise<void> {
  const profile = parseProfileArg(process.argv.slice(2));
  const env = buildDemoEnv(profile, readEnvFile(profile.envFile));

  console.log(`[seed:showcase] Seeding showcase data for profile "${profile.name}"`);
  await runCommand('npx', ['tsx', 'scripts/seed-demo.ts'], env);
}

main().catch((error) => {
  console.error('[seed:showcase] Failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
