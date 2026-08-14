import { DOMParser } from '@xmldom/xmldom';

import { renderTechRadar } from '../../templates/tech-radar';
import { lightEditorial, brandDark } from '../../design-tokens';

describe('renderTechRadar', () => {
  const fixture = {
    quadrants: [
      { id: 'q0', name: 'Q1', order: 0 },
      { id: 'q1', name: 'Q2', order: 1 },
      { id: 'q2', name: 'Q3', order: 2 },
      { id: 'q3', name: 'Q4', order: 3 },
    ],
    rings: ['ADOPT', 'TRIAL', 'ASSESS', 'HOLD'],
    items: Array.from({ length: 50 }, (_, i) => ({
      name: `Tech ${i + 1}`,
      quadrantId: `q${i % 4}`,
      ring: ['ADOPT', 'TRIAL', 'ASSESS', 'HOLD'][i % 4],
    })),
    title: 'Industrial AI Radar',
  };

  it('emits a self-contained <svg> string', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).toContain('</svg>');
    expect(svg).toContain('viewBox');
  });

  it('emits well-formed XML when the design-token font family contains quotes', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    const parseErrors: string[] = [];
    const document = new DOMParser({
      errorHandler: {
        warning: (message) => parseErrors.push(String(message)),
        error: (message) => parseErrors.push(String(message)),
        fatalError: (message) => parseErrors.push(String(message)),
      },
    }).parseFromString(svg, 'image/svg+xml');

    expect(parseErrors).toEqual([]);
    expect(document.documentElement.localName).toBe('svg');
    expect(document.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg).toContain('font-family="Inter, &quot;Inter Display&quot;, system-ui, -apple-system, sans-serif"');
    expect(svg).not.toContain('font-family="Inter, "Inter Display"');
  });

  it('every blip is represented — either inline label OR legend entry', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    for (const it of fixture.items) {
      // Either the name appears inline (as an SVG <text>) or as a legend row.
      expect(svg.includes(it.name)).toBe(true);
    }
  });

  it('renders all four quadrant titles', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    for (const q of fixture.quadrants) expect(svg).toContain(q.name);
  });

  it('renders all ring labels', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    for (const r of fixture.rings) expect(svg).toContain(r);
  });

  it('NO inline blip-label bboxes overlap (premium quality bar)', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    // Skip ring labels and quadrant titles — they live outside the placement region.
    // Identify blip labels by the data-role attribute we set in the template.
    const blipRe = /<text[^>]*data-role="blip-label"[^>]*\bx="([\d.\-]+)"[^>]*\by="([\d.\-]+)"[^>]*>([^<]+)<\/text>/g;
    const boxes: Array<{ x1: number; y1: number; x2: number; y2: number; text: string }> = [];
    let m;
    while ((m = blipRe.exec(svg)) !== null) {
      const x = parseFloat(m[1]);
      const y = parseFloat(m[2]);
      const text = m[3];
      boxes.push({ x1: x, y1: y - 16, x2: x + text.length * 6.4, y2: y, text });
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
        if (overlap) {
          throw new Error(`blip labels overlap: "${a.text}" and "${b.text}"`);
        }
      }
    }
  });

  it('emits leader lines for offset labels (not for inline-adjacent labels)', () => {
    const svg = renderTechRadar(fixture, lightEditorial());
    // Leader lines have data-role="blip-leader". Could be zero in low-density renders,
    // but with 50 items in a 4×4 grid we should see some.
    const leaders = (svg.match(/data-role="blip-leader"/g) ?? []).length;
    expect(leaders).toBeGreaterThan(0);
  });

  it('escapes XML metacharacters in user-supplied strings', () => {
    const f = {
      quadrants: [{ id: 'q0', name: 'A & B <C>', order: 0 }],
      rings: ['Adopt', '"Trial"'],
      items: [{ name: 'X & Y <Z>', quadrantId: 'q0', ring: 'Adopt' }],
      title: 'Tech & "Radar"',
    };
    const svg = renderTechRadar(f, lightEditorial());
    expect(svg).not.toContain('A & B <C>');
    expect(svg).toContain('A &amp; B &lt;C&gt;');
    expect(svg).not.toContain('X & Y <Z>');
    expect(svg).toContain('X &amp; Y &lt;Z&gt;');
  });

  it('uses only token-derived colors (no hardcoded hex outside tokens)', () => {
    const t = lightEditorial();
    const svg = renderTechRadar(fixture, t);
    // Every fill/stroke value must appear in the tokens, OR be a CSS keyword (none/transparent), OR rgba derived.
    const allowedColors = new Set(
      [
        t.color.canvas,
        t.color.surface,
        t.color.ink,
        t.color.muted,
        t.color.rule,
        ...t.color.sequence,
        t.color.positive,
        t.color.negative,
        t.color.warning,
        t.color.info,
      ].map((c) => c.toLowerCase())
    );
    const re = /(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g;
    let m;
    while ((m = re.exec(svg)) !== null) {
      const used = m[1].toLowerCase();
      if (!allowedColors.has(used)) {
        throw new Error(`tech-radar emitted off-token color ${used}`);
      }
    }
  });

  it('switches colors when given dark tokens', () => {
    const lightSvg = renderTechRadar(fixture, lightEditorial());
    const darkSvg = renderTechRadar(fixture, brandDark());
    expect(lightSvg).not.toEqual(darkSvg);
  });
});
