/**
 * @file lib/signal-fetchers/index.ts
 * @description Central export for all signal fetchers
 *
 * This file provides a convenient way to import and use all signal fetchers,
 * as well as utilities for fetching from multiple sources.
 *
 * **Usage:**
 * ```typescript
 * import { getFetcherForSource, fetchFromAllSources } from '@/lib/signal-fetchers';
 *
 * // Fetch from specific source
 * const fetcher = getFetcherForSource('patents');
 * const result = await fetcher.fetch(params);
 *
 * // Fetch from all enabled sources
 * const results = await fetchFromAllSources(keywords, config);
 * ```
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

export { BaseFetcher, type FetchSignalsParams, type FetchSignalsResult, type RawSignalItem } from './base-fetcher';
export { PatentsFetcher, patentsFetcher } from './patents-fetcher';
export {
  PapersResearchFetcher,
  papersResearchFetcher,
  HackerNewsFetcher,
  hackerNewsFetcher,
  SecFilingsFetcher,
  secFilingsFetcher,
} from './research-adapter';
export { NewsFetcher, newsFetcher } from './news-fetcher';
export { GitHubFetcher, githubFetcher } from './github-fetcher';
export {
  fetchAllRSSFallback,
  fetchGoogleNewsRSS,
  fetchHackerNewsRSS,
  fetchArxivRSS,
  hasRSSFallback,
} from './rss-fallback';

import type { BaseFetcher, FetchSignalsParams, FetchSignalsResult } from './base-fetcher';
import { patentsFetcher } from './patents-fetcher';
import { papersResearchFetcher, hackerNewsFetcher, secFilingsFetcher } from './research-adapter';
import { newsFetcher } from './news-fetcher';
import { githubFetcher } from './github-fetcher';
import type { SystemConfiguration } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { DEFAULT_SIGNAL_SOURCES } from '@/lib/signal-source-defaults';

const log = createLogger('signal-fetchers');

/**
 * Source type
 */
export type SignalSource = 'patents' | 'papers' | 'news' | 'github' | 'trends' | 'funding' | 'hackernews' | 'sec';

/**
 * Map of source names to fetcher instances
 */
const FETCHER_MAP: Record<Exclude<SignalSource, 'trends' | 'funding'>, BaseFetcher> = {
  patents: patentsFetcher,
  papers: papersResearchFetcher,
  news: newsFetcher,
  github: githubFetcher,
  hackernews: hackerNewsFetcher,
  sec: secFilingsFetcher,
};

/**
 * Get fetcher instance for a specific source
 *
 * @param source Source identifier
 * @returns Fetcher instance
 * @throws Error if source is not supported
 */
export function getFetcherForSource(source: Exclude<SignalSource, 'trends' | 'funding'>): BaseFetcher {
  const fetcher = FETCHER_MAP[source];

  if (!fetcher) {
    throw new Error(`Fetcher not found for source: ${source}`);
  }

  return fetcher;
}

/**
 * Get all available fetcher sources
 *
 * @returns Array of source identifiers
 */
export function getAvailableSources(): Array<Exclude<SignalSource, 'trends' | 'funding'>> {
  return Object.keys(FETCHER_MAP) as Array<Exclude<SignalSource, 'trends' | 'funding'>>;
}

/**
 * Fetch signals from all enabled sources
 *
 * This is a convenience function that fetches from all sources configured
 * in the system settings and returns combined results.
 *
 * @param params Fetch parameters (same for all sources)
 * @param config System configuration
 * @returns Map of source to fetch results
 */
export async function fetchFromAllSources(
  params: FetchSignalsParams,
  config: SystemConfiguration
): Promise<Record<string, FetchSignalsResult>> {
  const results: Record<string, FetchSignalsResult> = {};

  // Determine which sources to fetch from
  const sources = config.signalDetection.sources;
  const sourcesToFetch: Array<Exclude<SignalSource, 'trends' | 'funding'>> = [];

  if (sources.patents) sourcesToFetch.push('patents');
  if (sources.papers) sourcesToFetch.push('papers');
  if (sources.news) sourcesToFetch.push('news');
  if (sources.github) sourcesToFetch.push('github');
  if (sources.hackernews ?? DEFAULT_SIGNAL_SOURCES.hackernews) sourcesToFetch.push('hackernews');
  if (sources.sec ?? DEFAULT_SIGNAL_SOURCES.sec) sourcesToFetch.push('sec');

  log.info('Fetching from all sources', { count: sourcesToFetch.length, sources: sourcesToFetch });

  // Fetch from all sources in parallel
  const fetchPromises = sourcesToFetch.map(async (source) => {
    try {
      const fetcher = getFetcherForSource(source);
      const result = await fetcher.fetch(params);
      return { source, result };
    } catch (error) {
      log.error('Failed to fetch from source', error instanceof Error ? error : undefined, { source });
      return {
        source,
        result: {
          success: false,
          signals: [],
          itemsScanned: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        } as FetchSignalsResult,
      };
    }
  });

  const fetchResults = await Promise.all(fetchPromises);

  // Build results map
  for (const { source, result } of fetchResults) {
    results[source] = result;
  }

  return results;
}

/**
 * Fetch signals from a specific source
 *
 * This is a convenience wrapper around getFetcherForSource().fetch()
 *
 * @param source Source identifier
 * @param params Fetch parameters
 * @returns Fetch result
 */
export async function fetchFromSource(
  source: Exclude<SignalSource, 'trends' | 'funding'>,
  params: FetchSignalsParams
): Promise<FetchSignalsResult> {
  const fetcher = getFetcherForSource(source);
  return await fetcher.fetch(params);
}
