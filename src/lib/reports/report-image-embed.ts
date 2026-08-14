/**
 * @file lib/reports/report-image-embed.ts
 * @description REPORT-013 — bounded image embedding for the SHIPPED legacy
 * report path.
 *
 * In-report images ran at roughly 26/month through spring 2026 and fell to zero
 * in July: UX-021 began rejecting off-origin `src`, the viewer began stripping
 * remote `<img>`, and REPORT-011 resolved the resulting contradiction by
 * deleting the embed mandate. The compliant bridge that replaced it — mint an
 * `imageId`, resolve it to a bounded `data:` URI — was built only inside the
 * default-off composer branch, so the release path lost images entirely.
 *
 * This module is that bridge for the legacy path, and it deliberately narrows
 * what an agent can ask for:
 *   - the draft references an image by ID ONLY (`data-image-id`), never a URL,
 *     so an agent cannot point publication at an arbitrary host;
 *   - the id must exist in THIS mission's image cache, which only the platform's
 *     own image tool writes;
 *   - the bytes still pass through the owner-scoped, redirect-rejecting,
 *     size-bounded `inlineImage` boundary — this module adds no new trust;
 *   - an image that cannot be resolved becomes visible, truthful text. A report
 *     may never keep an `<img>` that claims a visual it does not have.
 */
import {
  decodeBasicHtmlEntities,
  MAX_EMBEDDED_REPORT_IMAGES,
  REPORT_FIGURE_IMAGE_CLASS,
  REPORT_IMAGE_ID_ATTRIBUTE,
} from '@/lib/reports/publication-contract';

export interface ReportImageEmbedDeps {
  /** Resolve a mission-minted image id to its source URL, or null if unknown. */
  resolveImageUrl: (imageId: string) => Promise<string | null>;
  /** Owner-scoped bounded inliner (`@/lib/reports/image-inline`). */
  inlineImage: (url: string, maxBytes?: number) => Promise<{ dataUri: string; bytes: number } | null>;
  /** Per-image output budget; the boundary's own default applies when omitted. */
  maxBytesPerImage?: number;
  /** Overrides the shared cap only for tests that assert the bound itself. */
  maxImages?: number;
}

export interface ReportImageEmbedFailure {
  imageId: string;
  reason: string;
}

export interface ReportImageEmbedResult {
  html: string;
  /** Images successfully embedded as bounded data: URIs. */
  embedded: number;
  /** Images that could not be embedded and were replaced with truthful text. */
  failures: ReportImageEmbedFailure[];
  /** Total bytes of embedded image data. */
  bytes: number;
}

/** `<img …>` tags carrying the image-id attribute, in any attribute order. */
const IMAGE_PLACEHOLDER_RE = new RegExp(
  `<img\\b[^>]*\\b${REPORT_IMAGE_ID_ATTRIBUTE}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*>`,
  'gi'
);
/** Ids are minted by the platform; anything else is refused before any lookup. */
const IMAGE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

function attributeValue(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Decode the entity forms an author may already have written, so a hostile alt
 * cannot round-trip back into live markup once re-escaped. Shared with the
 * source-URL normalizer via the publication contract.
 */
const decodeBasicEntities = decodeBasicHtmlEntities;

/** Visible, truthful stand-in for an image the report does not actually have. */
function unavailableNotice(alt: string | null): string {
  const label = alt ? `: ${escapeHtml(decodeBasicEntities(alt))}` : '';
  return `<p class="figure-unavailable"><em>[Figure unavailable — the generated visual could not be embedded${label}]</em></p>`;
}

/**
 * Replace every image-id placeholder with a bounded `data:` image, or with a
 * truthful notice when it cannot be resolved.
 *
 * Rejects (throws) a draft that references more images than the shared cap
 * allows, mirroring the composer's `image-ref` bound so both paths keep the same
 * stored-document budget.
 */
export async function resolveReportImageEmbeds(
  html: string,
  deps: ReportImageEmbedDeps
): Promise<ReportImageEmbedResult> {
  const maxImages = deps.maxImages ?? MAX_EMBEDDED_REPORT_IMAGES;
  if (!html || !html.includes(REPORT_IMAGE_ID_ATTRIBUTE)) {
    return { html, embedded: 0, failures: [], bytes: 0 };
  }

  IMAGE_PLACEHOLDER_RE.lastIndex = 0;
  const placeholders = [...html.matchAll(IMAGE_PLACEHOLDER_RE)];
  if (placeholders.length > maxImages) {
    throw new Error(
      `report references ${placeholders.length} embedded images (max ${maxImages} per report — the stored document has a bounded byte budget)`
    );
  }

  const failures: ReportImageEmbedFailure[] = [];
  const replacements: string[] = [];
  let embedded = 0;
  let bytes = 0;

  for (const match of placeholders) {
    const tag = match[0];
    const rawId = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    const alt = attributeValue(tag, 'alt');

    if (!IMAGE_ID_RE.test(rawId)) {
      failures.push({ imageId: rawId || '(missing)', reason: 'malformed image id' });
      replacements.push(unavailableNotice(alt));
      continue;
    }

    try {
      const url = await deps.resolveImageUrl(rawId);
      if (!url) {
        failures.push({ imageId: rawId, reason: 'no generated image is registered under this id for this mission' });
        replacements.push(unavailableNotice(alt));
        continue;
      }
      const inlined = await deps.inlineImage(url, deps.maxBytesPerImage);
      if (!inlined) {
        failures.push({ imageId: rawId, reason: 'image could not be inlined within the byte budget' });
        replacements.push(unavailableNotice(alt));
        continue;
      }
      const altAttribute = ` alt="${escapeHtml(decodeBasicEntities(alt ?? ''))}"`;
      // REPORT-014: emit the bounded responsive element, not a bare <img>. The
      // previous markup forwarded ONLY `alt`, so a generated image arrived with
      // no width constraint from any source — the legacy stylesheet defines no
      // image rule, and the composer's `.report-figure img { max-width:100% }`
      // floor is composer-path-only. A 1200px infographic then pushed the whole
      // document wider than the viewport.
      //
      // The class is platform-owned rather than forwarded from the draft: an
      // an author class may carry no styling, and forwarding
      // arbitrary attributes would widen what a draft can inject.
      replacements.push(`<img class="${REPORT_FIGURE_IMAGE_CLASS}" src="${inlined.dataUri}"${altAttribute}>`);
      embedded += 1;
      bytes += inlined.bytes;
    } catch (error) {
      failures.push({ imageId: rawId, reason: error instanceof Error ? error.message : String(error) });
      replacements.push(unavailableNotice(alt));
    }
  }

  // Rebuild in one pass so a data: URI (which can contain `$&`-like sequences)
  // is never interpreted as a replacement pattern.
  let cursor = 0;
  const out: string[] = [];
  placeholders.forEach((match, index) => {
    const start = match.index ?? 0;
    out.push(html.slice(cursor, start), replacements[index] ?? '');
    cursor = start + match[0].length;
  });
  out.push(html.slice(cursor));

  return { html: out.join(''), embedded, failures, bytes };
}
