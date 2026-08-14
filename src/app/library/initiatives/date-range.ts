/**
 * Date formatting for the initiatives page (table + grid views).
 *
 * Extracted from page.tsx so the range logic is unit-testable without
 * rendering the page (P-B8) — App Router page files can't carry extra
 * named exports.
 */

export function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp));
}

/**
 * P-B8: compact single-line timeline — "Jan 1, 2026 – Dec 31, 2026" (en dash).
 * Falls back to a single date when only one bound is set (never a dangling
 * dash); '—' when both are missing.
 */
export function formatDateRange(start: number | undefined, end: number | undefined): string {
  if (!start && !end) return '—';
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end);
}
