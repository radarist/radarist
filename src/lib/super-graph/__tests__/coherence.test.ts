import { renderTechRadar } from '../templates/tech-radar';
import { lightEditorial, brandDark } from '../design-tokens';

describe('cross-branch visual coherence', () => {
  const fixture = {
    quadrants: [
      { id: 'q0', name: 'A', order: 0 },
      { id: 'q1', name: 'B', order: 1 },
      { id: 'q2', name: 'C', order: 2 },
      { id: 'q3', name: 'D', order: 3 },
    ],
    rings: ['1', '2', '3', '4'],
    items: [{ name: 'x', quadrantId: 'q0', ring: '1' }],
  };

  it('tech-radar uses the design-tokens font family', () => {
    const tokens = lightEditorial();
    const svg = renderTechRadar(fixture, tokens);
    expect(svg).toContain(`font-family="${tokens.type.family.replaceAll('"', '&quot;')}"`);
  });

  it('tech-radar respects mode switching (light vs dark)', () => {
    const lightSvg = renderTechRadar(fixture, lightEditorial());
    const darkSvg = renderTechRadar(fixture, brandDark());
    expect(lightSvg).not.toEqual(darkSvg);
    expect(lightSvg).toContain(`font-family="${lightEditorial().type.family.replaceAll('"', '&quot;')}"`);
    expect(darkSvg).toContain(`font-family="${brandDark().type.family.replaceAll('"', '&quot;')}"`);
  });
});
