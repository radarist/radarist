/**
 * @file mcp/__tests__/resource-uris.test.ts
 * @description Round-trip + golden-snapshot tests for the frozen `radarist://`
 *              resource URI grammar (Wave 0 contract).
 */

import {
  buildUri,
  parseUri,
  InvalidResourceUriError,
  MEMORY_RESOURCE_KINDS,
  RADARIST_URI_PREFIX,
  type ParsedResourceUri,
} from '../resource-uris';

describe('resource-uris grammar', () => {
  // --------------------------------------------------------------------------
  // Golden snapshot — the frozen forward contract. If this changes, every
  // downstream MCP client breaks. Update only with an explicit grammar bump.
  // --------------------------------------------------------------------------
  describe('golden snapshot', () => {
    const cases: { label: string; parts: ParsedResourceUri }[] = [
      {
        label: 'memory/episodes',
        parts: { scheme: 'memory', kind: 'episodes', userId: 'user-123' },
      },
      {
        label: 'memory/interest-profile',
        parts: { scheme: 'memory', kind: 'interest-profile', userId: 'user-123' },
      },
      {
        label: 'memory/insights',
        parts: { scheme: 'memory', kind: 'insights', userId: 'user-123' },
      },
      {
        label: 'memory/sessions',
        parts: { scheme: 'memory', kind: 'sessions', userId: 'user-123' },
      },
      {
        label: 'graph/community-reports',
        parts: { scheme: 'graph', kind: 'community-reports', query: 'quantum computing' },
      },
      {
        label: 'skill',
        parts: { scheme: 'skill', name: 'evaluate-signal', version: '1.0.0' },
      },
    ];

    it('builds the exact frozen URI form for each resource shape', () => {
      const grammar = Object.fromEntries(cases.map((c) => [c.label, buildUri(c.parts)]));
      expect(grammar).toMatchInlineSnapshot(`
        {
          "graph/community-reports": "radarist://graph/community-reports?q=quantum%20computing",
          "memory/episodes": "radarist://memory/episodes/user-123",
          "memory/insights": "radarist://memory/insights/user-123",
          "memory/interest-profile": "radarist://memory/interest-profile/user-123",
          "memory/sessions": "radarist://memory/sessions/user-123",
          "skill": "radarist://skill/evaluate-signal@1.0.0",
        }
      `);
    });
  });

  // --------------------------------------------------------------------------
  // Round-trip invariants
  // --------------------------------------------------------------------------
  describe('round-trip parse <-> build', () => {
    const samples: ParsedResourceUri[] = [
      { scheme: 'memory', kind: 'episodes', userId: 'abc' },
      { scheme: 'memory', kind: 'interest-profile', userId: 'XyZ_9' },
      { scheme: 'memory', kind: 'insights', userId: 'u1' },
      { scheme: 'memory', kind: 'sessions', userId: 'u1' },
      { scheme: 'graph', kind: 'community-reports', query: 'edge AI' },
      { scheme: 'graph', kind: 'community-reports', query: 'a=b&c d?e' },
      { scheme: 'skill', name: 'research-technology', version: '2.1.3' },
      { scheme: 'skill', name: 'detect-ma-event', version: 'abc123def' },
    ];

    it.each(samples)('build -> parse deep-equals the source ($scheme)', (parts) => {
      expect(parseUri(buildUri(parts))).toEqual(parts);
    });

    it.each([
      'radarist://memory/episodes/user-123',
      'radarist://graph/community-reports?q=quantum%20computing',
      'radarist://skill/evaluate-signal@1.0.0',
    ])('parse -> build returns the canonical string (%s)', (uri) => {
      expect(buildUri(parseUri(uri))).toBe(uri);
    });
  });

  // --------------------------------------------------------------------------
  // Parsing specifics
  // --------------------------------------------------------------------------
  describe('parseUri', () => {
    it('exposes all four memory kinds', () => {
      expect(MEMORY_RESOURCE_KINDS).toEqual(['episodes', 'interest-profile', 'insights', 'sessions']);
    });

    it('decodes a percent-encoded community-reports query', () => {
      const parsed = parseUri('radarist://graph/community-reports?q=a%26b');
      expect(parsed).toEqual({ scheme: 'graph', kind: 'community-reports', query: 'a&b' });
    });

    it('parses a skill name containing hyphens', () => {
      expect(parseUri('radarist://skill/analysis-of-competing-hypotheses@1.0.0')).toEqual({
        scheme: 'skill',
        name: 'analysis-of-competing-hypotheses',
        version: '1.0.0',
      });
    });
  });

  // --------------------------------------------------------------------------
  // Rejections
  // --------------------------------------------------------------------------
  describe('rejections', () => {
    const bad: string[] = [
      'http://memory/episodes/u1',
      'radarist://',
      'radarist://memory/episodes',
      'radarist://memory/unknown/u1',
      'radarist://memory/episodes/u1?q=x',
      'radarist://graph/community-reports',
      'radarist://graph/other?q=x',
      'radarist://skill/no-version',
      'radarist://skill/@1.0.0',
      'radarist://skill/name@',
      'radarist://unknown/foo',
    ];

    it.each(bad)('throws InvalidResourceUriError for %s', (uri) => {
      expect(() => parseUri(uri)).toThrow(InvalidResourceUriError);
    });

    it('rejects a non-string input', () => {
      // @ts-expect-error — deliberately passing a non-string
      expect(() => parseUri(42)).toThrow(InvalidResourceUriError);
    });
  });

  it('exports the canonical scheme prefix', () => {
    expect(RADARIST_URI_PREFIX).toBe('radarist://');
  });
});
