/**
 * @file lib/signal-fetchers/__tests__/github-fetcher.test.ts
 * @description Unit tests for the GitHubFetcher — first coverage for this
 * fetcher — focused on the OSS-health enrichment step (Task S11): bounded,
 * best-effort, never fabricates data, never blocks/fails the fetch.
 */

// base-fetcher imports generateSlug from entity-factory, which pulls in the
// Firebase client SDK — mock it to break the initialization chain.
jest.mock('@/lib/entity-factory', () => ({
  generateSlug: jest.fn((name: string) => String(name).toLowerCase().replace(/\s+/g, '-')),
}));

jest.mock('@/lib/research/oss-health', () => ({ searchOssHealth: jest.fn() }));

import { GitHubFetcher, buildGitHubSearchQuery, MAX_GITHUB_QUERY_TERMS } from '../github-fetcher';
import { searchOssHealth } from '@/lib/research/oss-health';
import type { OssHealthResult, ResearchOutcome } from '@/lib/research/types';

const mockSearchOssHealth = searchOssHealth as jest.Mock;

const PARAMS = { keywords: ['rust'], timeRangeDays: 7, maxSignals: 10 };

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    full_name: 'owner/repo',
    name: 'repo',
    description: 'A repo',
    html_url: 'https://github.com/owner/repo',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    pushed_at: '2026-06-01T00:00:00Z',
    stargazers_count: 1200,
    watchers_count: 1200,
    forks_count: 30,
    language: 'Rust',
    topics: ['rust'],
    owner: { login: 'owner', type: 'Organization' },
    ...overrides,
  };
}

function makeSearchResponse(repos: ReturnType<typeof makeRepo>[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => ({ total_count: repos.length, incomplete_results: false, items: repos }),
  };
}

function makeErrorResponse(status: number, body: Record<string, unknown> = {}, contentType = 'application/json') {
  return {
    ok: false,
    status,
    statusText: `Status ${status}`,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyOssHealth(overrides: Partial<OssHealthResult> = {}): OssHealthResult {
  return {
    name: '',
    stars: null,
    contributors: null,
    lastCommit: null,
    downloads: null,
    dependentsCount: null,
    advisories: null,
    maintenanceScore: null,
    attribution: 'Data: Ecosyste.ms (CC-BY-SA 4.0)',
    ...overrides,
  };
}

describe('GitHubFetcher', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('enriches a signal with OSS-health metrics and CC-BY-SA attribution', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(makeSearchResponse([makeRepo({ id: 1, full_name: 'owner/repo' })]));
    mockSearchOssHealth.mockResolvedValue({
      data: {
        name: 'owner/repo',
        stars: 1200,
        contributors: 48,
        lastCommit: '2026-06-01T00:00:00Z',
        downloads: null,
        dependentsCount: null,
        advisories: 0,
        maintenanceScore: 0.82,
        attribution: 'Data: Ecosyste.ms (CC-BY-SA 4.0)',
      },
    } satisfies ResearchOutcome<OssHealthResult>);

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    const ossHealth = result.signals[0].metadata?.ossHealth as Record<string, unknown>;
    expect(ossHealth).toBeDefined();
    expect(ossHealth.contributors).toBe(48);
    expect(ossHealth.maintenanceScore).toBe(0.82);
    expect(ossHealth.attribution).toEqual(expect.stringContaining('CC-BY-SA'));
    expect(mockSearchOssHealth).toHaveBeenCalledWith({ repoOrPackage: 'owner/repo' });
  });

  it('leaves the signal unchanged when searchOssHealth returns an error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(makeSearchResponse([makeRepo({ id: 2, full_name: 'owner/broken' })]));
    mockSearchOssHealth.mockResolvedValue({
      data: emptyOssHealth(),
      error: 'Ecosyste.ms 500',
    } satisfies ResearchOutcome<OssHealthResult>);

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].metadata?.ossHealth).toBeUndefined();
  });

  it('skips enrichment when the health data has no usable signal (all null)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(makeSearchResponse([makeRepo({ id: 3, full_name: 'owner/empty' })]));
    mockSearchOssHealth.mockResolvedValue({
      data: emptyOssHealth({ name: 'owner/empty' }),
    } satisfies ResearchOutcome<OssHealthResult>);

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].metadata?.ossHealth).toBeUndefined();
  });

  // ── OPS-002: query contract + permanent-failure handling ──────────────────

  it('does not emit the undocumented fork:false qualifier (a 422 trigger)', () => {
    const query = buildGitHubSearchQuery(['rust'], new Date('2026-06-01T00:00:00Z'));
    expect(query).not.toContain('fork:false');
    // Forks are excluded by GitHub search by default; the documented qualifier
    // values are fork:true / fork:only, neither of which we want here.
    expect(query).not.toMatch(/fork:/);
  });

  it("bounds the boolean-operator count to GitHub's documented limit of five", () => {
    const manyKeywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const query = buildGitHubSearchQuery(manyKeywords, new Date('2026-06-01T00:00:00Z'));
    const orCount = (query.match(/ OR /g) ?? []).length;
    // N terms → N-1 OR operators; GitHub rejects queries with >5 operators.
    expect(orCount).toBeLessThanOrEqual(MAX_GITHUB_QUERY_TERMS - 1);
    expect(orCount).toBeLessThanOrEqual(5);
  });

  it("keeps the built query within GitHub's 256-character limit", () => {
    const longKeywords = Array.from({ length: 8 }, (_, i) => `very-long-keyword-phrase-number-${i}-${'x'.repeat(30)}`);
    const query = buildGitHubSearchQuery(longKeywords, new Date('2026-06-01T00:00:00Z'));
    expect(query.length).toBeLessThanOrEqual(256);
  });

  it('skips an oversized term when a later keyword still fits the query contract', () => {
    const query = buildGitHubSearchQuery(
      ['x'.repeat(300), 'rust'],
      new Date('2026-06-01T00:00:00Z')
    );
    expect(query).toContain('rust');
    expect(query).not.toContain('x'.repeat(300));
  });

  it('fails honestly instead of emitting a qualifier-only query when no keyword fits', async () => {
    const oversized = ['x'.repeat(300), 'y'.repeat(300)];
    expect(() => buildGitHubSearchQuery(oversized, new Date('2026-06-01T00:00:00Z'))).toThrow(
      /no usable keyword/i
    );

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch({ ...PARAMS, keywords: oversized });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toMatch(/no usable keyword/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reproduces the GitHub 422 and fails fast WITHOUT retrying (permanent contract error)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(makeErrorResponse(422, { message: 'Validation Failed' }));

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain('422');
    // A permanent 422 must be attempted exactly once — not retried every cycle.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an HTML body served with a 200 as a permanent contract violation', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      text: async () => '<!DOCTYPE html>',
    });

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient 503 (permanent flag stays falsy)', async () => {
    jest.useFakeTimers();
    try {
      (global.fetch as jest.Mock).mockResolvedValue(makeErrorResponse(503, { message: 'Service Unavailable' }));

      const fetcher = new GitHubFetcher();
      const promise = fetcher.fetch(PARAMS);
      await jest.runAllTimersAsync(); // flush retry backoff delays
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.permanent).toBeFalsy();
      // Transient errors are retried; the default cap is 3 attempts.
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a GitHub 403 rate-limit response as transient using headers and body', async () => {
    jest.useFakeTimers();
    try {
      (global.fetch as jest.Mock).mockResolvedValue({
        ...makeErrorResponse(403, { message: 'API rate limit exceeded for this user.' }),
        headers: new Headers({
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
        }),
      });

      const fetcher = new GitHubFetcher();
      const promise = fetcher.fetch(PARAMS);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.permanent).toBeFalsy();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still fails fast for a non-rate-limit GitHub 403 authorization failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      makeErrorResponse(403, { message: 'Resource not accessible by integration' })
    );

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch(PARAMS);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('caps enrichment lookups at OSS_ENRICH_MAX even when more repos are returned', async () => {
    const repos = Array.from({ length: 15 }, (_, i) => makeRepo({ id: i + 1, full_name: `owner/repo-${i + 1}` }));
    (global.fetch as jest.Mock).mockResolvedValue(makeSearchResponse(repos));
    mockSearchOssHealth.mockResolvedValue({ data: emptyOssHealth() } satisfies ResearchOutcome<OssHealthResult>);

    const fetcher = new GitHubFetcher();
    const result = await fetcher.fetch({ ...PARAMS, maxSignals: 20 });

    expect(result.success).toBe(true);
    expect(result.signals).toHaveLength(15);
    expect(mockSearchOssHealth).toHaveBeenCalledTimes(10);
  });
});
