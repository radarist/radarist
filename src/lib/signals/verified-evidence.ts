/**
 * @file signals/verified-evidence.ts
 * @description AI-032 — evidence identity and independence for `createVerifiedSignal`.
 *
 * `createVerifiedSignal` fed the RAW LENGTH of a model-supplied evidence array
 * straight into the corroboration term. Repeating one URL four times moved a
 * single-source signal from ~71 to ~85 on the trust scale — across the
 * `getTrustScoreTier` threshold that labels a signal "High confidence - suitable
 * for autopilot mode". Redirect aliases and model-authored summaries were
 * indistinguishable from independent publishers.
 *
 * This module derives the corroboration input from **source identity and
 * independence** instead of count:
 *
 *  - Every evidence URL is validated and canonicalized (shared implementation
 *    with the expansion evidence contract — see `source-identity.ts`). Nothing
 *    is fetched and no redirect is followed; validation is purely structural.
 *  - Alias forms of one article (`www.`, trailing slash, `utm_*`/click ids,
 *    http-vs-https) collapse to a single identity.
 *  - An unresolved Google grounding redirect has no knowable publisher, so two
 *    of them can never be counted as two independent sources.
 *  - Several articles from the SAME publisher count once — independence is
 *    measured in distinct publishers, not distinct URLs.
 *  - Evidence published by the signal's own publisher is first-party and
 *    contributes no corroboration, mirroring the expansion contract and the
 *    graph-side rule that first-party `entity_field` evidence is not
 *    independent corroboration.
 *  - Items with no resolvable URL are labelled `unverifiable` — this is where
 *    model-authored summaries land. They are retained for the audit trail but
 *    excluded from the independence tally.
 *
 * The frozen 40/70/85/95 corroboration tiers in `trust-score.ts` are deliberately
 * NOT touched — `confidence-calibration.ts` derives its graph-side
 * `corroborationNudge` from those same tiers. Only the input changes.
 *
 * @author Radarist Team
 * @created 2026-07-19
 */

import { canonicalHttpUrl, isUnresolvedGoogleGroundingRedirect } from './source-identity';

/**
 * How much corroboration weight an evidence item carries.
 *
 * - `independent` — a distinct publisher, different from the signal's own.
 * - `first_party` — published by the signal's own publisher. Real evidence, but
 *   it corroborates nothing: a vendor confirming its own announcement.
 * - `unverifiable` — no resolvable publisher (missing/invalid URL, credentialed
 *   URL, or an unresolved redirect alias). Model-authored summaries land here.
 */
export type VerifiedEvidenceProvenance = 'independent' | 'first_party' | 'unverifiable';

export interface VerifiedEvidenceItem {
  /** The caller's URL, unrewritten. Empty when no usable URL was supplied. */
  url: string;
  /** Bounded supporting snippet. */
  snippet: string;
  /** Registrable domain, or `null` when no publisher could be resolved. */
  publisher: string | null;
  provenance: VerifiedEvidenceProvenance;
  /** Why this item was not counted as independent corroboration. */
  reason?: string;
}

export interface NormalizedVerifiedEvidence {
  /** Retained evidence, deduplicated by canonical identity and bounded. */
  items: VerifiedEvidenceItem[];
  /** Distinct independent publishers — the corroboration input. */
  independentPublisherCount: number;
  independentPublishers: string[];
  /** Alias/replay items collapsed into an already-seen identity. */
  droppedDuplicateCount: number;
  unverifiableCount: number;
  firstPartyCount: number;
}

/** Maximum evidence items retained on a verified signal. */
export const MAX_VERIFIED_EVIDENCE_ITEMS = 25;

/** Maximum characters retained per evidence snippet. */
const MAX_SNIPPET_CHARS = 1_000;

/** IPv4 dotted-quad literal. */
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Multi-label public suffixes, under which the registrable name is the THIRD
 * label from the right.
 *
 * This is a bounded, deliberately-not-exhaustive subset of the Public Suffix
 * List. Getting it wrong is safe in one direction only: a missing suffix
 * collapses distinct publishers into one, which UNDER-counts independence and
 * can only lower trust. An over-broad entry would do the opposite, so entries
 * are limited to well-known registry suffixes.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'net.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'ac.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'go.jp',
  'ac.jp',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'co.za',
  'org.za',
  'net.za',
  'gov.za',
  'ac.za',
  'com.mx',
  'org.mx',
  'gob.mx',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'ac.in',
  'co.kr',
  'or.kr',
  'go.kr',
  'co.il',
  'org.il',
  'ac.il',
  'com.sg',
  'com.hk',
  'com.tw',
  'com.tr',
  'com.ar',
  'com.co',
  'com.pe',
  'com.pl',
  'com.ua',
  'com.es',
]);

/** Reduce a normalized hostname to its registrable domain, or `null`. */
function registrableDomain(hostname: string): string | null {
  const labels = hostname.split('.');
  // An empty label means a doubled or leading dot — not a real host.
  if (labels.some((label) => label.length === 0)) return null;
  if (labels.length < 2) return null;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    // `co.za` alone names a registry, not a publisher.
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  }
  return lastTwo;
}

/**
 * Resolve the publisher (registrable domain) of a validated URL, or `null` when
 * the host cannot name one.
 *
 * A "publisher" must be a public DNS name, so these are all rejected:
 *
 * - **IP literals.** A last-two-labels split turns `1.1.1.1` and `2.2.2.2` into
 *   `1.1` and `2.2`, which would count as two independent sources.
 * - **Trailing dots.** `vendor.com.` is the same host as `vendor.com`, but split
 *   naively yields `com.`, and `vendor.com..` yields `.` — three aliases of one
 *   article scoring as three publishers, defeating the whole contract.
 * - **Dotless hosts** (`localhost`, intranet names) and **bare public suffixes**.
 *
 * Nothing is resolved or fetched; this is a purely syntactic check.
 */
function publisherOf(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  // IPv6 literals arrive bracketed from the URL parser.
  if (hostname.startsWith('[') || hostname.includes(':')) return null;
  // A fully-qualified name may carry trailing dots; they are not extra labels.
  hostname = hostname.replace(/\.+$/, '');
  if (IPV4_LITERAL.test(hostname)) return null;

  return registrableDomain(hostname);
}

function boundedSnippet(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_SNIPPET_CHARS ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…` : trimmed;
}

/**
 * Normalize model-supplied evidence into an identity-aware, independence-aware
 * set.
 *
 * Purely structural: no network access, no redirect following. An evidence URL
 * that cannot be validated offline is treated as missing provenance rather than
 * being resolved, so a hostile or mistaken URL can never cause a fetch.
 *
 * @param rawEvidence - The caller-supplied evidence array (untrusted shape).
 * @param signalUrl - The signal's own URL, used to detect first-party evidence.
 * @returns Retained evidence plus the independence tallies used for trust.
 */
export function normalizeVerifiedEvidence(rawEvidence: unknown, signalUrl: string): NormalizedVerifiedEvidence {
  const items: VerifiedEvidenceItem[] = [];
  const independentPublishers: string[] = [];
  const seenIdentities = new Set<string>();
  const seenIndependentPublishers = new Set<string>();
  let droppedDuplicateCount = 0;
  let unverifiableCount = 0;
  let firstPartyCount = 0;

  if (!Array.isArray(rawEvidence)) {
    return {
      items,
      independentPublisherCount: 0,
      independentPublishers,
      droppedDuplicateCount,
      unverifiableCount,
      firstPartyCount,
    };
  }

  const signalCanonical = canonicalHttpUrl(signalUrl);
  const signalPublisher = signalCanonical ? publisherOf(signalCanonical.displayUrl) : null;

  for (const raw of rawEvidence) {
    if (items.length >= MAX_VERIFIED_EVIDENCE_ITEMS) break;

    const record = (raw ?? {}) as { url?: unknown; snippet?: unknown };
    const snippet = boundedSnippet(record.snippet);
    const canonical = canonicalHttpUrl(record.url);

    if (!canonical) {
      unverifiableCount += 1;
      items.push({
        url: '',
        snippet,
        publisher: null,
        provenance: 'unverifiable',
        reason: 'No resolvable http(s) source URL — treated as model-authored text.',
      });
      continue;
    }

    if (isUnresolvedGoogleGroundingRedirect(canonical)) {
      unverifiableCount += 1;
      items.push({
        url: canonical.displayUrl,
        snippet,
        publisher: null,
        provenance: 'unverifiable',
        reason: 'Unresolved grounding redirect — the underlying publisher is unknown.',
      });
      continue;
    }

    // Replay and alias forms of an article already counted add nothing.
    if (seenIdentities.has(canonical.identity)) {
      droppedDuplicateCount += 1;
      continue;
    }
    seenIdentities.add(canonical.identity);

    const publisher = publisherOf(canonical.displayUrl);

    if (publisher !== null && signalPublisher !== null && publisher === signalPublisher) {
      firstPartyCount += 1;
      items.push({
        url: canonical.displayUrl,
        snippet,
        publisher,
        provenance: 'first_party',
        reason: "Published by the signal's own publisher — not independent corroboration.",
      });
      continue;
    }

    if (publisher === null) {
      unverifiableCount += 1;
      items.push({
        url: canonical.displayUrl,
        snippet,
        publisher: null,
        provenance: 'unverifiable',
        reason: 'Publisher could not be resolved from the source URL.',
      });
      continue;
    }

    if (!seenIndependentPublishers.has(publisher)) {
      seenIndependentPublishers.add(publisher);
      independentPublishers.push(publisher);
    }
    items.push({ url: canonical.displayUrl, snippet, publisher, provenance: 'independent' });
  }

  return {
    items,
    independentPublisherCount: independentPublishers.length,
    independentPublishers,
    droppedDuplicateCount,
    unverifiableCount,
    firstPartyCount,
  };
}
