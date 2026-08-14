/**
 * @file SKILL-004 — proves the visual gate is BAKED, REPOSITORY-OWNED, and
 * HOST-PLUGIN-FREE, and that the host wrapper (runVisualGate) invokes it
 * correctly with a fail-safe skip.
 *
 * These are static + real-shell checks (no Docker required) so they run in the
 * normal jest gate forever. The one-time "the file is physically inside the
 * built image" proof is the owner Docker capstone (docker run cat …), whose
 * result is recorded on the SKILL-004 backlog row at closure; here we lock the
 * WIRING that guarantees it: the Dockerfile COPY target, the on-disk source,
 * and the path the runner invokes all agree.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSanitizedShellCommand } from '../src/sandbox/session.js';
import {
  runVisualGate,
  buildVisualGateCommand,
  BAKED_NODE_PATH,
  BAKED_VISUAL_GATE_PATH,
} from '../src/sandbox/visual-gate.js';
import type { SandboxDriver, SandboxRef } from '../src/sandbox/types.js';

const url = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const VALIDATOR_SRC = url('../src/sandbox/template/scripts/visual-gate.mjs');
const DOCKERFILE = url('../src/sandbox/template/Dockerfile');
const ENTRYPOINT = url('../src/sandbox/template/entrypoint.sh');
const validatorSource = () => readFileSync(VALIDATOR_SRC, 'utf8');

describe('SKILL-004 — validator is baked into the sandbox image', () => {
  it('the Dockerfile COPYs the scripts dir to the baked path the runner invokes', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    expect(dockerfile).toMatch(/COPY\s+scripts\s+\/opt\/impulse\/template\/scripts\b/);
    // Triangulation: baked dir (from Dockerfile) + filename === runner path.
    expect(`/opt/impulse/template/scripts/${'visual-gate.mjs'}`).toBe(BAKED_VISUAL_GATE_PATH);
  });

  it('the on-disk validator exists at the source path that gets COPYed', () => {
    // readFileSync throws if it is missing — an existence proof with a message.
    expect(validatorSource().length).toBeGreaterThan(0);
  });

  it('entrypoint.sh does NOT seed scripts/ into the workspace (baked-only → survives resume)', () => {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8');
    expect(entrypoint).not.toMatch(/template\/scripts/);
    // It DOES seed the other template dirs on first start.
    expect(entrypoint).toMatch(/template\/skills/);
  });
});

describe('SKILL-004 — repository-owned, no host-plugin dependency', () => {
  it('imports ONLY Node.js built-ins (no npm / relative / host-plugin modules)', () => {
    const src = validatorSource();
    const specifiers = [
      ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0); // guards against a silently-empty scan
    for (const spec of specifiers) {
      expect(spec.startsWith('node:')).toBe(true);
    }
  });

  it('carries an explicit provenance block (origin, MIT, no frontend-design plugin, WCAG)', () => {
    const src = validatorSource();
    expect(src).toContain('PROVENANCE');
    expect(src).toContain('MIT');
    expect(src).toContain('frontend-design'); // the explicit "does NOT use" disclaimer
    expect(src).toContain('WCAG');
  });
});

describe('SKILL-004 — runVisualGate host wrapper contract', () => {
  let recordedArgv: string[] | undefined;
  let recordedOpts: { timeoutMs?: number } | undefined;

  function fakeDriver(result: { code: number; stdout: string; stderr: string }): SandboxDriver {
    recordedArgv = undefined;
    recordedOpts = undefined;
    return {
      exec: async (_ref: SandboxRef, argv: string[], opts?: { timeoutMs?: number }) => {
        recordedArgv = argv;
        recordedOpts = opts;
        return result;
      },
    } as unknown as SandboxDriver;
  }
  const ref = {} as unknown as SandboxRef;

  it('invokes the baked validator under sh with the workspace forced as cwd, 60s timeout', async () => {
    const driver = fakeDriver({ code: 0, stdout: 'VISUAL GATE PASS\n', stderr: '' });
    await runVisualGate(driver, ref);
    expect(recordedArgv).toEqual(['sh', '-c', buildSanitizedShellCommand(buildVisualGateCommand())]);
    expect(recordedArgv?.[2]).toContain(BAKED_VISUAL_GATE_PATH);
    expect(recordedArgv?.[2]).toContain(BAKED_NODE_PATH);
    expect(recordedArgv?.[2]).toContain('cd . || exit 1');
    expect(recordedOpts?.timeoutMs).toBe(60_000);
  });

  it('maps exit code 0 → ok:true and nonzero → ok:false', async () => {
    expect((await runVisualGate(fakeDriver({ code: 0, stdout: 'ok', stderr: '' }), ref)).ok).toBe(true);
    expect((await runVisualGate(fakeDriver({ code: 1, stdout: '', stderr: 'bad' }), ref)).ok).toBe(false);
  });

  it('returns the concatenated stdout+stderr, tail-clamped to 1500 chars', async () => {
    const short = await runVisualGate(fakeDriver({ code: 1, stdout: 'out', stderr: 'err' }), ref);
    expect(short.output).toBe('outerr');
    const big = await runVisualGate(fakeDriver({ code: 1, stdout: 'X' + 'A'.repeat(2000), stderr: '' }), ref);
    expect(big.output).toHaveLength(1500);
    expect(big.output).toBe('A'.repeat(1500)); // the leading 'X' is dropped → it's the TAIL
  });

  it('builds the canonical absolute-runtime command', () => {
    expect(buildVisualGateCommand()).toBe(
      'cd . || exit 1; S=/opt/impulse/template/scripts/visual-gate.mjs; if [ -f "$S" ]; then /usr/local/bin/node "$S"; else echo "VISUAL GATE FAIL: validator not baked in this image" >&2; exit 1; fi'
    );
  });
});

describe('SKILL-004 — missing vs present branch (real shell)', () => {
  function runShell(
    scriptPath: string,
    workspace: string,
    env: NodeJS.ProcessEnv = process.env
  ): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('sh', ['-c', buildVisualGateCommand(scriptPath, process.execPath)], {
      cwd: workspace,
      env: { ...env, WORKSPACE_PATH: workspace },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('PRESENT branch: runs the baked validator when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-present-'));
    try {
      const pass = join(dir, 'gate.mjs');
      writeFileSync(pass, 'console.log("RAN GATE"); process.exit(0);');
      expect(runShell(pass, dir)).toMatchObject({ status: 0 });
      expect(runShell(pass, dir).stdout).toContain('RAN GATE');

      const fail = join(dir, 'gate-fail.mjs');
      writeFileSync(fail, 'process.exit(1);');
      expect(runShell(fail, dir).status).toBe(1); // present + nonzero propagates
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABSENT branch: fails closed when the validator is not baked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-absent-'));
    try {
      const r = runShell(join(dir, 'does-not-exist.mjs'), dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('VISUAL GATE FAIL: validator not baked in this image');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the absolute runtime even when HOME and PATH contain a poisoned node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-poisoned-runtime-'));
    try {
      const bin = join(dir, 'bin');
      const home = join(dir, 'home');
      mkdirSync(bin, { recursive: true });
      mkdirSync(home, { recursive: true });
      const poisonMarker = join(dir, 'poison-ran');
      const poisonNode = join(bin, 'node');
      writeFileSync(poisonNode, `#!/bin/sh\ntouch "${poisonMarker}"\nexit 99\n`);
      chmodSync(poisonNode, 0o755);
      writeFileSync(join(home, '.profile'), `PATH="${bin}:$PATH"\nexport PATH\n`);
      const gate = join(dir, 'gate.mjs');
      writeFileSync(gate, 'console.log("TRUSTED NODE");');

      const result = runShell(gate, dir, { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` });
      expect(result).toMatchObject({ status: 0 });
      expect(result.stdout).toContain('TRUSTED NODE');
      expect(() => readFileSync(poisonMarker)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
