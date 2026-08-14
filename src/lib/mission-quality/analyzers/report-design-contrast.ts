/**
 * @file lib/mission-quality/analyzers/report-design-contrast.ts
 * @description REPORT-003 — deterministic WCAG-contrast checks over the
 * AUTHORED CSS of a report (inline <style> blocks + style="" attributes).
 *
 * Motivating failure: authored text can have unreadable contrast while still
 * reaching `published`. A browser can compute every effective pair;
 * a server-side gate cannot, so this analyzer restricts itself to pairs it
 * can resolve with CONFIDENCE and stays silent otherwise:
 *
 *   1. same-selector pairs — a rule (or two rules with the exact same
 *      selector text) declaring both `color` and `background(-color)`;
 *   2. inline `style=""` attributes declaring both;
 *   3. page-level text — body/html/:root `color` vs the declared page
 *      background;
 *   4. page sweep — when the author declares a LIGHT page background, any
 *      authored text color that fails against the page AND has no plausible
 *      authored surface (no declared background anywhere that would give it
 *      ≥ MIN_HARD contrast) is flagged. Light-on-dark-card styling always has
 *      such a surface, so it never false-positives here; a color that works
 *      NOWHERE in the document cannot be intended.
 *
 * Ratios below HARD_FLOOR (3.0:1 — the WCAG AA large-text floor) are hard
 * violations; the 3.0–4.5 band is advisory. Colors the analyzer cannot parse
 * (var(), gradients, exotic names) are skipped, never guessed. The Playwright
 * acceptance drives the same fixtures through a real browser's computed
 * styles so the static gate and the browser agree on this failure class.
 */

export interface ContrastFinding {
  check: 'minimum-contrast';
  detail: string;
  severity?: 'block' | 'advise';
}

export interface ContrastVerdict {
  ok: boolean;
  violations: ContrastFinding[];
  advisories: ContrastFinding[];
}

/**
 * WCAG AA floor for large text — below this nothing is legitimately readable.
 *
 * Exported so the browser capture gate grades paper against the SAME number this
 * static analyzer grades screen against (COORD-021). A second hand-copied floor
 * is how the two surfaces would drift into disagreeing about "readable".
 */
export const HARD_FLOOR = 3.0;
/** WCAG AA floor for normal text — the advisory band ceiling. */
const ADVISORY_FLOOR = 4.5;

// ---------------------------------------------------------------------------
// Color parsing + WCAG math
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
};

/** Parse a CSS color into [r,g,b] 0–255, or null when not confidently parseable. */
export function parseCssColor(raw: string): [number, number, number] | null {
  const value = raw.trim().toLowerCase();
  const named = NAMED_COLORS[value];
  const hex = named ?? value;

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(hex);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length === 8) {
      // 8-digit hex: only fully opaque colors are confidently resolvable.
      if (h.slice(6) !== 'ff') return null;
      h = h.slice(0, 6);
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(1|1\.0+)\s*)?\)$/.exec(value);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }

  return null;
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of a parsed color.
 *
 * REPORT-016: this module is the ONE importable WCAG implementation. The copies
 * in `report-theme.ts` and `graph-theme.ts` were deleted in favour of these
 * exports (`composer-verify.ts` already imported rather than forked). The
 * sandbox's `visual-gate.mjs` keeps its own copy by design — it runs inside a
 * generated project that cannot import app code.
 */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * WCAG contrast ratio, or `null` when either color is not confidently
 * parseable. Callers that must not throw on runtime-supplied colors (a
 * user-authored DesignBrief palette, a CSS custom property read from the live
 * document) use this and choose their own fallback.
 */
export function contrastRatioOrNull(colorA: string, colorB: string): number | null {
  const a = parseCssColor(colorA);
  const b = parseCssColor(colorB);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast ratio between two CSS colors (throws on unparseable input). */
export function contrastRatio(colorA: string, colorB: string): number {
  const ratio = contrastRatioOrNull(colorA, colorB);
  if (ratio === null) throw new Error(`unparseable color pair: ${colorA} / ${colorB}`);
  return ratio;
}

// ---------------------------------------------------------------------------
// Authored-CSS extraction
// ---------------------------------------------------------------------------

interface AuthoredRule {
  selector: string;
  color?: string;
  background?: string;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function lastDeclaration(body: string, property: 'color' | 'background'): string | undefined {
  // background matches background and background-color (shorthand first token
  // must look like a color for us to consider it; gradients etc. drop out at
  // parse time).
  const re =
    property === 'color'
      ? /(?:^|[;{\s])color\s*:\s*([^;!}]+)/gi
      : /(?:^|[;{\s])background(?:-color)?\s*:\s*([^;!}]+)/gi;
  let match: RegExpExecArray | null;
  let value: string | undefined;
  while ((match = re.exec(body)) !== null) {
    value = match[1].trim();
  }
  return value;
}

/**
 * True when a media query targets paper and paper only.
 *
 * Conservative by design: a query that also names `screen`, or negates print,
 * still reaches the screen and must keep being graded. Anything that does not
 * mention print at all (`(max-width: 768px)`, `screen`, no query) is screen-
 * applicable and is flattened as before.
 */
function isPrintOnlyQuery(query: string): boolean {
  const q = query.toLowerCase();
  if (!/\bprint\b/.test(q)) return false;
  if (/\bnot\s+print\b/.test(q)) return false;
  if (/\bscreen\b/.test(q)) return false;
  return true;
}

/**
 * COORD-021 — resolve `@media` wrappers for SCREEN grading.
 *
 * This analyzer grades the palette a reader sees on screen. It previously
 * deleted every `@media` opener with a regex, which flattened print and screen
 * rules into one namespace and made the "last page background wins" rule below
 * depend on document order across media. That was invisible while no print rule
 * set a page background — but the moment the page-theme suffix gained a
 * print-scoped `html,body` remap, print-white became the last background for
 * every themed export and this analyzer would have silently started grading the
 * PRINT palette, turning screen contrast into the new blind spot (and flipping
 * existing withhold verdicts to pass).
 *
 * So: print-only blocks are excised whole (brace-matched, so nested at-rules and
 * their contents go with them); every other block keeps today's behaviour of
 * contributing its contents. Paper contrast is covered separately by the A4
 * capture check, which measures the rendered page rather than parsing CSS.
 */
export function resolveScreenCss(css: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const at = css.indexOf('@media', cursor);
    if (at === -1) {
      out += css.slice(cursor);
      return out;
    }
    out += css.slice(cursor, at);
    const braceStart = css.indexOf('{', at);
    if (braceStart === -1) {
      // Malformed tail — nothing further can be parsed as a block.
      return out;
    }
    const query = css.slice(at + '@media'.length, braceStart);
    let depth = 1;
    let scan = braceStart + 1;
    while (scan < css.length && depth > 0) {
      const ch = css[scan];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      scan += 1;
    }
    // `scan` sits just past the matching `}` (or at EOF when unbalanced).
    const innerEnd = depth === 0 ? scan - 1 : css.length;
    if (!isPrintOnlyQuery(query)) out += css.slice(braceStart + 1, innerEnd);
    cursor = scan;
  }
}

/** Extract authored rules from every inline <style> block. */
function extractAuthoredRules(html: string): AuthoredRule[] {
  const rules: AuthoredRule[] = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleRe.exec(html)) !== null) {
    const css = resolveScreenCss(stripCssComments(styleMatch[1]));
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(css)) !== null) {
      const selector = ruleMatch[1].trim().replace(/\s+/g, ' ');
      if (!selector || selector.startsWith('@')) continue;
      const body = ruleMatch[2];
      const color = lastDeclaration(body, 'color');
      const background = lastDeclaration(body, 'background');
      if (color || background) rules.push({ selector, color, background });
    }
  }
  return rules;
}

/** Extract inline style="" declarations that carry both color and background. */
function extractInlineStylePairs(html: string): Array<{ color: string; background: string }> {
  const pairs: Array<{ color: string; background: string }> = [];
  const attrRe = /style\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(html)) !== null) {
    const body = match[2] ?? match[3] ?? '';
    const color = lastDeclaration(body, 'color');
    const background = lastDeclaration(body, 'background');
    if (color && background) pairs.push({ color, background });
  }
  return pairs;
}

const PAGE_SELECTOR = /(^|,)\s*(body|html|:root)\s*($|,)/i;

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

function classify(ratio: number, where: string, fg: string, bg: string): ContrastFinding | null {
  if (ratio >= ADVISORY_FLOOR) return null;
  const detail = `${where}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (WCAG floor ${
    ratio < HARD_FLOOR ? `${HARD_FLOOR.toFixed(1)}:1` : `${ADVISORY_FLOOR.toFixed(1)}:1 for normal text`
  }). Use a text color the reader can actually see against this background.`;
  return ratio < HARD_FLOOR
    ? { check: 'minimum-contrast', detail }
    : { check: 'minimum-contrast', detail, severity: 'advise' };
}

/**
 * Run the confident-pair contrast checks over a report's authored CSS.
 * Silent (ok) when nothing is confidently resolvable — the browser-level
 * acceptance owns full-fidelity coverage.
 */
export function analyzeReportContrast(html: string): ContrastVerdict {
  const violations: ContrastFinding[] = [];
  const advisories: ContrastFinding[] = [];
  const record = (finding: ContrastFinding | null) => {
    if (!finding) return;
    if (finding.severity === 'advise') advisories.push(finding);
    else violations.push(finding);
  };

  const rules = extractAuthoredRules(html);

  // Merge color/background by exact selector text (same rule or split rules).
  const bySelector = new Map<string, { color?: string; background?: string }>();
  for (const rule of rules) {
    const entry = bySelector.get(rule.selector) ?? {};
    if (rule.color) entry.color = rule.color;
    if (rule.background) entry.background = rule.background;
    bySelector.set(rule.selector, entry);
  }

  // Page background: the last body/html/:root background declaration wins.
  let pageBackground: string | undefined;
  for (const rule of rules) {
    if (PAGE_SELECTOR.test(rule.selector) && rule.background && parseCssColor(rule.background)) {
      pageBackground = rule.background;
    }
  }

  // 1+2. Same-selector pairs (and page-level text vs the page background).
  const flaggedColors = new Set<string>();
  for (const [selector, entry] of bySelector) {
    const effectiveBg = entry.background ?? (PAGE_SELECTOR.test(selector) ? pageBackground : undefined);
    if (!entry.color || !effectiveBg) continue;
    const fg = parseCssColor(entry.color);
    const bg = parseCssColor(effectiveBg);
    if (!fg || !bg) continue;
    const finding = classify(
      contrastRatio(entry.color, effectiveBg),
      `selector "${selector}"`,
      entry.color,
      effectiveBg
    );
    if (finding && !finding.severity) flaggedColors.add(entry.color.toLowerCase());
    record(finding);
  }

  // 3. Inline style pairs.
  for (const pair of extractInlineStylePairs(html)) {
    if (!parseCssColor(pair.color) || !parseCssColor(pair.background)) continue;
    record(classify(contrastRatio(pair.color, pair.background), 'inline style', pair.color, pair.background));
  }

  // 4. Page sweep — only when the author declared the page background. A text
  // color that fails against the page and has NO plausible authored surface
  // (no declared background anywhere giving it ≥ HARD_FLOOR) cannot be
  // intended for anything in this document.
  if (pageBackground && parseCssColor(pageBackground)) {
    const authoredBackgrounds = rules
      .map((r) => r.background)
      .filter((bg): bg is string => Boolean(bg && parseCssColor(bg)));
    for (const [selector, entry] of bySelector) {
      if (!entry.color || entry.background) continue; // paired rules already handled
      if (PAGE_SELECTOR.test(selector)) continue; // page-level handled above
      const color = entry.color;
      if (!parseCssColor(color) || flaggedColors.has(color.toLowerCase())) continue;
      const pageRatio = contrastRatio(color, pageBackground);
      if (pageRatio >= HARD_FLOOR) continue;
      const hasPlausibleSurface = authoredBackgrounds.some((bg) => contrastRatio(color, bg) >= HARD_FLOOR);
      if (hasPlausibleSurface) continue;
      record(
        classify(
          pageRatio,
          `selector "${selector}" (no authored surface makes this color readable)`,
          color,
          pageBackground
        )
      );
    }
  }

  return { ok: violations.length === 0, violations, advisories };
}
