#!/usr/bin/env node
/**
 * @file scripts/postbuild-agent-runtime.mjs
 * @description OPS-004 — build the mission runtime after `npm run build` when a
 * deployment target needs the in-process worker.
 *
 * The worker (Inngest, in the app process) dynamically imports
 * agent/dist/orchestrator-lite.js and resolves the Claude Agent SDK from
 * agent/node_modules. Deployment targets that invoke `npm run build` without
 * the Dockerfile need this hook or the backend cannot load the orchestrator.
 *
 * Gated on BUILD_AGENT_RUNTIME=1 so ordinary local/CI `npm run build` stays fast
 * — deployment configuration opts in through this variable. The Dockerfile
 * path builds the runtime explicitly and does not rely on this hook.
 */

import { spawnSync } from 'node:child_process';

if (process.env.BUILD_AGENT_RUNTIME !== '1') {
  console.log('[postbuild] BUILD_AGENT_RUNTIME!=1 — skipping mission-runtime build (set it for deployment builds).');
  process.exit(0);
}

console.log('[postbuild] BUILD_AGENT_RUNTIME=1 — building the mission runtime (npm run setup:agents).');
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'setup:agents'], {
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error(
    '[postbuild] mission-runtime build failed — the deployed worker would not be able to load the orchestrator.'
  );
  process.exit(result.status ?? 1);
}
console.log('[postbuild] mission runtime built (agent/dist + agent/node_modules).');
