/**
 * @file lib/signal-fetchers/rss-fallback.ts
 * @description RSS fallback fetcher for when primary APIs are unavailable
 *
 * Provides fallback signal fetching using RSS feeds when primary APIs:
 * - Are not configured (no API key)
 * - Are rate-limited
 * - Are experiencing downtime
 *
 * **Supported RSS Sources:**
 * - Google News RSS
 * - Tech news sites (TechCrunch, Hacker News, etc.)
 * - Patent RSS feeds
 * - Research paper feeds (arXiv)
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import type { RawSignalItem } from './base-fetcher';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/rss');

/**
 * RSS feed configuration
 */
interface RSSFeedConfig {
  url: string;
  name: string;
  type: 'news' | 'patents' | 'papers' | 'github' | 'general';
}

/**
 * Parsed RSS item
 */
interface RSSItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid?: string;
  author?: string;
  category?: string[];
}

/**
 * Available RSS feeds for fallback
 */
const _RSS_FEEDS: Record<string, RSSFeedConfig[]> = {
  news: [
    { url: 'https://news.google.com/rss/search?q=', name: 'Google News', type: 'news' },
    { url: 'https://hnrss.org/newest?q=', name: 'Hacker News', type: 'news' },
    { url: 'https://techcrunch.com/feed/', name: 'TechCrunch', type: 'news' },
  ],
  patents: [{ url: 'https://patents.google.com/rss?q=', name: 'Google Patents', type: 'patents' }],
  papers: [{ url: 'http://export.arxiv.org/api/query?search_query=', name: 'arXiv', type: 'papers' }],
  github: [{ url: 'https://github.com/trending.atom', name: 'GitHub Trending', type: 'github' }],
};

/**
 * Parse RSS XML into items
 */
function parseRSSXML(xml: string): RSSItem[] {
  const items: RSSItem[] = [];

  try {
    // Simple regex-based RSS parser (works in Node.js environment)
    // For production, consider using a proper XML parser

    // Match <item> or <entry> blocks (RSS 2.0 or Atom)
    const itemRegex = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
    const matches = Array.from(xml.matchAll(itemRegex));

    for (const match of matches) {
      const itemContent = match[1] || match[2] || '';

      // Extract fields with fallbacks for different RSS formats
      const rawTitle = extractTag(itemContent, 'title') || 'No title';
      const link = extractTag(itemContent, 'link') || extractAttr(itemContent, 'link', 'href') || '';
      const rawDescription =
        extractTag(itemContent, 'description') ||
        extractTag(itemContent, 'summary') ||
        extractTag(itemContent, 'content') ||
        '';
      const pubDate =
        extractTag(itemContent, 'pubDate') ||
        extractTag(itemContent, 'published') ||
        extractTag(itemContent, 'updated') ||
        new Date().toISOString();
      const guid = extractTag(itemContent, 'guid') || extractTag(itemContent, 'id') || link;

      if (rawTitle && link) {
        items.push({
          title: cleanText(rawTitle),
          link,
          description: cleanText(rawDescription),
          pubDate,
          guid,
        });
      }
    }
  } catch (error) {
    log.error('Failed to parse RSS XML', error instanceof Error ? error : undefined);
  }

  return items;
}

/**
 * Clean RSS field text: decode HTML entities FIRST (so encoded `&lt;a&gt;`
 * becomes real `<a>`), then strip tags, then decode once more to catch any
 * double-encoded sequences (Google News does this). Finally collapse
 * whitespace so the UI doesn't render ragged blobs.
 *
 * Previous order (strip -> decode) failed for Google News RSS because the
 * raw descriptions arrive HTML-encoded, so stripHTML saw no tags and left
 * them intact after decode. Symptom: signal descriptions rendered as
 * `<a href="...">Title</a> <font color="...">BBC</font>` in the UI.
 */
function cleanText(raw: string): string {
  if (!raw) return '';
  const decoded = decodeHTMLEntities(raw);
  const stripped = stripHTML(decoded);
  const doubled = decodeHTMLEntities(stripped);
  return doubled.replace(/\s+/g, ' ').trim();
}

/**
 * Extract text content from XML tag
 */
function extractTag(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : undefined;
}

/**
 * Extract attribute value from XML tag
 */
function extractAttr(xml: string, tagName: string, attrName: string): string | undefined {
  const regex = new RegExp(`<${tagName}[^>]*${attrName}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : undefined;
}

/**
 * Decode HTML entities
 */
function decodeHTMLEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };

  return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Strip HTML tags from text
 */
function stripHTML(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Fetch RSS feed with retry logic
 */
async function fetchRSS(url: string, retries: number = 3): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Radarist/1.0 (Innovation Platform; +https://radarist.ai)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.warn('RSS fetch attempt failed', { attempt, retries, url, error: lastError.message });

      if (attempt < retries) {
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw lastError || new Error('RSS fetch failed');
}

/**
 * Fetch news from Google News RSS
 */
export async function fetchGoogleNewsRSS(keywords: string[], maxResults: number = 20): Promise<RawSignalItem[]> {
  try {
    const query = encodeURIComponent(keywords.join(' OR '));
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    log.debug('Fetching Google News RSS', { url });
    const xml = await fetchRSS(url);
    const items = parseRSSXML(xml);

    return items.slice(0, maxResults).map((item) => ({
      id: `gnews-${hashString(item.guid || item.link)}`,
      title: item.title,
      description: item.description || 'No description available.',
      url: item.link,
      date: new Date(item.pubDate),
      metadata: {
        source: 'Google News',
        type: 'news',
      },
    }));
  } catch (error) {
    log.error('Google News RSS fetch failed', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Fetch news from Hacker News RSS
 */
export async function fetchHackerNewsRSS(keywords: string[], maxResults: number = 20): Promise<RawSignalItem[]> {
  try {
    const query = encodeURIComponent(keywords.join(' '));
    const url = `https://hnrss.org/newest?q=${query}&points=10`;

    log.debug('Fetching Hacker News RSS', { url });
    const xml = await fetchRSS(url);
    const items = parseRSSXML(xml);

    return items.slice(0, maxResults).map((item) => ({
      id: `hn-${hashString(item.guid || item.link)}`,
      title: item.title,
      description: item.description || 'No description available.',
      url: item.link,
      date: new Date(item.pubDate),
      metadata: {
        source: 'Hacker News',
        type: 'news',
      },
    }));
  } catch (error) {
    log.error('Hacker News RSS fetch failed', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Fetch papers from arXiv RSS
 */
export async function fetchArxivRSS(keywords: string[], maxResults: number = 20): Promise<RawSignalItem[]> {
  try {
    // arXiv uses a different API format
    const query = keywords.map((k) => `all:${k}`).join('+OR+');
    const url = `http://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

    log.debug('Fetching arXiv RSS', { url });
    const xml = await fetchRSS(url);

    // arXiv uses Atom format
    const items: RawSignalItem[] = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    const matches = Array.from(xml.matchAll(entryRegex));

    for (const match of matches) {
      const entry = match[1];
      const id = extractTag(entry, 'id') || '';
      const title = extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim() || 'No title';
      const summary = extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim() || '';
      const published = extractTag(entry, 'published') || new Date().toISOString();

      // Extract link with PDF
      const pdfLink = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/)?.[1];
      const absLink = entry.match(/<link[^>]*type="text\/html"[^>]*href="([^"]*)"/)?.[1];
      const link = absLink || pdfLink || id;

      items.push({
        id: `arxiv-${hashString(id)}`,
        title: decodeHTMLEntities(title),
        description: decodeHTMLEntities(summary.slice(0, 500)),
        url: link,
        date: new Date(published),
        metadata: {
          source: 'arXiv',
          type: 'paper',
          arxivId: id.split('/').pop(),
        },
      });
    }

    return items.slice(0, maxResults);
  } catch (error) {
    log.error('arXiv RSS fetch failed', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Combined RSS fallback for all sources
 */
export async function fetchAllRSSFallback(
  source: 'news' | 'patents' | 'papers' | 'github' | 'trends',
  keywords: string[],
  maxResults: number = 20
): Promise<RawSignalItem[]> {
  log.info('Fetching RSS fallback', { source, keywords });

  switch (source) {
    case 'news': {
      // Try multiple news sources in parallel
      const [googleNews, hackerNews] = await Promise.allSettled([
        fetchGoogleNewsRSS(keywords, maxResults),
        fetchHackerNewsRSS(keywords, Math.ceil(maxResults / 2)),
      ]);

      const results: RawSignalItem[] = [];
      if (googleNews.status === 'fulfilled') results.push(...googleNews.value);
      if (hackerNews.status === 'fulfilled') results.push(...hackerNews.value);

      // Sort by date and return limited results
      return results.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, maxResults);
    }

    case 'papers':
      return fetchArxivRSS(keywords, maxResults);

    case 'patents':
      // Google Patents RSS requires specific formatting
      log.warn('Patent RSS not fully implemented');
      return [];

    case 'github':
      // GitHub trending is not keyword-searchable via RSS
      log.warn('GitHub RSS not fully implemented');
      return [];

    case 'trends':
      // Trends require Google Trends API
      log.warn('Trends RSS not available');
      return [];

    default:
      return [];
  }
}

/**
 * Simple string hash function
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check if RSS fallback is available for a source
 */
export function hasRSSFallback(source: string): boolean {
  return ['news', 'papers'].includes(source);
}
