import { resolveScreenCss } from '@/lib/mission-quality/analyzers/report-design-contrast';
import { detectExecutableReportContent } from './publication-policy';

export type ReportConformanceCheck =
  | 'authored-content'
  | 'self-containment'
  | 'image-materialization'
  | 'duplicate-theme-variables'
  | 'process-debris'
  | 'figure-placeholders';

export interface ReportConformanceViolation {
  check: ReportConformanceCheck;
  detail: string;
}

const PLACEHOLDER_RE =
  /(?:data-image-id\s*=|class\s*=\s*["'][^"']*figure-unavailable\b|\[\s*figure\s+unavailable\b|generated\s+visual\s+could\s+not\s+be\s+embedded|\{\{[^}]+\}\}|\[\[(?:figure|chart|image)[^\]]*\]\]|(?:figure|chart|image)\s+(?:placeholder|todo))/gi;

function visibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function conflictingRootVariables(html: string, trustProductStyles: boolean): string[] {
  // Only the server-side exact-export verifier enables this. Raw authored HTML
  // is checked first with product styles untrusted, so an author cannot spoof
  // these attributes to hide conflicting declarations.
  const checkedHtml = trustProductStyles
    ? html.replace(
        /<style\b[^>]*(?:data-source=["']report-brand\.css["']|data-design-pass=["']page-theme["']|data-composer=["']v1["'])[^>]*>[\s\S]*?<\/style>/gi,
        ''
      )
    : html;
  // COORD-021: a `:root` inside `@media print` deliberately redeclares the
  // screen variables with paper values — that is a media override, not two
  // conflicting authors fighting over one cascade, which is what this check
  // exists to catch. Compare screen-applicable declarations only, using the same
  // resolution the contrast analyzer applies for exactly the same reason.
  const values = new Map<string, Set<string>>();
  for (const root of resolveScreenCss(checkedHtml).matchAll(/:root\s*\{([^}]*)\}/gi)) {
    for (const declaration of root[1].matchAll(/(--[a-z][\w-]*)\s*:\s*([^;]+)/gi)) {
      const seen = values.get(declaration[1]) ?? new Set<string>();
      seen.add(declaration[2].replace(/\s+/g, ' ').trim().toLowerCase());
      values.set(declaration[1], seen);
    }
  }
  return [...values.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([name, seen]) => `${name}=[${[...seen].join(' | ')}]`);
}

/**
 * Publication-time checks that must be true before a report is persisted.
 *
 * The product export has a stricter browser-level capture gate; this boundary
 * prevents known-bad source bytes from reaching storage in the first place.
 */
export function inspectReportPublicationConformance(
  html: string,
  options: { trustProductStyles?: boolean } = {}
): ReportConformanceViolation[] {
  const violations: ReportConformanceViolation[] = [];
  const text = visibleText(html);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    violations.push({
      check: 'authored-content',
      detail: 'expected reader-visible authored content; found none',
    });
  }

  const executable = detectExecutableReportContent(html);
  const nonBrandLinks = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((link) => !/href\s*=\s*["']\/css\/report-brand\.css["']/i.test(link));
  if (executable.length > 0 || nonBrandLinks.length > 0) {
    violations.push({
      check: 'self-containment',
      detail: [
        ...executable.map((finding) => `${finding.kind}: ${finding.sample}`),
        ...nonBrandLinks.map((link) => `unmaterialized link: ${link.slice(0, 100)}`),
      ].join('; '),
    });
  }

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const nonMaterialized = images.filter((image) => !/\bsrc\s*=\s*["']data:image\/[a-z0-9.+-]+;base64,/i.test(image));
  if (nonMaterialized.length > 0) {
    violations.push({
      check: 'image-materialization',
      detail: `${nonMaterialized.length} image(s) lack an embedded data URI`,
    });
  }

  const placeholders = [...html.matchAll(PLACEHOLDER_RE)].map((match) => match[0].slice(0, 100));
  if (placeholders.length > 0) {
    violations.push({ check: 'figure-placeholders', detail: placeholders.join('; ') });
  }

  const conflicting = conflictingRootVariables(html, options.trustProductStyles === true);
  if (conflicting.length > 0) {
    violations.push({ check: 'duplicate-theme-variables', detail: conflicting.join('; ') });
  }

  const debris = text.match(/\b(?:Design review|QA review)\s*:\s*(?:PASS|FAIL|complete[d]?)\b/gi) ?? [];
  if (debris.length > 0) {
    violations.push({ check: 'process-debris', detail: debris.join('; ') });
  }
  return violations;
}

export class ReportPublicationConformanceError extends Error {
  constructor(public readonly violations: ReportConformanceViolation[]) {
    super(
      [
        'Report cannot be published because release-facing conformance checks failed.',
        ...violations.map((violation) => `  • ${violation.check}: ${violation.detail}`),
      ].join('\n')
    );
    this.name = 'ReportPublicationConformanceError';
  }
}

export function assertReportPublicationConformance(html: string, options: { trustProductStyles?: boolean } = {}): void {
  const violations = inspectReportPublicationConformance(html, options);
  if (violations.length > 0) throw new ReportPublicationConformanceError(violations);
}
