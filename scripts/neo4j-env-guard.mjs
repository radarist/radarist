#!/usr/bin/env node
/**
 * Preflight guard for the neo4j:* npm scripts that pass `--env-file .env.local`
 * to docker compose.
 *
 * docker compose's CLI `--env-file` flag hard-fails (exit 1, "couldn't find
 * env file") when the file is missing — which happens on any fresh clone that
 * hasn't run `npm run setup:local` yet. This guard turns that cryptic compose
 * error into an actionable message before compose ever runs.
 *
 * Dependency-free by design (node:fs only) — no ts-node/tsx transpile cost on
 * a script that runs before every neo4j:* command.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(repoRoot, '.env.local');

if (!existsSync(envFile)) {
  console.error('Missing .env.local — run `npm run setup:local` first (it generates NEO4J_PASSWORD).');
  process.exit(1);
}
