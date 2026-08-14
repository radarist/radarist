/**
 * @file lib/research/__tests__/http.test.ts
 * @description Unit tests for the shared `politeFetch` helper used by every
 * primary-source research module (papers, open-access, HN, SEC, OSS health).
 * Mocks global `fetch` (mirrors src/lib/signal-fetchers/__tests__/patents-fetcher.test.ts).
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { politeFetch, getResearchContactEmail, ResearchFetchError } from '../http';

describe('politeFetch', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RESEARCH_CONTACT_EMAIL;
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  it('sends a User-Agent header containing Radarist', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await politeFetch('https://example.com/api');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Radarist');
  });

  it('includes RESEARCH_CONTACT_EMAIL in the User-Agent when set', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@x.com';
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await politeFetch('https://example.com/api');

    const [, options] = mockFetch.mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('test@x.com');
  });

  it('omits the email from the User-Agent when RESEARCH_CONTACT_EMAIL is unset', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await politeFetch('https://example.com/api');

    const [, options] = mockFetch.mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('Radarist');
    expect(headers['User-Agent']).not.toContain('@');
  });

  it('does not put a URL in the User-Agent (SEC EDGAR WAF 403s any UA containing a URL)', async () => {
    process.env.RESEARCH_CONTACT_EMAIL = 'test@x.com';
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await politeFetch('https://example.com/api');

    const [, options] = mockFetch.mock.calls[0];
    const headers = options.headers as Record<string, string>;
    // Regression guard for the live-verified SEC 403: no scheme, no bare host.
    expect(headers['User-Agent']).not.toMatch(/https?:\/\//);
    expect(headers['User-Agent']).not.toContain('github.com');
  });

  it('rejects with ResearchFetchError on a non-200 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(politeFetch('https://example.com/api')).rejects.toBeInstanceOf(ResearchFetchError);
    await expect(politeFetch('https://example.com/api')).rejects.toMatchObject({ status: 503 });
  });

  it('rejects with ResearchFetchError on abort/timeout', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = politeFetch('https://example.com/api', { timeoutMs: 5000 });
    // Attach a rejection handler immediately so advancing timers doesn't
    // trigger an unhandled-rejection warning before the assertion runs.
    const assertion = expect(promise).rejects.toBeInstanceOf(ResearchFetchError);
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('getResearchContactEmail', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns undefined when unset', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RESEARCH_CONTACT_EMAIL;
    expect(getResearchContactEmail()).toBeUndefined();
  });

  it('returns the trimmed email when set', () => {
    process.env = { ...ORIGINAL_ENV, RESEARCH_CONTACT_EMAIL: '  test@x.com  ' };
    expect(getResearchContactEmail()).toBe('test@x.com');
  });

  it('returns undefined for an empty/whitespace-only value', () => {
    process.env = { ...ORIGINAL_ENV, RESEARCH_CONTACT_EMAIL: '   ' };
    expect(getResearchContactEmail()).toBeUndefined();
  });
});
