/**
 * @file lib/research/__tests__/citation.test.ts
 * @description Unit tests for `formatIeeeCitation`. The happy-path case must
 * assert genuine IEEE-style CSL output (numbered bracket + "[Online]. Available:"),
 * not the plain-string fallback — the bundled `@citation-js/plugin-csl` templates
 * are only `apa`/`vancouver`/`harvard1` (verified via manual inspection of
 * `node_modules/@citation-js/plugin-csl/lib/styles.json`), so `citation.ts` must
 * vendor+register `IEEE_CSL_XML` (from `../ieee-csl`) for a real IEEE template
 * to exist at all — without it, citation-js silently falls back to `apa` (no
 * throw). The last test in this file locks in the guard in `citation.ts` that
 * checks template registration before formatting, so that silent-APA case
 * returns the plain fallback instead of a mislabeled APA string.
 */

import { formatIeeeCitation } from '../citation';

describe('formatIeeeCitation', () => {
  it('formats a well-formed input as real IEEE CSL output (not the plain fallback)', () => {
    const result = formatIeeeCitation({
      title: 'Attention Is All You Need',
      authors: ['A. Vaswani', 'N. Shazeer'],
      year: 2017,
      url: 'https://arxiv.org/abs/1706.03762',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('Attention Is All You Need');
    expect(result).toContain('2017');
    // Markers only the real IEEE CSL template produces — the plain fallback
    // string (`"<authors> (<year>). <title>. <url>"`) never contains these.
    expect(result).toMatch(/\[Online\]\. Available:/);
    expect(result).not.toBe(
      'A. Vaswani, N. Shazeer (2017). Attention Is All You Need. https://arxiv.org/abs/1706.03762'
    );
  });

  it('falls back to the plain string when citation-js throws', () => {
    // Use an isolated module registry so mocking `@citation-js/core` here
    // doesn't leak into the other tests in this file (which need the real
    // `Cite` + vendored `IEEE_CSL_XML` template to assert genuine IEEE output).
    let result = '';
    jest.isolateModules(() => {
      jest.doMock('@citation-js/core', () => {
        const actual = jest.requireActual('@citation-js/core');
        return {
          ...actual,
          Cite: jest.fn().mockImplementation(() => {
            throw new Error('citation-js exploded');
          }),
        };
      });

      const { formatIeeeCitation: formatWithThrowingCite } = require('../citation') as typeof import('../citation');
      result = formatWithThrowingCite({
        title: 'Some Title',
        authors: ['Jane Doe'],
        year: 2020,
        url: 'https://example.com/paper',
      });
    });

    expect(result).toBe('Jane Doe (2020). Some Title. https://example.com/paper');
  });

  it('does not crash and still returns a non-empty string for empty authors', () => {
    const result = formatIeeeCitation({
      title: 'No Author Paper',
      authors: [],
      year: null,
      url: 'https://example.com/no-author',
    });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the plain fallback (not a silently-mislabeled APA string) when the ieee template is not registered', () => {
    // Regression guard for the silent-APA-mislabel bug: citation-js does NOT
    // throw when asked to format with an unregistered template name — it
    // silently falls back to `apa`, which is non-empty and would beat
    // `plain` in the old (unguarded) code path. Drive that "not registered"
    // state directly by mocking `templates.has` to return false, and assert
    // `formatIeeeCitation` short-circuits to the plain fallback instead of
    // ever calling `.format(..., { template: 'ieee' })`.
    let result = '';
    jest.isolateModules(() => {
      jest.doMock('@citation-js/core', () => {
        const actual = jest.requireActual('@citation-js/core');
        return {
          ...actual,
          plugins: {
            ...actual.plugins,
            config: {
              ...actual.plugins.config,
              get: jest.fn(() => ({
                templates: {
                  has: jest.fn(() => false),
                  add: jest.fn(),
                  get: jest.fn(() => undefined),
                },
              })),
            },
          },
        };
      });

      const { formatIeeeCitation: formatWithoutRegisteredTemplate } =
        require('../citation') as typeof import('../citation');
      result = formatWithoutRegisteredTemplate({
        title: 'Attention Is All You Need',
        authors: ['A. Vaswani', 'N. Shazeer'],
        year: 2017,
        url: 'https://arxiv.org/abs/1706.03762',
      });
    });

    expect(result).toBe('A. Vaswani, N. Shazeer (2017). Attention Is All You Need. https://arxiv.org/abs/1706.03762');
    // The real IEEE CSL template is the only thing that would produce this
    // marker; APA output never does. Asserting its absence pins down that
    // we got the plain fallback, not a mislabeled APA string.
    expect(result).not.toMatch(/\[Online\]\. Available:/);
  });
});
