/**
 * @file lib/reports/publication-contract.ts
 * @description REPORT-013 — the single vocabulary describing what a published
 * report may contain.
 *
 * Two historical regressions came from the same shape: an agent-facing
 * instruction mandated output that the publication gate rejects, and nothing
 * compared the two. The creator profile mandated remote `<img src="https://…">`
 * infographics while UX-021 rejected off-origin resources (2026-06-07 →
 * 2026-07-20, resolved by deleting the mandate, so in-report images went to
 * zero); `cite-ieee` mandated `<a href="https://…">source</a>` references that
 * the same rule rejects, so reports shipped without reachable sources.
 *
 * Runtime code, instruction documents, and the conformance test all read the
 * constants and probes below, so "what may be published" cannot fork into three
 * different opinions again.
 */

/**
 * Attribute a legacy-mode report uses to reference a generated image.
 *
 * The value is an id minted by this mission's own image cache — never a URL. An
 * agent therefore cannot introduce an arbitrary remote image: publication
 * resolves the id through the mission cache and the owner-scoped `inlineImage`
 * boundary, and anything it cannot resolve becomes visible truthful text.
 */
export const REPORT_IMAGE_ID_ATTRIBUTE = 'data-image-id';

/**
 * Embedded images allowed per report. Shared by the legacy bridge and the
 * composer's `image-ref` bound so one number governs the stored-document budget.
 */
export const MAX_EMBEDDED_REPORT_IMAGES = 2;

/**
 * Class applied to every image publication embeds (REPORT-014).
 *
 * `report-brand.css` bounds it to the column width, mirroring the composer's
 * `.report-figure img` contract. Named here beside the other publication
 * constants so the embedder and the stylesheet drift test read one value.
 */
export const REPORT_FIGURE_IMAGE_CLASS = 'report-figure-img';

/** Prefix of the reference-target ids that reference integrity validates. */
export const REFERENCE_TARGET_PREFIX = 'ref-';

/**
 * Render a source URL as plain text that survives publication.
 *
 * Sources stay UNLINKED in RC.2 — the gate rejects off-origin `href` and the
 * sandboxed viewer strips anchors — but the reader still needs the complete,
 * copyable URL. One hazard blocks the naive approach: the gate's
 * external-resource rule matches `url=https://` and `url(https://` anywhere in
 * the stored bytes, so a legitimate source carrying a `?url=` redirect
 * parameter would make an otherwise-clean report unpublishable.
 *
 * Escaping `=` and `(` as numeric character references keeps the rendered text
 * byte-identical for a reader who copies it, while the stored markup can no
 * longer be mistaken for an attribute reference. HTML specials are escaped
 * first so the entities introduced here are not double-escaped.
 */
export function escapeUrlTextForPublication(url: string): string {
  return url
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/=/g, '&#61;')
    .replace(/\(/g, '&#40;');
}

/**
 * Decode the entity forms an author may already have written, so re-escaping is
 * idempotent rather than producing `&amp;amp;`.
 */
export function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#0*61;/gi, '=')
    .replace(/&#0*40;/gi, '(')
    .replace(/&amp;/gi, '&');
}

/** `<span class="ref-source">…</span>`, in any attribute order, with any class list. */
const REF_SOURCE_SPAN_RE =
  /(<span\b[^>]*\bclass\s*=\s*(?:"[^"]*\bref-source\b[^"]*"|'[^']*\bref-source\b[^']*')[^>]*>)([\s\S]*?)(<\/span>)/gi;

/**
 * Apply {@link escapeUrlTextForPublication} to source URLs an AGENT wrote.
 *
 * The composer calls the escape itself when it renders a reference, so composed
 * reports were already safe. The legacy path emits author-written markup, and a
 * perfectly legitimate source — a news or proxy link carrying a `?url=https://…`
 * parameter — matches the publication gate's `external-resource` rule and makes
 * the whole report unpublishable. Measured: the raw form is REFUSED, the escaped
 * form publishes, so the two authoring paths did not behave the same.
 *
 * Scope is deliberately narrow. Only the inside of a `ref-source` span is
 * touched — the one element the `cite-ieee` contract defines as plain source
 * text — so CSS `url(https://…)` and real attributes are untouched and the gate
 * keeps its full strength everywhere else. Nested markup inside that span is
 * flattened to text, which is the intended reading of the contract and strips
 * exactly the off-origin anchors publication rejects anyway.
 */
export function normalizeSourceUrlText(html: string): string {
  if (!html) return html;
  return html.replace(
    REF_SOURCE_SPAN_RE,
    (_match, open: string, inner: string, close: string) =>
      `${open}${escapeUrlTextForPublication(decodeBasicHtmlEntities(inner))}${close}`
  );
}

/**
 * A construct an agent-facing instruction must never MANDATE, because the
 * publication gate rejects it.
 */
export interface PublicationContractProbe {
  /** Stable id, used in failure messages and waivers. */
  id: string;
  /** Human summary of the forbidden construct. */
  description: string;
  /** Matches the construct inside example markup in an instruction document. */
  pattern: RegExp;
  /** What the instruction must teach instead. */
  compliantForm: string;
  /** The publication rule that rejects it. */
  rejectedBy: string;
}

/**
 * The two constructs whose mandate/gate contradictions actually shipped. Each
 * probe matches EXAMPLE MARKUP, not prose: an instruction may (and should) name
 * a construct in order to forbid it.
 */
export const PUBLICATION_CONTRACT_PROBES: readonly PublicationContractProbe[] = [
  {
    id: 'remote-image-src',
    description: 'an <img> whose src points off-origin',
    pattern: /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i,
    compliantForm: `<img ${REPORT_IMAGE_ID_ATTRIBUTE}="img-…" alt="…"> — publication resolves the id into a bounded data: URI`,
    rejectedBy:
      "publication-policy 'external-resource' rejects off-origin src; the viewer CSP allows img-src data: blob: only",
  },
  {
    id: 'off-origin-anchor',
    description: 'an <a> whose href points off-origin',
    pattern: /<a\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i,
    compliantForm: 'print the full URL as plain text; keep anchors to same-document #fragment targets',
    rejectedBy:
      "publication-policy 'external-resource' rejects off-origin href; the viewer strips every non-fragment href and the report frame is sandboxed",
  },
] as const;

/**
 * Markers that make a line a PROHIBITION rather than a mandate. An instruction
 * that tells an agent never to emit a construct necessarily shows it.
 */
const PROHIBITION_MARKERS: readonly RegExp[] = [
  /\bnever\b/i,
  /\bnot\b/i,
  /\bno\b\s+(?:remote|off-origin|external)/i,
  /\bforbidden\b/i,
  /\breject(?:s|ed|ion)?\b/i,
  /\bavoid\b/i,
  /\binstead of\b/i,
  /\bwrong\b/i,
  /\bbad\b/i,
  /\banti-pattern\b/i,
  /\bstrip(?:s|ped)?\b/i,
  /\bremoved?\b/i,
  /\bblocked?\b/i,
  /\bfails?\b/i,
];

/** True when a line shows a construct in order to forbid it. */
export function isProhibitionContext(line: string): boolean {
  return PROHIBITION_MARKERS.some((marker) => marker.test(line));
}

export interface ContractConformanceFinding {
  probeId: string;
  /** 1-based line number within the scanned document. */
  line: number;
  /** The offending line, trimmed and bounded for a readable failure message. */
  sample: string;
  compliantForm: string;
  rejectedBy: string;
}

/**
 * Scan an agent-facing instruction document for example markup that mandates
 * output the publication gate rejects.
 *
 * Prohibition lines are exempt: "never use remote <img src="https://…">" is the
 * instruction working correctly. Only an unqualified example counts as a
 * mandate.
 */
export function findContractConformanceViolations(source: string): ContractConformanceFinding[] {
  const findings: ContractConformanceFinding[] = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (isProhibitionContext(line)) continue;
    for (const probe of PUBLICATION_CONTRACT_PROBES) {
      if (!probe.pattern.test(line)) continue;
      findings.push({
        probeId: probe.id,
        line: index + 1,
        sample: line.trim().slice(0, 160),
        compliantForm: probe.compliantForm,
        rejectedBy: probe.rejectedBy,
      });
    }
  }
  return findings;
}

/** Format findings as an operator-readable failure message. */
export function formatContractConformanceFindings(
  label: string,
  findings: readonly ContractConformanceFinding[]
): string {
  return [
    `${label} mandates report output the publication gate rejects:`,
    ...findings.map(
      (f) =>
        `  • line ${f.line} [${f.probeId}] "${f.sample}"\n      rejected by: ${f.rejectedBy}\n      teach instead: ${f.compliantForm}`
    ),
  ].join('\n');
}
