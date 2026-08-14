/**
 * @file lib/signal-fetchers/news-fetcher.ts
 * @description Fetches news signals from NewsAPI
 *
 * This fetcher searches for news articles using keywords and returns
 * relevant articles as signals.
 *
 * **Data Source:** NewsAPI (https://newsapi.org/)
 * **API Key Required:** Yes (free tier: 100 requests/day)
 * **Rate Limits:** 100 requests/day (free), 1000 requests/day (developer)
 *
 * **Alternative APIs:**
 * - Google News RSS (free, no key)
 * - Bing News API (requires Azure subscription)
 * - GNews API (free tier available)
 *
 * **Setup:**
 * 1. Get API key from https://newsapi.org/register
 * 2. Add to .env.local: NEWS_API_KEY=your_key_here
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { BaseFetcher, type FetchSignalsParams, type RawSignalItem } from './base-fetcher';
import { fetchAllRSSFallback } from './rss-fallback';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/news');

/**
 * Article from NewsAPI response
 */
interface NewsArticle {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

/**
 * NewsAPI response
 */
interface NewsAPIResponse {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
}

/**
 * News fetcher using NewsAPI
 *
 * NewsAPI provides access to news articles from over 80,000 sources worldwide.
 *
 * **API Documentation:** https://newsapi.org/docs
 *
 * **Endpoints:**
 * - /everything: Search all articles
 * - /top-headlines: Get top headlines
 * - /sources: Get available sources
 */
export class NewsFetcher extends BaseFetcher {
  protected readonly source = 'news' as const;

  /**
   * NewsAPI base URL
   */
  private readonly API_BASE = 'https://newsapi.org/v2';

  /**
   * API key from environment
   */
  private readonly API_KEY = process.env.NEWS_API_KEY;

  /**
   * Fetch news articles from NewsAPI
   *
   * @param params Fetch parameters
   * @returns Array of raw news items
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    // Check for API key
    if (!this.API_KEY) {
      log.warn('NEWS_API_KEY not configured, using fallback RSS feed');
      return this.fetchFromGoogleNewsRSS(params);
    }

    const { startDate, endDate } = this.getDateRange(params.timeRangeDays);

    // Build query
    const query = params.keywords.join(' OR ');

    // Build URL
    const url = new URL(`${this.API_BASE}/everything`);
    url.searchParams.set('q', query);
    url.searchParams.set('from', this.formatDate(startDate));
    url.searchParams.set('to', this.formatDate(endDate));
    url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', String(Math.min(params.maxSignals * 2, 100)));
    url.searchParams.set('language', 'en');
    url.searchParams.set('apiKey', this.API_KEY);

    // Fetch with retry logic
    const response = await this.retry(async () => {
      const res = await fetch(url.toString());

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`NewsAPI error: ${res.status} ${errorData.message || res.statusText}`);
      }

      return res.json() as Promise<NewsAPIResponse>;
    });

    if (response.status !== 'ok') {
      throw new Error('NewsAPI returned error status');
    }

    // Convert to RawSignalItem format
    return response.articles
      .filter((article) => article.title && article.url)
      .map((article) => this.convertArticleToRawItem(article));
  }

  /**
   * Fallback: Fetch from Google News RSS feed
   *
   * Used when NewsAPI key is not configured or API fails.
   *
   * @param params Fetch parameters
   * @returns Array of raw news items
   */
  private async fetchFromGoogleNewsRSS(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    log.info('Using RSS fallback for news fetching');
    return fetchAllRSSFallback('news', params.keywords, params.maxSignals);
  }

  /**
   * Convert news article to raw signal item
   *
   * @param article Article from API
   * @returns Raw signal item
   */
  private convertArticleToRawItem(article: NewsArticle): RawSignalItem {
    return {
      id: this.generateArticleId(article),
      title: article.title,
      description: article.description || article.content || 'No description available.',
      url: article.url,
      date: new Date(article.publishedAt),
      metadata: {
        source: article.source.name,
        author: article.author || 'Unknown',
        imageUrl: article.urlToImage,
        publishedAt: article.publishedAt,
      },
    };
  }

  /**
   * Generate unique ID for article
   *
   * NewsAPI doesn't provide IDs, so we generate one from URL
   *
   * @param article Article object
   * @returns Unique ID
   */
  private generateArticleId(article: NewsArticle): string {
    // Use URL hash as ID
    const url = article.url;
    const hash = this.hashString(url);
    return `news-${hash}`;
  }

  /**
   * Simple string hash function
   *
   * @param str String to hash
   * @returns Hash as string
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}

/**
 * Create and export singleton instance
 */
export const newsFetcher = new NewsFetcher();
