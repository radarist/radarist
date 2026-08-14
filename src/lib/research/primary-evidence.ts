/**
 * @file research/primary-evidence.ts
 * @description AI-038 — the evidence gate between a finished deep-research
 * report and the Document Library.
 *
 * Generated research can contain an unbounded raw title, unresolved grounding
 * redirects, no reliable primary identifiers, and unsupported claims. Such a
 * document must not be indistinguishable from well-sourced research.
 *
 * This module is pure and deterministic: markdown in, verdict out. No network,
 * no provider calls, no clock. That is what makes it testable without spend and
 * safe to recompute on an Inngest replay.
 *
 * It does not decide policy — it reports what the evidence IS. The caller
 * decides what to do (see `run-document-deep-research.ts`, which retains the
 * report and prepends the review section so the caveat travels into every
 * chunk, citation and reader).
 */

import { canonicalHttpUrl, isUnresolvedGoogleGroundingRedirect } from '@/lib/signals/source-identity';

// ---------------------------------------------------------------------------
// Quotas + bounds
// ---------------------------------------------------------------------------

/** Distinct primary-source domains a report needs before it reads as well-sourced. */
export const MIN_DISTINCT_PRIMARY_SOURCES = 2;

/** Longest title a generated document may carry. Longer queries are truncated for display only. */
export const MAX_RESEARCH_TITLE_LENGTH = 120;

/** Most unsupported identifiers named in the verdict — keeps persisted metadata bounded. */
export const MAX_REPORTED_UNSUPPORTED_CLAIMS = 10;

/** Most example domains recorded per class — keeps persisted metadata bounded. */
export const MAX_REPORTED_DOMAINS = 10;

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

/**
 * What a cited URL is, for evidence purposes.
 *
 * - `primary` — the artifact itself: a patent, a paper of record, a filing, a
 *   standard, an official government or standards-body publication.
 * - `secondary` — a resolvable third party writing ABOUT the artifact.
 * - `search-redirect` — an opaque search/grounding redirect. Two of these may
 *   alias the same article or different ones, so they can never be counted as
 *   evidence at all.
 * - `unusable` — not an absolute http(s) URL, or carries credentials.
 */
export type ResearchSourceClass = 'primary' | 'secondary' | 'search-redirect' | 'unusable';

/** Hosts (matched on the registrable tail) that publish primary artifacts. */
const PRIMARY_SOURCE_HOSTS: readonly string[] = [
  // Patents
  'patents.google.com',
  'patentscope.wipo.int',
  'worldwide.espacenet.com',
  'register.epo.org',
  'uspto.gov',
  'ppubs.uspto.gov',
  'patentsview.org',
  'epo.org',
  'j-platpat.inpit.go.jp',
  // Papers of record + preprint servers
  'doi.org',
  'dx.doi.org',
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'chemrxiv.org',
  'ssrn.com',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'openreview.net',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'link.springer.com',
  'nature.com',
  'science.org',
  'sciencedirect.com',
  'onlinelibrary.wiley.com',
  'aclanthology.org',
  'proceedings.mlr.press',
  // Filings + regulators
  'sec.gov',
  'eur-lex.europa.eu',
  'europa.eu',
  'federalregister.gov',
  // Standards
  'nist.gov',
  'ietf.org',
  'rfc-editor.org',
  'iso.org',
  'itu.int',
  'w3.org',
  'etsi.org',
];

/** Suffixes that identify an official publisher without an explicit host entry. */
const PRIMARY_SOURCE_HOST_SUFFIXES: readonly string[] = ['.gov', '.gov.uk', '.mil', '.int'];

/** Hosts whose job is to bounce a click somewhere else — never evidence. */
const SEARCH_REDIRECT_HOSTS: readonly string[] = [
  'vertexaisearch.cloud.google.com',
  'www.google.com',
  'google.com',
  'duckduckgo.com',
  'r.jina.ai',
  'news.google.com',
  'bing.com',
  'www.bing.com',
];

function hostMatches(hostname: string, candidate: string): boolean {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

/**
 * Classify one cited URL.
 *
 * A Google grounding redirect is detected through the shared
 * `isUnresolvedGoogleGroundingRedirect` helper so this module and the signal
 * evidence contract agree on what "unresolved redirect" means.
 */
export function classifyResearchSource(rawUrl: string): ResearchSourceClass {
  const canonical = canonicalHttpUrl(rawUrl);
  if (!canonical) return 'unusable';
  if (isUnresolvedGoogleGroundingRedirect(canonical)) return 'search-redirect';

  let hostname: string;
  let pathname: string;
  let search: string;
  try {
    const parsed = new URL(canonical.displayUrl);
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    return 'unusable';
  }

  // A search engine's own result/redirect page is a click, not a document.
  if (SEARCH_REDIRECT_HOSTS.some((host) => hostMatches(hostname, host.replace(/^www\./, '')))) {
    const isBareSearchOrRedirect = pathname === '/' || /^\/(url|search|imgres)$/.test(pathname) || search.length > 0;
    if (isBareSearchOrRedirect) return 'search-redirect';
  }

  if (PRIMARY_SOURCE_HOSTS.some((host) => hostMatches(hostname, host.replace(/^www\./, '')))) return 'primary';
  if (PRIMARY_SOURCE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return 'primary';

  return 'secondary';
}

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

export interface ResearchCitation {
  /** The URL exactly as it appeared in the report. */
  url: string;
  /** Link text when the URL came from a markdown link; empty for a bare URL. */
  label: string;
  sourceClass: ResearchSourceClass;
  /** Registrable host, lowercased and `www.`-stripped. Empty when unusable. */
  domain: string;
}

const INLINE_LINK_PATTERN = /\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION_PATTERN = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]+>|\S+)/gm;
const AUTOLINK_PATTERN = /<((?:https?:\/\/)[^>\s]+)>/g;
const BARE_URL_PATTERN = /(?<![("<\]])\bhttps?:\/\/[^\s<>()[\]"']+/g;

function unwrapUrl(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  // Markdown prose commonly ends a sentence right after a bare URL.
  return unwrapped.replace(/[.,;:]+$/, '');
}

function domainOf(url: string): string {
  const canonical = canonicalHttpUrl(url);
  if (!canonical) return '';
  try {
    return new URL(canonical.displayUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Pull every cited URL out of a markdown report — inline links, reference
 * definitions, autolinks, and bare URLs — de-duplicated on canonical identity.
 *
 * Deliberately generous: the gate must see everything the report offers as
 * evidence, so an under-count can never make a weak report look strong.
 */
export function extractResearchCitations(markdown: string): ResearchCitation[] {
  const byIdentity = new Map<string, ResearchCitation>();

  const add = (rawUrl: string, label: string): void => {
    const url = unwrapUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) return;
    const canonical = canonicalHttpUrl(url);
    // Keep unusable URLs — a malformed citation is still a claim of evidence.
    const identity = canonical ? canonical.identity : url.toLowerCase();
    const existing = byIdentity.get(identity);
    if (existing) {
      if (!existing.label && label) existing.label = label.trim();
      return;
    }
    byIdentity.set(identity, {
      url,
      label: label.trim(),
      sourceClass: classifyResearchSource(url),
      domain: domainOf(url),
    });
  };

  for (const match of markdown.matchAll(INLINE_LINK_PATTERN)) add(match[2], match[1]);
  for (const match of markdown.matchAll(REFERENCE_DEFINITION_PATTERN)) add(match[2], match[1]);
  for (const match of markdown.matchAll(AUTOLINK_PATTERN)) add(match[1], '');
  for (const match of markdown.matchAll(BARE_URL_PATTERN)) add(match[0], '');

  return [...byIdentity.values()];
}

// ---------------------------------------------------------------------------
// Identifier-claim extraction
// ---------------------------------------------------------------------------

export type IdentifierKind = 'patent' | 'doi' | 'arxiv' | 'cve';

export interface IdentifierClaim {
  kind: IdentifierKind;
  /** The identifier as written in the report. */
  value: string;
  /** Comparison form: lowercased, punctuation and separators stripped. */
  normalized: string;
}

/**
 * Patent publication numbers: 2-letter country, digits, optional kind code.
 * Requires >= 6 digits — real publication numbers are 7+, and a lower floor
 * starts matching ordinary prose ("IN 12345 cases") as unsourced claims.
 */
const PATENT_PATTERN = /\b([A-Z]{2})[ -]?(\d{6,})[ -]?([A-Z]\d?)?\b/g;
const WO_PATENT_PATTERN = /\bWO[ -]?(\d{4})[/ -](\d{5,6})\b/g;
const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/g;
const ARXIV_PATTERN = /\barXiv[:\s]\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/gi;
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,}\b/gi;

/** Two-letter prefixes that are patent authorities, not stray capitals. */
const PATENT_AUTHORITIES = new Set([
  'US',
  'EP',
  'WO',
  'CN',
  'JP',
  'KR',
  'DE',
  'GB',
  'FR',
  'CA',
  'AU',
  'IN',
  'RU',
  'BR',
  'TW',
]);

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[\s\-_/.:]/g, '');
}

/**
 * Extract identifier-shaped claims from the report body.
 *
 * These are the claims a reader is most likely to act on and least able to
 * sanity-check by eye — "US11234567B2 covers lattice-based key exchange" reads
 * as verifiable precisely because it names a record. If no citation carries that
 * identifier, the report asserted a record it never sourced.
 */
export function extractIdentifierClaims(markdown: string): IdentifierClaim[] {
  const byNormalized = new Map<string, IdentifierClaim>();

  const add = (kind: IdentifierKind, value: string, normalizedOverride?: string): void => {
    const normalized = normalizedOverride ?? normalizeIdentifier(value);
    if (!normalized || byNormalized.has(normalized)) return;
    byNormalized.set(normalized, { kind, value, normalized });
  };

  for (const match of markdown.matchAll(WO_PATENT_PATTERN)) add('patent', match[0]);
  for (const match of markdown.matchAll(PATENT_PATTERN)) {
    if (!PATENT_AUTHORITIES.has(match[1])) continue;
    add('patent', match[0]);
  }
  for (const match of markdown.matchAll(DOI_PATTERN)) add('doi', match[0]);
  // arXiv matches on the numeric core: a canonical URL is `arxiv.org/abs/2401.12345`,
  // where the `arxiv` prefix is separated from the id by path segments, so
  // comparing the full `arXiv:2401.12345` form would never match its own URL.
  for (const match of markdown.matchAll(ARXIV_PATTERN)) {
    add('arxiv', `arXiv:${match[1]}`, normalizeIdentifier(match[1]));
  }
  for (const match of markdown.matchAll(CVE_PATTERN)) add('cve', match[0]);

  return [...byNormalized.values()];
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * - `sufficient` — resolvable citations, enough distinct primary sources, and
 *   every identifier claim traceable to one of them.
 * - `limited` — sourced and internally consistent, but thin on primary
 *   evidence. Usable with the caveat stated.
 * - `insufficient` — a hard failure: nothing citable, nothing resolvable, or
 *   identifiers asserted without any supporting source.
 */
export type ResearchEvidenceVerdict = 'sufficient' | 'limited' | 'insufficient';

export type ResearchEvidenceFindingCode =
  'no-citations' | 'no-resolvable-citations' | 'unsupported-identifier-claims' | 'below-primary-quota';

export interface ResearchEvidenceFinding {
  code: ResearchEvidenceFindingCode;
  /** One plain sentence a reader can act on. */
  detail: string;
}

export interface ResearchEvidenceReport {
  verdict: ResearchEvidenceVerdict;
  totalCitations: number;
  primaryCitations: number;
  secondaryCitations: number;
  /** Citations that are opaque search/grounding redirects — never counted as evidence. */
  searchRedirectCitations: number;
  unusableCitations: number;
  distinctPrimaryDomains: number;
  /** Bounded sample of primary domains, for the persisted summary. */
  primaryDomains: string[];
  identifierClaims: number;
  /** Bounded list of identifiers the report asserted but never cited. */
  unsupportedIdentifiers: string[];
  findings: ResearchEvidenceFinding[];
}

/**
 * An identifier is supported when it appears inside any citation's URL or link
 * text. A report that writes "US11234567B2" and links
 * `patents.google.com/patent/US11234567B2` has sourced it; one that only writes
 * the number has not.
 */
function isIdentifierSupported(claim: IdentifierClaim, citations: readonly ResearchCitation[]): boolean {
  return citations.some(
    (citation) =>
      normalizeIdentifier(citation.url).includes(claim.normalized) ||
      (citation.label.length > 0 && normalizeIdentifier(citation.label).includes(claim.normalized))
  );
}

/**
 * Evaluate a finished research report against the evidence quotas.
 *
 * Pure: same markdown always yields the same report. Never throws — an
 * unparseable body is simply a report with no citations, which is itself the
 * honest finding.
 */
export function evaluateResearchEvidence(markdown: string): ResearchEvidenceReport {
  const body = typeof markdown === 'string' ? markdown : '';
  const citations = extractResearchCitations(body);
  const claims = extractIdentifierClaims(body);

  const primary = citations.filter((citation) => citation.sourceClass === 'primary');
  const secondary = citations.filter((citation) => citation.sourceClass === 'secondary');
  const redirects = citations.filter((citation) => citation.sourceClass === 'search-redirect');
  const unusable = citations.filter((citation) => citation.sourceClass === 'unusable');

  const primaryDomains = [...new Set(primary.map((citation) => citation.domain).filter(Boolean))];
  const unsupported = claims.filter((claim) => !isIdentifierSupported(claim, citations));

  const findings: ResearchEvidenceFinding[] = [];

  if (citations.length === 0) {
    findings.push({
      code: 'no-citations',
      detail: 'The report cites no sources at all.',
    });
  } else if (primary.length + secondary.length === 0) {
    findings.push({
      code: 'no-resolvable-citations',
      detail: `All ${citations.length} citation(s) are opaque search-redirect or unusable URLs, so not one names a publisher that can be checked.`,
    });
  }

  if (unsupported.length > 0) {
    findings.push({
      code: 'unsupported-identifier-claims',
      detail: `${unsupported.length} of ${claims.length} identifier(s) named in the text (${unsupported
        .slice(0, MAX_REPORTED_UNSUPPORTED_CLAIMS)
        .map((claim) => claim.value)
        .join(', ')}) appear in no citation.`,
    });
  }

  if (primaryDomains.length < MIN_DISTINCT_PRIMARY_SOURCES) {
    findings.push({
      code: 'below-primary-quota',
      detail: `${primaryDomains.length} distinct primary source(s) found; ${MIN_DISTINCT_PRIMARY_SOURCES} is the minimum for a well-sourced report (patents, papers of record, filings, standards, official publications).`,
    });
  }

  const hasHardFailure = findings.some((finding) => finding.code !== 'below-primary-quota');
  const verdict: ResearchEvidenceVerdict = hasHardFailure
    ? 'insufficient'
    : findings.length > 0
      ? 'limited'
      : 'sufficient';

  return {
    verdict,
    totalCitations: citations.length,
    primaryCitations: primary.length,
    secondaryCitations: secondary.length,
    searchRedirectCitations: redirects.length,
    unusableCitations: unusable.length,
    distinctPrimaryDomains: primaryDomains.length,
    primaryDomains: primaryDomains.slice(0, MAX_REPORTED_DOMAINS),
    identifierClaims: claims.length,
    unsupportedIdentifiers: unsupported.slice(0, MAX_REPORTED_UNSUPPORTED_CLAIMS).map((claim) => claim.value),
    findings,
  };
}

// ---------------------------------------------------------------------------
// Rendering + bounded metadata
// ---------------------------------------------------------------------------

const VERDICT_HEADLINE: Record<Exclude<ResearchEvidenceVerdict, 'sufficient'>, string> = {
  insufficient: 'Evidence review — insufficient primary evidence',
  limited: 'Evidence review — limited primary evidence',
};

/**
 * Render the review block prepended to a report that did not clear the gate.
 *
 * It goes into the stored markdown rather than sitting only on the Firestore
 * record so the caveat travels with the content — into every search chunk, every
 * citation, and every reader — instead of being visible on one library screen.
 *
 * Returns `''` for a `sufficient` report: a banner on everything is a banner
 * nobody reads.
 */
export function renderEvidenceReviewSection(report: ResearchEvidenceReport): string {
  if (report.verdict === 'sufficient') return '';

  const lines: string[] = [`> **${VERDICT_HEADLINE[report.verdict]}**`, '>'];
  for (const finding of report.findings) {
    lines.push(`> - ${finding.detail}`);
  }
  lines.push(
    '>',
    `> Citations: ${report.totalCitations} total — ${report.primaryCitations} primary, ${report.secondaryCitations} secondary, ${report.searchRedirectCitations} unresolved search redirects, ${report.unusableCitations} unusable.`
  );
  lines.push(
    '>',
    report.verdict === 'insufficient'
      ? '> Treat every claim below as UNVERIFIED. This report was generated automatically and did not meet the primary-evidence bar; confirm each fact against a named source before acting on it or citing it.'
      : '> Claims below are sourced but rest largely on secondary reporting. Confirm anything load-bearing against a primary source before acting on it.'
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Prepend the review section to the report body when one is warranted.
 * A `sufficient` report is returned unchanged.
 */
export function annotateResearchReport(markdown: string, report: ResearchEvidenceReport): string {
  const section = renderEvidenceReviewSection(report);
  return section ? `${section}\n${markdown}` : markdown;
}

/**
 * AI-038 — bound a generated document's title.
 *
 * A model may send a whole research brief as the query, so the raw query must
 * not become an unbounded display title.
 * The full query is never lost — it stays on the document's description — but
 * the title is a display field and must behave like one.
 */
export function boundResearchTitle(rawTitle: string, maxLength: number = MAX_RESEARCH_TITLE_LENGTH): string {
  const collapsed = rawTitle.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;

  // Prefer a clean word boundary so the truncation reads as a title, not a cut.
  const window = collapsed.slice(0, maxLength - 1);
  const lastSpace = window.lastIndexOf(' ');
  const head = (lastSpace > maxLength * 0.6 ? window.slice(0, lastSpace) : window).replace(/[\s,;:.-]+$/, '');
  return `${head}…`;
}
