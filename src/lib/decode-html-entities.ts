/**
 * @file lib/decode-html-entities.ts
 * @description Tiny pure decoder for the handful of named HTML entities that
 * leak into plain-text fields (report titles, etc.) when a value is copied
 * out of HTML markup (e.g. a `<title>` tag) and stored verbatim instead of
 * as decoded text. Applied at BOTH boundaries of the reports data layer:
 * write-time (schemas/report.ts title transforms, upsertReportBySlot,
 * executeUpdateReport) so new titles are never stored encoded, and read-time
 * (normalizeReportDoc in reports.ts, plus the direct-Firestore-read AI
 * executors in report-tools.ts) to heal docs stored before the writer fix.
 * UI consumers must NOT decode again — that would double-decode.
 *
 * Trade-off (intentional): titles are plain text; entities are ALWAYS
 * decoded — a user deliberately titling a report with the literal string
 * "&amp;" gets "&" instead; intentional entity-literals are not preserved.
 *
 * Deliberately NOT a full HTML entity parser: only the 5 entities this
 * codebase's own escaping helpers ever produce (html-sanitizer.ts,
 * super-graph/templates/tech-radar.ts `esc`, research/patents.ts,
 * reports/build-download-html.ts `escapeHtml`) are handled —
 * `&amp;` `&lt;` `&gt;` `&quot;` `&#39;`. Decoding is single-pass (not
 * recursive), so a doubly-escaped value like `&amp;amp;` only unwraps one
 * level, matching the non-parser scope.
 *
 * Output is plain text only — NEVER pass the result to
 * `dangerouslySetInnerHTML`.
 */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39);/g;

/**
 * Decode the 5 common HTML entities in a plain-text string.
 *
 * @param value - Raw string, possibly containing HTML entities
 * @returns Decoded string, safe for text-node display (not for HTML injection)
 */
export function decodeHtmlEntities(value: string): string {
  if (!value) return value;
  return value.replace(ENTITY_PATTERN, (match) => ENTITY_MAP[match] ?? match);
}
