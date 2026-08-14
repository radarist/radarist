import { parseScoutBundle, containsBundleMarker, verdictFromAdmiralty } from '../scout-bundle-parser';

const VALID_BUNDLE = {
  queries: [
    'open-weight AI model pricing 2026',
    'enterprise LLM production stats',
    'Llama DeepSeek benchmark comparisons',
  ],
  sources: [
    {
      id: 1,
      url: 'https://example.com/paper',
      fetched_via: 'exa',
      tool_call_id: 'toolu_abc123',
      admiralty: 'A2',
      date_accessed: '2026-04-22',
      title: 'Example paper',
    },
  ],
  findings: ['Cost dropped 30% YoY [1]'],
  unresolved: ['No data on Q1 2026 adoption'],
};

function wrapInMarkdown(bundle: unknown, prose = 'some prose'): string {
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\`\n`;
}

describe('parseScoutBundle', () => {
  it('parses a valid bundle', () => {
    const result = parseScoutBundle(wrapInMarkdown(VALID_BUNDLE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.sources).toHaveLength(1);
      expect(result.bundle.sources[0].fetched_via).toBe('exa');
    }
  });

  it('fails when no fenced json block is present', () => {
    const result = parseScoutBundle('just some prose, no block');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no.*json.*block/i);
  });

  it('fails when the json is malformed', () => {
    const result = parseScoutBundle('```json\n{ not valid json }\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/json.*parse/i);
  });

  it('fails when a source is missing required fields', () => {
    const bad = { ...VALID_BUNDLE, sources: [{ id: 1, url: 'https://x.com', title: 'X' }] };
    const result = parseScoutBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fetched_via|tool_call_id|admiralty|date_accessed/);
  });

  it('fails when fetched_via is not one of the allowed tools', () => {
    const bad = {
      ...VALID_BUNDLE,
      sources: [{ ...VALID_BUNDLE.sources[0], fetched_via: 'google-search' }],
    };
    const result = parseScoutBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fetched_via/);
  });

  it.each(['impulse-entities', 'impulse-graph', 'impulse-signals', 'impulse-research'])(
    'accepts Radarist platform provenance from %s',
    (fetchedVia) => {
      const bundle = {
        ...VALID_BUNDLE,
        sources: [{ ...VALID_BUNDLE.sources[0], fetched_via: fetchedVia }],
      };
      const result = parseScoutBundle(wrapInMarkdown(bundle));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.bundle.sources[0].fetched_via).toBe(fetchedVia);
    }
  );

  it('picks the last fenced json block when multiple are present', () => {
    const text = '```json\n{"discarded": true}\n```\n\nmore prose\n\n' + wrapInMarkdown(VALID_BUNDLE, '');
    const result = parseScoutBundle(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.sources[0].fetched_via).toBe('exa');
  });

  it('rejects an empty sources array (bundle must have at least one source)', () => {
    const bad = { ...VALID_BUNDLE, sources: [] };
    const result = parseScoutBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sources/);
  });

  it('fails when queries is missing', () => {
    const bad = { ...VALID_BUNDLE, queries: undefined };
    const result = parseScoutBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/queries/);
  });

  it('fails when queries has fewer than 3 entries', () => {
    const bad = { ...VALID_BUNDLE, queries: ['only one query'] };
    const result = parseScoutBundle(wrapInMarkdown(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/queries/);
  });
});

describe('containsBundleMarker', () => {
  it('detects the bundle-requirement marker in a prompt', () => {
    expect(containsBundleMarker('Return a bundle with tool_call_id and admiralty fields.')).toBe(true);
    expect(containsBundleMarker('sources: { fetched_via: exa, tool_call_id: ... }')).toBe(true);
  });

  it('returns false for prompts without the marker', () => {
    expect(containsBundleMarker('find AI startups')).toBe(false);
  });

  // Regression: the marker MUST detect the actual scout prompt emitted by
  // buildResearchChainSteps. An earlier regex (/tool_call_id.*per.*source/i)
  // drifted out of sync with the prompt (which never uses "per source") and
  // caused the L1 bundle checks to silently no-op in production.
  it('detects the actual scout chain prompt emitted by buildResearchChainSteps', () => {
    const actualScoutPrompt =
      'You are the research layer for a downstream writing task. Your output is ' +
      'machine-parsed.\n\n' +
      'Output format: end your response with a fenced ```json block containing ' +
      'an object with these exact fields:\n' +
      '- `sources`: array of { id (int), title, url, fetched_via (one of: exa, ' +
      'arxiv, firecrawl, playwright, github), tool_call_id (SDK tool_use_id), ' +
      'admiralty (A1-F6), date_accessed (YYYY-MM-DD), snippet (optional string) }\n';
    expect(containsBundleMarker(actualScoutPrompt)).toBe(true);
  });
});

// ============================================================================
// verdictFromAdmiralty (P5-B M13 — honest observation verdicts)
// ============================================================================

describe('verdictFromAdmiralty', () => {
  it.each([['A1'], ['A2'], ['B1'], ['B2'], ['C2'], ['D1']])(
    '%s (credibility 1-2 from a usable source) → confirming',
    (code) => {
      expect(verdictFromAdmiralty(code)).toBe('confirming');
    }
  );

  it.each([['A5'], ['B5'], ['F5']])('%s (credibility 5 = improbable/contradicted) → contradicting', (code) => {
    expect(verdictFromAdmiralty(code)).toBe('contradicting');
  });

  it.each([['A3'], ['B4'], ['C6'], ['B3']])(
    '%s (possibly true / doubtful / cannot be judged) → inconclusive',
    (code) => {
      expect(verdictFromAdmiralty(code)).toBe('inconclusive');
    }
  );

  it.each([['E1'], ['E2'], ['F1'], ['F2']])(
    '%s (unreliable source cannot confirm, even with high credibility digit) → inconclusive',
    (code) => {
      expect(verdictFromAdmiralty(code)).toBe('inconclusive');
    }
  );

  it('treats malformed codes as inconclusive rather than rubber-stamping', () => {
    expect(verdictFromAdmiralty('')).toBe('inconclusive');
    expect(verdictFromAdmiralty('Z9')).toBe('inconclusive');
    expect(verdictFromAdmiralty('A')).toBe('inconclusive');
  });
});
