/**
 * @file lib/signal-fetchers/__tests__/research-adapter.test.ts
 * @description Unit tests for the PapersResearchFetcher, HackerNewsFetcher, and
 * SecFilingsFetcher — BaseFetcher adapters over the Component-A `searchPapers`
 * (OpenAlex + Crossref + Semantic Scholar), `searchHackerNews` (HN Algolia),
 * and `searchSecFilings` (SEC EDGAR full-text search) tools, replacing the
 * fragile arXiv XML fetcher and the RSS-scraped HN fallback respectively.
 */

// base-fetcher imports generateSlug from entity-factory, which pulls in the
// Firebase client SDK — mock it to break the initialization chain.
jest.mock('@/lib/entity-factory', () => ({
  generateSlug: jest.fn((name: string) => String(name).toLowerCase().replace(/\s+/g, '-')),
}));

jest.mock('@/lib/research/papers', () => ({ searchPapers: jest.fn() }));
jest.mock('@/lib/research/hn', () => ({ searchHackerNews: jest.fn() }));
jest.mock('@/lib/research/sec', () => ({ searchSecFilings: jest.fn() }));
jest.mock('@/lib/research/open-access', () => ({ resolveOpenAccess: jest.fn() }));

import { searchPapers } from '@/lib/research/papers';
import { searchHackerNews } from '@/lib/research/hn';
import { searchSecFilings } from '@/lib/research/sec';
import { resolveOpenAccess } from '@/lib/research/open-access';
import { papersResearchFetcher, hackerNewsFetcher, secFilingsFetcher } from '../research-adapter';
import type { PaperResult, HackerNewsResult, SecFilingResult } from '@/lib/research/types';

const mockSearchPapers = searchPapers as jest.Mock;
const mockSearchHackerNews = searchHackerNews as jest.Mock;
const mockSearchSecFilings = searchSecFilings as jest.Mock;
const mockResolveOpenAccess = resolveOpenAccess as jest.Mock;

function makePaper(overrides: Partial<PaperResult> = {}): PaperResult {
  return {
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    authors: ['P. Lewis', 'E. Perez'],
    year: 2020,
    url: 'https://doi.org/10.48550/arXiv.2005.11401',
    abstract: 'We explore RAG models that combine parametric and non-parametric memory.',
    citationCount: 4200,
    source: 'openalex',
    doi: '10.48550/arXiv.2005.11401',
    citation: 'P. Lewis and E. Perez, "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks," 2020.',
    ...overrides,
  };
}

describe('PapersResearchFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps PaperResult[] to RawSignalItem[] on a happy response', async () => {
    const pA = makePaper({ title: 'Paper A' });
    const pB = makePaper({
      title: 'Paper B',
      doi: null,
      url: 'https://example.com/paper-b',
      year: 2019,
      citation: 'Paper B citation',
    });
    mockSearchPapers.mockResolvedValue({ data: [pA, pB] });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag', 'llm'],
      timeRangeDays: 7,
      maxSignals: 25,
    });

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe(pA.title);
    expect(items[0].description).toBe(pA.abstract);
    expect(items[0].url).toBe(pA.url);
    expect(items[0].metadata?.doi).toBe(pA.doi);
    expect(items[0].metadata?.citationCount).toBe(pA.citationCount);
    expect(items[0].date.getUTCFullYear()).toBe(pA.year);

    expect(mockSearchPapers).toHaveBeenCalledWith({ query: 'rag OR llm', limit: 25 });
  });

  it('falls back to the citation string when abstract is null', async () => {
    const paper = makePaper({ abstract: null, citation: 'Fallback IEEE citation string' });
    mockSearchPapers.mockResolvedValue({ data: [paper] });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items[0].description).toBe(paper.citation);
    expect(items[0].description.length).toBeGreaterThan(0);
  });

  it('returns [] (no throw) on an upstream error', async () => {
    mockSearchPapers.mockResolvedValue({ data: [], error: 'OpenAlex 503' });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items).toEqual([]);
  });

  it('returns [] on a genuinely empty result', async () => {
    mockSearchPapers.mockResolvedValue({ data: [] });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items).toEqual([]);
  });

  it('integrates with BaseFetcher.fetch() end to end', async () => {
    const pA = makePaper();
    mockSearchPapers.mockResolvedValue({ data: [pA] });

    const result = await papersResearchFetcher.fetch({ keywords: ['rag'], timeRangeDays: 7, maxSignals: 10 });

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe('papers');
    expect(result.signals[0].type).toBe('paper');
    expect(typeof result.signals[0].relevanceScore).toBe('number');
  });
});

describe('PapersResearchFetcher open-access enrichment', () => {
  const ORIGINAL_EMAIL = process.env.RESEARCH_CONTACT_EMAIL;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_EMAIL === undefined) {
      delete process.env.RESEARCH_CONTACT_EMAIL;
    } else {
      process.env.RESEARCH_CONTACT_EMAIL = ORIGINAL_EMAIL;
    }
  });

  it('attaches an open-access PDF link when the contact email is set and the DOI is OA', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@example.com';
    const paper = makePaper({ doi: '10.x/y' });
    mockSearchPapers.mockResolvedValue({ data: [paper] });
    mockResolveOpenAccess.mockResolvedValue({
      data: { isOA: true, pdfUrl: 'https://pdf', hostType: 'repository', version: 'publishedVersion' },
    });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(mockResolveOpenAccess).toHaveBeenCalledWith({ doi: '10.x/y' });
    expect(items[0].metadata?.openAccessPdf).toBe('https://pdf');
  });

  it('does not call resolveOpenAccess or enrich when RESEARCH_CONTACT_EMAIL is unset', async () => {
    delete process.env.RESEARCH_CONTACT_EMAIL;
    const paper = makePaper({ doi: '10.x/y' });
    mockSearchPapers.mockResolvedValue({ data: [paper] });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(mockResolveOpenAccess).not.toHaveBeenCalled();
    expect(items[0].metadata?.openAccessPdf).toBeUndefined();
  });

  it('leaves the item unchanged when resolveOpenAccess reports non-OA', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@example.com';
    const paper = makePaper({ doi: '10.x/y' });
    mockSearchPapers.mockResolvedValue({ data: [paper] });
    mockResolveOpenAccess.mockResolvedValue({
      data: { isOA: false, pdfUrl: null, hostType: null, version: null },
    });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items[0].metadata?.openAccessPdf).toBeUndefined();
  });

  it('leaves the item unchanged and does not throw when resolveOpenAccess reports an error', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@example.com';
    const paper = makePaper({ doi: '10.x/y' });
    mockSearchPapers.mockResolvedValue({ data: [paper] });
    mockResolveOpenAccess.mockResolvedValue({
      data: { isOA: false, pdfUrl: null, hostType: null, version: null },
      error: 'Unpaywall 500',
    });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items[0].metadata?.openAccessPdf).toBeUndefined();
  });

  it('skips resolveOpenAccess for papers without a DOI', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@example.com';
    const withDoi = makePaper({ doi: '10.x/y', title: 'Has DOI' });
    const withoutDoi = makePaper({ doi: null, title: 'No DOI', url: 'https://example.com/no-doi' });
    mockSearchPapers.mockResolvedValue({ data: [withDoi, withoutDoi] });
    mockResolveOpenAccess.mockResolvedValue({
      data: { isOA: true, pdfUrl: 'https://pdf', hostType: 'repository', version: 'publishedVersion' },
    });

    const items = await (papersResearchFetcher as any).fetchFromSource({
      keywords: ['rag'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(mockResolveOpenAccess).toHaveBeenCalledTimes(1);
    expect(mockResolveOpenAccess).toHaveBeenCalledWith({ doi: '10.x/y' });
    const noDoiItem = items.find((i: any) => i.title === 'No DOI');
    expect(noDoiItem.metadata?.openAccessPdf).toBeUndefined();
  });
});

function makeHnHit(overrides: Partial<HackerNewsResult> = {}): HackerNewsResult {
  return {
    title: 'Show HN: A new Rust to Wasm compiler',
    url: 'https://example.com/rust-wasm',
    points: 120,
    numComments: 42,
    author: 'someuser',
    createdAt: '2026-06-30T12:00:00.000Z',
    objectID: '12345678',
    ...overrides,
  };
}

describe('HackerNewsFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries each keyword individually and merges the per-keyword hits', async () => {
    const hnA = makeHnHit({ title: 'Rust HN A', objectID: '111' });
    const hnB = makeHnHit({ title: 'Wasm HN B', objectID: '222' });
    mockSearchHackerNews.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve({ data: query === 'rust' ? [hnA] : [hnB] })
    );

    const items = await (hackerNewsFetcher as any).fetchFromSource({
      keywords: ['rust', 'wasm'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchHackerNews).toHaveBeenCalledTimes(2);
    expect(mockSearchHackerNews).toHaveBeenNthCalledWith(1, { query: 'rust', limit: 15 });
    expect(mockSearchHackerNews).toHaveBeenNthCalledWith(2, { query: 'wasm', limit: 15 });

    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.id)).toEqual([hnA.objectID, hnB.objectID]);
    expect(items[0].title).toBe(hnA.title);
    expect(items[0].metadata?.points).toBe(hnA.points);
    expect(items[0].metadata?.numComments).toBe(hnA.numComments);
    expect(items[0].url).toBe(hnA.url);
    expect(items[0].date.toISOString()).toBe(new Date(hnA.createdAt).toISOString());
  });

  it('dedups hits that share the same objectID across different keywords', async () => {
    const shared = makeHnHit({ title: 'Shared story', objectID: '555' });
    mockSearchHackerNews.mockResolvedValue({ data: [shared] });

    const items = await (hackerNewsFetcher as any).fetchFromSource({
      keywords: ['rust', 'wasm'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchHackerNews).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('555');
  });

  it('isolates a per-keyword error so one bad keyword does not zero the source', async () => {
    const hnB = makeHnHit({ title: 'Wasm HN B', objectID: '222' });
    mockSearchHackerNews.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve(query === 'rust' ? { data: [], error: 'HN 500' } : { data: [hnB] })
    );

    const items = await (hackerNewsFetcher as any).fetchFromSource({
      keywords: ['rust', 'wasm'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(hnB.objectID);
  });

  it('caps the number of queried keywords at HN_MAX_QUERY_KEYWORDS', async () => {
    mockSearchHackerNews.mockResolvedValue({ data: [] });

    const keywords = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    await (hackerNewsFetcher as any).fetchFromSource({
      keywords,
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchHackerNews.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('never returns more merged items than params.maxSignals', async () => {
    const hits = ['a', 'b', 'c'].map((suffix) => makeHnHit({ objectID: `rust-${suffix}` }));
    const otherHits = ['d', 'e', 'f'].map((suffix) => makeHnHit({ objectID: `wasm-${suffix}` }));
    mockSearchHackerNews.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve({ data: query === 'rust' ? hits : otherHits })
    );

    const items = await (hackerNewsFetcher as any).fetchFromSource({
      keywords: ['rust', 'wasm'],
      timeRangeDays: 7,
      maxSignals: 4,
    });

    expect(items.length).toBeLessThanOrEqual(4);
  });

  it('falls back to the HN item URL when url is null', async () => {
    const hnHit = makeHnHit({ url: null, objectID: '999' });
    mockSearchHackerNews.mockResolvedValue({ data: [hnHit] });

    const items = await (hackerNewsFetcher as any).fetchFromSource({
      keywords: ['rust'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items[0].url).toBe('https://news.ycombinator.com/item?id=999');
  });

  it('integrates with BaseFetcher.fetch() end to end', async () => {
    const hnA = makeHnHit();
    mockSearchHackerNews.mockResolvedValue({ data: [hnA] });

    const result = await hackerNewsFetcher.fetch({ keywords: ['rust'], timeRangeDays: 7, maxSignals: 10 });

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe('hackernews');
    expect(result.signals[0].type).toBe('hackernews');
  });
});

function makeSecFiling(overrides: Partial<SecFilingResult> = {}): SecFilingResult {
  return {
    company: 'C3.ai, Inc.',
    cik: '1577526',
    formType: '10-K',
    filedAt: '2025-06-23',
    url: 'https://www.sec.gov/Archives/edgar/data/1577526/000162828025032604/0001628280-25-032604-index.htm',
    snippet: 'Annual report pursuant to Section 13 or 15(d).',
    ...overrides,
  };
}

describe('SecFilingsFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries each keyword individually and maps SecFilingResult -> RawSignalItem', async () => {
    const fA = makeSecFiling({ url: 'https://www.sec.gov/a', company: 'Quantum Co', formType: '10-K' });
    const fB = makeSecFiling({ url: 'https://www.sec.gov/b', company: 'Crispr Co', formType: '8-K' });
    mockSearchSecFilings.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve({ data: query === 'quantum' ? [fA] : [fB] })
    );

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum', 'crispr'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchSecFilings).toHaveBeenCalledTimes(2);
    expect(mockSearchSecFilings).toHaveBeenNthCalledWith(1, { query: 'quantum', limit: 15 });
    expect(mockSearchSecFilings).toHaveBeenNthCalledWith(2, { query: 'crispr', limit: 15 });

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe(`${fA.company} — ${fA.formType}`);
    expect(items[0].description).toBe(fA.snippet);
    expect(items[0].url).toBe(fA.url);
    expect(items[0].date.toISOString()).toBe(new Date(fA.filedAt).toISOString());
    expect(items[0].metadata?.cik).toBe(fA.cik);
    expect(items[0].metadata?.formType).toBe(fA.formType);
    expect(items[0].metadata?.company).toBe(fA.company);
    expect(items[0].metadata?.filedAt).toBe(fA.filedAt);
  });

  it('caps the number of queried keywords at SEC_MAX_QUERY_KEYWORDS', async () => {
    mockSearchSecFilings.mockResolvedValue({ data: [] });

    const keywords = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    await (secFilingsFetcher as any).fetchFromSource({
      keywords,
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchSecFilings.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('dedups hits that share the same url across different keywords', async () => {
    const shared = makeSecFiling({ url: 'https://www.sec.gov/shared' });
    mockSearchSecFilings.mockResolvedValue({ data: [shared] });

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum', 'crispr'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(mockSearchSecFilings).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(shared.url);
  });

  it('isolates a per-keyword error so one bad keyword does not zero the source', async () => {
    const fB = makeSecFiling({ url: 'https://www.sec.gov/b', company: 'Crispr Co' });
    mockSearchSecFilings.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve(query === 'quantum' ? { data: [], error: 'SEC EDGAR 503' } : { data: [fB] })
    );

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum', 'crispr'],
      timeRangeDays: 7,
      maxSignals: 15,
    });

    expect(items).toHaveLength(1);
    expect(items[0].url).toBe(fB.url);
  });

  it('never returns more merged items than params.maxSignals', async () => {
    const hitsA = ['a', 'b', 'c'].map((suffix) => makeSecFiling({ url: `https://www.sec.gov/quantum-${suffix}` }));
    const hitsB = ['d', 'e', 'f'].map((suffix) => makeSecFiling({ url: `https://www.sec.gov/crispr-${suffix}` }));
    mockSearchSecFilings.mockImplementation(({ query }: { query: string }) =>
      Promise.resolve({ data: query === 'quantum' ? hitsA : hitsB })
    );

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum', 'crispr'],
      timeRangeDays: 7,
      maxSignals: 4,
    });

    expect(items.length).toBeLessThanOrEqual(4);
  });

  it('falls back to a synthesized description when snippet is null', async () => {
    const filing = makeSecFiling({ snippet: null, company: 'NullCo', formType: '10-Q' });
    mockSearchSecFilings.mockResolvedValue({ data: [filing] });

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items[0].description).toBe(`${filing.formType} filing by ${filing.company}`);
  });

  it('returns [] (no throw) on an upstream error', async () => {
    mockSearchSecFilings.mockResolvedValue({ data: [], error: 'SEC EDGAR 503' });

    const items = await (secFilingsFetcher as any).fetchFromSource({
      keywords: ['quantum'],
      timeRangeDays: 7,
      maxSignals: 10,
    });

    expect(items).toEqual([]);
  });

  it('integrates with BaseFetcher.fetch() end to end', async () => {
    const filing = makeSecFiling();
    mockSearchSecFilings.mockResolvedValue({ data: [filing] });

    const result = await secFilingsFetcher.fetch({ keywords: ['quantum'], timeRangeDays: 7, maxSignals: 10 });

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe('sec');
    expect(result.signals[0].type).toBe('filing');
  });
});
