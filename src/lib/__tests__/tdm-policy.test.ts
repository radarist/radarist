/**
 * @file tdm-policy.test.ts
 * @description Unit tests for the TDM opt-out policy check (DSM Art 4(3)).
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { isDisallowed, checkTdmPolicy } from '../tdm-policy';

describe('isDisallowed (robots/ai.txt grammar)', () => {
  it('blocks a blanket Disallow: / for *', () => {
    expect(isDisallowed('User-agent: *\nDisallow: /', '/article')).toBe(true);
  });

  it('allows when the path is outside the disallowed prefix', () => {
    expect(isDisallowed('User-agent: *\nDisallow: /private', '/public/x')).toBe(false);
  });

  it('blocks a matching path prefix', () => {
    expect(isDisallowed('User-agent: *\nDisallow: /private', '/private/secret')).toBe(true);
  });

  it('treats an empty Disallow as allow-all', () => {
    expect(isDisallowed('User-agent: *\nDisallow:', '/anything')).toBe(false);
  });

  it('honours an agent-specific block for Radarist even when * is permissive', () => {
    const body = 'User-agent: *\nDisallow:\n\nUser-agent: Radarist\nDisallow: /';
    expect(isDisallowed(body, '/article')).toBe(true);
  });

  it('lets a longer Allow override a Disallow (longest-match wins)', () => {
    const body = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public';
    expect(isDisallowed(body, '/docs/public/x')).toBe(false);
    expect(isDisallowed(body, '/docs/private')).toBe(true);
  });

  it('returns false when no rules apply', () => {
    expect(isDisallowed('# just a comment', '/x')).toBe(false);
  });
});

describe('checkTdmPolicy', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(map: Record<string, string | null>) {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(map).find((k) => url.endsWith(k));
      const body = key ? map[key] : null;
      if (body === null || body === undefined) return { ok: false, status: 404, text: async () => '' } as Response;
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as unknown as typeof fetch;
  }

  // AUDIT-007 — what counts as a rights reservation in robots.txt.
  //
  // This test previously asserted the OPPOSITE: that a blanket
  // `User-agent: * / Disallow: /` blocks ingestion. That is the broad reading,
  // and it was only ever exercised on the background refresh job. Wiring the
  // same rule into the user-facing ingest surfaced what it actually costs: a
  // site-wide crawler block is how a great many ordinary sites talk to search
  // engines, so the broad reading would 403 a URL the operator just pasted for
  // a page already open in their browser. DSM Art 4(3) asks for an *express*
  // reservation; a crawler block is not one.
  //
  // Owner decision (2026-07-12): gate on an express reservation only.
  it('does NOT block on a blanket `User-agent: *` robots block — that is a crawl directive, not a TDM reservation', async () => {
    mockFetch({ '/robots.txt': 'User-agent: *\nDisallow: /', '/ai.txt': null, '/.well-known/ai.txt': null });
    const result = await checkTdmPolicy('https://example.com/article');
    expect(result.allowed).toBe(true);
  });

  it('blocks when robots.txt names our agent specifically', async () => {
    mockFetch({
      '/robots.txt': 'User-agent: *\nDisallow:\n\nUser-agent: Radarist\nDisallow: /',
      '/ai.txt': null,
      '/.well-known/ai.txt': null,
    });
    const result = await checkTdmPolicy('https://example.com/article');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/robots\.txt/);
  });

  // Over-blocking is a real failure mode now that this gates a user's paste, not
  // just a background job. A malformed `User-agent:` line parses to an empty
  // token, and '' is a substring of every string — so it used to read as a group
  // NAMING us, and a `Disallow: /` beneath it would 403 the user.
  it('does not treat a malformed empty `User-agent:` group as naming us', async () => {
    mockFetch({ '/robots.txt': 'User-agent:\nDisallow: /', '/ai.txt': null, '/.well-known/ai.txt': null });
    await expect(checkTdmPolicy('https://example.com/article')).resolves.toMatchObject({ allowed: true });
  });

  it.each(['Googlebot', 'GPTBot', 'CCBot', 'ia_archiver', 'AdsBot-Google'])(
    'does not treat a `%s` reservation as one aimed at us',
    async (agent) => {
      mockFetch({
        '/robots.txt': `User-agent: ${agent}\nDisallow: /`,
        '/ai.txt': null,
        '/.well-known/ai.txt': null,
      });
      await expect(checkTdmPolicy('https://example.com/article')).resolves.toMatchObject({ allowed: true });
    }
  );

  it('blocks a named-agent reservation scoped to one path, and allows the rest', async () => {
    mockFetch({
      '/robots.txt': 'User-agent: Radarist\nDisallow: /premium',
      '/ai.txt': null,
      '/.well-known/ai.txt': null,
    });
    await expect(checkTdmPolicy('https://example.com/premium/story')).resolves.toMatchObject({ allowed: false });
    await expect(checkTdmPolicy('https://example.com/free/story')).resolves.toMatchObject({ allowed: true });
  });

  it('blocks when ai.txt reserves the content (DSM Art 4(3))', async () => {
    mockFetch({
      '/robots.txt': 'User-agent: *\nDisallow:',
      '/ai.txt': 'User-agent: *\nDisallow: /',
      '/.well-known/ai.txt': null,
    });
    const result = await checkTdmPolicy('https://example.com/news/story');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/ai\.txt/);
  });

  it('allows when neither robots.txt nor ai.txt opts out', async () => {
    mockFetch({ '/robots.txt': 'User-agent: *\nDisallow: /admin', '/ai.txt': null, '/.well-known/ai.txt': null });
    const result = await checkTdmPolicy('https://example.com/public/post');
    expect(result.allowed).toBe(true);
  });

  it('fails OPEN (allows) on network errors', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    try {
      const result = await checkTdmPolicy('https://example.com/article');
      expect(result.allowed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails OPEN (allows) for an unparseable URL', async () => {
    const result = await checkTdmPolicy('not-a-url');
    expect(result.allowed).toBe(true);
  });
});
