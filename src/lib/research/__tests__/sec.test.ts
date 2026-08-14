/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/sec.test.ts
 * @description Unit tests for `searchSecFilings` (SEC EDGAR full-text search).
 * The upstream `politeFetch` is mocked (jest.mock('../http')) so no network is
 * hit — mirrors the fetch-mock idiom in papers.test.ts.
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

import { searchSecFilings } from '../sec';
import { ResearchFetchError } from '../http';

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

const FILING_HIT = {
  _id: '0001628280-25-032604:ai-20250430.htm',
  _source: {
    adsh: '0001628280-25-032604',
    ciks: ['0001577526'],
    form: '10-K',
    root_forms: ['10-K'],
    display_names: ['C3.ai, Inc.  (AI)  (CIK 0001577526)'],
    file_date: '2025-06-23',
    file_description: 'Annual report',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmail.mockReturnValue(undefined);
});

describe('searchSecFilings — happy path', () => {
  it('maps real _source fields (ciks/form/file_date/file_description) and cleans the company display name', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: { hits: [FILING_HIT] } }));

    const { data, error } = await searchSecFilings({ query: 'c3.ai' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    const r = data[0];
    expect(r.company).toBe('C3.ai, Inc.');
    expect(r.cik).toBe('0001577526');
    expect(r.formType).toBe('10-K');
    expect(r.filedAt).toBe('2025-06-23');
    expect(r.snippet).toBe('Annual report');
  });

  it('builds the filing index URL from adsh + ciks[0] (accession, no-dash accession, stripped cik)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: { hits: [FILING_HIT] } }));

    const { data } = await searchSecFilings({ query: 'c3.ai' });

    expect(data[0].url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1577526/000162828025032604/0001628280-25-032604-index.htm'
    );
  });

  it('maps snippet to null when file_description is absent', async () => {
    const { file_description: _unused, ...sourceWithoutDescription } = FILING_HIT._source;
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({ hits: { hits: [{ _id: FILING_HIT._id, _source: sourceWithoutDescription }] } })
    );

    const { data } = await searchSecFilings({ query: 'c3.ai' });

    expect(data[0].snippet).toBeNull();
  });

  it('builds the query URL with q= and appends &forms= when formTypes is given', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: { hits: [FILING_HIT] } }));

    await searchSecFilings({ query: 'c3.ai', formTypes: ['10-K', '10-Q'] });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('efts.sec.gov/LATEST/search-index');
    expect(calledUrl).toContain('q=c3.ai');
    expect(calledUrl).toContain('forms=10-K%2C10-Q');
  });

  it('omits &forms= when formTypes is not given', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: { hits: [FILING_HIT] } }));

    await searchSecFilings({ query: 'c3.ai' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('forms=');
  });
});

describe('searchSecFilings — degradation', () => {
  it('returns { data: [] } with error undefined on a genuine empty result set', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: { hits: [] } }));

    const { data, error } = await searchSecFilings({ query: 'nothing' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('sets error + logs the SEC User-Agent hint when the upstream fetch rejects with a ResearchFetchError (e.g. 403)', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 403 for x', 403));

    const { data, error } = await searchSecFilings({ query: 'boom' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
    expect(error).toContain('403');
    expect(mockLogWarn).toHaveBeenCalled();
    const [message] = mockLogWarn.mock.calls[0];
    expect(String(message).toLowerCase()).toMatch(/user-agent/);
  });

  it('skips entries missing required fields (no ciks / no adsh) without throwing', async () => {
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        hits: {
          hits: [
            { _source: { display_names: ['NO CIK CO'], form: '10-K', file_date: '2023-01-01' } }, // no ciks, no adsh
            FILING_HIT,
          ],
        },
      })
    );

    const { data, error } = await searchSecFilings({ query: 'x' });

    expect(error).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].company).toBe('C3.ai, Inc.');
  });

  it('sets error when the response shape is entirely wrong (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ hits: 'not-an-object' }));

    const { data, error } = await searchSecFilings({ query: 'x' });

    expect(data).toEqual([]);
    expect(error).toBeDefined();
  });

  it('returns { data: [] } with error undefined for a blank query without fetching', async () => {
    const { data, error } = await searchSecFilings({ query: '  ' });

    expect(data).toEqual([]);
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });
});
