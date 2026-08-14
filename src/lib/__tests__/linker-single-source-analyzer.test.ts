import { analyzeLinkerSingleSource } from '../mission-quality/analyzers/linker-single-source-analyzer';
import type { LinkerBundle } from '../schemas/linker-bundle';

function bundleWith(edges: Array<{ evidence: string; sourceUrl?: string }>): LinkerBundle {
  return {
    edges: edges.map((e, i) => ({
      sourceEntityName: `Source${i}`,
      targetEntityName: `Target${i}`,
      relationType: 'related-to',
      confidence: 0.8,
      ...e,
    })),
  } as unknown as LinkerBundle;
}

describe('analyzeLinkerSingleSource', () => {
  it('passes when no edge evidence contains quantitative tokens', () => {
    const verdict = analyzeLinkerSingleSource(bundleWith([{ evidence: 'OpenAI and Anthropic both ship LLM APIs.' }]));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeEdgeCount).toBe(0);
  });

  it('passes when a quantitative edge has 2+ URLs in evidence', () => {
    const verdict = analyzeLinkerSingleSource(
      bundleWith([
        {
          evidence: 'Anthropic raised $4B per https://anthropic.com/news and https://reuters.com/article-12345.',
        },
      ])
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeEdgeCount).toBe(1);
  });

  it('passes when evidence has 1 URL and sourceUrl is a different host', () => {
    const verdict = analyzeLinkerSingleSource(
      bundleWith([
        {
          evidence: 'Anthropic raised $4B per https://anthropic.com/news.',
          sourceUrl: 'https://reuters.com/article-12345',
        },
      ])
    );
    expect(verdict.ok).toBe(true);
  });

  it('fails when a quantitative edge has only one URL total', () => {
    const verdict = analyzeLinkerSingleSource(
      bundleWith([
        {
          evidence: 'Anthropic raised $4B in 2025.',
          sourceUrl: 'https://anthropic.com/news',
        },
      ])
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0].quantitativeMatches).toContain('$4B');
      expect(verdict.violations[0].distinctUrls).toHaveLength(1);
    }
  });

  it('fails when a quantitative edge has no URLs at all', () => {
    const verdict = analyzeLinkerSingleSource(bundleWith([{ evidence: 'OpenAI has 700M weekly active users.' }]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0].distinctUrls).toEqual([]);
  });

  it('counts URLs by host so duplicate paths on the same host count once', () => {
    const verdict = analyzeLinkerSingleSource(
      bundleWith([
        {
          evidence:
            'Anthropic raised $4B per https://anthropic.com/news/series-c and https://anthropic.com/news/follow-up.',
          sourceUrl: 'https://anthropic.com/about',
        },
      ])
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations[0].distinctUrls).toHaveLength(1);
  });
});
