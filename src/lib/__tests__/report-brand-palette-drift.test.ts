/**
 * @file lib/__tests__/report-brand-palette-drift.test.ts
 * @description REPORT-016 — the brand palette has ONE definition.
 *
 * `design-brief.ts` owns the numbers. `design-tokens.ts` imports them, so a
 * divergence there is a compile-time impossibility. `public/css/report-brand.css`
 * cannot import TypeScript — it is a static stylesheet served to the report
 * viewer — so this test is the mechanism that fails when its `:root` and the
 * constants disagree.
 *
 * Before REPORT-016 the two were held together only by a "mirrors
 * report-brand.css" comment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPORT_FIGURE_IMAGE_CLASS } from '@/lib/reports/publication-contract';
import { BRAND_DARK, BRAND_DARK_CHROME, BRAND_SEQUENCE } from '@/lib/schemas/design-brief';

const CSS_PATH = join(process.cwd(), 'public/css/report-brand.css');

/**
 * Extract the `:root` custom-property declarations. The stylesheet begins with
 * generated `@font-face` blocks carrying base64 payloads, so the block is
 * anchored on a line-initial `:root {` and read to its closing brace.
 */
function parseRootVars(css: string): Record<string, string> {
  const start = css.search(/^:root\s*\{/m);
  if (start === -1) throw new Error('report-brand.css has no :root block');
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('}', bodyStart);
  if (end === -1) throw new Error('report-brand.css :root block is unterminated');

  const vars: Record<string, string> = {};
  for (const decl of css.slice(bodyStart, end).split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

/** The stylesheet variable -> the constant that owns its value. */
function expectedPalette(): Record<string, string> {
  const p = BRAND_DARK.palette;
  return {
    '--bg-primary': p.bg,
    '--bg-card': p.surface,
    '--text-primary': p.ink,
    '--accent-gold': p.accent,
    '--accent-blue': BRAND_SEQUENCE[1],
    '--accent-green': BRAND_SEQUENCE[2],
    '--accent-red': BRAND_SEQUENCE[3],
    '--accent-purple': BRAND_SEQUENCE[4],
    '--bg-secondary': BRAND_DARK_CHROME.bgSecondary,
    '--accent-gold-light': BRAND_DARK_CHROME.accentGoldLight,
    '--text-secondary': BRAND_DARK_CHROME.textSecondary,
    '--text-muted': BRAND_DARK_CHROME.textMuted,
    '--border': BRAND_DARK_CHROME.border,
    '--border-accent': BRAND_DARK_CHROME.borderAccent,
  };
}

/** Vars in `:root` whose value is derived or non-color, so not palette numbers. */
const NON_PALETTE_VARS = new Set(['--gradient-gold', '--shadow-hover']);

/**
 * Every stylesheet/constant disagreement, as `--var: css != constant` strings.
 * The single comparator both the conformance case and the failure-first case
 * run, so "the check passes" and "the check can fail" are the same mechanism.
 */
function driftAgainstConstants(css: string): string[] {
  const actual = parseRootVars(css);
  return Object.entries(expectedPalette())
    .filter(([name, value]) => actual[name]?.toLowerCase() !== value.toLowerCase())
    .map(([name, value]) => `${name}: ${actual[name]} != ${value}`);
}

describe('report-brand.css :root vs the design-brief constants', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');

  it('declares exactly the brand palette values the constants define', () => {
    expect(driftAgainstConstants(css)).toEqual([]);
  });

  it('covers every color var in :root — a new one cannot slip past this test', () => {
    const declared = Object.keys(parseRootVars(css)).filter((v) => !NON_PALETTE_VARS.has(v));
    expect(declared.sort()).toEqual(Object.keys(expectedPalette()).sort());
  });

  it('bounds every image and keeps wide content off the page axis (REPORT-014)', () => {
    // The stylesheet carried NO image rule at all, which is why a 1200px
    // generated infographic could widen the whole document. These are the floors
    // the browser acceptance measures; asserting them here means a later edit
    // that drops one fails in unit tests rather than only under Playwright.
    const normalized = css.replace(/\s+/g, ' ');
    expect(normalized).toMatch(/img,[^{]*svg,[^{]*video\s*\{[^}]*max-width:\s*100%/);
    expect(normalized).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
    expect(normalized).toContain(`.${REPORT_FIGURE_IMAGE_CLASS}`);
    expect(normalized).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    // Both halves are required. Without `min-width: max-content` the table is
    // clamped to its wrapper, so the wrapper never scrolls and dense cells are
    // clipped instead — measured in the browser while building REPORT-014.
    expect(normalized).toMatch(/\.table-scroll > table\s*\{[^}]*min-width:\s*max-content/);
  });

  it('reverts the screen-only floors for print, so nothing is clipped on paper', () => {
    const printBlock = css.slice(css.indexOf('@media print')).replace(/\s+/g, ' ');
    expect(printBlock).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*visible/);
    // A scroll region on paper prints only its first screenful.
    expect(printBlock).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*visible/);
    expect(printBlock).toMatch(/\.table-scroll > table\s*\{[^}]*min-width:\s*0/);
    expect(printBlock).toMatch(/th,\s*td\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('reports drift when the stylesheet diverges from the constants', () => {
    // Failure-first proof: the SAME comparator must go non-empty on a
    // divergence, otherwise the passing case above proves nothing. Mutating a
    // copy of the stylesheet text keeps the tracked file untouched.
    const drifted = css.replace(`--accent-gold: ${BRAND_DARK.palette.accent}`, '--accent-gold: #ff0000');
    expect(drifted).not.toEqual(css); // the anchor really matched

    expect(driftAgainstConstants(drifted)).toEqual([`--accent-gold: #ff0000 != ${BRAND_DARK.palette.accent}`]);
  });
});
