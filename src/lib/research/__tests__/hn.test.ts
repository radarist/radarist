/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/hn.test.ts
 * @description Unit tests for `searchHackerNews` (HN Algolia). The upstream
 * `politeFetch` is mocked (jest.mock('../http')) so no network is hit —
 * mirrors the fetch-mock idiom in papers.test.ts.
 */

// ============================================================================
// Mocks
// ============================================================================

const mockPoliteFetch = jest.fn();
const mockGetEmail = jest.fn<string | undefined, []>(() => undefined);

jest.mock('../http', () => ({
  __esModule: true,
  politeFetch: (...args: unknown[]) => mockPoliteFetch(...args),
  getResearchContactEmail: () => mockGetEmail(),
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

import { searchHackerNews } from '../hn';
import { ResearchFetchError } from '../http';

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

const HITS_BODY = {
  hits: [
    {
      objectID: '12345',
      title: 'Show HN: A new keyless research tool',
      url: 'https://example.com/post',
      points: 250,
      num_comments: 42,
      author: 'pg',
      created_at: '2026-01-01T12:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmail.mockReturnValue(undefined);
});

describe('searchHackerNews — happy path', () => {
  it('maps hits fields with renames (numComments, createdAt)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(HITS_BODY));

    const { data, error } = await searchHackerNews({ query: 'radarist' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    const r = data[0];
    expect(r.objectID).toBe('12345');
    expect(r.title).toBe('Show HN: A new keyless research tool');
    expect(r.url).toBe('https://example.com/post');
    expect(r.points).toBe(250);
    expect(r.numComments).toBe(42);
    expect(r.author).toBe('pg');
    expect(r.createdAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('builds the URL with default limit:10 and tags:story', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(HITS_BODY));

    await searchHackerNews({ query: 'radarist' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('hn.algolia.com/api/v1/search');
    expect(calledUrl).toContain('query=radarist');
    expect(calledUrl).toContain('tags=story');
    expect(calledUrl).toContain('hitsPerPage=10');
  });

  it('honors a custom limit and tags', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(HITS_BODY));

    await searchHackerNews({ query: 'radarist', limit: 3, tags: 'comment' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('hitsPerPage=3');
    expect(calledUrl).toContain('tags=comment');
  });

  it('defaults points/numComments to 0 when omitted', async () => {
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        hits: [
          {
            objectID: '999',
            title: 'No engagement fields',
            url: null,
            author: 'nobody',
            created_at: '2026-02-01T00:00:00.000Z',
          },
        ],
      })
    );

    const { data, error } = await searchHackerNews({ query: 'x' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].points).toBe(0);
    expect(data[0].numComments).toBe(0);
    expect(data[0].url).toBeNull();
  });
});

describe('searchHackerNews — degradation', () => {
  it('returns { data: [] } with error undefined on a genuine empty result set', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: [] }));

    const { data, error } = await searchHackerNews({ query: 'nothing' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('sets error (not just an empty array) when the upstream fetch rejects with a ResearchFetchError', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 503 for x', 503));

    const { data, error } = await searchHackerNews({ query: 'boom' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
    expect(error).toContain('503');
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('skips entries missing required fields (no title / no objectID) without throwing', async () => {
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        hits: [
          { objectID: '1' }, // no title -> skipped
          {
            objectID: '2',
            title: 'Valid Story',
            url: 'https://example.com/valid',
            points: 10,
            num_comments: 1,
            author: 'someone',
            created_at: '2026-03-01T00:00:00.000Z',
          },
        ],
      })
    );

    const { data, error } = await searchHackerNews({ query: 'x' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Valid Story');
  });

  it('sets error when the response shape is entirely wrong (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: 'not-an-array' }));

    const { data, error } = await searchHackerNews({ query: 'x' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
  });

  it('returns { data: [] } with error undefined for a blank query without fetching', async () => {
    const { data, error } = await searchHackerNews({ query: '  ' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });
});
