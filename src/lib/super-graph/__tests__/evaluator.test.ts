import { evaluateSvg } from '../evaluator';
import { lightEditorial } from '../design-tokens';

describe('evaluateSvg (Layer A)', () => {
  const tokens = lightEditorial();

  it('passes a clean svg using only token colors', () => {
    const svg = `<svg viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${tokens.color.canvas}"/><text x="100" y="100" font-family="${tokens.type.family}" fill="${tokens.color.ink}">Hello</text></svg>`;
    const r = evaluateSvg(svg, { kind: 'tech-radar', aspect: '16:9' }, tokens);
    expect(r.verdict).toBe('PASS');
    expect(r.issues).toHaveLength(0);
  });

  it('flags off-token colors', () => {
    const svg = `<svg viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#ff00ff"/></svg>`;
    const r = evaluateSvg(svg, { kind: 'tech-radar', aspect: '16:9' }, tokens);
    expect(r.verdict).toBe('REVISE');
    expect(r.issues.some((i) => i.dimension === 'token-compliance')).toBe(true);
  });

  it('passes visualMap interpolants — linear blends of two token colors', () => {
    // Midpoint of positive #15803d and negative #b91c1c: (103, 78, 44.5).
    const svg = `<svg viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${tokens.color.canvas}"/><rect fill="#674e2d"/></svg>`;
    const r = evaluateSvg(svg, { kind: 'risk-matrix', aspect: '16:9' }, tokens);
    expect(r.issues.filter((i) => i.dimension === 'token-compliance')).toHaveLength(0);
  });

  it('flags wrong aspect', () => {
    const svg = `<svg viewBox="0 0 800 800"><rect fill="${tokens.color.canvas}"/></svg>`;
    const r = evaluateSvg(svg, { kind: 'tech-radar', aspect: '16:9' }, tokens);
    expect(r.verdict).toBe('REVISE');
    expect(r.issues.some((i) => i.dimension === 'aspect')).toBe(true);
  });
});
