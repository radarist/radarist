/**
 * @file Tests for the visual gate (Task 6 / SKILL-004).
 *
 * Two layers:
 *   1. PURE MATH — imports the .mjs named exports directly. main() is guarded
 *      by a `process.argv[1].endsWith('visual-gate.mjs')` check, so importing
 *      this module never executes the gate (no fs/exec side effects).
 *   2. PROCESS-LEVEL — spawns the real validator (`node visual-gate.mjs`) with
 *      a temp workspace as cwd and asserts on its EXIT CODE + stdout/stderr.
 *      This is the pass/fail contract the done-gate actually relies on
 *      (runVisualGate maps `code === 0` → ok), exercised end-to-end including
 *      the real `grep` hardcoded-hex scan — not just the contrast arithmetic.
 *
 * Baking/provenance/no-host-plugin invariants + the runVisualGate host wrapper
 * live in sandbox-visual-gate-wiring.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, wcagAA } from '../src/sandbox/template/scripts/visual-gate.mjs';

const VALIDATOR = fileURLToPath(new URL('../src/sandbox/template/scripts/visual-gate.mjs', import.meta.url));

/** A palette that clears WCAG-AA (ink on dark bg) — the BRAND_DARK default. */
const GOOD_PALETTE = { bg: '#0a0c10', surface: '#161b22', ink: '#e8eaf0', accent: '#d4a84b' };
/** ink on near-identical bg — well below the 4.5:1 AA threshold. */
const BAD_PALETTE = { bg: '#0d0d0d', ink: '#111111' };

/**
 * Materialize a temp workspace from a { relativePath: contents } map, run the
 * real validator with that dir as cwd, and return its process result. The
 * validator reads `.impulse/design-brief.json` and greps `src/` relative to
 * cwd, so this reproduces exactly what runVisualGate does in the sandbox.
 */
function writeWorkspace(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
}

function spawnGate(dir: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [VALIDATOR], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runGate(files: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'visual-gate-'));
  try {
    writeWorkspace(dir, files);
    return spawnGate(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const brief = (palette: unknown) => JSON.stringify({ palette });

describe('visual gate — contrast math (pure)', () => {
  it('computes WCAG contrast and flags sub-AA', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(wcagAA('#111111', '#0d0d0d')).toBe(false); // ink on near-equal bg → fail
    expect(wcagAA('#e6edf3', '#0d1117')).toBe(true); // light ink on dark bg → pass
  });

  it('passes the real brand-dark default palette (ink #e8eaf0 on bg #0a0c10)', () => {
    // The DesignBrief BRAND_DARK default (src/lib/schemas/design-brief.ts) —
    // what the provisioner seeds into .impulse/design-brief.json when the user
    // gives no custom palette. Confirms the gate is meaningful, not just math.
    expect(wcagAA('#e8eaf0', '#0a0c10')).toBe(true);
  });
});

describe('visual gate — process-level pass/fail (spawns the real validator)', () => {
  it('PASSES a clean workspace (exit 0, "VISUAL GATE PASS")', () => {
    const r = runGate({
      '.impulse/design-brief.json': brief(GOOD_PALETTE),
      'src/styles/tokens.css': ':root { --bg: #0a0c10; --ink: #e8eaf0; }',
      'src/App.tsx': 'export const App = () => <div style={{ color: "var(--ink)" }} />;',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VISUAL GATE PASS');
  });

  it('FAILS an invalid (sub-AA) palette (exit 1, reports the ratio)', () => {
    const r = runGate({ '.impulse/design-brief.json': brief(BAD_PALETTE) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('VISUAL GATE FAIL');
    expect(r.stderr).toContain('below WCAG-AA');
    expect(r.stderr).toMatch(/ink #111111 on bg #0d0d0d/);
  });

  it('FAILS on a hardcoded hex color in src/ (exit 1)', () => {
    const r = runGate({
      '.impulse/design-brief.json': brief(GOOD_PALETTE),
      'src/App.tsx': 'export const App = () => <div style={{ color: "#ff0000" }} />;',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hardcoded hex colors found');
    expect(r.stderr).toContain('src/App.tsx');
  });

  it('EXEMPTS the token file — hex inside src/styles/tokens.css is allowed', () => {
    const r = runGate({
      '.impulse/design-brief.json': brief(GOOD_PALETTE),
      'src/styles/tokens.css': ':root { --bg: #0a0c10; --accent: #d4a84b; }',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VISUAL GATE PASS');
  });

  it('SKIPS the contrast check when no design brief is seeded (still passes clean src)', () => {
    const r = runGate({ 'src/App.tsx': 'export const App = () => <div className="card" />;' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VISUAL GATE PASS');
  });

  it('still FLAGS a hardcoded hex in a NON-token file even when the SAME line mentions tokens.css:<n>', () => {
    // Regression guard for the PATH-ANCHORED exemption `^([^:]*/)?tokens\.css:[0-9]`.
    // The unanchored `tokens\.css:[0-9]` this replaced WRONGLY exempted this exact
    // line: its CONTENT contains the substring "tokens.css:12". The anchored form
    // exempts a line only when its FILE basename is tokens.css, so the real
    // violation in src/App.tsx is caught. (A bare `grep -v tokens.css` also leaked it.)
    const r = runGate({
      '.impulse/design-brief.json': brief(GOOD_PALETTE),
      'src/App.tsx': 'const c = "#ff0000"; // mirror of src/styles/tokens.css:12',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hardcoded hex colors found');
    expect(r.stderr).toContain('src/App.tsx');
  });

  it('does NOT over-exempt a differently-named token-ish file (design-tokens.css is still scanned)', () => {
    // Only the emitted src/styles/tokens.css basename is exempt. The unanchored
    // substring form leaked any *tokens.css basename; the anchored form flags a
    // hex in design-tokens.css because its basename is not exactly tokens.css.
    const r = runGate({
      '.impulse/design-brief.json': brief(GOOD_PALETTE),
      'src/styles/design-tokens.css': '.brand { color: #123456; }',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('hardcoded hex colors found');
    expect(r.stderr).toContain('design-tokens.css');
  });

  it('is DETERMINISTIC — same workspace, two runs → identical exit code and output', () => {
    // Run twice against ONE workspace so there is zero cross-directory variance:
    // any difference must come from the validator, not the filesystem. A pure
    // function of the tree yields byte-identical status/stdout/stderr.
    const dir = mkdtempSync(join(tmpdir(), 'visual-gate-det-'));
    try {
      writeWorkspace(dir, {
        '.impulse/design-brief.json': brief(GOOD_PALETTE),
        'src/A.tsx': 'const a = "#123456";',
        'src/b/B.tsx': 'const b = "#abcdef";',
      });
      const first = spawnGate(dir);
      const second = spawnGate(dir);
      expect(second.status).toBe(first.status);
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).toBe(first.stderr);
      expect(first.status).toBe(1); // sanity: this tree really does fail
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
