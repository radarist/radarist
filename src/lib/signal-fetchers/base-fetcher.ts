/**
 * @file lib/signal-fetchers/base-fetcher.ts
 * @description Abstract base class for all signal fetchers
 *
 * This class provides a common interface and shared functionality
 * for fetching signals from external sources (patents, papers, news, etc.)
 *
 * **Design Pattern:**
 * - Abstract class with template method pattern
 * - Each fetcher implements source-specific logic
 * - Shared error handling and logging
 * - Rate limiting and retry logic
 *
 * **Usage:**
 * ```typescript
 * class MyFetcher extends BaseFetcher {
 *   async fetchFromSource(params) {
 *     // Implement source-specific logic
 *   }
 * }
 * ```
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import type { Signal } from '@/lib/types';
import { generateSlug } from '@/lib/entity-factory-shared';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/base');

/**
 * A source failure that will NOT be fixed by retrying: a permanent HTTP 4xx
 * (a rejected/invalid request), a retired endpoint, or an HTML/non-JSON body
 * where the API contract promises JSON. `BaseFetcher.retry` throws these
 * immediately instead of burning the whole backoff budget, and
 * `BaseFetcher.fetch` stamps `permanent: true` on the result so a scheduled
 * caller can surface actionable source health instead of hammering the same
 * broken contract every cycle. (OPS-002)
 */
export class PermanentSourceError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSourceError';
  }
}

/**
 * True when an HTTP status is a permanent contract failure that retrying
 * cannot fix. 4xx are client/contract errors EXCEPT 408 (Request Timeout) and
 * 429 (Too Many Requests), which are transient. 3xx/5xx are not permanent
 * here — a fetcher that follows redirects sees the final status, and 5xx are
 * genuinely transient. (OPS-002)
 */
export function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * True when a response's declared content type is present and clearly not the
 * JSON the API contract promises (e.g. an HTML error/redirect page). A missing
 * content-type is treated as "unknown, proceed" so best-effort mocks and lax
 * upstreams are not falsely rejected. (OPS-002)
 */
export function isNonJsonContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalized === '') return false;
  return !(normalized.includes('json') || normalized.endsWith('+json'));
}

/**
 * Parameters for fetching signals
 */
export interface FetchSignalsParams {
  /**
   * Keywords to search for
   */
  keywords: string[];

  /**
   * Time range in days (e.g., 7 for last 7 days)
   */
  timeRangeDays: number;

  /**
   * Maximum number of signals to return
   */
  maxSignals: number;

  /**
   * Minimum relevance score (0-100)
   */
  minRelevance?: number;
}

/**
 * Result from fetching signals
 */
export interface FetchSignalsResult {
  /**
   * Whether the fetch was successful
   */
  success: boolean;

  /**
   * Fetched signals
   */
  signals: Signal[];

  /**
   * Number of items scanned
   */
  itemsScanned: number;

  /**
   * Error message if failed
   */
  error?: string;

  /**
   * True when the failure is a permanent contract failure (permanent 4xx,
   * retired endpoint, HTML-where-JSON-expected) that retrying cannot fix. The
   * caller can surface this as actionable source health instead of retrying
   * the same broken source every cycle. (OPS-002)
   */
  permanent?: boolean;

  /**
   * Metadata about the fetch operation
   */
  metadata?: {
    source: string;
    executionTimeMs: number;
    rateLimitRemaining?: number;
    nextResetAt?: number;
  };
}

/**
 * Raw item from external source (before conversion to Signal)
 */
export interface RawSignalItem {
  /**
   * Unique identifier from source
   */
  id: string;

  /**
   * Title/name of the item
   */
  title: string;

  /**
   * Description/abstract/content
   */
  description: string;

  /**
   * URL to the item
   */
  url: string;

  /**
   * Publication/discovery date
   */
  date: Date;

  /**
   * Source-specific metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Abstract base fetcher class
 *
 * All signal fetchers should extend this class and implement:
 * - fetchFromSource(): Source-specific fetch logic
 * - convertToSignal(): Convert raw items to Signal format
 */
export abstract class BaseFetcher {
  /**
   * Source identifier
   */
  protected abstract readonly source:
    'patents' | 'papers' | 'news' | 'funding' | 'github' | 'trends' | 'hackernews' | 'sec';

  /**
   * Fetch signals from external source
   *
   * This is the main public method that orchestrates the fetch operation:
   * 1. Validate parameters
   * 2. Fetch raw items from source
   * 3. Convert to Signal format
   * 4. Filter by relevance
   * 5. Limit results
   *
   * @param params Fetch parameters
   * @returns Fetch result with signals
   */
  async fetch(params: FetchSignalsParams): Promise<FetchSignalsResult> {
    const startTime = Date.now();

    try {
      // Validate parameters
      this.validateParams(params);

      log.info('Fetching signals', { source: this.source, keywords: params.keywords });

      // Fetch raw items from source
      const rawItems = await this.fetchFromSource(params);

      log.info('Fetched raw items', { source: this.source, count: rawItems.length });

      // Convert to Signal format (passing params so fetchers can score
      // relevance against the search keywords).
      const signals = await Promise.all(rawItems.map((item) => this.convertToSignal(item, params)));

      // Filter by relevance if specified
      let filteredSignals = signals;
      if (params.minRelevance) {
        filteredSignals = signals.filter((signal: Signal) => (signal.relevanceScore || 0) >= params.minRelevance!);
      }

      // Limit results
      const limitedSignals = filteredSignals.slice(0, params.maxSignals);

      const executionTimeMs = Date.now() - startTime;

      log.info('Returning signals', {
        source: this.source,
        returned: limitedSignals.length,
        scanned: rawItems.length,
        filtered: signals.length,
      });

      return {
        success: true,
        signals: limitedSignals,
        itemsScanned: rawItems.length,
        metadata: {
          source: this.source,
          executionTimeMs,
        },
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      log.error('Fetch failed', error instanceof Error ? error : undefined, { source: this.source });

      return {
        success: false,
        signals: [],
        itemsScanned: 0,
        error: errorMessage,
        permanent: error instanceof PermanentSourceError,
        metadata: {
          source: this.source,
          executionTimeMs,
        },
      };
    }
  }

  /**
   * Fetch raw items from source
   *
   * This method must be implemented by each fetcher to handle
   * source-specific API calls and data retrieval.
   *
   * @param params Fetch parameters
   * @returns Array of raw items from source
   */
  protected abstract fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]>;

  /**
   * Convert raw item to Signal format
   *
   * This method can be overridden by each fetcher to handle
   * source-specific data transformation.
   *
   * @param item Raw item from source
   * @returns Signal object
   */
  protected async convertToSignal(item: RawSignalItem, params?: FetchSignalsParams): Promise<Signal> {
    // Split "Title - Publisher" before anything else so relevance scoring and
    // the displayed title both use the clean version. The publisher name
    // ends up in metadata.publisher for UI prominence.
    const { title: cleanTitle, publisher } = extractPublisherFromTitle(item.title);
    const relevance = computeKeywordRelevance(cleanTitle, item.description, params?.keywords ?? []);
    const matchedKeyword = bestMatchedKeyword(cleanTitle, item.description, params?.keywords ?? []);
    const aiSummary = buildAiSummary(cleanTitle, item.description);
    return {
      id: `${this.source}-${item.id}-${Date.now()}`,
      slug: generateSlug(cleanTitle),
      source: this.source,
      type: this.inferSignalType(item),
      title: cleanTitle,
      description: item.description,
      url: item.url,
      date: item.date.getTime(),
      status: 'Detected',
      relevanceScore: relevance,
      alignmentScore: 0,
      alignedStrategies: [],
      linkedEntities: {},
      sentiment: 'neutral' as const,
      aiSummary,
      detectedAt: Date.now(),
      metadata: {
        sourceId: item.id,
        ...(publisher ? { publisher } : {}),
        ...(matchedKeyword ? { matchedKeyword } : {}),
        ...item.metadata,
      },
    };
  }

  /**
   * Infer signal type from raw item
   *
   * Can be overridden by specific fetchers for better type inference.
   *
   * @param item Raw item
   * @returns Inferred signal type
   */
  protected inferSignalType(_item: RawSignalItem): Signal['type'] {
    // Default mapping based on source
    const typeMapping: Record<typeof this.source, Signal['type']> = {
      patents: 'patent',
      papers: 'paper',
      news: 'news',
      funding: 'funding',
      github: 'github',
      trends: 'trend',
      hackernews: 'hackernews',
      sec: 'filing',
    };

    return typeMapping[this.source];
  }

  /**
   * Validate fetch parameters
   *
   * @param params Parameters to validate
   * @throws Error if parameters are invalid
   */
  protected validateParams(params: FetchSignalsParams): void {
    if (!params.keywords || params.keywords.length === 0) {
      throw new Error('Keywords are required');
    }

    if (params.timeRangeDays <= 0) {
      throw new Error('Time range must be positive');
    }

    if (params.maxSignals <= 0) {
      throw new Error('Max signals must be positive');
    }

    if (params.minRelevance !== undefined && (params.minRelevance < 0 || params.minRelevance > 100)) {
      throw new Error('Min relevance must be between 0 and 100');
    }
  }

  /**
   * Calculate date range for query
   *
   * @param days Number of days in the past
   * @returns Start and end dates
   */
  protected getDateRange(days: number): { startDate: Date; endDate: Date } {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return { startDate, endDate };
  }

  /**
   * Format date for API queries
   *
   * @param date Date to format
   * @returns Formatted date string (YYYY-MM-DD)
   */
  protected formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Retry logic for API calls
   *
   * @param fn Function to retry
   * @param maxRetries Maximum number of retries
   * @param delayMs Delay between retries in milliseconds
   * @returns Result from function
   */
  protected async retry<T>(fn: () => Promise<T>, maxRetries: number = 3, delayMs: number = 1000): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        // A permanent contract failure will never clear on retry (permanent
        // 4xx, retired endpoint, HTML-where-JSON-expected). Fail fast so a
        // scheduled fetch does not burn the whole backoff budget every cycle
        // on a source that is structurally broken. (OPS-002)
        if (err instanceof PermanentSourceError) {
          log.warn('Permanent source failure — not retrying', { source: this.source, error: err.message });
          throw err;
        }
        lastError = err;
        log.warn('Retry attempt failed', { source: this.source, attempt, maxRetries, error: lastError.message });

        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = delayMs * Math.pow(2, attempt - 1);
          log.debug('Retrying', { source: this.source, delay });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Retry failed');
  }
}

// ============================================================================
// SCORING HELPERS
// ============================================================================

/**
 * Compute a 0-100 relevance score from keyword overlap with the fetched item.
 *
 * Signal fetchers query external APIs using keywords, so a returned item
 * already implies *some* match. We still differentiate:
 *   - base 60 for any RSS/API hit
 *   - +10 per unique keyword matched in title (max +30)
 *   - +5 per unique keyword matched in description only
 *   - capped at 95 so the downstream evaluator can promote to 100 on AI
 *     verification
 *
 * Previously hardcoded to 0 for every fetched item, which rendered the UI's
 * relevance badges permanently stuck at 0%.
 */
export function computeKeywordRelevance(title: string, description: string, keywords: string[]): number {
  if (keywords.length === 0) return 50; // Neutral — caller didn't supply keywords
  const hay = `${title}\n${description}`.toLowerCase();
  let titleMatches = 0;
  let descOnlyMatches = 0;
  const titleLower = title.toLowerCase();
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (titleLower.includes(k)) titleMatches++;
    else if (hay.includes(k)) descOnlyMatches++;
  }
  const base = titleMatches + descOnlyMatches > 0 ? 60 : 30;
  const titleBonus = Math.min(titleMatches * 10, 30);
  const descBonus = Math.min(descOnlyMatches * 5, 10);
  return Math.min(95, base + titleBonus + descBonus);
}

/**
 * The single search keyword that best explains why this item was fetched — a title match wins
 * over a description-only match. Used to attribute a fetched signal back to its originating
 * keyword (so the discovery lane can key feedback on the right topic). `undefined` when no
 * keyword textually matches (the item was a loose API hit).
 */
export function bestMatchedKeyword(title: string, description: string, keywords: string[]): string | undefined {
  const t = (title ?? '').toLowerCase();
  const hay = `${title ?? ''}\n${description ?? ''}`.toLowerCase();
  let descHit: string | undefined;
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (t.includes(k)) return raw; // title match wins immediately (return the ORIGINAL casing)
    if (!descHit && hay.includes(k)) descHit = raw;
  }
  return descHit;
}

/**
 * Build a first-pass AI summary for the signal list UI.
 *
 * The RSS "description" for Google News and similar aggregators is just a
 * restatement of the title with source-name boilerplate. Echoing it as the
 * aiSummary produces the "description == aiSummary" UX that feels broken.
 *
 * Prefer: title + short description excerpt if the description actually adds
 * words beyond the title.
 */
export function buildAiSummary(title: string, description: string): string {
  const t = (title ?? '').trim();
  const d = (description ?? '').trim();
  if (!d) return t;
  // If description is just the title (or echoes it verbatim), return title only.
  if (d.toLowerCase().startsWith(t.toLowerCase()) && d.length <= t.length + 20) return t;
  const excerpt = d.length > 240 ? `${d.slice(0, 237)}...` : d;
  return `${t}\n\n${excerpt}`;
}

/**
 * Google News (and similar aggregators) tack the publisher name onto the end
 * of the RSS <title> with ` - <Publisher>`. Pulling the publisher off lets us
 * display a clean, canonical-looking title in the signals list and surface
 * the publisher as first-class metadata instead of an afterthought in the
 * title string.
 *
 * Heuristic:
 *   - Only split on the LAST occurrence of ` - ` so legitimate dashes in a
 *     title survive.
 *   - Only treat the suffix as a publisher when it's short-ish (<= 40 chars)
 *     and doesn't look like an article fragment (has no sentence punctuation).
 *
 * Returns the original title unchanged when the heuristic doesn't match.
 */
export function extractPublisherFromTitle(raw: string): { title: string; publisher?: string } {
  const t = (raw ?? '').trim();
  if (!t) return { title: t };
  const idx = t.lastIndexOf(' - ');
  if (idx < 0) return { title: t };
  const candidateTitle = t.slice(0, idx).trim();
  const candidatePublisher = t.slice(idx + 3).trim();
  if (!candidatePublisher || candidatePublisher.length > 40) return { title: t };
  // Publisher names are nouns/proper nouns; reject anything that looks like a
  // sentence fragment.
  if (/[.!?,:;]/.test(candidatePublisher)) return { title: t };
  if (candidateTitle.length < 8) return { title: t };
  return { title: candidateTitle, publisher: candidatePublisher };
}
