/**
 * @file lib/signal-fetchers/research-adapter.ts
 * @description Fetches signals via the Component-A keyless research tools:
 * `searchPapers` (OpenAlex + Crossref + Semantic Scholar, deduped, IEEE
 * citations), `searchHackerNews` (HN Algolia), and `searchSecFilings` (SEC
 * EDGAR full-text search).
 *
 * `PapersResearchFetcher` replaces the fragile arXiv `papers-fetcher.ts`
 * (regex-parsed Atom XML, single source, hard rate limit). `searchPapers` is
 * keyless, never throws, and is safe to call from Inngest workers (no
 * Firebase client SDK — uses `politeFetch`). `source`/`SignalType` are
 * unchanged: still `'papers'` / `'paper'`.
 *
 * `HackerNewsFetcher` replaces the RSS-scraped HN fallback with the same
 * keyless, never-throws contract over `searchHackerNews`. `source`/
 * `SignalType` are both `'hackernews'`.
 *
 * `SecFilingsFetcher` is a specialized, opt-in (default OFF) source over
 * `searchSecFilings`. `source` is `'sec'`, `SignalType` is `'filing'` (source
 * ≠ type, like patents → `'patent'`).
 *
 * @created 2026-07-04
 */

import { BaseFetcher, type FetchSignalsParams, type RawSignalItem } from './base-fetcher';
import { searchPapers } from '@/lib/research/papers';
import { searchHackerNews } from '@/lib/research/hn';
import { searchSecFilings } from '@/lib/research/sec';
import { getResearchContactEmail } from '../research/http';
import { resolveOpenAccess } from '../research/open-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/papers-research');
const hnLog = createLogger('signal-fetchers/hackernews');
const secLog = createLogger('signal-fetchers/sec');

// HN Algolia is AND-leaning; query the top-N interest keywords individually
const HN_MAX_QUERY_KEYWORDS = 6;

// SEC EFTS full-text; query top-N interest keywords individually
const SEC_MAX_QUERY_KEYWORDS = 3;

// Cap Unpaywall calls per fetch — enrichment is best-effort, not a blocker
const OA_ENRICH_MAX = 10;

/**
 * Papers fetcher backed by the multi-index `searchPapers` research tool.
 */
export class PapersResearchFetcher extends BaseFetcher {
  protected readonly source = 'papers' as const;

  /**
   * Fetch papers from OpenAlex/Crossref/Semantic Scholar via `searchPapers`.
   *
   * Honesty contract: `searchPapers` never throws, but flags upstream
   * failures via `error`. On error we log and degrade to `[]` rather than
   * fabricate results.
   *
   * @param params Fetch parameters
   * @returns Array of raw paper items
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    const query = params.keywords.join(' OR ');
    const { data, error } = await searchPapers({ query, limit: params.maxSignals });

    if (error) {
      log.warn('searchPapers upstream error', { error });
      return [];
    }

    const items: RawSignalItem[] = data.map((p) => ({
      id: p.doi ?? p.url,
      title: p.title,
      description: p.abstract ?? p.citation,
      url: p.url,
      date: p.year ? new Date(Date.UTC(p.year, 0, 1)) : new Date(),
      metadata: {
        citation: p.citation,
        doi: p.doi,
        citationCount: p.citationCount,
        authors: p.authors,
        paperSource: p.source,
      },
    }));

    // Open-access enrichment: opt-in, gated entirely on a configured contact
    // email (Unpaywall requires one). With no email this is a no-op — no
    // calls, no latency. Best-effort + bounded (OA_ENRICH_MAX); never blocks
    // or fails the fetch, and never fabricates a link on error/non-OA.
    const email = getResearchContactEmail();
    if (email) {
      const enrichable = items
        .filter((i) => typeof i.metadata?.doi === 'string' && (i.metadata.doi as string).length > 0)
        .slice(0, OA_ENRICH_MAX);
      await Promise.all(
        enrichable.map(async (item) => {
          const doi = item.metadata!.doi as string;
          const { data: oaData, error: oaError } = await resolveOpenAccess({ doi });
          if (!oaError && oaData.isOA && oaData.pdfUrl) {
            item.metadata = { ...item.metadata, openAccessPdf: oaData.pdfUrl };
          }
        })
      );
    }

    return items;
  }
}

/**
 * Create and export singleton instance
 */
export const papersResearchFetcher = new PapersResearchFetcher();

/**
 * Hacker News fetcher backed by the keyless `searchHackerNews` research tool
 * (HN Algolia). Replaces the RSS-scraped `fetchHackerNewsRSS` fallback.
 */
export class HackerNewsFetcher extends BaseFetcher {
  protected readonly source = 'hackernews' as const;

  /**
   * Fetch stories from Hacker News via `searchHackerNews`.
   *
   * HN Algolia's `query` is AND-leaning: a single space-joined multi-keyword
   * query matches almost nothing once an interest profile has more than a
   * couple of keywords (verified live: full keyword set → 0 hits). Query the
   * top-N keywords individually instead and merge/dedup by `objectID`.
   *
   * Honesty contract: `searchHackerNews` never throws, but flags upstream
   * failures via `error`. A per-keyword error is logged and skipped rather
   * than aborting the whole fetch — one bad keyword shouldn't zero out the
   * source.
   *
   * @param params Fetch parameters
   * @returns Array of raw HN story items, merged and deduped across keywords
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    const queryKeywords = params.keywords.slice(0, HN_MAX_QUERY_KEYWORDS);
    const seen = new Set<string>();
    const items: RawSignalItem[] = [];

    for (const kw of queryKeywords) {
      if (items.length >= params.maxSignals) break;

      const { data, error } = await searchHackerNews({ query: kw, limit: params.maxSignals });
      if (error) {
        hnLog.warn('searchHackerNews upstream error', { keyword: kw, error });
        continue;
      }

      for (const h of data) {
        if (items.length >= params.maxSignals) break;
        if (seen.has(h.objectID)) continue;
        seen.add(h.objectID);

        items.push({
          id: h.objectID,
          title: h.title,
          // HN stories are title-only; base buildAiSummary dedups title==description.
          description: h.title,
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          date: new Date(h.createdAt),
          metadata: {
            points: h.points,
            numComments: h.numComments,
            author: h.author,
            hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
          },
        });
      }
    }

    return items;
  }
}

/**
 * Create and export singleton instance
 */
export const hackerNewsFetcher = new HackerNewsFetcher();

/**
 * SEC EDGAR filings fetcher backed by the keyless `searchSecFilings` research
 * tool (EDGAR full-text search). Specialized, opt-in (default OFF) — not
 * everyone wants filings surfaced as signals.
 */
export class SecFilingsFetcher extends BaseFetcher {
  protected readonly source = 'sec' as const;

  /**
   * Fetch filings from SEC EDGAR via `searchSecFilings`.
   *
   * EDGAR's full-text search is AND-leaning like HN Algolia, so query the
   * top-N interest keywords individually instead of joining them into one
   * query (which would return almost nothing once an interest profile has
   * more than a couple of keywords).
   *
   * Honesty contract: `searchSecFilings` never throws, but flags upstream
   * failures via `error`. A per-keyword error is logged and skipped rather
   * than aborting the whole fetch — one bad keyword shouldn't zero out the
   * source.
   *
   * @param params Fetch parameters
   * @returns Array of raw filing items, merged and deduped across keywords
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    const queryKeywords = params.keywords.slice(0, SEC_MAX_QUERY_KEYWORDS);
    const seen = new Set<string>();
    const items: RawSignalItem[] = [];

    for (const kw of queryKeywords) {
      if (items.length >= params.maxSignals) break;

      const { data, error } = await searchSecFilings({ query: kw, limit: params.maxSignals });
      if (error) {
        secLog.warn('searchSecFilings upstream error', { keyword: kw, error });
        continue;
      }

      for (const f of data) {
        if (items.length >= params.maxSignals) break;
        if (seen.has(f.url)) continue;
        seen.add(f.url);

        items.push({
          id: f.url,
          title: `${f.company} — ${f.formType}`,
          description: f.snippet ?? `${f.formType} filing by ${f.company}`,
          url: f.url,
          date: new Date(f.filedAt),
          metadata: { company: f.company, cik: f.cik, formType: f.formType, filedAt: f.filedAt },
        });
      }
    }

    return items;
  }
}

/**
 * Create and export singleton instance
 */
export const secFilingsFetcher = new SecFilingsFetcher();
