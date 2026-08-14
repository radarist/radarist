/**
 * P1 (design-pass) — brand-exact chart themes + theme threading + infographic
 * brand injection. All pure (no Chromium, no firebase). The critical tripwire:
 * the existing editorial themes' sequence is UNCHANGED so no chart golden moves.
 */
import { lightEditorial, brandDark, brandLight, chartTokensForBrief } from '@/lib/super-graph/design-tokens';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { buildInfographicPrompt } from '@/lib/ai/infographic-prompt';

describe('P1 brand themes are additive (no existing golden moves)', () => {
  it('adds brandDark/brandLight with the brand-exact sequence (gold leads)', () => {
    expect(brandDark().mode).toBe('dark');
    expect(brandDark().color.canvas).toBe('#0a0c10');
    expect(brandDark().color.sequence[0]).toBe('#d4a84b');
    expect(brandLight().mode).toBe('light');
    expect(brandLight().color.canvas).toBe('#fafaf7');
    expect(brandLight().color.sequence[0]).toBe('#d4a84b');
  });

  it('TRIPWIRE: leaves the lightEditorial sequence unchanged', () => {
    // the editorial theme keeps the colorblind-safe palette — untouched
    expect(lightEditorial().color.sequence[0]).toBe('#1b9e77');
    // brand sequence is a separate array (additive, not a mutation)
    expect(brandDark().color.sequence).not.toEqual(lightEditorial().color.sequence);
  });
});

describe('P1 chartTokensForBrief threads the brief theme', () => {
  it('brand-dark brief → dark brand tokens', () => {
    const t = chartTokensForBrief(resolveDesignBrief('u', { theme: 'brand-dark' }));
    expect(t.mode).toBe('dark');
    expect(t.color.canvas).toBe('#0a0c10');
    expect(t.color.sequence[0]).toBe('#d4a84b');
  });

  it('brand-light brief → light brand tokens', () => {
    const t = chartTokensForBrief(resolveDesignBrief('u', { theme: 'brand-light' }));
    expect(t.mode).toBe('light');
    expect(t.color.canvas).toBe('#fafaf7');
    expect(t.color.sequence[0]).toBe('#d4a84b');
  });

  it('no brief → existing lightEditorial default (chat mode unchanged)', () => {
    expect(chartTokensForBrief(undefined).color.sequence).toEqual(lightEditorial().color.sequence);
    expect(chartTokensForBrief(undefined).color.canvas).toBe('#fafaf7');
  });
});

describe('P1 infographic brand injection', () => {
  it('puts the brand style/palette in the prompt when provided', () => {
    const p = buildInfographicPrompt({ prompt: 'AI agents', brandStyle: 'Use exactly gold #d4a84b on #0a0c10' });
    expect(p).toContain('#d4a84b');
    expect(p).toContain('#0a0c10');
    expect(p).toContain('AI agents');
  });

  it('falls back to a generic palette line with no brandStyle', () => {
    const p = buildInfographicPrompt({ prompt: 'x' });
    expect(p.toLowerCase()).toContain('professional color palette');
  });
});
