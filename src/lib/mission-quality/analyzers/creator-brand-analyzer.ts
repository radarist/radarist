/**
 * @file lib/creator-brand-analyzer.ts
 * @description Deterministic brand-compliance checks for Creator HTML output.
 *
 * Pairs with the "Visual Design System (mandatory)" section in
 * agent/agents/creator/PROFILE.md. The PROFILE.md tells the agent the rules;
 * this module verifies the agent followed them. Used as an L1 soft check by
 * `mission-quality.ts:checkCreatorBrandCompliance`.
 *
 * The brand stylesheet is `public/css/report-brand.css`. It's the canonical
 * editorial design system for agent-generated reports.
 *
 * Four mechanical checks (V1):
 *   1. brand-stylesheet-linked   — <link> to /css/report-brand.css in <head>
 *   2. no-variable-shadowing     — agent <style> doesn't redeclare brand tokens
 *   3. citations-use-cite-class  — every <sup> wrapping [N] has class="cite"
 *   4. no-banned-class-patterns  — agent didn't reinvent rec-card / profile-card
 *                                  / tag-adopt / evolution-pill / etc.
 *
 * Each check is regex-only — no DOM parser dep. Renderer-owned SVG styles are
 * excluded only when their exact output carries valid Super-Graph provenance;
 * unsigned or edited nested styles remain part of the author CSS budget.
 *
 * @author Radarist Team
 * @created 2026-05-08
 */

import { hasValidSuperGraphProvenance, SUPER_GRAPH_PROVENANCE_ATTRIBUTE } from '@/lib/super-graph/provenance';

export interface BrandComplianceViolation {
  check:
    | 'brand-stylesheet-linked'
    | 'no-variable-shadowing'
    | 'citations-use-cite-class'
    | 'no-banned-class-patterns'
    | 'chart-palette-conformance';
  detail: string;
  /** 'block' (default) flips the verdict to not-ok; 'advise' is surfaced in
   *  `advisories` but never blocks (design-pass ships palette checks advisory
   *  first to observe fire-rate before promoting). */
  severity?: 'block' | 'advise';
}

export type BrandComplianceVerdict =
  | { ok: true; htmlLength: number; advisories?: BrandComplianceViolation[] }
  | { ok: false; violations: BrandComplianceViolation[]; htmlLength: number; advisories?: BrandComplianceViolation[] };

/**
 * Decide whether the result is HTML worth checking. Plain markdown / SBAR
 * briefs / IMRAD whitepapers in plain text skip the brand checks (no HTML to
 * style). Only run when the result looks like a full HTML document.
 */
export function isHtmlReport(result: string): boolean {
  if (!result || result.length < 200) return false;
  const lower = result.toLowerCase();
  return /<html[\s>]/.test(lower) || /<body[\s>]/.test(lower);
}

/**
 * Extract chart SVG fill colors from report HTML and return the ones NOT in the
 * allowed palette (the mission DesignBrief). Anchored to fill ATTRIBUTES only
 * (`fill="#hhh"` / `fill='#hhh'`) — it deliberately ignores CSS `fill:`
 * declarations (colon, no `=`), prose hex mentions (no `fill=`), and
 * rgba()/named/none/url() fills (no leading `#`), so it cannot false-positive on
 * those. Neutral white/black are always allowed (chart backgrounds, axes, text).
 *
 * Returns a deduped, lowercased list of off-palette hexes (empty = conformant).
 */
export function findOffPaletteFills(html: string, allowed: string[]): string[] {
  const allowedSet = new Set(allowed.map((c) => c.toLowerCase()));
  const NEUTRALS = new Set(['#fff', '#ffffff', '#000', '#000000']);
  const offPalette = new Set<string>();
  const re = /\bfill=["'](#[0-9a-fA-F]{3,6})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const hex = m[1].toLowerCase();
    if (!allowedSet.has(hex) && !NEUTRALS.has(hex)) offPalette.add(hex);
  }
  return [...offPalette];
}

/**
 * Brand variables owned by report-brand.css. Agents MUST NOT redeclare these.
 *
 * REPORT-015: exported so the report-authoring instruction can name the SAME
 * list this check enforces. A rule may only be armed when the writer was told
 * the exact value it requires, and that guarantee only holds if the prompt and
 * the checker read one list.
 */
export const BRAND_VARIABLES = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-card',
  '--accent-gold',
  '--accent-gold-light',
  '--accent-blue',
  '--accent-green',
  '--accent-red',
  '--accent-purple',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border',
  '--border-accent',
  '--gradient-gold',
  '--shadow-hover',
];

// Class names that conflict with the shared report vocabulary. Each entry has
// a brand-vocabulary suggestion in the violation detail.
//
// Known V1 limitation — dynamic rename: during a revise turn, a model may
// rename an invented class
// rather than removing it (e.g. `.evolution-pill` → `.evo-badge`,
// `.ev-product` → `.evo-product`). This list covers both the original and
// renamed forms; a future structural heuristic should count `.foo {` selectors
// in the agent's inline <style>
// blocks > N → REVISE) so we don't have to enumerate every rename the agent
// invents.
const BANNED_CLASSES: Array<{ pattern: string; suggestion: string }> = [
  // Original SaaS-card patterns
  { pattern: 'rec-card', suggestion: 'use .action-card' },
  { pattern: 'recommendation-card', suggestion: 'use .action-card' },
  { pattern: 'profile-card', suggestion: 'use .stat-card or .benchmark-card' },
  { pattern: 'vendor-card', suggestion: 'use .benchmark-card' },
  { pattern: 'vendor-header', suggestion: 'use .benchmark-org + .benchmark-model' },
  { pattern: 'experiment-box', suggestion: 'use .callout-success or .insight-box' },
  // Hero / section-header reinventions
  { pattern: 'hero-badge', suggestion: 'use .section-label' },
  { pattern: 'hero-tag', suggestion: 'use .section-label' },
  { pattern: 'confidence-tag', suggestion: 'use .section-label or .tag' },
  { pattern: 'audience-tag', suggestion: 'use .section-label or .meta-item' },
  { pattern: 'admiralty', suggestion: 'use .tag (the brand has no .admiralty class)' },
  // Adopt/Trial/Assess/Hold pill variants
  { pattern: 'tag-adopt', suggestion: 'use .tag inside a colored .benchmark-card variant' },
  { pattern: 'tag-trial', suggestion: 'use .tag inside a colored .benchmark-card variant' },
  { pattern: 'tag-assess', suggestion: 'use .tag inside a colored .benchmark-card variant' },
  { pattern: 'tag-hold', suggestion: 'use .tag inside a colored .benchmark-card variant' },
  // Wardley evolution-stage pill variants — original + renamed forms
  { pattern: 'evolution-pill', suggestion: 'use .tag (one .tag per stage; do not invent stage-color classes)' },
  { pattern: 'evo-badge', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'ev-product', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'ev-custom', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'ev-early', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'ev-growth', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'evo-genesis', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'evo-custom', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'evo-product', suggestion: 'use .tag (do not invent stage-color classes)' },
  { pattern: 'evo-commodity', suggestion: 'use .tag (do not invent stage-color classes)' },
  // Brand-class name slip-ups (right idea, wrong name)
  { pattern: 'jtbd-card', suggestion: 'use .jtbd-block' },
  { pattern: 'stat-grid', suggestion: 'use .stats-grid (note the trailing s)' },
  { pattern: 'refs-list', suggestion: 'use .references-list inside .references-section' },
  { pattern: 'data-table', suggestion: 'use .compare-table' },
];

// Class names defined by `public/css/report-brand.css`. Used to report shared
// vocabulary uptake without turning class count into a quality gate.
export const BRAND_CLASS_NAMES: ReadonlySet<string> = new Set([
  // Header
  'report-header',
  'report-hero',
  'header-label',
  'report-title',
  'report-subtitle',
  'header-meta',
  'meta-item',
  // Layout
  'container',
  'section',
  'section-nav',
  'nav-item',
  'section-number',
  'analytical-grid',
  'analytical-figure',
  // REPORT-014's narrow-frame floor bounds `.cover` (the band agents reach for
  // when a report opens with a title page), so an author styling it is styling
  // a class the platform stylesheet now owns.
  'cover',
  'section-label',
  'section-title',
  'section-intro',
  'section-divider',
  // Citations — `cite-link` is emitted by the cite-ieee contract AND stamped by
  // the REPORT-013 publication normalizer, so an author styling it is styling
  // platform output, not inventing a class.
  'cite',
  'cite-link',
  // Contents / navigation
  'toc',
  // Stats
  'stats-grid',
  'stat-card',
  'stat-number',
  'stat-label',
  'stat-source',
  // Insight
  'insight-box',
  'insight-source',
  // JTBD
  'jtbd-block',
  'jtbd-label',
  'jtbd-job',
  'jtbd-struggle',
  // Benchmark
  'benchmark-grid',
  'benchmark-card',
  'blue',
  'green',
  'purple',
  'benchmark-org',
  'benchmark-model',
  'benchmark-body',
  'benchmark-tags',
  'tag',
  // Figures — REPORT-014 publication stamps `report-figure-img` on every image
  // it embeds; `report-figure` is the composer's figure wrapper.
  'report-figure',
  'report-figure-img',
  // Wide-content scroller (REPORT-014 responsive floor)
  'table-scroll',
  // Charts
  'chart-container',
  'chart-title',
  'mermaid',
  'canvas-wrapper',
  'canvas-title',
  'canvas-subtitle',
  // Steps
  'steps-list',
  'step-item',
  'step-num',
  'step-content',
  // Compare table
  'compare-table',
  'bad',
  'good',
  'label-col',
  // Action plan
  'action-grid',
  'action-card',
  'action-phase',
  'action-title',
  'action-items',
  // Callouts
  'callout-warning',
  'callout-success',
  // References
  'references-section',
  'references-list',
  'ref-num',
  // Footer
  'report-footer',
  'footer-disclaimer',
  // Prose
  'prose',
]);

/**
 * Strip <style> blocks that belong to a provenance-verified Super-Graph SVG so
 * the platform renderer's own classes (.cluster, .edge-thickness-N, …) are not
 * charged to the author's CSS budget. The exemption is cryptographically bound
 * to unmodified renderer output: an unsigned <svg><style> or any post-render
 * edit fails `hasValidSuperGraphProvenance` and stays fully counted — so this is
 * NOT an arbitrary "skip nested SVG styles" bypass an author could exploit.
 */
function stripTrustedSuperGraphStyles(html: string): string {
  const markedSvgRe = new RegExp(
    `<svg\\b[^>]*${SUPER_GRAPH_PROVENANCE_ATTRIBUTE}=["'][a-f0-9]{64}["'][^>]*>[\\s\\S]*?<\\/svg>`,
    'gi'
  );
  return html.replace(markedSvgRe, (svg) => {
    if (!hasValidSuperGraphProvenance(svg)) return svg;
    return svg.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  });
}

/**
 * Extract the contents of every inline <style>...</style> block. Used so the
 * variable-shadowing and palette checks operate on agent-emitted CSS only —
 * not on whatever lives inside a linked stylesheet.
 */
/**
 * Style blocks the PLATFORM emits into a stored report, matched on the exact
 * opening tag each writer produces.
 *
 * REPORT-015. `applyPageTheme` appends `<style data-design-pass="page-theme">`
 * after the author's markup and the composer prepends
 * `<style data-composer="v1">`; both declare the canonical brand variables on
 * purpose, because that block is what decides the rendered palette. Scoring
 * stored bytes must not charge the platform's own `:root` to the model; the
 * `no-variable-shadowing` finding disappears once the server block is excluded.
 *
 * The publish path used to slice its own suffix off by string `endsWith`, which
 * protected exactly that one call site — the L1 soft check, the quality rubric
 * and any operator probe all read stored bytes and saw the platform's CSS as
 * authored. The exemption belongs here, structurally, like the SVG-internal one.
 *
 * Keyed on the EXACT opening tag: a hand-written `<style data-design-pass="…"
 * data-author="…">` is still counted, so this is not a "any style mentioning
 * the marker" bypass. An author who reproduces the platform's tag byte-for-byte
 * can hide CSS from the CLASS BUDGET — a quality signal — but not from the
 * contrast check, which is deliberately evaluated over the complete themed
 * document and is what actually withholds an artifact.
 */
const PLATFORM_STYLE_BLOCK_RE =
  /<style data-design-pass="page-theme">[\s\S]*?<\/style>|<style data-composer="v1">[\s\S]*?<\/style>/gi;

function extractInlineStyles(html: string): string {
  const out: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  // Drop ALL svg-internal content before collecting agent CSS.
  // Chart renderers (super-graph, mermaid) emit their own <style> blocks inside
  // the <svg>; the byte-exact provenance exemption below never fired in practice
  // because LLM re-typing can destroy the hash, which would charge renderer
  // classes to the agent's class budget.
  // SVG-internal styles are presentational renderer output, not authored page
  // CSS — exempt them structurally. stripTrustedSuperGraphStyles stays for the
  // (now rare) signed case and for backward compatibility.
  const withoutSvg = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  // REPORT-015: platform-owned blocks before anything else — see
  // PLATFORM_STYLE_BLOCK_RE.
  const withoutPlatform = withoutSvg.replace(PLATFORM_STYLE_BLOCK_RE, '');
  const authoredHtml = stripTrustedSuperGraphStyles(withoutPlatform);
  let m: RegExpExecArray | null;
  while ((m = re.exec(authoredHtml)) !== null) {
    out.push(m[1]);
  }
  return out.join('\n');
}

/**
 * Extract the head section so we can scope the stylesheet-link check to it.
 * Falls back to the whole document if no <head> is found (the brand link
 * elsewhere still counts — better forgiving than fragile).
 */
function extractHead(html: string): string {
  const m = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return m ? m[1] : html;
}

/**
 * Check 1 — the brand stylesheet must be linked from the document head.
 */
function checkStylesheetLinked(html: string): BrandComplianceViolation | null {
  const head = extractHead(html);
  const linked = /<link[^>]+href\s*=\s*["'][^"']*\/css\/report-brand\.css["'][^>]*>/i.test(head);
  if (linked) return null;
  return {
    check: 'brand-stylesheet-linked',
    detail:
      'missing `<link rel="stylesheet" href="/css/report-brand.css" />` in <head>. PROFILE.md "Visual Design System" requires this as the first <link> after <title> + viewport meta.',
  };
}

/**
 * Check 2 — agent <style> blocks must not redeclare brand variables. Brand
 * tokens are owned by `public/css/report-brand.css`. Agents may add new
 * page-specific variables but may not shadow `--bg-*`, `--accent-*`,
 * `--text-*`, `--border`, `--gradient-gold`, etc.
 */
function checkVariableShadowing(html: string): BrandComplianceViolation | null {
  const inline = extractInlineStyles(html);
  if (!inline) return null;
  const shadowed: string[] = [];
  for (const v of BRAND_VARIABLES) {
    // A redeclaration looks like `--bg-primary: #foo` (LHS in a declaration).
    // The variable name appears as `var(--bg-primary)` for usage, which is
    // fine — only LHS-of-colon assignments are violations.
    const re = new RegExp(`(^|[\\s;{])${v.replace('--', '--')}\\s*:`, 'm');
    if (re.test(inline)) shadowed.push(v);
  }
  if (shadowed.length === 0) return null;
  return {
    check: 'no-variable-shadowing',
    detail: `agent <style> redeclares brand variable(s): ${shadowed.join(', ')}. Brand tokens are owned by report-brand.css; remove the local declarations.`,
  };
}

/**
 * Check 3 — every `<sup>` element that wraps a `[N]`-shaped citation must
 * carry `class="cite"` (or include "cite" as one of its classes).
 */
function checkCitationsUseCiteClass(html: string): BrandComplianceViolation | null {
  const re = /<sup\b([^>]*)>([\s\S]*?)<\/sup>/gi;
  const offenders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2].trim();
    const looksLikeCitation = /^\[\s*\d+(?:\s*[,;-]\s*\d+)*\s*\]$/.test(inner);
    if (!looksLikeCitation) continue;
    const classMatch = /class\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const classes = classMatch ? classMatch[1].split(/\s+/) : [];
    if (!classes.includes('cite')) {
      // Truncate inner to keep the detail short.
      const sample = inner.length > 24 ? inner.slice(0, 24) + '…' : inner;
      offenders.push(`<sup>${sample}</sup>`);
    }
  }
  if (offenders.length === 0) return null;
  // Cap at 3 examples so the detail string stays readable.
  const examples = offenders.slice(0, 3).join(', ');
  const more = offenders.length > 3 ? ` (+${offenders.length - 3} more)` : '';
  return {
    check: 'citations-use-cite-class',
    detail: `${offenders.length} citation <sup> element(s) missing class="cite": ${examples}${more}. PROFILE.md mandates <sup class="cite">[N]</sup>.`,
  };
}

/**
 * Check 4 — agent must not reinvent class names the brand already covers.
 * The list in BANNED_CLASSES is exhaustive for the patterns observed in the
 * May 6–8 audit. Each match emits both the offending class and the brand
 * vocabulary the agent should have used instead.
 */
function checkNoBannedClasses(html: string): BrandComplianceViolation | null {
  const offenders: Array<{ banned: string; suggestion: string }> = [];
  for (const { pattern, suggestion } of BANNED_CLASSES) {
    // Match the class name as a whole token inside a class="..." attribute.
    // Avoid matching substrings like "data-table" inside an unrelated word.
    const re = new RegExp(`class\\s*=\\s*["'][^"']*\\b${pattern}\\b[^"']*["']`, 'i');
    if (re.test(html)) offenders.push({ banned: pattern, suggestion });
  }
  if (offenders.length === 0) return null;
  // De-duplicate by banned name (an agent can use the same banned class many
  // times; one fix lands all uses).
  const lines = offenders.map((o) => `  - .${o.banned} → ${o.suggestion}`);
  return {
    check: 'no-banned-class-patterns',
    detail: `${offenders.length} banned class name(s) in HTML — these reinvent brand vocabulary:\n${lines.join('\n')}`,
  };
}

/** Shared-vocabulary uptake is telemetry only; it is not a quality gate. */
export function measureBrandUptake(html: string): {
  brandClassesUsed: number;
  inventedClassesUsed: number;
  share: number;
} {
  const applied = new Set<string>();
  for (const match of html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) {
    for (const name of match[1].split(/\s+/).filter(Boolean)) applied.add(name);
  }
  const brandClassesUsed = [...applied].filter((name) => BRAND_CLASS_NAMES.has(name)).length;
  const inventedClassesUsed = applied.size - brandClassesUsed;
  return {
    brandClassesUsed,
    inventedClassesUsed,
    share: applied.size === 0 ? 0 : brandClassesUsed / applied.size,
  };
}

/**
 * Run the brand checks against an HTML report. Returns a verdict the L1 soft
 * check can stamp into mission.qualityReport.checks.
 *
 * The function does NOT short-circuit on the first failure — agents
 * benefit from seeing the full violation list in one revise turn rather than
 * walking the gate five times.
 */
export function analyzeCreatorBrand(
  html: string,
  brief?: import('@/lib/schemas/design-brief').DesignBrief
): BrandComplianceVerdict {
  // PROFILE.md §0 precedence: an EXPLICIT user directive for a
  // non-dark theme wins over the brand default. Enforcing the DARK brand
  // stylesheet on a user-light mission creates a contradiction the agent can
  // only resolve by inventing a stylesheet. For user-themed missions we skip the dark-brand link check
  // and the dark-palette chart advisory; typography/citation/class checks still
  // apply. Auto briefs and user-chosen brand-dark keep the full check set.
  const userTheme = brief?.source === 'user' && brief.theme !== 'brand-dark';
  const violations: BrandComplianceViolation[] = [];
  const c1 = userTheme ? null : checkStylesheetLinked(html);
  if (c1) violations.push(c1);
  const c2 = checkVariableShadowing(html);
  if (c2) violations.push(c2);
  const c3 = checkCitationsUseCiteClass(html);
  if (c3) violations.push(c3);
  const c4 = checkNoBannedClasses(html);
  if (c4) violations.push(c4);
  // Advisory (non-blocking) chart palette-conformance — only when a DesignBrief
  // is bound (existing brief-less missions are unaffected → no regression).
  // Skipped for user themes (T1.3): the user's palette is authoritative there.
  const advisories: BrandComplianceViolation[] = [];
  if (brief && !userTheme) {
    const allowed = [
      brief.palette.bg,
      brief.palette.surface,
      brief.palette.ink,
      brief.palette.accent,
      ...brief.palette.sequence,
    ];
    const off = findOffPaletteFills(html, allowed);
    if (off.length > 0) {
      advisories.push({
        check: 'chart-palette-conformance',
        severity: 'advise',
        detail: `Chart SVG uses ${off.length} off-palette fill color(s): ${off.slice(0, 6).join(', ')}. Charts should use the design-brief palette — re-render via super-graph renderDiagram (it applies the brief theme).`,
      });
    }
  }
  const advisoryTail = advisories.length > 0 ? { advisories } : {};

  if (violations.length === 0) {
    return { ok: true, htmlLength: html.length, ...advisoryTail };
  }
  return { ok: false, violations, htmlLength: html.length, ...advisoryTail };
}
