import { hasValidSuperGraphProvenance, markSuperGraphSvg, SUPER_GRAPH_PROVENANCE_ATTRIBUTE } from '../provenance';

describe('Super-Graph SVG provenance', () => {
  const svg = '<svg viewBox="0 0 10 10"><style>.node { fill: #fff; }</style><rect width="10" height="10" /></svg>';

  it('marks exact renderer output with verifiable provenance', () => {
    const marked = markSuperGraphSvg(svg);

    expect(marked).toContain(SUPER_GRAPH_PROVENANCE_ATTRIBUTE);
    expect(hasValidSuperGraphProvenance(marked)).toBe(true);
  });

  it('is idempotent when renderer output is marked more than once', () => {
    const once = markSuperGraphSvg(svg);
    const twice = markSuperGraphSvg(once);

    expect(twice).toBe(once);
    expect(hasValidSuperGraphProvenance(twice)).toBe(true);
  });

  it('rejects unsigned and post-render edited SVG', () => {
    expect(hasValidSuperGraphProvenance(svg)).toBe(false);

    const tampered = markSuperGraphSvg(svg).replace('#fff', '#000');
    expect(hasValidSuperGraphProvenance(tampered)).toBe(false);
  });
});
