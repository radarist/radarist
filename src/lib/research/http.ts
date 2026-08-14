/**
 * Shared polite-fetch helper for the primary-source research tools.
 *
 * Every source module (papers, open-access, HN, SEC, OSS health) goes through
 * `politeFetch` so requests to public research APIs carry a descriptive
 * User-Agent (with optional contact email for polite-pool identification),
 * a bounded timeout, and a single normalized error type on failure.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('research/http');

export class ResearchFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ResearchFetchError';
  }
}

export function getResearchContactEmail(): string | undefined {
  const v = process.env.RESEARCH_CONTACT_EMAIL?.trim();
  return v ? v : undefined;
}

export async function politeFetch(
  url: string,
  opts: { timeoutMs?: number; accept?: string; userAgent?: string } = {}
): Promise<Response> {
  const email = getResearchContactEmail();
  // NB: no URL in the User-Agent. SEC EDGAR's WAF returns 403 for any UA that
  // contains a URL (verified live 2026-07-04); polite-pool identification is
  // the contact email (passed as ?mailto=/?email= query params), not the UA URL.
  // `userAgent` overrides the default for endpoints that require a browser-like
  // UA (e.g. Google Patents' xhr/query rejects the research UA).
  const ua = opts.userAgent ?? `Radarist/0.1 (research tools${email ? `; ${email}` : ''})`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': ua, Accept: opts.accept ?? 'application/json' },
    });
    if (!res.ok) throw new ResearchFetchError(`Upstream ${res.status} for ${url}`, res.status);
    return res;
  } catch (err) {
    if (err instanceof ResearchFetchError) throw err;
    const msg = err instanceof Error ? err.message : 'fetch failed';
    log.warn('politeFetch failed', { url, msg });
    throw new ResearchFetchError(msg);
  } finally {
    clearTimeout(timer);
  }
}
