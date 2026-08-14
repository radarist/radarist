/**
 * visual-gate.mjs — the machine visual check (Task 6).
 *
 * Baked into the sandbox image at /opt/impulse/template/scripts/visual-gate.mjs
 * (see ../../Dockerfile) and invoked by the host-side runVisualGate()
 * (agent/src/sandbox/visual-gate.ts) with the workspace forced as cwd.
 *
 * Fails (exit 1) when either:
 *   1) the seeded .impulse/design-brief.json palette is below WCAG-AA contrast, or
 *   2) src/ contains a hardcoded hex color outside the token file
 *      (src/styles/tokens.css — the file the design-system skill emits).
 *
 * Pure helpers (contrastRatio, wcagAA) are exported for the host-side unit
 * test (agent/tests/sandbox-visual-gate.test.ts); main() only runs when the
 * file is executed directly, so importing it in tests never triggers the gate.
 *
 * PROVENANCE (SKILL-004) — repository-owned, not a host plugin.
 *   - Origin:  authored in-tree for this repository; not vendored from any
 *              third party. Versioned here, so "pinned" = the committed file at
 *              the image's build tag (IMPULSE_BUILD_SANDBOX_IMAGE_TAG).
 *   - License: the repository's MIT license (see /LICENSE, "Radarist
 *              Contributors"). No separate upstream license to attribute.
 *   - Deps:    Node.js built-ins only (node:fs, node:child_process) plus the
 *              base image's `grep`. Zero npm packages; nothing is downloaded at
 *              runtime. It does NOT use the host `frontend-design` Claude Code
 *              plugin or any host plugin, so the check is reproducible from the
 *              committed image alone, independent of host-side plugin state
 *              (SKILL-004: "never depend on accidental host plugins"). The
 *              all-`node:`-imports invariant is enforced by
 *              agent/tests/sandbox-visual-gate-wiring.test.ts.
 *   - Algorithm: WCAG 2.x relative-luminance contrast ratio (sRGB linearize →
 *              (L1+0.05)/(L2+0.05)); AA body-text threshold 4.5:1. Deterministic
 *              — a pure function of the workspace tree; identical input → identical
 *              exit code + output (proven in the process-level tests).
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function contrastRatio(hexA, hexB) {
  const lum = (hex) => {
    const c = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [la, lb] = [lum(hexA), lum(hexB)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}
export const wcagAA = (fg, bg) => contrastRatio(fg, bg) >= 4.5;

export function main() {
  const problems = [];
  // 1) contrast on the seeded brief palette
  if (existsSync('.impulse/design-brief.json')) {
    const { palette } = JSON.parse(readFileSync('.impulse/design-brief.json', 'utf8'));
    if (palette?.ink && palette?.bg && !wcagAA(palette.ink, palette.bg))
      problems.push(
        `ink ${palette.ink} on bg ${palette.bg} is below WCAG-AA (${contrastRatio(palette.ink, palette.bg).toFixed(2)}:1)`
      );
  }
  // 2) no hardcoded hex in src/ outside the emitted token file. The exemption is
  // PATH-ANCHORED to the token file's own grep lines: `^([^:]*/)?tokens\.css:[0-9]`
  // anchors at line start and lets `[^:]*/` match only a leading path (it cannot
  // cross a colon), so a line is dropped ONLY when its `path:lineNo:` prefix names
  // a file whose basename is exactly `tokens.css` (what the design-system skill
  // emits at src/styles/tokens.css). A hex in any OTHER file is still flagged —
  // even when the line's CONTENT mentions `tokens.css:12` (content sits after the
  // second colon, which the anchor can't reach) and even in a differently-named
  // token-ish file like `design-tokens.css` (basename ≠ `tokens.css`). A bare
  // `grep -v tokens.css`, or the unanchored `tokens\.css:[0-9]`, would wrongly
  // exempt both of those.
  try {
    const hits = execSync(
      `grep -rInE "#[0-9a-fA-F]{6}" src --include=*.tsx --include=*.ts --include=*.css | grep -vE '^([^:]*/)?tokens\\.css:[0-9]' || true`,
      { encoding: 'utf8' }
    ).trim();
    if (hits) problems.push(`hardcoded hex colors found (use tokens):\n${hits.split('\n').slice(0, 20).join('\n')}`);
  } catch {
    /* no src/ yet → skip */
  }

  if (problems.length) {
    console.error('VISUAL GATE FAIL\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('VISUAL GATE PASS');
}
// Run only when invoked directly (not when imported by the host test).
if (process.argv[1] && process.argv[1].endsWith('visual-gate.mjs')) main();
