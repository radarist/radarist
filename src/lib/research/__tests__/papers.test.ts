/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/papers.test.ts
 * @description Unit tests for `searchPapers` (OpenAlex + Crossref + Semantic
 * Scholar). The upstream `politeFetch` is mocked (jest.mock('../http')) so each
 * source's JSON body is controlled and no network is hit — mirrors the
 * fetch-mock idiom in src/lib/ai/tools/__tests__/web-research.test.ts.
 *
 * `formatIeeeCitation` (from ../citation) is NOT mocked: the mapped `citation`
 * field is produced by the real citation module so we assert it's non-empty.
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
const mockLogError = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  // Lazy arrows: `createLogger` is invoked at citation.ts import time (before the
  // `const mockLog*` below are initialized), so the factory must not read them eagerly.
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import { searchPapers } from '../papers';
import { ResearchFetchError } from '../http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

const OPENALEX_BODY = {
  results: [
    {
      title: 'Attention Is All You Need',
      publication_year: 2017,
      cited_by_count: 100000,
      doi: 'https://doi.org/10.5555/3295222.3295349',
      authorships: [{ author: { display_name: 'Ashish Vaswani' } }, { author: { display_name: 'Noam Shazeer' } }],
      primary_location: { landing_page_url: 'https://openalex.example/W1' },
      abstract_inverted_index: { The: [0], model: [1] },
    },
  ],
};

const CROSSREF_BODY = {
  message: {
    items: [
      {
        title: ['Deep Residual Learning for Image Recognition'],
        author: [
          { given: 'Kaiming', family: 'He' },
          { given: 'Xiangyu', family: 'Zhang' },
        ],
        created: { 'date-parts': [[2016, 6, 27]] },
        'is-referenced-by-count': 50000,
        DOI: '10.1109/CVPR.2016.90',
        URL: 'https://doi.org/10.1109/CVPR.2016.90',
        abstract: '<jats:p>We present a residual learning framework.</jats:p>',
      },
    ],
  },
};

const S2_BODY = {
  data: [
    {
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      abstract: 'We introduce a new language representation model called BERT.',
      year: 2019,
      citationCount: 60000,
      url: 'https://www.semanticscholar.org/paper/abc',
      authors: [{ name: 'Jacob Devlin' }, { name: 'Ming-Wei Chang' }],
      externalIds: { DOI: '10.18653/v1/N19-1423' },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmail.mockReturnValue(undefined);
});

// ============================================================================
// Per-source happy paths
// ============================================================================

describe('searchPapers — OpenAlex', () => {
  it('maps OpenAlex fields and fills a non-empty citation', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(OPENALEX_BODY));

    const { data, error } = await searchPapers({ query: 'transformers', source: 'openalex' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    const p = data[0];
    expect(p.source).toBe('openalex');
    expect(p.title).toBe('Attention Is All You Need');
    expect(p.year).toBe(2017);
    expect(p.citationCount).toBe(100000);
    expect(p.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(p.url).toBe('https://openalex.example/W1');
    // DOI is stripped of the https://doi.org/ prefix.
    expect(p.doi).toBe('10.5555/3295222.3295349');
    // Inverted-index abstracts are deliberately not reconstructed.
    expect(p.abstract).toBeNull();
    expect(p.citation).toContain('Attention Is All You Need');
    expect(p.citation.length).toBeGreaterThan(0);
  });

  it('appends &mailto when a contact email is configured', async () => {
    mockGetEmail.mockReturnValue('me@example.com');
    mockPoliteFetch.mockResolvedValue(jsonResponse(OPENALEX_BODY));

    await searchPapers({ query: 'transformers', source: 'openalex' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('mailto=me%40example.com');
  });

  it('applies the yearFrom filter to the OpenAlex URL', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(OPENALEX_BODY));

    await searchPapers({ query: 'transformers', source: 'openalex', yearFrom: 2020 });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('from_publication_date:2020-01-01');
  });

  it('coerces a numeric-string yearFrom (e.g. arriving over MCP) and still applies the filter', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(OPENALEX_BODY));

    await searchPapers({
      query: 'transformers',
      source: 'openalex',
      yearFrom: '2021' as unknown as number,
    });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('from_publication_date:2021-01-01');
  });

  it('drops a non-numeric yearFrom rather than interpolating it raw into the URL', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(OPENALEX_BODY));

    await searchPapers({
      query: 'transformers',
      source: 'openalex',
      yearFrom: 'not-a-year' as unknown as number,
    });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('from_publication_date');
    expect(calledUrl).not.toContain('not-a-year');
  });
});

describe('searchPapers — Crossref', () => {
  it('maps Crossref fields (title[0], author given+family, date-parts year) and fills a citation', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(CROSSREF_BODY));

    const { data, error } = await searchPapers({ query: 'resnet', source: 'crossref' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    const p = data[0];
    expect(p.source).toBe('crossref');
    expect(p.title).toBe('Deep Residual Learning for Image Recognition');
    expect(p.authors).toEqual(['Kaiming He', 'Xiangyu Zhang']);
    expect(p.year).toBe(2016);
    expect(p.citationCount).toBe(50000);
    expect(p.doi).toBe('10.1109/CVPR.2016.90');
    expect(p.url).toBe('https://doi.org/10.1109/CVPR.2016.90');
    expect(p.abstract).toContain('residual learning framework');
    expect(p.citation.length).toBeGreaterThan(0);
  });

  it('strips JATS/XML markup from the Crossref abstract', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(CROSSREF_BODY));

    const { data } = await searchPapers({ query: 'resnet', source: 'crossref' });

    expect(data).toHaveLength(1);
    expect(data[0].abstract).toBe('We present a residual learning framework.');
    expect(data[0].abstract).not.toMatch(/<[^>]+>/);
  });

  it('preserves a null abstract when Crossref omits it', async () => {
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        message: {
          items: [
            {
              title: ['No Abstract Paper'],
              author: [{ given: 'A.', family: 'Author' }],
              created: { 'date-parts': [[2020]] },
              DOI: '10.1/no-abstract',
              URL: 'https://doi.org/10.1/no-abstract',
              // abstract omitted entirely
            },
          ],
        },
      })
    );

    const { data } = await searchPapers({ query: 'x', source: 'crossref' });

    expect(data).toHaveLength(1);
    expect(data[0].abstract).toBeNull();
  });
});

describe('searchPapers — Semantic Scholar', () => {
  it('maps Semantic Scholar fields (authors[].name, externalIds.DOI) and fills a citation', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(S2_BODY));

    const { data, error } = await searchPapers({ query: 'bert', source: 'semantic-scholar' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    const p = data[0];
    expect(p.source).toBe('semantic-scholar');
    expect(p.title).toBe('BERT: Pre-training of Deep Bidirectional Transformers');
    expect(p.authors).toEqual(['Jacob Devlin', 'Ming-Wei Chang']);
    expect(p.year).toBe(2019);
    expect(p.citationCount).toBe(60000);
    expect(p.doi).toBe('10.18653/v1/N19-1423');
    expect(p.url).toBe('https://www.semanticscholar.org/paper/abc');
    expect(p.abstract).toContain('BERT');
    expect(p.citation.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Empty / error / malformed
// ============================================================================

describe('searchPapers — degradation', () => {
  it('returns { data: [] } with error undefined on a genuine empty result set', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ results: [] }));

    const { data, error } = await searchPapers({ query: 'nothing', source: 'openalex' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('sets error (not just an empty array) when the upstream fetch rejects with a ResearchFetchError', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 503 for x', 503));

    const { data, error } = await searchPapers({ query: 'boom', source: 'openalex' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
    expect(error).toContain('503');
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('skips entries missing required fields without throwing', async () => {
    // One entry has no title → skipped; the valid entry survives.
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        results: [
          { cited_by_count: 5 }, // no title / no url → skipped
          {
            title: 'Valid Paper',
            publication_year: 2021,
            primary_location: { landing_page_url: 'https://openalex.example/W2' },
          },
        ],
      })
    );

    const { data, error } = await searchPapers({ query: 'x', source: 'openalex' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Valid Paper');
  });

  it('sets error when the response shape is entirely wrong (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ results: 'not-an-array' }));

    const { data, error } = await searchPapers({ query: 'x', source: 'openalex' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
  });

  it('returns { data: [] } with error undefined for a blank query without fetching', async () => {
    const { data, error } = await searchPapers({ query: '   ' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });

  it("sets a top-level error for source: 'all' only when EVERY source fails", async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 500 for x', 500));

    const { data, error } = await searchPapers({ query: 'total failure', source: 'all' });

    expect(data).toEqual([]);
    expect(error).toBe('All paper sources failed');
  });
});

// ============================================================================
// source: 'all' — merge + dedup
// ============================================================================

describe("searchPapers — source: 'all'", () => {
  /** Route each source to its body based on the requested URL. */
  function routeByUrl(bodies: { openalex?: unknown; crossref?: unknown; s2?: unknown }): void {
    mockPoliteFetch.mockImplementation((url: string) => {
      if (url.includes('openalex.org')) return Promise.resolve(jsonResponse(bodies.openalex ?? { results: [] }));
      if (url.includes('crossref.org'))
        return Promise.resolve(jsonResponse(bodies.crossref ?? { message: { items: [] } }));
      if (url.includes('semanticscholar.org')) return Promise.resolve(jsonResponse(bodies.s2 ?? { data: [] }));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  }

  it('dedups the same paper by DOI (case-insensitive) across two sources', async () => {
    routeByUrl({
      openalex: {
        results: [
          {
            title: 'Shared Paper',
            publication_year: 2018,
            doi: 'https://doi.org/10.1145/ABC.123',
            authorships: [{ author: { display_name: 'A. Author' } }],
            primary_location: { landing_page_url: 'https://openalex.example/shared' },
          },
        ],
      },
      crossref: {
        message: {
          items: [
            {
              title: ['Shared Paper (Crossref copy)'],
              author: [{ given: 'A.', family: 'Author' }],
              created: { 'date-parts': [[2018]] },
              DOI: '10.1145/abc.123', // same DOI, lowercase
              URL: 'https://doi.org/10.1145/abc.123',
            },
          ],
        },
      },
      s2: { data: [] },
    });

    const { data, error } = await searchPapers({ query: 'shared', source: 'all' });

    // Both sources describe the same DOI → collapsed to a single result.
    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].doi?.toLowerCase()).toBe('10.1145/abc.123');
    // The first source (OpenAlex) wins.
    expect(data[0].source).toBe('openalex');
  });

  it('keeps distinct papers from different sources', async () => {
    routeByUrl({ openalex: OPENALEX_BODY, crossref: CROSSREF_BODY, s2: S2_BODY });

    const { data, error } = await searchPapers({ query: 'ml', source: 'all' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(3);
    expect(data.map((r) => r.source).sort()).toEqual(['crossref', 'openalex', 'semantic-scholar']);
  });

  it('still returns the good source (with no top-level error) when another source fails', async () => {
    mockPoliteFetch.mockImplementation((url: string) => {
      if (url.includes('openalex.org')) return Promise.resolve(jsonResponse(OPENALEX_BODY));
      return Promise.reject(new ResearchFetchError('down', 503));
    });

    const { data, error } = await searchPapers({ query: 'partial', source: 'all' });

    // A partial failure alongside a genuine success is NOT a top-level error.
    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].source).toBe('openalex');
  });

  it('keeps two papers that share a title but have different DOIs (DOI takes precedence)', async () => {
    routeByUrl({
      openalex: {
        results: [
          {
            title: 'Deep Learning for Vision',
            publication_year: 2018,
            doi: 'https://doi.org/10.1/A',
            authorships: [{ author: { display_name: 'A. Author' } }],
            primary_location: { landing_page_url: 'https://openalex.example/a' },
          },
        ],
      },
      crossref: {
        message: {
          items: [
            {
              title: ['Deep Learning for Vision'],
              author: [{ given: 'B.', family: 'Author' }],
              created: { 'date-parts': [[2019]] },
              DOI: '10.2/B',
              URL: 'https://doi.org/10.2/B',
            },
          ],
        },
      },
      s2: { data: [] },
    });

    const { data } = await searchPapers({ query: 'deep learning', source: 'all' });

    // Same normalized title, but distinct DOIs → both must be kept.
    expect(data).toHaveLength(2);
    expect(data.map((r) => r.doi).sort()).toEqual(['10.1/A', '10.2/B']);
  });

  it('caps merged + deduped results to `limit` when source is "all"', async () => {
    const makeResults = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ idx: i, prefix }));

    const limit = 5;
    routeByUrl({
      openalex: {
        results: makeResults(limit, 'oa').map(({ idx }) => ({
          title: `OpenAlex Paper ${idx}`,
          publication_year: 2020,
          doi: `10.oa/${idx}`,
          primary_location: { landing_page_url: `https://openalex.example/${idx}` },
        })),
      },
      crossref: {
        message: {
          items: makeResults(limit, 'cr').map(({ idx }) => ({
            title: [`Crossref Paper ${idx}`],
            created: { 'date-parts': [[2020]] },
            DOI: `10.cr/${idx}`,
            URL: `https://doi.org/10.cr/${idx}`,
          })),
        },
      },
      s2: {
        data: makeResults(limit, 's2').map(({ idx }) => ({
          title: `S2 Paper ${idx}`,
          year: 2020,
          url: `https://www.semanticscholar.org/paper/${idx}`,
          externalIds: { DOI: `10.s2/${idx}` },
        })),
      },
    });

    const { data, error } = await searchPapers({ query: 'capped', source: 'all', limit });

    // Each source returns `limit` distinct papers (15 total pre-trim) — the
    // merged+deduped output must still be trimmed to `limit`.
    expect(error).toBeUndefined();
    expect(data).toHaveLength(limit);
  });
});
