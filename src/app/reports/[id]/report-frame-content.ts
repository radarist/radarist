import { buildStaticReportHtml } from '@/lib/reports/static-report-html';

export interface ReportFrameContentOptions {
  brandCss?: string | null;
}

export type ReportPreviewContentOptions = ReportFrameContentOptions;

/**
 * Builds the report preview as static HTML. Arbitrary report JavaScript cannot
 * be made zero-egress in a browser sandbox because it may navigate its own
 * frame, so executable content is removed before the document enters an
 * opaque-origin sandbox. Inline SVG, static CSS, fragment anchors, and native
 * disclosure controls remain available.
 */
export function buildReportPreviewHtml(html: string, options: ReportPreviewContentOptions): string {
  return buildStaticReportHtml(html, options);
}

/**
 * Builds the separate printable document. It is deliberately static because
 * its iframe must be same-origin for the parent to invoke `print()`.
 */
export function buildReportPrintHtml(
  html: string,
  title: string,
  options: ReportFrameContentOptions = {}
): string {
  return buildStaticReportHtml(html, { ...options, title });
}
