/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/patents.test.ts
 * @description Unit tests for `searchPatents` (Google Patents xhr/query). The
 * upstream `politeFetch` is mocked (jest.mock('../http')) so no network is hit
 * — mirrors the fetch-mock idiom in oss-health.test.ts / papers.test.ts.
 */

// ============================================================================
// Mocks
// ============================================================================

const mockPoliteFetch = jest.fn();

jest.mock('../http', () => ({
  __esModule: true,
  politeFetch: (...args: unknown[]) => mockPoliteFetch(...args),
  getResearchContactEmail: () => undefined,
  ResearchFetchError: class ResearchFetchError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'ResearchFetchError';
      this.status = status;
    }
  },
}));

const mockLogWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import { searchPatents, __resetPatentsThrottleForTest, MIN_REQUEST_INTERVAL_MS } from '../patents';
import { ResearchFetchError } from '../http';

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

const PATENT = {
  title: 'Identifying and analyzing <b>actions</b> from vector representations &hellip;',
  snippet: 'A <b>method</b> for retrieval augmented generation &amp; ranking',
  assignee: 'Citibank, N.A.',
  inventor: 'Shardul Malviya',
  priority_date: '2024-04-11',
  filing_date: '2024-07-23',
  grant_date: '2025-01-14',
  publication_date: '2025-01-14',
  publication_number: 'US12197859B1',
};

function googleBody(patents: unknown[], total = 21888) {
  return {
    results: {
      total_num_results: total,
      cluster: [{ result: patents.map((p) => ({ id: 'patent/US12197859B1/en', patent: p })) }],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Module-level request spacing is process-wide; reset it so a prior test's
  // reservation doesn't make the next test's single call wait 2s.
  __resetPatentsThrottleForTest();
});

describe('searchPatents — happy path', () => {
  it('maps patent fields, strips HTML/entities from title + snippet, and carries totalResults', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([PATENT])));

    const { data, error } = await searchPatents({ query: 'retrieval augmented generation' });

    expect(error).toBeUndefined();
    expect(data.source).toBe('google-patents');
    expect(data.totalResults).toBe(21888);
    expect(data.patents).toHaveLength(1);
    const p = data.patents[0];
    expect(p.patentNumber).toBe('US12197859B1');
    expect(p.title).toBe('Identifying and analyzing actions from vector representations …');
    expect(p.snippet).toBe('A method for retrieval augmented generation & ranking');
    expect(p.assignee).toBe('Citibank, N.A.');
    expect(p.inventor).toBe('Shardul Malviya');
    expect(p.priorityDate).toBe('2024-04-11');
    expect(p.filingDate).toBe('2024-07-23');
    expect(p.grantDate).toBe('2025-01-14');
    expect(p.publicationDate).toBe('2025-01-14');
    expect(p.url).toBe('https://patents.google.com/patent/US12197859B1/en');
  });

  it('builds the xhr/query URL with the encoded query + num, and sends a browser User-Agent', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([PATENT])));

    await searchPatents({ query: 'vector database', limit: 40 });

    const [url, opts] = mockPoliteFetch.mock.calls[0] as [string, { userAgent?: string }];
    expect(url).toContain('patents.google.com/xhr/query');
    // inner query is url-encoded: q="vector database"&type=PATENT&num=40
    expect(decodeURIComponent(url)).toContain('q="vector database"&type=PATENT&num=40');
    expect(opts.userAgent).toMatch(/Mozilla\/5\.0/);
  });

  it('clamps limit into 1..100', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([PATENT])));
    await searchPatents({ query: 'x', limit: 5000 });
    expect(decodeURIComponent(mockPoliteFetch.mock.calls[0][0] as string)).toContain('num=100');
  });

  it('never invents missing fields — absent dates/assignee map to null', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([{ publication_number: 'US1B', title: 'Bare' }])));

    const { data, error } = await searchPatents({ query: 'x' });

    expect(error).toBeUndefined();
    const p = data.patents[0];
    expect(p.assignee).toBeNull();
    expect(p.inventor).toBeNull();
    expect(p.priorityDate).toBeNull();
    expect(p.filingDate).toBeNull();
  });

  it('preserves the full totalResults count independent of how many filings were sampled', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([PATENT, PATENT], 9999)));

    const { data } = await searchPatents({ query: 'x', limit: 2 });

    expect(data.totalResults).toBe(9999);
    expect(data.patents).toHaveLength(2);
  });

  it('returns empty patents (no error) when the response legitimately has zero results', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ results: { total_num_results: 0, cluster: [] } }));

    const { data, error } = await searchPatents({ query: 'nonexistent-xyzzy-topic' });

    expect(error).toBeUndefined();
    expect(data.totalResults).toBe(0);
    expect(data.patents).toEqual([]);
  });
});

describe('searchPatents — degradation (never fabricates)', () => {
  it('returns a typed-empty result for a blank query WITHOUT fetching and WITHOUT error', async () => {
    const { data, error } = await searchPatents({ query: '   ' });

    expect(error).toBeUndefined();
    expect(data).toEqual({ totalResults: 0, patents: [], source: 'google-patents' });
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });

  it('retries once (backoff) then, on a persistent 503, sets an error + empty data — never fabricated filings', async () => {
    jest.useFakeTimers();
    try {
      mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 503 for x', 503));

      const p = searchPatents({ query: 'crowded space' });
      await jest.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS + 500); // past the single backoff
      const { data, error } = await p;

      expect(data).toEqual({ totalResults: 0, patents: [], source: 'google-patents' });
      expect(error).toBeDefined();
      expect(error).toContain('503');
      expect(error).toMatch(/rate-limit/i);
      expect(mockPoliteFetch).toHaveBeenCalledTimes(2); // initial + 1 retry
      expect(mockLogWarn).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers: a 503 that clears on retry returns real data (no fabrication needed)', async () => {
    jest.useFakeTimers();
    try {
      mockPoliteFetch
        .mockRejectedValueOnce(new ResearchFetchError('Upstream 503 for x', 503))
        .mockResolvedValueOnce(jsonResponse(googleBody([PATENT])));

      const p = searchPatents({ query: 'x' });
      await jest.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS + 500);
      const { data, error } = await p;

      expect(error).toBeUndefined();
      expect(data.patents).toHaveLength(1);
      expect(mockPoliteFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT retry a non-rate-limit error (e.g. a generic network failure) — fails fast', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('network down'));

    const { data, error } = await searchPatents({ query: 'x' });

    expect(data.patents).toEqual([]);
    expect(error).toBeDefined();
    expect(mockPoliteFetch).toHaveBeenCalledTimes(1); // no retry
  });

  it('sets an error + empty data when the response shape is malformed (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ results: { total_num_results: 'lots' } }));

    const { data, error } = await searchPatents({ query: 'x' });

    expect(data.patents).toEqual([]);
    expect(error).toBeDefined();
  });
});

describe('searchPatents — request spacing (avoids tripping the rate limit)', () => {
  it('holds a rapid second call for ~MIN_REQUEST_INTERVAL_MS before it hits the network', async () => {
    jest.useFakeTimers();
    try {
      mockPoliteFetch.mockResolvedValue(jsonResponse(googleBody([PATENT])));

      const p1 = searchPatents({ query: 'a' });
      const p2 = searchPatents({ query: 'b' });

      // First call fires straight away; the second is gated behind the spacing.
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPoliteFetch).toHaveBeenCalledTimes(1);

      // Only after the interval elapses does the second request go out.
      await jest.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS);
      expect(mockPoliteFetch).toHaveBeenCalledTimes(2);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.error).toBeUndefined();
      expect(r2.error).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
