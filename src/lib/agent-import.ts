/**
 * @file lib/agent-import.ts
 * @description Shared utility for dynamically importing the agent orchestrator (Task 0.4)
 *
 * Centralizes the dynamic import pattern so it's not duplicated across consumers
 * (run-agent-mission.ts, future chat route, etc.).
 *
 * Uses file URL to bypass Turbopack static analysis. The @impulse/agent package
 * is an ESM package with its own node_modules; using an absolute file URL lets
 * Node.js resolve both relative imports and the Claude Agent SDK from
 * agent/node_modules/.
 *
 * If Turbopack ever supports the @impulse/agent/orchestrator import directly,
 * this file can be simplified to: return import('@impulse/agent/orchestrator');
 */

import { pathToFileURL } from 'url';
import { existsSync, statSync } from 'fs';
import path from 'path';

const AGENT_SETUP_COMMAND = 'npm run setup:agents';

export class AgentRuntimeUnavailableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(
      `Optional agent mission runtime is unavailable: ${reason}. ` +
        `Run \`${AGENT_SETUP_COMMAND}\` from the repository root to install and build it.`,
      options
    );
    this.name = 'AgentRuntimeUnavailableError';
  }
}

/** Validate the opt-in runtime before attempting an opaque file-URL import. */
export function assertAgentRuntimeAvailable(relDistFile: string, root = process.cwd()): string {
  const agentDir = path.resolve(root, 'agent');
  const distPath = path.resolve(agentDir, 'dist', relDistFile);
  const missing: string[] = [];

  if (!existsSync(path.resolve(agentDir, 'node_modules'))) missing.push('dependencies are not installed');
  if (!existsSync(distPath)) missing.push(`compiled artifact ${relDistFile} is missing`);
  if (missing.length > 0) throw new AgentRuntimeUnavailableError(missing.join(' and '));

  return distPath;
}

/**
 * Dynamically import the agent orchestrator module.
 * Returns the same exports as `@impulse/agent/orchestrator`.
 *
 * Bug E: in development, append the dist file's mtime as a query string so
 * `npm run build` in agent/ produces a fresh URL → ESM module-cache miss →
 * rebuilt code reaches the running Next.js dev server WITHOUT needing a
 * full restart. In production NODE_ENV the cache-bust is skipped (one
 * import per process is the right behaviour for a long-lived server).
 */
export async function importOrchestrator() {
  return importAgentDist('orchestrator-lite.js');
}

/**
 * Dynamically import the build-mission sandbox layer.
 * Returns the same exports as `@impulse/agent/sandbox` (driver registry,
 * provisioner, session runner, stream-json parser, STATUS/checks contracts).
 */
export async function importSandbox() {
  return importAgentDist(path.join('sandbox', 'index.js'));
}

async function importAgentDist(relDistFile: string) {
  const distPath = assertAgentRuntimeAvailable(relDistFile);
  const baseUrl = pathToFileURL(distPath).href;
  const cacheBust =
    process.env.NODE_ENV !== 'production'
      ? `?mtime=${(() => {
          try {
            return statSync(distPath).mtimeMs;
          } catch {
            return Date.now();
          }
        })()}`
      : '';
  try {
    return await import(/* webpackIgnore: true */ baseUrl + cacheBust);
  } catch (error) {
    throw new AgentRuntimeUnavailableError(`failed to load ${relDistFile}`, { cause: error });
  }
}
