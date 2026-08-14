/**
 * @file lib/html-sanitizer.ts
 * @description Shared HTML sanitizer for XSS prevention.
 *
 * Used by:
 * - Share report page (app/share/report/[id]/page.tsx)
 * - Report generation MCP tool (publishReport)
 *
 * Removes:
 * - <script>...</script> tags (including content)
 * - on* event handler attributes (onclick, onerror, onload, etc.)
 * - javascript: protocol URLs
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * @param html - Raw HTML string to sanitize
 * @returns Sanitized HTML string safe for rendering
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return (
    html
      // Remove <script> tags and their content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove on* event handler attributes (double-quoted)
      .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '')
      // Remove on* event handler attributes (single-quoted)
      .replace(/\s+on\w+\s*=\s*'[^']*'/gi, '')
      // Remove on* event handler attributes (unquoted)
      .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')
      // Remove javascript: protocol URLs
      .replace(/javascript\s*:/gi, 'blocked:')
  );
}

/**
 * Apply the storage/read-boundary normalization used for active report HTML.
 *
 * Preserves <script> tags and event handlers for interactive reports
 * (navigation, filters, hover states, SVG interactivity).
 * Only removes javascript: protocol URLs as a minimal safety net.
 *
 * IMPORTANT: this is not an XSS security boundary. Renderers must either strip
 * executable content or contain it in an opaque-origin sandbox with a
 * restrictive child CSP. Report HTML can come from authenticated users as well
 * as model output.
 */
export function sanitizeReportHtml(html: string): string {
  if (!html) return '';
  return (
    html
      // Remove javascript: protocol URLs (minimal safety)
      .replace(/javascript\s*:/gi, 'blocked:')
  );
}
