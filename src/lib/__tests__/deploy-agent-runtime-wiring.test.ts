/**
 * @jest-environment node
 *
 * The in-process mission worker dynamically imports agent/dist/orchestrator-lite.js
 * (see agent-import.ts). If the supported
 * deployment artifacts don't build/include that runtime, every mission fails at
 * load. These regressions assert the public Docker and Compose configs wire the runtime so a
 * future edit can't silently drop it again. (An actual image build
 * deploy is a CI/deploy step, not a unit test — this guards the wiring, not the
 * built image.)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'yaml';

const root = process.cwd();
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8');

describe('deployment wires the mission runtime', () => {
  describe('Docker (Compose app worker)', () => {
    const dockerfile = read('Dockerfile');
    const dockerignore = read('.dockerignore');

    it('builds the agent runtime in the image', () => {
      expect(dockerfile).toMatch(/npm run setup:agents/);
    });

    it('copies the runtime the worker resolves into the runner (dist + node_modules + profiles)', () => {
      expect(dockerfile).toMatch(/agent\/dist \.\/agent\/dist/);
      expect(dockerfile).toMatch(/agent\/node_modules \.\/agent\/node_modules/);
      expect(dockerfile).toMatch(/agent\/agents \.\/agent\/agents/);
    });

    it('.dockerignore ships agent source (excludes only rebuilt artifacts) and keeps agent profiles', () => {
      const lines = dockerignore.split('\n').map((l) => l.trim());
      // The whole `agent` tree must NOT be excluded as a bare line.
      expect(lines).not.toContain('agent');
      expect(lines).toContain('agent/node_modules');
      expect(lines).toContain('agent/dist');
      // Agent profiles (.md/.yaml) are re-included past the broad *.md rule.
      expect(dockerignore).toMatch(/!agent\/agents\/\*\*/);
      expect(dockerignore).toMatch(/!agent\/runtime-plugin\/\*\*/);
    });
  });

  describe('Compose env contract', () => {
    const compose = yaml.parse(read('docker-compose.yml')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };

    it('app service (in-process worker) requires IMPULSE_MCP_BASE_URL and IMPULSE_INTERNAL_KEY', () => {
      const appEnv = compose.services.app.environment ?? {};
      expect(appEnv.IMPULSE_MCP_BASE_URL).toBe('http://localhost:9002/api/mcp');
      // Fail-loud required key (no default), env-only.
      expect(appEnv.IMPULSE_INTERNAL_KEY).toMatch(/\$\{IMPULSE_INTERNAL_KEY:\?/);
    });

    it('agent service never authenticates with a bare-blank key', () => {
      const agentEnv = compose.services.agent.environment ?? {};
      // The old `${IMPULSE_API_KEY:-}` blank default is gone; it falls back to
      // the required internal key.
      expect(agentEnv.IMPULSE_API_KEY).not.toBe('${IMPULSE_API_KEY:-}');
      expect(agentEnv.IMPULSE_API_KEY).toMatch(/IMPULSE_INTERNAL_KEY:\?/);
    });
  });
});
