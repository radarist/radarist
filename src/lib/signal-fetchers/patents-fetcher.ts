/**
 * @file lib/signal-fetchers/patents-fetcher.ts
 * @description Fetches patent signals from Google Patents
 *
 * This fetcher searches for patents using keywords and returns relevant
 * patent information as signals.
 *
 * **Data Source:** Google Patents (https://patents.google.com/)
 * **API:** Google Custom Search API with Patents filter
 * **Rate Limits:** 100 queries/day (free tier)
 *
 * **Alternative APIs:**
 * - USPTO PatentsView API (free, no key required)
 * - EPO Open Patent Services (free)
 * - Patent Public Search (scraping)
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import {
  BaseFetcher,
  PermanentSourceError,
  isNonJsonContentType,
  type FetchSignalsParams,
  type RawSignalItem,
} from './base-fetcher';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/patents');

/**
 * Patent item from USPTO PatentsView API
 */
interface PatentItem {
  patent_id: string;
  patent_title: string;
  patent_abstract: string;
  patent_date: string;
  patent_number: string;
  assignees?: Array<{
    assignee_organization?: string;
  }>;
  inventors?: Array<{
    inventor_first_name?: string;
    inventor_last_name?: string;
  }>;
}

/**
 * PatentsView API response
 */
interface PatentsViewResponse {
  patents: PatentItem[];
  count: number;
  total_patent_count: number;
}

/**
 * Patents fetcher using USPTO PatentsView API
 *
 * PatentsView provides free access to US patent data without requiring an API key.
 *
 * **API Documentation:** https://patentsview.org/apis/api-endpoints
 *
 * **Query Format:**
 * - Uses JSON query DSL
 * - Supports full-text search on titles and abstracts
 * - Can filter by date, assignee, inventor, etc.
 *
 * **KNOWN-BROKEN (see docs/LIMITATIONS.md):** the legacy endpoint
 * `api.patentsview.org/patents/query` was retired and now 301-redirects to an
 * HTML page, so every fetch fails. The `patents` source is disabled by default
 * in the system config; re-enabling it requires the planned migration to the
 * `search.patentsview.org` API (free key).
 */
export class PatentsFetcher extends BaseFetcher {
  protected readonly source = 'patents' as const;

  /**
   * PatentsView API base URL
   */
  private readonly API_BASE = 'https://api.patentsview.org/patents/query';

  /**
   * Fetch patents from PatentsView API
   *
   * @param params Fetch parameters
   * @returns Array of raw patent items
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    const { startDate, endDate } = this.getDateRange(params.timeRangeDays);

    // Build query for PatentsView API
    const query = this.buildQuery(params.keywords, startDate, endDate);

    // Fetch with retry logic
    let response: PatentsViewResponse;
    try {
      response = await this.retry(async () => {
        const res = await fetch(this.API_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: query,
            f: [
              'patent_id',
              'patent_number',
              'patent_title',
              'patent_abstract',
              'patent_date',
              'assignee_organization',
              'inventor_first_name',
              'inventor_last_name',
            ],
            o: {
              per_page: Math.min(params.maxSignals * 2, 100), // Fetch more than needed for filtering
              page: 1,
            },
            s: [{ patent_date: 'desc' }], // Sort by most recent
          }),
        });

        // The legacy endpoint is retired: it 301-redirects to an HTML page, so
        // every outcome here is a permanent contract failure. Classify each
        // failure mode as PermanentSourceError so it fails fast (no retry storm
        // every cycle) and the result is flagged as actionable source health.
        if (!res.ok) {
          throw new PermanentSourceError(
            `PatentsView API error: ${res.status} ${res.statusText} (retired endpoint — see docs/LIMITATIONS.md)`
          );
        }

        if (isNonJsonContentType(res.headers?.get?.('content-type'))) {
          throw new PermanentSourceError(
            `PatentsView returned a non-JSON body (retired endpoint served content-type: ${res.headers?.get?.('content-type')})`
          );
        }

        try {
          return (await res.json()) as PatentsViewResponse;
        } catch (parseError) {
          throw new PermanentSourceError(
            `PatentsView returned an unparseable body (retired endpoint): ${
              parseError instanceof Error ? parseError.message : 'invalid JSON'
            }`
          );
        }
      });
    } catch (error) {
      // The legacy api.patentsview.org endpoint was retired (301 → HTML page),
      // so this is the expected outcome whenever the source is enabled. Log an
      // honest pointer, then rethrow so BaseFetcher reports success: false.
      log.warn('PatentsView legacy endpoint retired — see docs/LIMITATIONS.md', {
        endpoint: this.API_BASE,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Convert to RawSignalItem format
    return response.patents.map((patent) => this.convertPatentToRawItem(patent));
  }

  /**
   * Build PatentsView API query
   *
   * @param keywords Search keywords
   * @param startDate Start date for filtering
   * @param endDate End date for filtering
   * @returns Query object for API
   */
  private buildQuery(keywords: string[], startDate: Date, endDate: Date): Record<string, unknown> {
    // Create OR conditions for keywords
    const keywordConditions = keywords.map((keyword) => ({
      _text_any: {
        patent_title: keyword,
        patent_abstract: keyword,
      },
    }));

    return {
      _and: [
        // Date range filter
        {
          _gte: {
            patent_date: this.formatDate(startDate),
          },
        },
        {
          _lte: {
            patent_date: this.formatDate(endDate),
          },
        },
        // Keywords filter (OR condition)
        {
          _or: keywordConditions,
        },
      ],
    };
  }

  /**
   * Convert patent item to raw signal item
   *
   * @param patent Patent from API
   * @returns Raw signal item
   */
  private convertPatentToRawItem(patent: PatentItem): RawSignalItem {
    const assignees =
      patent.assignees
        ?.map((a) => a.assignee_organization)
        .filter(Boolean)
        .join(', ') || 'Unknown';

    const inventors =
      patent.inventors
        ?.map((i) => `${i.inventor_first_name || ''} ${i.inventor_last_name || ''}`.trim())
        .filter(Boolean)
        .join(', ') || 'Unknown';

    return {
      id: patent.patent_id,
      title: patent.patent_title || 'Untitled Patent',
      description: patent.patent_abstract || 'No abstract available.',
      url: `https://patents.google.com/patent/${patent.patent_number}`,
      date: new Date(patent.patent_date),
      metadata: {
        patentNumber: patent.patent_number,
        assignees,
        inventors,
        patentDate: patent.patent_date,
      },
    };
  }
}

/**
 * Create and export singleton instance
 */
export const patentsFetcher = new PatentsFetcher();
