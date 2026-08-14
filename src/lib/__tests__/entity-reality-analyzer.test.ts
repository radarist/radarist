import { analyzeEntityReality } from '../entity-reality-analyzer';

describe('analyzeEntityReality', () => {
  it('passes when summary mentions the single-word name as a whole word', () => {
    const verdict = analyzeEntityReality('Anthropic', {
      summary: 'Anthropic is an AI safety company founded in 2021. They build large language models called Claude.',
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.reason).toBe('verified');
      expect(verdict.evidenceText.length).toBeGreaterThan(0);
    }
  });

  it('passes when summary mentions all significant words of a multi-word name', () => {
    const verdict = analyzeEntityReality('Hugging Face', {
      summary: 'Hugging Face is an open-source platform that hosts models and datasets for machine learning.',
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.reason).toBe('verified');
      expect(verdict.evidenceText.length).toBeGreaterThan(0);
    }
  });

  it('fails with no-results when summary is too short to carry evidence', () => {
    const verdict = analyzeEntityReality('QuantumFlavor Labs', { summary: 'No info.' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('no-results');
  });

  it('fails with no-name-match when summary is substantial but never mentions the name', () => {
    const verdict = analyzeEntityReality('QuantumFlavor Labs', {
      summary:
        'The food-tech sector has seen significant investment in 2025 with dozens of startups entering the market around flavor personalization and precision fermentation.',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('no-name-match');
  });

  it('rejects partial-substring matches inside larger words', () => {
    const verdict = analyzeEntityReality('Apple', {
      summary:
        'Pineapple and snapple dominated the beverage discussion, along with grapefruit and appleseed varieties.',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('no-name-match');
  });

  it('passes inconclusively when searchFailed flag is set', () => {
    const verdict = analyzeEntityReality('AnyName', {
      summary: 'Search did not complete',
      searchFailed: true,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.reason).toBe('inconclusive');
  });
});
