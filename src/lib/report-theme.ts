/**
 * @file lib/report-theme.ts
 * @description Page-level theming for published reports.
 *
 * `report-brand.css` is fully CSS-variable-driven, but its `:root` defaults are
 * hard-coded brand-dark (`--bg-primary:#0a0c10`, `--accent-blue:#4a9eff`, …). The
 * DesignBrief only themes the CHARTS (server-side, via `chartTokensForBrief`) — the
 * page chrome (hero, cards, text, borders) stays dark unless we inject the brief's
 * palette as a `:root` override. Without this, a "brand-light / no black" brief
 * still renders a black page (charts premium, page dark — the exact inconsistency
 * users hit).
 *
 * This module emits that override `<style>` block. It is appended at the END of the
 * report HTML so it wins the cascade over the linked `report-brand.css` `:root`
 * defaults (equal specificity → last one wins).
 *
 * COORD-021 — that same "last one wins" property is why the block must carry its
 * own print remap. Media queries add ZERO specificity, so the unconditional
 * `html,body` pin below beat every earlier `@media print` rule: the author's own
 * A4 rules (`report-tools.ts` instructs the model to write them) and
 * `report-brand.css`'s print block (`:966-1029`, which remaps `:root` but never
 * sets a page background). The exact product export therefore printed dark ink on
 * a `#0a0c10` page. The composer path had a fix, but composer mode is off by
 * default and the freehand path — the default — had none. The remedy travels with
 * the cause: the suffix that pins the page also releases it for paper.
 */
import {
  contrastRatioOrNull,
  parseCssColor,
  relativeLuminance,
} from '@/lib/mission-quality/analyzers/report-design-contrast';
import type { DesignBrief } from '@/lib/schemas/design-brief';

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

/** Linear blend of two hex colors; `t=0` → `a`, `t=1` → `b`. */
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/**
 * WCAG relative luminance of a hex color; `NaN` when unparseable.
 *
 * REPORT-016: the math lives in `report-design-contrast.ts` — the one
 * importable WCAG implementation. A DesignBrief palette is `z.string()`, so an
 * API caller can supply a value neither this module nor the analyzer can parse;
 * such a color must degrade, never throw.
 */
function relLum(hex: string): number {
  const rgb = parseCssColor(hex);
  return rgb ? relativeLuminance(rgb) : Number.NaN;
}

/**
 * WCAG contrast ratio between two hex colors.
 *
 * Unparseable input yields `Infinity` — "cannot verify, so leave the color
 * alone". `ensureContrast` compares `< floor`, which is false for both the old
 * fork's `NaN` and this `Infinity`, so an unresolvable color is still returned
 * untouched. The one case that differs: when a brief declares a parseable `bg`
 * but an unparseable `surface`, `worseBg` now selects the background it CAN
 * measure instead of skipping the adjustment entirely — strictly more contrast
 * enforcement on a malformed palette, never less.
 */
function wcag(a: string, b: string): number {
  return contrastRatioOrNull(a, b) ?? Number.POSITIVE_INFINITY;
}

/**
 * Nudge `color` toward `ink` until it meets `floor` against `bg` (≤20 steps).
 * Deterministic — the same brief always yields the same resolved color. This is
 * what makes semantic accents (green/red pills, muted meta) readable on BOTH
 * brand themes and arbitrary user palettes without hand-tuning per theme.
 */
function ensureContrast(color: string, bg: string, ink: string, floor: number): string {
  let out = color;
  for (let i = 0; i < 20 && wcag(out, bg) < floor; i++) {
    out = mix(out, ink, 0.12);
  }
  return out;
}

/**
 * The RESOLVED semantic palette for a brief — the exact values the theme
 * suffix emits after contrast adjustment. Exported so the composer verify
 * can validate the same numbers the page will render.
 */
export function resolveThemeAccents(brief: DesignBrief): {
  secondary: string;
  muted: string;
  accent: string;
  accentStrong: string;
  greenStrong: string;
  redStrong: string;
  blueStrong: string;
  blue: string;
  green: string;
  red: string;
  purple: string;
} {
  const p = brief.palette;
  const seq = p.sequence ?? [];
  const accent = p.accent || seq[0] || '#9c7c3c';
  const worseBg = (c: string) => (wcag(c, p.bg) <= wcag(c, p.surface) ? p.bg : p.surface);
  const fix = (c: string, floor: number) => ensureContrast(c, worseBg(c), p.ink, floor);
  return {
    secondary: ensureContrast(mix(p.ink, p.bg, 0.32), p.bg, p.ink, 4.5),
    muted: ensureContrast(mix(p.ink, p.bg, 0.52), p.bg, p.ink, 4.5),
    accent: fix(accent, 3.0),
    /** For SMALL accent text (labels/kickers/cites/pills) — AA normal-text floor. */
    accentStrong: fix(accent, 4.5),
    greenStrong: fix(seq[2] ?? accent, 4.5),
    redStrong: fix(seq[3] ?? accent, 4.5),
    blueStrong: fix(seq[1] ?? accent, 4.5),
    blue: fix(seq[1] ?? accent, 3.0),
    green: fix(seq[2] ?? accent, 3.0),
    red: fix(seq[3] ?? accent, 3.0),
    purple: fix(seq[4] ?? seq[3] ?? accent, 3.0),
  };
}

/**
 * The one print palette, shared by the freehand page-theme suffix and the
 * composer's `.composed` remap (COORD-021).
 *
 * Every text/surface pairing here is WCAG-checked by `report-composer-print.test.ts`,
 * which also drift-guards it: every `--var` the suffix emits must exist in this
 * map. Change values only with that test.
 *
 * Two consumers, one definition — a second hand-rolled print palette would let
 * the two authoring paths disagree about what paper looks like, which is the
 * class of bug COORD-021 is.
 */
export const COMPOSER_PRINT_THEME: Readonly<Record<string, string>> = {
  '--bg-primary': '#ffffff',
  '--bg-secondary': '#fafaf8',
  '--bg-card': '#f6f6f3',
  '--bg-card-alt': '#efefec',
  '--text-primary': '#111318',
  '--text-secondary': '#333a45',
  '--text-muted': '#50565f',
  '--accent-gold': '#7a5c17',
  '--accent-strong': '#7a5c17',
  '--accent-gold-light': '#8a6f2a',
  '--green-strong': '#1d6f4f',
  '--red-strong': '#a33434',
  '--blue-strong': '#2b5fa3',
  '--accent-blue': '#2b5fa3',
  '--accent-green': '#1d6f4f',
  '--accent-red': '#a33434',
  '--accent-purple': '#6b46a3',
  '--border': '#d9d9d4',
  '--border-accent': '#bcbcb6',
  '--cyan': '#2b5fa3',
  '--magenta': '#a33434',
  '--lime': '#1d6f4f',
  '--amber': '#7a5c17',
  '--text': '#111318',
  '--muted': '#50565f',
  '--bg': '#ffffff',
  '--accent': '#7a5c17',
  '--gold': '#7a5c17',
  '--green': '#1d6f4f',
  '--red': '#a33434',
  '--purple': '#6b46a3',
};

/** Paper ink/surface, kept in one place so the pin and the vars cannot drift. */
const PRINT_PAGE_BG = COMPOSER_PRINT_THEME['--bg-primary'];
const PRINT_PAGE_INK = COMPOSER_PRINT_THEME['--text-primary'];

/**
 * The print counterpart to the unconditional `html,body` pin (COORD-021).
 *
 * `:root` here supersedes both the suffix's own screen `:root` and
 * `report-brand.css`'s print `:root` by document order, so this one block covers
 * the variable-driven path. The `html,body` rule needs `!important` because the
 * screen pin is a later-or-equal type selector in the same stylesheet — exactly
 * the reason the composer's block already carries it.
 */
const PRINT_THEME_CSS = `@media print{:root{${Object.entries(COMPOSER_PRINT_THEME)
  .map(([k, v]) => `${k}:${v};`)
  .join('')}}html,body{background:${PRINT_PAGE_BG} !important;color:${PRINT_PAGE_INK} !important;}}`;

/**
 * Build the `<style>` block that re-themes `report-brand.css` to the brief's
 * palette. Maps `brief.palette` onto the stylesheet's CSS variable names and
 * derives the secondary/muted/border shades by blending ink toward bg.
 *
 * Returns `''` when no brief (or no palette). Append the result to the report HTML.
 */
export function reportThemeStyleForBrief(brief: DesignBrief | undefined): string {
  if (!brief?.palette) return '';
  const p = brief.palette;
  const seq = p.sequence ?? [];
  const accent = p.accent || seq[0] || '#9c7c3c';
  const resolved = resolveThemeAccents(brief);

  const vars: Record<string, string> = {
    '--bg-primary': p.bg,
    '--bg-secondary': mix(p.bg, p.ink, 0.04),
    '--bg-card': p.surface,
    // Templates build card/table/timeline surfaces as `var(--bg-card-alt)` or a
    // `var(--bg-card) → var(--bg-card-alt)` gradient. report-brand.css has no
    // default, so the agent's own dark `--bg-card-alt` (e.g. #0a0f2e) wins and
    // those surfaces render BLACK on a light brief. Pin it to a light shade.
    '--bg-card-alt': mix(p.surface, p.ink, 0.05),
    '--text-primary': p.ink,
    '--text-secondary': resolved.secondary,
    '--text-muted': resolved.muted,
    '--accent-gold': resolved.accent,
    '--accent-strong': resolved.accentStrong,
    '--green-strong': resolved.greenStrong,
    '--red-strong': resolved.redStrong,
    '--blue-strong': resolved.blueStrong,
    // REPORT-016: blend toward whichever of bg/ink is LIGHTER. Blending toward
    // `bg` unconditionally is only correct on a light brief; on brand-dark the
    // background is near-black, so the "light" gold resolved DARKER than its
    // base (#d4a84b -> #9b7c3a) and reversed `--gradient-gold`. Light briefs are
    // unaffected — there `bg` already is the lighter endpoint.
    '--accent-gold-light': mix(accent, relLum(p.ink) > relLum(p.bg) ? p.ink : p.bg, 0.28),
    // Semantic accents follow the canonical sequence order (mirrors
    // BRAND_SEQUENCE + design-tokens): [1]=info/blue, [2]=positive/green,
    // [3]=negative/red, [4]=purple. The previous cross-mapping rendered
    // "good" cells purple and "bad" cells green on the brand palette.
    '--accent-blue': resolved.blue,
    '--accent-green': resolved.green,
    '--accent-red': resolved.red,
    '--accent-purple': resolved.purple,
    '--border': mix(p.bg, p.ink, 0.14),
    '--border-accent': mix(p.bg, p.ink, 0.24),
    // Aliases for accent var names agents sometimes invent (e.g. `color: var(--cyan)`
    // on table headers) — map them onto the brief sequence so that text stays on-brand.
    '--cyan': resolved.blue,
    '--magenta': resolved.red,
    '--lime': resolved.green,
    '--amber': resolved.accent,
    // Short-name aliases the agent's component CSS actually uses (it defines the
    // long `--text-primary`/`--accent-gold` in :root but styles components with
    // `var(--text)`, `var(--gold)`, `var(--bg)`, …). Appended last, these win —
    // without them section headings (`color:var(--text)`) render washed-out and
    // surfaces (`var(--bg)`) ignore the brief.
    '--text': p.ink,
    '--muted': resolved.muted,
    '--bg': p.bg,
    '--accent': resolved.accent,
    '--gold': resolved.accent,
    '--green': resolved.green,
    '--red': resolved.red,
    '--purple': resolved.purple,
  };

  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  // Appended last → overrides report-brand.css's brand-dark :root defaults.
  // Also pin html/body bg+fg so the page surface itself follows the brief.
  //
  // COORD-021: the print block is APPENDED after the pin and never rewrites it.
  // `publish-report-tool.test.ts` matches the pin as an exact substring, and the
  // screen cascade must stay byte-identical — only paper behaviour is added.
  return `<style data-design-pass="page-theme">:root{${decls}}html,body{background:${p.bg};color:${p.ink};}${PRINT_THEME_CSS}</style>`;
}

/**
 * Theme the report page to the brief — SUFFIX-ONLY.
 *
 * The previous implementation additionally regex-rewrote authored colors by
 * luminance (dark backgrounds → one tint, light text → ink, gradient stops,
 * `-webkit-text-fill-color`). That pass flattened authored design instead of
 * fixing it and invalidated Super-Graph provenance hashes by editing bytes
 * inside `<svg>` style attributes. Those
 * rewrites are deliberately deleted: the authored HTML is preserved byte-for-byte
 * and only the `:root` variable suffix (which wins the cascade for var-driven
 * styling) is appended. Returns `html` unchanged with no brief.
 */
export function applyPageTheme(html: string, brief: DesignBrief | undefined): string {
  if (!brief?.palette) return html;
  return html + reportThemeStyleForBrief(brief);
}
