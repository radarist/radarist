/**
 * Pins the CLI behaviour the SEC-013 fix depends on.
 *
 * The orchestrator hands the SDK `'x-api-key': '${IMPULSE_INTERNAL_KEY}'` instead
 * of the key, so the plaintext never reaches `--mcp-config` on the child's
 * command line or the transport traces the CLI persists. That is only safe
 * because Claude Code expands `${VAR}` in MCP HTTP headers from the child's own
 * environment.
 *
 * That is an assumption about a pinned third-party binary, so it is tested
 * rather than asserted — in the same spirit as the stream-json response-boundary
 * test. If a future CLI stops expanding, this fails and names the fix
 * ("mission MCP auth would 401") instead of leaving the runtime to discover it.
 *
 * Zero provider spend: MCP servers connect during CLI startup, before the first
 * assistant turn, so the child is killed the moment the loopback server records
 * the request. Skipped when the platform CLI binary is absent (CI images without
 * the optional native package, non-darwin-arm64 hosts).
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import type { Server } from 'http';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Jest runs with the Agent package as cwd. This suite's CommonJS module setting
// rejects `import.meta` with TS1343, so build this path from process.cwd().
const CLI = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude');

/** Synthetic; never a real credential. */
const PROBE_VALUE = 'synthetic-probe-value-77f3a91c';
const PROBE_VAR = 'IMPULSE_SEC013_PROBE';

const describeWithCli = existsSync(CLI) ? describe : describe.skip;

// The per-test timeout is passed to `it(...)` rather than set via
// `jest.setTimeout`: this suite runs under the ESM preset, which does not inject
// the `jest` global, and a bare reference fails the whole file to load.
const PROBE_TIMEOUT_MS = 120_000;

describeWithCli('SEC-013 — the CLI expands ${VAR} in MCP HTTP headers', () => {
  it('sends the RESOLVED value while the config on disk holds only the reference', async () => {
    const received: Array<{ method: string | null; apiKey: string | null }> = [];
    let child: ReturnType<typeof spawn> | null = null;

    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed: { id?: unknown; method?: string } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* health probes may send no body */
        }
        received.push({
          method: parsed.method ?? null,
          apiKey: (req.headers['x-api-key'] as string | undefined) ?? null,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id ?? 1,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'sec013-probe', version: '0.0.1' },
              tools: [],
            },
          })
        );
        // The header has been observed — end the run before any model turn.
        if (child && !child.killed) setTimeout(() => child?.kill('SIGKILL'), 50);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'sec013-probe-'));
    const configPath = join(dir, 'probe-mcp.json');
    const config = JSON.stringify({
      mcpServers: {
        sec013probe: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'x-api-key': `\${${PROBE_VAR}}` },
          alwaysLoad: true,
        },
      },
    });
    writeFileSync(configPath, config);

    // The config the CLI is given must NOT contain the value — that is the
    // property the whole mitigation rests on.
    expect(config).not.toContain(PROBE_VALUE);

    try {
      child = spawn(CLI, ['-p', 'noop', '--mcp-config', configPath, '--strict-mcp-config', '--model', 'haiku'], {
        cwd: dir,
        env: { ...process.env, [PROBE_VAR]: PROBE_VALUE },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const guard = setTimeout(() => child?.kill('SIGKILL'), 90_000);
      await new Promise<void>((resolve) => child!.on('close', () => resolve()));
      clearTimeout(guard);
    } finally {
      server.close();
    }

    expect(received.length).toBeGreaterThan(0);
    for (const request of received) {
      // Expanded, not the literal reference: the transport authenticates.
      expect(request.apiKey).toBe(PROBE_VALUE);
    }
  }, PROBE_TIMEOUT_MS);
});
