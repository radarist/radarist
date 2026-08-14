/**
 * @jest-environment node
 */
import { DiagramRenderer } from '../render';
import { lightEditorial } from '../design-tokens';
import { buildEchartsOption } from '../branches/echarts';
import { diagramKindExample } from '../kind-contract';

jest.setTimeout(30_000);

describe('DiagramRenderer smoke', () => {
  it('boots Playwright and renders a trivial mermaid flowchart to inline SVG', async () => {
    const r = new DiagramRenderer();
    await r.start();
    try {
      const tokens = lightEditorial();
      const svg = await r.renderViaLibrary({
        kind: 'flowchart',
        branch: 'mermaid',
        data: { source: 'flowchart TD\n  A --> B\n  B --> C' },
        tokens,
      });
      expect(svg.trim()).toMatch(/^<svg[\s>]/);
      expect(svg).toContain('</svg>');
      expect(svg.length).toBeGreaterThan(200);
      // Guard against an empty `<svg></svg>` sneaking past the prefix check.
      // Mermaid stamps the render id ('m1', from buildHostHtml) into the
      // resulting SVG, so its presence proves Mermaid actually rendered.
      expect(svg).toContain('m1');
    } finally {
      await r.stop();
    }
  });

  it.each([
    ['s-curve', ['Research', 'Prototype', 'Inflection', 'Scale', 'Mainstream']],
    ['labeled-scatter', ['Option A', 'Option B', 'Option C']],
    ['roadmap-timeline', ['Baseline', 'Pilot', 'Scale']],
  ] as const)('renders the strategic %s primitive in real Chromium with authored labels', async (kind, labels) => {
    const r = new DiagramRenderer();
    await r.start();
    try {
      const tokens = lightEditorial();
      const option = buildEchartsOption(kind, diagramKindExample(kind), tokens);
      const svg = await r.renderViaLibrary({
        kind,
        branch: 'echarts',
        data: { option },
        tokens,
      });
      expect(svg.trim()).toMatch(/^<svg[\s>]/);
      for (const label of labels) expect(svg).toContain(label);

      // A non-empty SVG can still rasterize blank when an option is invalid,
      // so verify the exact Chromium pixel boundary the report consumes.
      const png = await r.rasterizeSvg(svg);
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(png.byteLength).toBeGreaterThan(8_000);
    } finally {
      await r.stop();
    }
  });
});
