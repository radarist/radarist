/**
 * @file reports/build-download-html.ts
 * @description Prepares a stored `report.html` value for download as a
 * self-contained `.html` file that opens with the same styling as the
 * in-app iframe preview.
 *
 * Why this exists: every Creator-agent report links the brand stylesheet
 * via `<link rel="stylesheet" href="/css/report-brand.css" />`. That
 * relative path resolves to the app origin when the report renders
 * inside `<iframe src="/reports/[id]">`, but it resolves to
 * `file:///css/report-brand.css` (404) when the user opens the downloaded
 * file from their disk — so the dark hero, Playfair Display headings,
 * gold accents, and editorial layout all silently disappear. Inline
 * styles on individual elements (metric cards, table headers) survive,
 * which made the regression easy to miss on first inspection.
 *
 * The same DOMParser-based transform used by preview, print, and public sharing
 * removes executable/network capabilities, inserts the deny-by-default child
 * CSP, inlines trusted brand CSS, and emits a complete static document.
 */
import { buildStaticReportHtml, buildStaticReportHtmlFromDocument } from './static-report-html';

export interface BuildDownloadHtmlOptions {
  /**
   * Contents of `public/css/report-brand.css`. When supplied, the helper
   * replaces the brand `<link>` tag with an inline `<style>` block so
   * the downloaded file renders self-contained. Optional so the helper
   * still works when the browser cannot fetch the stylesheet.
   */
  brandCss?: string | null;
}

/**
 * Returns a self-contained, static HTML document for download. Full documents
 * and fragments take the same parser-normalized path; the caller-supplied title
 * replaces any stored title through the DOM API.
 */
export function buildDownloadHtml(html: string, title: string, options: BuildDownloadHtmlOptions = {}): string {
  return buildStaticReportHtml(html, { brandCss: options.brandCss, title });
}

/** Same product export transform for server callers using a JSDOM document. */
export function buildDownloadHtmlFromDocument(
  document: Document,
  title: string,
  options: BuildDownloadHtmlOptions = {}
): string {
  return buildStaticReportHtmlFromDocument(document, { brandCss: options.brandCss, title });
}
