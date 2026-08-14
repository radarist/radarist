#!/usr/bin/env npx tsx

import {
  buildDemoEnv,
  getFlagValue,
  hasFlag,
  parseProfileArg,
  readEnvFile,
  validateDemoEnv,
  writeDemoEnvFile,
} from './lib/local-demo';

function printUsage(): void {
  console.log(`Usage: npm run setup:local -- [--profile selftest] [--gemini-key KEY] [--anthropic-key KEY]

Creates or refreshes the local demo env file.

Profiles:
  default   .env.local          app :9002, Firebase :8080/:9099/:9199, Neo4j :7474/:7687
  selftest  .env.selftest.local app :9012, alternate local service ports`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage();
    return;
  }

  const profile = parseProfileArg(args);
  const existing = readEnvFile(profile.envFile);
  const env = buildDemoEnv(profile, existing);
  const geminiKey = getFlagValue(args, '--gemini-key');
  const anthropicKey = getFlagValue(args, '--anthropic-key');

  if (geminiKey) {
    env.GOOGLE_GENAI_API_KEY = geminiKey;
    env.GOOGLE_API_KEY = geminiKey;
    env.GEMINI_API_KEY = geminiKey;
  }
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
  }

  writeDemoEnvFile(profile.envFile, env);

  const checks = validateDemoEnv(env);
  const failures = checks.filter((check) => check.level === 'fail');
  const warnings = checks.filter((check) => check.level === 'warn');

  console.log(`[setup:local] Wrote ${profile.envFile} for profile "${profile.name}".`);
  console.log(`[setup:local] App URL: http://127.0.0.1:${profile.appPort}`);
  console.log(`[setup:local] Demo login: ${env.E2E_USER_EMAIL} / ${env.E2E_USER_PASSWORD}`);

  if (warnings.length > 0) {
    console.log('');
    console.log('[setup:local] Optional keys still need real values for live AI behavior:');
    for (const warning of warnings) {
      console.log(`  - ${warning.label}: ${warning.detail}`);
    }
  }

  if (failures.length > 0) {
    console.log('');
    console.error('[setup:local] Required local demo values are missing:');
    for (const failure of failures) {
      console.error(`  - ${failure.label}: ${failure.detail}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[setup:local] Failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
