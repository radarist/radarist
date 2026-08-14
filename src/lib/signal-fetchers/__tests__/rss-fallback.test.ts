/**
 * @file lib/signal-fetchers/__tests__/rss-fallback.test.ts
 * @description Unit tests for RSS fallback fetcher
 */

import {
  fetchGoogleNewsRSS,
  fetchHackerNewsRSS,
  fetchArxivRSS,
  fetchAllRSSFallback,
  hasRSSFallback,
} from '../rss-fallback';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('RSS Fallback', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('hasRSSFallback()', () => {
    it('should return true for news source', () => {
      expect(hasRSSFallback('news')).toBe(true);
    });

    it('should return true for papers source', () => {
      expect(hasRSSFallback('papers')).toBe(true);
    });

    it('should return false for patents source', () => {
      expect(hasRSSFallback('patents')).toBe(false);
    });

    it('should return false for github source', () => {
      expect(hasRSSFallback('github')).toBe(false);
    });

    it('should return false for trends source', () => {
      expect(hasRSSFallback('trends')).toBe(false);
    });

    it('should return false for unknown source', () => {
      expect(hasRSSFallback('unknown')).toBe(false);
    });
  });

  describe('fetchGoogleNewsRSS()', () => {
    const sampleGoogleNewsRSS = `
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>AI breakthrough in quantum computing</title>
            <link>https://example.com/news/1</link>
            <description>Scientists announce major AI advancement</description>
            <pubDate>Mon, 06 Jan 2025 10:00:00 GMT</pubDate>
            <guid>https://example.com/news/1</guid>
          </item>
          <item>
            <title>New machine learning framework released</title>
            <link>https://example.com/news/2</link>
            <description>Open source ML framework gains traction</description>
            <pubDate>Sun, 05 Jan 2025 15:00:00 GMT</pubDate>
            <guid>https://example.com/news/2</guid>
          </item>
        </channel>
      </rss>
    `;

    it('should fetch and parse Google News RSS', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(sampleGoogleNewsRSS),
      });

      const results = await fetchGoogleNewsRSS(['AI', 'technology']);

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('AI breakthrough in quantum computing');
      expect(results[0].url).toBe('https://example.com/news/1');
      expect(results[0].metadata?.source).toBe('Google News');
    });

    it('should respect maxResults limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(sampleGoogleNewsRSS),
      });

      const results = await fetchGoogleNewsRSS(['AI'], 1);

      expect(results).toHaveLength(1);
    });

    it('should return empty array on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const results = await fetchGoogleNewsRSS(['AI']);

      expect(results).toEqual([]);
    });

    it('should return empty array on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const results = await fetchGoogleNewsRSS(['AI']);

      expect(results).toEqual([]);
    });
  });

  describe('fetchHackerNewsRSS()', () => {
    const sampleHNRSS = `
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Show HN: New AI Tool</title>
            <link>https://news.ycombinator.com/item?id=123</link>
            <description>A new tool for developers</description>
            <pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
            <guid>https://news.ycombinator.com/item?id=123</guid>
          </item>
        </channel>
      </rss>
    `;

    it('should fetch and parse Hacker News RSS', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(sampleHNRSS),
      });

      const results = await fetchHackerNewsRSS(['AI']);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Show HN: New AI Tool');
      expect(results[0].metadata?.source).toBe('Hacker News');
    });

    it('should return empty array on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const results = await fetchHackerNewsRSS(['AI']);

      expect(results).toEqual([]);
    });
  });

  describe('fetchArxivRSS()', () => {
    const sampleArxivAtom = `
      <?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2501.00001</id>
          <title>Deep Learning for Natural Language Processing</title>
          <summary>We present a new approach to NLP using transformer architectures...</summary>
          <published>2025-01-05T00:00:00Z</published>
          <link type="text/html" href="http://arxiv.org/abs/2501.00001"/>
          <link title="pdf" href="http://arxiv.org/pdf/2501.00001"/>
        </entry>
      </feed>
    `;

    it('should fetch and parse arXiv Atom feed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(sampleArxivAtom),
      });

      const results = await fetchArxivRSS(['deep learning']);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Deep Learning for Natural Language Processing');
      expect(results[0].metadata?.source).toBe('arXiv');
      expect(results[0].id).toContain('arxiv-');
    });

    it('should return empty array on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const results = await fetchArxivRSS(['AI']);

      expect(results).toEqual([]);
    });
  });

  describe('fetchAllRSSFallback()', () => {
    it('should fetch news from multiple sources', async () => {
      const googleRSS = `
        <rss><channel>
          <item>
            <title>Google News Item</title>
            <link>https://google.com/1</link>
            <description>Test</description>
            <pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
          </item>
        </channel></rss>
      `;
      const hnRSS = `
        <rss><channel>
          <item>
            <title>HN Item</title>
            <link>https://hn.com/1</link>
            <description>Test</description>
            <pubDate>Mon, 06 Jan 2025 11:00:00 GMT</pubDate>
          </item>
        </channel></rss>
      `;

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(googleRSS) })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(hnRSS) });

      const results = await fetchAllRSSFallback('news', ['AI']);

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should fetch papers from arXiv', async () => {
      const arxivRSS = `
        <feed><entry>
          <id>http://arxiv.org/abs/123</id>
          <title>Paper Title</title>
          <summary>Summary</summary>
          <published>2025-01-05T00:00:00Z</published>
        </entry></feed>
      `;

      mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(arxivRSS) });

      const results = await fetchAllRSSFallback('papers', ['AI']);

      expect(results).toHaveLength(1);
    });

    it('should return empty array for unsupported sources', async () => {
      const results = await fetchAllRSSFallback('patents', ['AI']);
      expect(results).toEqual([]);
    });

    it('should handle trends source with warning', async () => {
      const results = await fetchAllRSSFallback('trends', ['AI']);
      expect(results).toEqual([]);
    });
  });

  describe('HTML entity decoding', () => {
    it('should decode common HTML entities', async () => {
      const rssWithEntities = `
        <rss><channel>
          <item>
            <title>Test &amp; Demo &quot;Example&quot;</title>
            <link>https://example.com</link>
            <description>It&apos;s &lt;great&gt;</description>
            <pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
          </item>
        </channel></rss>
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(rssWithEntities),
      });

      const results = await fetchGoogleNewsRSS(['test']);

      expect(results[0].title).toBe('Test & Demo "Example"');
      expect(results[0].description).toContain("It's");
    });
  });

  describe('CDATA handling', () => {
    it('should handle CDATA sections', async () => {
      const rssWithCDATA = `
        <rss><channel>
          <item>
            <title><![CDATA[CDATA Title Here]]></title>
            <link>https://example.com</link>
            <description><![CDATA[Description with <b>HTML</b>]]></description>
            <pubDate>Mon, 06 Jan 2025 12:00:00 GMT</pubDate>
          </item>
        </channel></rss>
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(rssWithCDATA),
      });

      const results = await fetchGoogleNewsRSS(['test']);

      expect(results[0].title).toBe('CDATA Title Here');
    });
  });

  describe('Retry logic', () => {
    it('should retry on failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('<rss><channel></channel></rss>'),
        });

      const results = await fetchGoogleNewsRSS(['AI']);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(results).toEqual([]);
    });
  });
});
