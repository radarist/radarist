import { lightEditorial, brandDark, type DesignTokens } from '../design-tokens';

describe('DesignTokens factories', () => {
  it('lightEditorial returns a valid DesignTokens with cream canvas and ink text', () => {
    const t: DesignTokens = lightEditorial();
    expect(t.mode).toBe('light');
    expect(t.color.canvas).toMatch(/^#[0-9a-f]{6}$/i);
    // No `color.quadrant` token anymore — quadrant accents derive from `color.sequence`
    // so the radar template can support 1..8 quadrants.
    expect(t.color.sequence.length).toBeGreaterThanOrEqual(8);
    expect(typeof t.color.leader).toBe('string');
    expect(t.type.family).toContain('Inter');
    expect(t.geom.strokeBase).toBe(1);
  });

  it('brandDark returns a dark-mode token set distinct from the light theme', () => {
    const t = brandDark();
    expect(t.mode).toBe('dark');
    expect(t.color.canvas).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t.color.ink).not.toBe(lightEditorial().color.ink);
  });

  it('every token in sequence palette is a valid hex color', () => {
    const t = lightEditorial();
    for (const c of t.color.sequence) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('type scale is monotonically increasing', () => {
    const t = lightEditorial();
    const order = ['caption', 'small', 'base', 'lg', 'xl', 'title'] as const;
    let prev = 0;
    for (const k of order) {
      expect(t.type.scale[k]).toBeGreaterThan(prev);
      prev = t.type.scale[k];
    }
  });
});
