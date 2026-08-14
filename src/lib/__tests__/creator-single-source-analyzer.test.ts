import { analyzeCreatorSingleSource } from '../mission-quality/analyzers/creator-single-source-analyzer';

describe('analyzeCreatorSingleSource', () => {
  it('passes when no quantitative tokens appear in the output', () => {
    const verdict = analyzeCreatorSingleSource(
      'The vendor pivoted to enterprise. [1] Their narrative is consistent. [2]'
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeSentenceCount).toBe(0);
  });

  it('passes when a quantitative sentence cites two sources', () => {
    const verdict = analyzeCreatorSingleSource('Adoption grew 30% YoY. [1, 2] Other context here.');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeSentenceCount).toBe(1);
  });

  it('fails when a quantitative sentence cites only one source', () => {
    const verdict = analyzeCreatorSingleSource('Funding closed at $120M. [1] The market remains competitive. [2]');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0].quantitativeMatches).toEqual(['$120M']);
      expect(verdict.violations[0].citedSourceIds).toEqual([1]);
    }
  });

  it('reports each violating sentence separately when multiple are single-sourced', () => {
    const verdict = analyzeCreatorSingleSource(
      'Throughput hit 10000 tokens per second. [1] The community grew 5x year over year. [2] Sentiment improved. [3]'
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations).toHaveLength(2);
    }
  });

  it('fails when a quantitative sentence has zero citations', () => {
    const verdict = analyzeCreatorSingleSource('Inference latency dropped to 80ms. [1] Some other stuff. [2]');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0].citedSourceIds.length).toBeGreaterThanOrEqual(0);
      expect(verdict.violations[0].quantitativeMatches).toContain('80ms');
    }
  });

  it('treats years and small counts as non-quantitative (skips them)', () => {
    const verdict = analyzeCreatorSingleSource(
      'The product launched in 2024 with 3 founders. [1] Version 1.4 was released. [2]'
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.quantitativeSentenceCount).toBe(0);
  });
});
