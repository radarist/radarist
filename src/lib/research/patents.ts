/**
 * @file lib/research/patents.ts
 * @description Keyless patent-landscape search via Google Patents' public
 * `xhr/query` endpoint (the same JSON endpoint patents.google.com's own UI
 * calls). Server-only.
 *
 * Contract (mirrors the other primary-source adapters, esp. oss-health.ts):
 * - `searchPatents` NEVER throws to the caller. A blank query short-circuits
 *   to a typed-empty result WITHOUT `error` (nothing was asked). An upstream
 *   failure (network, a 503 — Google Patents rate-limits bursts by IP — or a
 *   schema-invalid body) degrades to the typed-empty result WITH `error` set,
 *   so a caller can tell "the search failed" from "no filings match." A valid
 *   response that legitimately has zero results returns empty data and NO
 *   error.
 * - Missing fields map to `null`, never invented.
 * - `totalResults` is the FULL upstream match count (the crowding signal),
 *   independent of how many filings were sampled into `patents`.
 * - CPC/IPC codes are NOT returned — the search endpoint does not carry them
 *   (a per-filing fetch would); an honest gap the caller/skill must respect.
 *
 * Live-verified real shape (2026-07-05, `patents.google.com/xhr/query`):
 * ```
 * { results: { total_num_results: 21888, cluster: [ { result: [
 *   { id: "patent/US12197859B1/en", patent: {
 *       title, snippet, assignee, inventor,
 *       priority_date, filing_date, grant_date, publication_date,
 *       publication_number } } ] } ] } }
 * ```
 * The endpoint requires a browser-like User-Agent (the research UA gets a 503)
 * and rate-limits bursts by IP — both handled by the honest error path.
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, ResearchFetchError } from './http';
import type { PatentResult, PatentSearchData, ResearchOutcome } from './types';

const log = createLogger('research/patents');

export interface SearchPatentsParams {
  query: string;
  /** Max filings to sample into `patents` (default 25, clamped to 1–100). */
  limit?: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Google Patents' xhr/query returns a 503 for the default research UA; it
// wants a browser-like UA (the one its own web UI sends).
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// The xhr/query endpoint is undocumented and publishes no RPM; empirically it
// 503s under bursts (rate-limited by IP). So we SPACE requests ≥ 2s apart and
// back off + retry once on a rate-limit status, rather than hammering it. The
// space + retry are why a rapid double-call (e.g. an agent loop calling twice
// in one turn) no longer trips the limit.
export const MIN_REQUEST_INTERVAL_MS = 2000;
const RETRY_STATUSES = new Set([429, 503]);
const RETRY_BACKOFF_MS = [2000]; // one retry, 2s backoff

// Process-wide throttle gate (epoch ms of the next allowed request start).
let nextRequestAllowedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset the throttle gate — test-only, so module-level spacing doesn't bleed
 *  a 2s wait across unit tests. */
export function __resetPatentsThrottleForTest(): void {
  nextRequestAllowedAt = 0;
}

/**
 * Fetch Google Patents with proactive spacing + a single backoff-retry on a
 * rate-limit status (429/503). Spacing prevents bursts from tripping the limit;
 * the retry heals a transient block. A non-rate-limit error is rethrown
 * immediately for the caller's honest error path.
 */
async function fetchGooglePatents(url: string): Promise<Response> {
  // Reserve this request's slot ≥ MIN_REQUEST_INTERVAL_MS after the previous
  // one (synchronous prologue — no await — so concurrent calls serialize).
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAllowedAt - now);
  nextRequestAllowedAt = Math.max(now, nextRequestAllowedAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);

  for (let attempt = 0; ; attempt++) {
    try {
      return await politeFetch(url, { userAgent: BROWSER_UA, timeoutMs: 15000 });
    } catch (err) {
      const status = err instanceof ResearchFetchError ? err.status : undefined;
      const canRetry = attempt < RETRY_BACKOFF_MS.length && status !== undefined && RETRY_STATUSES.has(status);
      if (!canRetry) throw err;
      log.warn('Google Patents rate-limited; backing off before retry', {
        status,
        attempt,
        backoffMs: RETRY_BACKOFF_MS[attempt],
      });
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
}

function emptyData(): PatentSearchData {
  return { totalResults: 0, patents: [], source: 'google-patents' };
}

/** Strip highlight tags + decode the handful of entities Google emits. */
function clean(text: string | null | undefined): string | null {
  if (text == null) return null;
  const stripped = text
    .replace(/<[^>]+>/g, '')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : null;
}

const PatentSchema = z
  .object({
    title: z.string().nullable().optional(),
    snippet: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    inventor: z.string().nullable().optional(),
    priority_date: z.string().nullable().optional(),
    filing_date: z.string().nullable().optional(),
    grant_date: z.string().nullable().optional(),
    publication_date: z.string().nullable().optional(),
    publication_number: z.string().nullable().optional(),
  })
  .passthrough();

const GooglePatentsSchema = z
  .object({
    results: z
      .object({
        total_num_results: z.number().nullable().optional(),
        cluster: z
          .array(
            z
              .object({
                result: z
                  .array(
                    z
                      .object({
                        id: z.string().nullable().optional(),
                        patent: PatentSchema.nullable().optional(),
                      })
                      .passthrough()
                  )
                  .nullable()
                  .optional(),
              })
              .passthrough()
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function toPatentResult(raw: z.infer<typeof PatentSchema>, id: string | null | undefined): PatentResult {
  // publication_number is the canonical id; fall back to parsing it out of the
  // `patent/US.../en` id string.
  const number = raw.publication_number?.trim() || id?.replace(/^patent\//, '').replace(/\/[a-z]{2}$/i, '') || '';
  return {
    patentNumber: number,
    title: clean(raw.title) ?? '',
    assignee: clean(raw.assignee),
    inventor: clean(raw.inventor),
    priorityDate: raw.priority_date?.trim() || null,
    filingDate: raw.filing_date?.trim() || null,
    grantDate: raw.grant_date?.trim() || null,
    publicationDate: raw.publication_date?.trim() || null,
    url: number ? `https://patents.google.com/patent/${encodeURIComponent(number)}/en` : 'https://patents.google.com/',
    snippet: clean(raw.snippet),
  };
}

/**
 * Search the patent landscape for a topic/assignee/keyword via Google Patents.
 * Never throws — degrades to a typed-empty result on a blank query (no error),
 * or with `error` set on any upstream/network/schema failure. Returns real
 * data only; missing fields are `null`, never invented.
 */
export async function searchPatents(params: SearchPatentsParams): Promise<ResearchOutcome<PatentSearchData>> {
  const query = params.query?.trim() ?? '';
  if (!query) return { data: emptyData() };

  const num = Math.min(MAX_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)));

  try {
    // The `url` param is itself a url-encoded query string that the Google
    // Patents UI builds: q="<terms>"&type=PATENT&num=<n>.
    const inner = `q="${query}"&type=PATENT&num=${num}`;
    const url = `https://patents.google.com/xhr/query?url=${encodeURIComponent(inner)}&exp=`;

    const res = await fetchGooglePatents(url);
    const json: unknown = await res.json();
    const validated = GooglePatentsSchema.safeParse(json);
    if (!validated.success) {
      log.warn('Google Patents response failed schema validation', {
        query,
        issues: validated.error.issues.length,
      });
      return { data: emptyData(), error: 'Unexpected response shape from Google Patents' };
    }

    const results = validated.data.results;
    const clusters = results?.cluster ?? [];
    const patents: PatentResult[] = [];
    for (const cluster of clusters) {
      for (const entry of cluster.result ?? []) {
        if (entry.patent) patents.push(toPatentResult(entry.patent, entry.id));
        if (patents.length >= num) break;
      }
      if (patents.length >= num) break;
    }

    return {
      data: {
        totalResults: results?.total_num_results ?? patents.length,
        patents,
        source: 'google-patents',
      },
    };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      const hint = err.status === 503 ? ' (Google Patents rate-limits bursts — retry shortly)' : '';
      log.warn('Google Patents fetch failed', { query, err: err.message, status: err.status });
      return {
        data: emptyData(),
        error: `Upstream request failed (${err.status ?? 'network'})${hint}: ${err.message}`,
      };
    }
    log.warn('Google Patents fetch failed', { query, err: err instanceof Error ? err.message : String(err) });
    return { data: emptyData(), error: 'Unexpected response shape from Google Patents' };
  }
}
