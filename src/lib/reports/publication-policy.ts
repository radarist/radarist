/**
 * @file lib/reports/publication-policy.ts
 * @description UX-021 — publication-time gate that keeps executable report HTML
 * out of storage.
 *
 * The report RENDER boundary (`src/app/reports/[id]/report-frame-content.ts`)
 * is the hard security guarantee: it parser-normalizes report HTML into an
 * opaque-origin, deny-by-default-CSP, scriptless frame at view time (SEC-003 /
 * SEC-004). Executable content therefore renders BLANK, not dangerous.
 *
 * This module is the complementary AUTHORING gate. Rather than let an agent or
 * user store a report whose charts/filters will silently render blank, it
 * rejects executable HTML at publication with an actionable static-conversion
 * error — pointing the author at the inline-SVG / declarative path the creator
 * profile already mandates (`agent/agents/creator/PROFILE.md`: "the report has
 * no mermaid/JS runtime, so those render BLANK/broken. Only the inline <svg>
 * from renderDiagram renders").
 *
 * It is a pure, dependency-free string scan so it is safe on every server write
 * path (createReport / upsertReportBySlot / updateReport) without pulling a DOM
 * into the request. It is deliberately conservative: a construct that CAN
 * execute or egress is rejected even if a given instance is inert, because the
 * fix (inline the asset, use a declarative widget) is always available and the
 * false-positive cost is a clear error, never silent breakage.
 *
 * `staticizeReportHtml` is the migration counterpart: it removes exactly the
 * constructs this gate rejects, producing publishable static HTML that preserves
 * inline SVG/CSS, embedded data:/blob: images, fragment anchors, and native
 * disclosure. It shares the pattern table below so detection and removal cannot
 * fork.
 */

export type ReportViolationKind =
  | 'script'
  | 'event-handler'
  | 'javascript-url'
  | 'mermaid'
  | 'chartjs'
  | 'canvas'
  | 'active-embed'
  | 'external-resource'
  | 'meta-refresh';

export interface ReportPublicationViolation {
  kind: ReportViolationKind;
  /** A short, human-readable sample of what matched (first occurrence, trimmed). */
  sample: string;
  /** How to convert this construct to trusted static output. */
  fix: string;
}

interface ViolationRule {
  kind: ReportViolationKind;
  /** Global, case-insensitive detector. Run against comment-stripped HTML. */
  pattern: RegExp;
  fix: string;
  /** Removal transform for staticization. Defaults to deleting the match. */
  strip?: (html: string) => string;
}

/**
 * Ordered rule table. Detection and staticization both derive from it, so the
 * publication gate and the migration converter can never disagree about what
 * "executable" means.
 */
const RULES: ViolationRule[] = [
  {
    kind: 'script',
    // Opening <script ...> — inline or sourced, incl. mermaid/chart bootstraps.
    pattern: /<script\b[^>]*>/gi,
    fix: 'Remove <script>. Charts must be embedded as inline <svg> (super-graph renderDiagram) or a static <img> (PNG/data URI); there is no JS runtime in a report.',
    // Delete whole <script>…</script> blocks (and any dangling open tag).
    strip: (html) =>
      html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<script\b[^>]*>/gi, ''),
  },
  {
    kind: 'event-handler',
    // Inline DOM handlers: on<event>= . {3,} after "on" avoids matching stray
    // attributes like `once=`; every real handler is on+3+ letters (onclick…).
    // The leading class also matches a quote/slash so `href="x"onclick=…`
    // (attribute after a closing quote, which browsers DO parse) is caught, and
    // the strip below preserves that delimiter so detection and removal agree.
    pattern: /[\s"'`/]on[a-z]{3,}\s*=/gi,
    fix: 'Remove inline event handlers (onclick, onload, …). Use static markup or native controls such as <details>/<summary>.',
    strip: (html) =>
      html
        .replace(/([\s"'`/])on[a-z]{3,}\s*=\s*"[^"]*"/gi, '$1')
        .replace(/([\s"'`/])on[a-z]{3,}\s*=\s*'[^']*'/gi, '$1')
        .replace(/([\s"'`/])on[a-z]{3,}\s*=\s*[^\s>]+/gi, '$1'),
  },
  {
    kind: 'javascript-url',
    pattern: /javascript\s*:/gi,
    fix: 'Remove javascript: URLs. Use fragment (#) links or plain text.',
    strip: (html) => html.replace(/javascript\s*:/gi, 'blocked:'),
  },
  {
    kind: 'mermaid',
    // A .mermaid container needs the mermaid runtime to render — blank without it.
    // (`mermaid.<call>` signatures live in <script> and are removed by that rule.)
    pattern: /\bclass\s*=\s*["'][^"']*\bmermaid\b[^"']*["']/gi,
    fix: 'Replace .mermaid blocks with the inline <svg> returned by super-graph renderDiagram.',
    // Drop only the `mermaid` token from the class list so the container is no
    // longer a runtime target; surrounding classes/content are preserved.
    strip: (html) => html.replace(/(\bclass\s*=\s*["'][^"']*?)\bmermaid\b\s?([^"']*["'])/gi, '$1$2'),
  },
  {
    kind: 'chartjs',
    // Code signatures only (not the bare string "Chart.js", which appears in
    // prose). These live in <script>/handlers and are removed by those rules;
    // the neutralizing strip guarantees the invariant even out of that context.
    pattern: /\bnew\s+Chart\s*\(|\bChart\s*\.\s*register\b/g,
    fix: 'Replace Chart.js with an inline <svg> chart (super-graph renderDiagram) or a static image.',
    strip: (html) => html.replace(/\bnew\s+Chart\s*\(/g, '(/* chart removed */').replace(/\bChart\s*\.\s*register\b/g, 'Chart_register'),
  },
  {
    kind: 'canvas',
    // A <canvas> only draws via script; in a scriptless report it is a dead box.
    pattern: /<canvas\b[^>]*>/gi,
    fix: 'Remove <canvas> — it renders blank without script. Use inline <svg> or a static image instead.',
    strip: (html) => html.replace(/<canvas\b[^<]*(?:(?!<\/canvas>)<[^<]*)*<\/canvas>/gi, '').replace(/<canvas\b[^>]*>/gi, ''),
  },
  {
    kind: 'active-embed',
    // External document embeds / base tag — navigation & egress surfaces.
    pattern: /<(?:iframe|object|embed|frame|base)\b[^>]*>/gi,
    fix: 'Remove <iframe>/<object>/<embed>/<frame>/<base>. Embed content as inline SVG or a static image.',
    strip: (html) =>
      html
        .replace(/<(iframe|object|embed)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '')
        .replace(/<(?:iframe|object|embed|frame|base)\b[^>]*>/gi, ''),
  },
  {
    kind: 'meta-refresh',
    pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi,
    fix: 'Remove <meta http-equiv="refresh"> — reports must not auto-navigate.',
    strip: (html) => html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, ''),
  },
  {
    kind: 'external-resource',
    // A resource/nav attribute pointing off-origin (http:, https:, or
    // protocol-relative //). data:, blob:, #fragment, and relative URLs are
    // allowed — only network egress is rejected.
    pattern: /\b(?:src|href|srcset|poster|data|action|formaction|ping|@import\s+url|url)\s*(?:=|\()\s*["'(]?\s*(?:https?:)?\/\//gi,
    fix: 'Inline external resources: embed images as data: URIs and CSS in a <style> block. Reports must not fetch off-origin.',
    strip: (html) => stripExternalResources(html),
  },
];

/** Strip HTML comments so commented-out code is not scanned or matched. */
function stripComments(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const opening = html.indexOf('<!--', cursor);
    if (opening < 0) {
      chunks.push(html.slice(cursor));
      break;
    }
    const closing = html.indexOf('-->', opening + '<!--'.length);
    if (closing < 0) {
      chunks.push(html.slice(cursor));
      break;
    }
    chunks.push(html.slice(cursor, opening));
    cursor = closing + '-->'.length;
  }

  return chunks.join('');
}

/**
 * Neutralize off-origin resource references: drop the offending attribute or
 * rewrite the CSS url()/@import to an empty reference, mirroring the render
 * boundary's `removeCssNetworkCapabilities`.
 */
function stripExternalResources(html: string): string {
  return html
    .replace(/\s(?:src|href|srcset|poster|data|action|formaction|ping)\s*=\s*"(?:https?:)?\/\/[^"]*"/gi, '')
    .replace(/\s(?:src|href|srcset|poster|data|action|formaction|ping)\s*=\s*'(?:https?:)?\/\/[^']*'/gi, '')
    .replace(/@import\s+url\s*\(\s*["']?\s*(?:https?:)?\/\/[^)]*\)\s*;?/gi, '')
    .replace(/@import\s+["'](?:https?:)?\/\/[^"']*["']\s*;?/gi, '')
    .replace(/url\s*\(\s*["']?\s*(?:https?:)?\/\/[^)]*\)/gi, 'url("")');
}

/**
 * Scan report HTML for constructs that cannot be trusted in a static report.
 * Returns one violation per matched kind (first sample each); an empty array
 * means the HTML is publishable.
 */
export function detectExecutableReportContent(html: string): ReportPublicationViolation[] {
  if (!html) return [];
  const scanned = stripComments(html);
  const violations: ReportPublicationViolation[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(scanned);
    if (match) {
      violations.push({
        kind: rule.kind,
        sample: match[0].replace(/\s+/g, ' ').trim().slice(0, 80),
        fix: rule.fix,
      });
    }
  }
  return violations;
}

/** Thrown by `assertPublishableReportHtml` when executable content is present. */
export class ReportPublicationError extends Error {
  constructor(public readonly violations: ReportPublicationViolation[]) {
    super(formatViolationMessage(violations));
    this.name = 'ReportPublicationError';
  }
}

function formatViolationMessage(violations: ReportPublicationViolation[]): string {
  const lines = violations.map((v) => `  • ${v.kind} (found "${v.sample}") — ${v.fix}`);
  return [
    'Report cannot be published: it contains executable or off-origin content that renders blank in the static report viewer.',
    ...lines,
    'Convert to trusted static output (inline <svg>, data: images, native <details> controls) and republish.',
  ].join('\n');
}

/**
 * Publication chokepoint. Throws `ReportPublicationError` with an actionable
 * message if `html` contains executable/off-origin content; otherwise returns.
 */
export function assertPublishableReportHtml(html: string): void {
  const violations = detectExecutableReportContent(html);
  if (violations.length > 0) throw new ReportPublicationError(violations);
}

/**
 * Convert legacy executable report HTML into publishable static HTML by removing
 * exactly what {@link assertPublishableReportHtml} rejects. Preserves inline
 * SVG/CSS, embedded data:/blob: images, fragment anchors, and native disclosure.
 *
 * Idempotent: static HTML passes through unchanged, and the output always
 * satisfies `assertPublishableReportHtml` (verified in tests). This is a
 * storage-side hardening pass; the render boundary remains the hard guarantee.
 */
export function staticizeReportHtml(html: string): string {
  if (!html) return html;
  let out = stripComments(html);
  for (const rule of RULES) {
    if (rule.strip) out = rule.strip(out);
  }
  return out;
}
