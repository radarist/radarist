/**
 * @file lib/reports/reference-anchors.ts
 * @description REPORT-013 — publication-time repair that makes an emitted IEEE
 * reference list structurally usable.
 *
 * Writers can emit a well-formed reference list carrying complete source URLs
 * without the `id="ref-N"` targets and `href="#ref-N"` citations that make it
 * navigable. `cite-ieee` teaches the anchored form; this module provides a
 * narrow fallback when the writer does not follow it.
 *
 * This module is that fallback, and it is deliberately narrow:
 *   - it is a REPAIR, never a source of content — it links markers to entries
 *     the author already wrote, and invents neither;
 *   - it is fragment-only. `#ref-N` is the one navigable form that survives both
 *     the publication gate and the sandboxed viewer, so no off-origin authority,
 *     `target`, or popup capability is introduced;
 *   - a marker with no matching entry stays INERT. Linking `[11]` in a report
 *     with nine sources would convert a visible sourcing problem into a
 *     publication REFUSAL, so the existing `creator-citations-resolve` check
 *     keeps reporting it instead;
 *   - it is idempotent, so a re-publish cannot double-wrap or duplicate a target.
 *
 * It also extends the existing source-URL escape to the class real agent output
 * uses. `normalizeSourceUrlText` only ever matched `ref-source`, the class the
 * composer and the skill template use; generated reports can write
 * `ref-url`, so the escape that stops a legitimate `?url=https://…` source from
 * refusing the whole report had never fired on a real report.
 */
import { decodeBasicHtmlEntities, escapeUrlTextForPublication } from '@/lib/reports/publication-contract';

/** Class names that mark an ordered list as the references list. */
export const REFERENCE_LIST_CLASS_PATTERN = /^(?:ref|reference|references)-list$/;

/** Source-text spans whose contents are a URL printed for the reader to copy. */
const SOURCE_SPAN_CLASSES = ['ref-source', 'ref-url'] as const;

/** Regions whose text must never be rewritten. */
const PROTECTED_BLOCK_RE = /<(script|style|pre|code|textarea)\b[\s\S]*?<\/\1>/gi;

/** `<ol …class="…ref-list…"…> … </ol>`, non-greedy to the first closing tag. */
const REFERENCE_LIST_RE = /<ol\b([^>]*)>([\s\S]*?)<\/ol>/gi;

/** `<li …>` opening tags inside a reference list. */
const LIST_ITEM_RE = /<li\b([^>]*)>/gi;

/** A bracketed citation marker: `[3]`, `[2, 5]`, `[1,2,3]`. */
const MARKER_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/** An author `<sup …>[N]</sup>` that is not already wrapped in an anchor. */
const SUP_MARKER_RE = /<sup\b([^>]*)>\s*(\[\d{1,3}(?:\s*,\s*\d{1,3})*\])\s*<\/sup>/gi;

function classListOf(attributes: string): string[] {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  const raw = match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
  return raw.split(/\s+/).filter(Boolean);
}

function hasIdAttribute(attributes: string): boolean {
  return /\bid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(attributes);
}

/**
 * Replace the contents of every source-URL span with the publication-safe
 * escape. Nested markup is flattened to text, which is the intended reading of
 * the `cite-ieee` contract and strips exactly the off-origin anchors publication
 * rejects anyway.
 */
function normalizeSourceSpans(html: string): string {
  let out = html;
  for (const cls of SOURCE_SPAN_CLASSES) {
    const re = new RegExp(
      `(<span\\b[^>]*\\bclass\\s*=\\s*(?:"[^"]*\\b${cls}\\b[^"]*"|'[^']*\\b${cls}\\b[^']*')[^>]*>)([\\s\\S]*?)(<\\/span>)`,
      'gi'
    );
    out = out.replace(
      re,
      (_match, open: string, inner: string, close: string) =>
        `${open}${escapeUrlTextForPublication(decodeBasicHtmlEntities(inner.replace(/<[^>]+>/g, '')))}${close}`
    );
  }
  return out;
}

/**
 * Stamp `id="ref-N"` on each entry of the references list, 1-based in document
 * order, and report how many targets exist. An entry that already carries an id
 * is left alone — the author's numbering wins, and re-stamping it would be the
 * duplicate-target defect the integrity gate exists to catch.
 */
function stampReferenceTargets(html: string): { html: string; targets: Set<number> } {
  const targets = new Set<number>();
  let touchedAny = false;

  REFERENCE_LIST_RE.lastIndex = 0;
  const out = html.replace(REFERENCE_LIST_RE, (whole, attributes: string, body: string) => {
    const classes = classListOf(attributes);
    if (!classes.some((c) => REFERENCE_LIST_CLASS_PATTERN.test(c))) return whole;

    touchedAny = true;
    let index = 0;
    LIST_ITEM_RE.lastIndex = 0;
    const stampedBody = body.replace(LIST_ITEM_RE, (itemTag, itemAttributes: string) => {
      index += 1;
      targets.add(index);
      if (hasIdAttribute(itemAttributes)) return itemTag;
      return `<li id="ref-${index}"${itemAttributes}>`;
    });
    return `<ol${attributes}>${stampedBody}</ol>`;
  });

  return { html: touchedAny ? out : html, targets };
}

/** Split `html` into segments, marking the ones whose text must not be rewritten. */
function segmentByProtectedRegions(
  html: string,
  extraProtected: Array<{ start: number; end: number }>
): Array<{ text: string; protectedRegion: boolean }> {
  const regions: Array<{ start: number; end: number }> = [...extraProtected];
  PROTECTED_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROTECTED_BLOCK_RE.exec(html)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  regions.sort((a, b) => a.start - b.start);

  const segments: Array<{ text: string; protectedRegion: boolean }> = [];
  let cursor = 0;
  for (const region of regions) {
    if (region.start < cursor) {
      cursor = Math.max(cursor, region.end);
      continue;
    }
    if (region.start > cursor) segments.push({ text: html.slice(cursor, region.start), protectedRegion: false });
    segments.push({ text: html.slice(region.start, region.end), protectedRegion: true });
    cursor = region.end;
  }
  if (cursor < html.length) segments.push({ text: html.slice(cursor), protectedRegion: false });
  return segments;
}

/** Locate every references list so its own `[N]` numbering is never re-cited. */
function referenceListRegions(html: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  REFERENCE_LIST_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_LIST_RE.exec(html)) !== null) {
    if (classListOf(match[1]).some((c) => REFERENCE_LIST_CLASS_PATTERN.test(c))) {
      regions.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return regions;
}

/** An anchor that already cites a reference, contents included. */
const CITE_ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']#ref-[\w.-]+["'][^>]*>[\s\S]*?<\/a>/gi;

/**
 * Locate citations that already exist, so a second pass cannot wrap a marker
 * twice. This is what makes the transform idempotent: without it, an author who
 * followed `cite-ieee` correctly — or simply a re-publish — had the `[N]` inside
 * their own anchor rewritten into a nested anchor.
 */
function existingCitationRegions(html: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  CITE_ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_ANCHOR_RE.exec(html)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  return regions;
}

/** Rewrite only the text outside protected regions. */
function rewriteUnprotected(html: string, transform: (text: string) => string): string {
  return segmentByProtectedRegions(html, [...referenceListRegions(html), ...existingCitationRegions(html)])
    .map((segment) => (segment.protectedRegion ? segment.text : transform(segment.text)))
    .join('');
}

const CITE_ANCHOR_OPEN = '<a class="cite-link" href=';

function anchorFor(numbers: number[], marker: string): string {
  // A grouped marker (`[2, 5]`) links its FIRST number and keeps the rendered
  // text intact; splitting the group would change what the reader sees. The
  // remaining numbers are linked as their own trailing anchors so every cited
  // source is still reachable, without altering the visible bracket.
  const [first, ...rest] = numbers;
  const head = `${CITE_ANCHOR_OPEN}"#ref-${first}"><sup class="cite">${marker}</sup></a>`;
  const tail = rest
    .map((n) => `${CITE_ANCHOR_OPEN}"#ref-${n}"><sup class="cite" aria-hidden="true"></sup></a>`)
    .join('');
  return `${head}${tail}`;
}

/**
 * Rewrite resolvable citation markers in ordinary body text into same-document
 * anchors. Text inside HTML TAGS is skipped, so an attribute value containing
 * `[1]` can never be corrupted.
 */
function anchorMarkersInText(text: string, targets: Set<number>): string {
  // Alternate between tags and text; only text nodes are rewritten.
  return text.replace(/(<[^>]*>)|([^<]+)/g, (_whole, tag: string | undefined, chunk: string | undefined) => {
    if (tag !== undefined) return tag;
    const body = chunk ?? '';
    MARKER_RE.lastIndex = 0;
    return body.replace(MARKER_RE, (marker, group: string) => {
      const numbers = group
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n) && targets.has(n));
      if (numbers.length === 0) return marker;
      return anchorFor(numbers, marker);
    });
  });
}

/**
 * Wrap an author `<sup class="cite">[N]</sup>` that is not already inside an
 * anchor. Handled before bare markers so the `<sup>` is not double-wrapped.
 */
function anchorAuthorSups(text: string, targets: Set<number>): string {
  return text.replace(SUP_MARKER_RE, (whole, attributes: string, marker: string) => {
    const numbers = marker
      .slice(1, -1)
      .split(',')
      .map((n) => Number.parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n) && targets.has(n));
    if (numbers.length === 0) return whole;
    const supAttributes = attributes.trim() ? attributes : ' class="cite"';
    const [first, ...rest] = numbers;
    const head = `${CITE_ANCHOR_OPEN}"#ref-${first}"><sup${supAttributes}>${marker}</sup></a>`;
    const tail = rest
      .map((n) => `${CITE_ANCHOR_OPEN}"#ref-${n}"><sup class="cite" aria-hidden="true"></sup></a>`)
      .join('');
    return `${head}${tail}`;
  });
}

/**
 * Make an author-written reference list navigable, and its source URLs
 * publishable, without adding any capability the report did not already have.
 *
 * Returns the input unchanged when the document carries no recognizable
 * references list — there is nothing to link to, and inventing a target would be
 * fabricating provenance.
 */
export function normalizeReferenceAnchors(html: string): string {
  if (!html) return html;

  const withSources = normalizeSourceSpans(html);
  const { html: stamped, targets } = stampReferenceTargets(withSources);
  if (targets.size === 0) return stamped;

  // Two passes, each re-deriving the protected regions. The `<sup>` pass creates
  // NEW citation anchors, so the bare-marker pass must see them as protected —
  // otherwise it rewrites the marker it just wrapped.
  const withSups = rewriteUnprotected(stamped, (text) => anchorAuthorSups(text, targets));
  return rewriteUnprotected(withSups, (text) => anchorMarkersInText(text, targets));
}
