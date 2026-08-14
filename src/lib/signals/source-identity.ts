/**
 * @file signals/source-identity.ts
 * @description Canonical source identity for signal evidence.
 *
 * Extracted verbatim from `evidence-sources.ts` (AI-032) so the expansion
 * evidence contract and the verified-signal evidence contract share ONE
 * canonicalization implementation instead of drifting apart. Behaviour is
 * unchanged — `evidence-sources.ts` now imports these helpers, and its existing
 * contract tests guard the move.
 *
 * Identity is used for dedupe only. The caller's original URL is never
 * rewritten for navigation or display.
 *
 * @author Radarist Team
 * @created 2026-07-19
 */

export interface CanonicalEvidenceUrl {
  /** The caller's URL, trimmed but otherwise untouched — safe to navigate. */
  displayUrl: string;
  /** Normalized dedupe key: authority + path + filtered, sorted query. */
  identity: string;
}

/** Query keys that identify a click, not a document. Stripped from identity. */
const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'twclid',
  'li_fat_id',
  'mc_eid',
  'mc_cid',
]);

/**
 * The single bucket every unresolved Google grounding redirect collapses into,
 * shared by the display-side corroboration counter (`claim-chips.ts`) and the
 * durable `:Evidence` source key (`graph/assertions.ts`) so the two layers
 * cannot disagree about what counts as one source. Deliberately not a valid URL
 * identity, so it can never collide with a real publisher (GRAPH-070).
 */
export const UNRESOLVED_GROUNDING_REDIRECT_KEY = 'unresolved:google-grounding-redirect';

/**
 * A Google grounding redirect that has not been resolved to a publisher. Two
 * such URLs may alias the same article — or different ones — so they can never
 * be counted as independent sources.
 */
export function isUnresolvedGoogleGroundingRedirect(url: CanonicalEvidenceUrl): boolean {
  try {
    const parsed = new URL(url.displayUrl);
    return (
      parsed.hostname === 'vertexaisearch.cloud.google.com' && parsed.pathname.startsWith('/grounding-api-redirect/')
    );
  } catch {
    return false;
  }
}

/**
 * Validate and canonicalize an evidence URL.
 *
 * Rejects anything that is not an absolute http(s) URL, and anything carrying
 * embedded credentials. Returns `null` rather than throwing so callers can treat
 * an unusable URL as missing provenance.
 */
export function canonicalHttpUrl(value: unknown): CanonicalEvidenceUrl | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;

    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const defaultPort =
      (parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443');
    const authority = `${hostname}${parsed.port && !defaultPort ? `:${parsed.port}` : ''}`;
    const pathname =
      parsed.pathname !== '/' && parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
    const queryEntries = [...parsed.searchParams.entries()]
      .filter(([key]) => {
        const lower = key.toLowerCase();
        return !lower.startsWith('utm_') && !TRACKING_QUERY_KEYS.has(lower);
      })
      .sort(
        ([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      );
    const identityQuery = new URLSearchParams();
    for (const [key, queryValue] of queryEntries) identityQuery.append(key, queryValue);

    // HTTP and HTTPS aliases share an identity. The original validated URL is
    // retained for navigation; identity normalization is only for dedupe.
    const query = identityQuery.toString();
    return {
      displayUrl: value.trim(),
      identity: `${authority}${pathname}${query ? `?${query}` : ''}`,
    };
  } catch {
    return null;
  }
}

/**
 * Raw-string form of the redirect test, for write boundaries holding an
 * unvalidated URL. Returns `false` for anything that is not a usable http(s)
 * URL — an unusable URL is a separate failure the caller reports on its own,
 * not a redirect.
 */
export function isUnresolvedGroundingRedirectUrl(value: unknown): boolean {
  const canonical = canonicalHttpUrl(value);
  return canonical !== null && isUnresolvedGoogleGroundingRedirect(canonical);
}
