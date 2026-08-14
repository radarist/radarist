/**
 * Support-export fail-closed contract (SEC-013).
 *
 * The acceptance requires that a support export REFUSES unredacted traces. This
 * suite proves both halves: an ordinary secret-bearing log is redacted and
 * exported, and a credential the redactor cannot mask stops the write entirely
 * — with nothing left on disk and no value echoed into the error.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  auditSupportBundle,
  collectSupportBundle,
  renderSupportBundle,
  writeSupportBundle,
} from '../lib/support-bundle';

const INTERNAL_KEY = 'synthetic-internal-key-1234567890';
const ENV = { IMPULSE_INTERNAL_KEY: INTERNAL_KEY };
const GENERATED_AT = '2026-07-29T00:00:00.000Z';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-bundle-'));
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeLog(name: string, content: string): string {
  const filePath = path.join(root, 'logs', name);
  fs.writeFileSync(filePath, content);
  return path.relative(root, filePath);
}

describe('collectSupportBundle', () => {
  it('redacts a secret-bearing trace while keeping the surrounding context', () => {
    const rel = writeLog(
      'agent.log',
      [
        '2026-07-29T00:00:00.000Z INFO  [orchestrator] MCP servers: impulse-reports=http://localhost:9002/api/mcp/reports',
        `2026-07-29T00:00:01.000Z ERROR [mcp] auth failed sending x-api-key ${INTERNAL_KEY}`,
        '2026-07-29T00:00:02.000Z INFO  [cost] TOTAL turns=3 cost=$0.0342',
      ].join('\n')
    );

    const result = collectSupportBundle([rel], { rootDir: root, env: ENV });
    expect(result.entries).toHaveLength(1);
    const content = result.entries[0]!.content;
    expect(content).not.toContain(INTERNAL_KEY);
    expect(content).toContain('api/mcp/reports');
    expect(content).toContain('cost=$0.0342');
    expect(auditSupportBundle(result, { env: ENV })).toEqual([]);
  });

  it('SEC-016: neither MCP transport shape can export an external provider credential', () => {
    const providerEnv = { EXA_API_KEY: 'synthetic-provider-key-9f21ab77' };
    const transport = (envValue: string) =>
      JSON.stringify({
        type: 'transport',
        mcpServers: {
          exa: { type: 'stdio', command: 'npx', args: ['-y', 'exa-mcp-server'], env: { EXA_API_KEY: envValue } },
          firecrawl: { type: 'stdio', command: 'npx', args: [], env: { FIRECRAWL_API_KEY: envValue } },
        },
      });

    // The shape SEC-016 now emits: only the reference ever reaches the trace.
    const referenceBundle = collectSupportBundle([writeLog('session-reference.jsonl', transport('${EXA_API_KEY}'))], {
      rootDir: root,
      env: providerEnv,
    });
    expect(referenceBundle.entries[0]!.content).not.toContain(providerEnv.EXA_API_KEY);
    expect(auditSupportBundle(referenceBundle, { env: providerEnv })).toEqual([]);

    // The pre-SEC-016 shape, in case an OLD trace is still on disk: the export
    // gate must mask it rather than ship it.
    const leakedBundle = collectSupportBundle([writeLog('session-leaked.jsonl', transport(providerEnv.EXA_API_KEY))], {
      rootDir: root,
      env: providerEnv,
    });
    expect(leakedBundle.entries[0]!.content).not.toContain(providerEnv.EXA_API_KEY);
    expect(auditSupportBundle(leakedBundle, { env: providerEnv })).toEqual([]);

    // …and still masked on a machine where the variable is not exported at all,
    // so `collectLiveSecrets` finds nothing and only the key-name net applies.
    const foreignHostBundle = collectSupportBundle(
      [writeLog('session-foreign.jsonl', transport(providerEnv.EXA_API_KEY))],
      { rootDir: root, env: {} }
    );
    expect(foreignHostBundle.entries[0]!.content).not.toContain(providerEnv.EXA_API_KEY);
  });

  it('records unreadable targets instead of failing the whole bundle', () => {
    const rel = writeLog('agent.log', 'clean line');
    const result = collectSupportBundle([rel, 'logs/does-not-exist.log'], { rootDir: root, env: ENV });
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.label).toBe('logs/does-not-exist.log');
  });

  it('refuses to follow a symlink out of the collected set', () => {
    fs.writeFileSync(path.join(root, 'outside.txt'), 'sensitive');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'logs', 'link.log'));
    const result = collectSupportBundle(['logs/link.log'], { rootDir: root, env: ENV });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain('symlink');
  });

  it('collects only the tail of an oversized file', () => {
    const rel = writeLog('big.log', `${'a'.repeat(3 * 1024 * 1024)}TAIL-MARKER`);
    const result = collectSupportBundle([rel], { rootDir: root, env: ENV });
    expect(result.entries[0]!.truncated).toBe(true);
    expect(result.entries[0]!.content).toContain('TAIL-MARKER');
  });
});

describe('writeSupportBundle', () => {
  it('writes a redacted bundle with owner-only permissions', () => {
    const rel = writeLog('agent.log', `x-api-key: ${INTERNAL_KEY}`);
    const result = collectSupportBundle([rel], { rootDir: root, env: ENV });
    const out = path.join(root, 'reports', 'support-bundle.txt');

    const written = writeSupportBundle(result, out, GENERATED_AT, { env: ENV });
    expect(written.bytes).toBeGreaterThan(0);

    const document = fs.readFileSync(out, 'utf-8');
    expect(document).not.toContain(INTERNAL_KEY);
    expect(document).toContain('logs/agent.log');
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it('REFUSES to write when a credential survives redaction, and leaves no file behind', () => {
    // Force the failure honestly: collect the file WITHOUT the env that makes
    // the value recognisable, then audit WITH it. That is exactly the real risk
    // — a credential whose shape the redactor does not know.
    const rel = writeLog('agent.log', `opaque-value ${INTERNAL_KEY}`);
    const unredacted = collectSupportBundle([rel], { rootDir: root, env: {} });
    expect(unredacted.entries[0]!.content).toContain(INTERNAL_KEY);

    const out = path.join(root, 'reports', 'support-bundle.txt');
    let thrown: Error | undefined;
    try {
      writeSupportBundle(unredacted, out, GENERATED_AT, { env: ENV });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('Refusing to write the support bundle');
    expect(thrown!.message).toContain('logs/agent.log');
    expect(thrown!.message).toContain('live-env-value');
    // The refusal must never reproduce the value it refused to export.
    expect(thrown!.message).not.toContain(INTERNAL_KEY);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('names every offending file in the refusal', () => {
    const a = writeLog('a.log', `key ${INTERNAL_KEY}`);
    const b = writeLog('b.log', `key ${INTERNAL_KEY}`);
    const unredacted = collectSupportBundle([a, b], { rootDir: root, env: {} });
    expect(() => writeSupportBundle(unredacted, path.join(root, 'out.txt'), GENERATED_AT, { env: ENV })).toThrow(
      /logs\/a\.log.*logs\/b\.log/s
    );
  });
});

describe('renderSupportBundle', () => {
  it('labels each file and lists what was skipped', () => {
    const rel = writeLog('agent.log', 'line one');
    const result = collectSupportBundle([rel, 'logs/missing.log'], { rootDir: root, env: ENV });
    const document = renderSupportBundle(result, GENERATED_AT);
    expect(document).toContain('# Radarist support bundle');
    expect(document).toContain(`# generated: ${GENERATED_AT}`);
    expect(document).toContain('===== logs/agent.log');
    expect(document).toContain('===== skipped =====');
    expect(document).toContain('logs/missing.log');
  });
});
