/**
 * SEC-016 — pins the CLI behaviour the stdio-MCP credential containment rests on.
 *
 * SEC-013 removed the internal HTTP MCP key from `--mcp-config` by emitting
 * `${VAR}` instead of the value. The stdio servers kept the old shape: their
 * `env:` block was expanded at config load, so an external provider credential
 * was serialized into the same argv and into every transport trace the CLI
 * persists. SEC-016 emits the reference there too.
 *
 * That mitigation is only safe if the pinned CLI expands `${VAR}` inside an MCP
 * server's `env` map from the child's own environment — a property of a
 * third-party binary, so it is PROVEN here rather than assumed, exactly as
 * SEC-013 proved the header case.
 *
 * Zero provider spend: stdio MCP servers are spawned during CLI startup, before
 * the first assistant turn. The probe server records what it received and the
 * test kills the CLI the moment that observation lands. Skipped when the
 * platform CLI binary is absent (CI images without the optional native package,
 * non-darwin-arm64 hosts).
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Jest runs with the Agent package as cwd. This suite's CommonJS module setting
// rejects `import.meta` with TS1343, so build this path from process.cwd().
const CLI = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude');

/** Synthetic; never a real credential. */
const PROBE_VALUE = 'synthetic-stdio-probe-4d18b2ce';
const PROBE_VAR = 'IMPULSE_SEC016_PROBE';
/** The server-side env KEY differs from the host VAR, as `github` does in the example config. */
const PROBE_ENV_KEY = 'PROBE_PROVIDER_API_KEY';

const describeWithCli = existsSync(CLI) ? describe : describe.skip;

const PROBE_TIMEOUT_MS = 120_000;

/**
 * A stdio "MCP server" that only records the credential-shaped env value it was
 * spawned with. It deliberately never completes the MCP handshake — the fact of
 * the spawn is the whole observation, and an unanswered handshake keeps the CLI
 * from reaching a model turn.
 */
const PROBE_SERVER_SOURCE = `
const { writeFileSync } = require('fs');
writeFileSync(process.argv[2], JSON.stringify({
  received: process.env[${JSON.stringify(PROBE_ENV_KEY)}] ?? null,
}));
process.stdin.resume();
`;

async function waitForFile(path: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describeWithCli('SEC-016 — the CLI expands ${VAR} in a stdio MCP server env map', () => {
  it(
    'spawns the server with the RESOLVED value while argv carries only the reference',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sec016-probe-'));
      const serverPath = join(dir, 'probe-server.cjs');
      const observationPath = join(dir, 'observation.json');
      writeFileSync(serverPath, PROBE_SERVER_SOURCE);

      // EXACTLY the shape the orchestrator now emits: a reference, not a value.
      const mcpConfig = JSON.stringify({
        mcpServers: {
          sec016probe: {
            type: 'stdio',
            command: process.execPath,
            args: [serverPath, observationPath],
            env: { [PROBE_ENV_KEY]: `\${${PROBE_VAR}}` },
          },
        },
      });

      // The property the whole mitigation rests on: the argv string is secret-free.
      expect(mcpConfig).not.toContain(PROBE_VALUE);

      const argv = ['-p', 'noop', '--mcp-config', mcpConfig, '--strict-mcp-config', '--model', 'haiku'];
      expect(argv.join(' ')).not.toContain(PROBE_VALUE);

      const child = spawn(CLI, argv, {
        cwd: dir,
        env: { ...process.env, [PROBE_VAR]: PROBE_VALUE },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
      const observed = await waitForFile(observationPath, 90_000);
      child.kill('SIGKILL');
      await closed;

      expect(observed).toBe(true);
      const observation = JSON.parse(readFileSync(observationPath, 'utf-8')) as { received: string | null };
      // Expanded, not the literal reference: the stdio server authenticates.
      expect(observation.received).toBe(PROBE_VALUE);
    },
    PROBE_TIMEOUT_MS
  );

  it(
    'leaves an unresolvable reference unexpanded rather than inventing a value',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sec016-probe-missing-'));
      const serverPath = join(dir, 'probe-server.cjs');
      const observationPath = join(dir, 'observation.json');
      writeFileSync(serverPath, PROBE_SERVER_SOURCE);

      const mcpConfig = JSON.stringify({
        mcpServers: {
          sec016probe: {
            type: 'stdio',
            command: process.execPath,
            args: [serverPath, observationPath],
            env: { [PROBE_ENV_KEY]: '${IMPULSE_SEC016_ABSENT_VAR}' },
          },
        },
      });

      const child = spawn(CLI, ['-p', 'noop', '--mcp-config', mcpConfig, '--strict-mcp-config', '--model', 'haiku'], {
        cwd: dir,
        // The referenced variable is deliberately absent from the child env.
        env: { ...process.env, IMPULSE_SEC016_ABSENT_VAR: undefined } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
      const observed = await waitForFile(observationPath, 90_000);
      child.kill('SIGKILL');
      await closed;

      // Whether the CLI drops the server or spawns it with an unexpanded/blank
      // value, the ONE thing that must hold is that no other value is invented.
      if (observed) {
        const observation = JSON.parse(readFileSync(observationPath, 'utf-8')) as { received: string | null };
        expect(
          observation.received === null || observation.received === '' || observation.received?.includes('${')
        ).toBe(true);
        expect(observation.received).not.toBe(PROBE_VALUE);
      }
    },
    PROBE_TIMEOUT_MS
  );
});
