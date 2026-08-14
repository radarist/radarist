import type { SignalGroundingCitation } from './evidence-sources';

const GOOGLE_GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const GOOGLE_GROUNDING_REDIRECT_PATH = '/grounding-api-redirect/';
const MAX_REDIRECT_HOPS = 2;
const MAX_RESOLVED_CITATIONS = 20;
const RESOLUTION_TIMEOUT_MS = 3_000;

export interface GroundingCitationResolutionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function asHttpUrl(value: string, base?: URL): URL | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isGoogleGroundingRedirect(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === GOOGLE_GROUNDING_REDIRECT_HOST &&
    url.port === '' &&
    url.pathname.startsWith(GOOGLE_GROUNDING_REDIRECT_PATH)
  );
}

async function resolveCitationIdentity<T extends SignalGroundingCitation>(
  citation: T,
  options: GroundingCitationResolutionOptions
): Promise<T> {
  // Idempotent: `uri` deliberately stays the redirect so navigation keeps
  // working, which means an already-resolved citation is recognised by
  // `identityUri`, not by its uri shape. Without this, resolving a citation set
  // twice (a caller that resolves after `generateGroundedContent` already did,
  // or a re-resolve of stored citations) would pay a second round-trip.
  if (citation.identityUri) return citation;

  const initial = asHttpUrl(citation.uri);
  if (!initial || !isGoogleGroundingRedirect(initial)) return citation;
  let current: URL = initial;

  const fetchImpl = options.fetchImpl ?? fetch;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? RESOLUTION_TIMEOUT_MS);
    try {
      // Manual redirect handling contacts only Google's known endpoint. The
      // publisher destination is inspected, never fetched by this resolver.
      const response: Response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) return citation;
      const location: string | null = response.headers.get('location');
      const destination: URL | null = location ? asHttpUrl(location, current) : null;
      if (!destination) return citation;
      if (isGoogleGroundingRedirect(destination)) {
        current = destination;
        continue;
      }
      return { ...citation, identityUri: destination.toString() };
    } catch {
      return citation;
    } finally {
      clearTimeout(timeout);
    }
  }

  return citation;
}

/**
 * Recover publisher identities from Gemini's Google grounding redirect URLs.
 * Untrusted URLs are never fetched, publisher redirects are never followed,
 * and any resolution failure leaves the citation unresolved and inconclusive.
 */
export async function resolveGroundingCitationIdentities<T extends SignalGroundingCitation>(
  citations: readonly T[],
  options: GroundingCitationResolutionOptions = {}
): Promise<T[]> {
  return Promise.all(
    citations.map((citation, index) =>
      index < MAX_RESOLVED_CITATIONS ? resolveCitationIdentity(citation, options) : Promise.resolve(citation)
    )
  );
}
