/**
 * @jest-environment node
 */
import { renderDiagram, shutdown } from '../tool';
import { lightEditorial } from '../design-tokens';
import { hasValidSuperGraphProvenance } from '../provenance';

jest.setTimeout(60_000);

afterAll(async () => {
  await shutdown();
});

describe('renderDiagram (end-to-end)', () => {
  it('renders a tech-radar via custom template (no Playwright)', async () => {
    const result = await renderDiagram({
      kind: 'tech-radar',
      data: {
        quadrants: [
          { id: 'q0', name: 'Q1', order: 0 },
          { id: 'q1', name: 'Q2', order: 1 },
          { id: 'q2', name: 'Q3', order: 2 },
          { id: 'q3', name: 'Q4', order: 3 },
        ],
        rings: ['Adopt', 'Trial', 'Assess', 'Hold'],
        items: [
          { name: 'Foo', quadrantId: 'q0', ring: 'Adopt' },
          { name: 'Bar', quadrantId: 'q1', ring: 'Trial' },
        ],
        title: 'Test Radar',
      },
      tokens: lightEditorial(),
    });
    expect(result.success).toBe(true);
    expect(result.svg).toMatch(/^<svg[\s>]/);
    expect(result.svg).toContain('Test Radar');
    expect(hasValidSuperGraphProvenance(result.svg)).toBe(true);
    expect(result.evaluation?.verdict).toBe('PASS');
  });

  it('auto-selects a kind when kind=auto', async () => {
    const result = await renderDiagram({
      kind: 'auto',
      data: {
        nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        links: [
          { source: 'A', target: 'B', value: 5 },
          { source: 'B', target: 'C', value: 3 },
        ],
      },
      intent: 'show flow between stages',
      tokens: lightEditorial(),
    });
    expect(result.success).toBe(true);
    // Sankey selected — rendered via Playwright + ECharts
    expect(result.kind).toBe('sankey');
    expect(result.svg).toMatch(/^<svg[\s>]/);
    expect(hasValidSuperGraphProvenance(result.svg)).toBe(true);
  });

  it('returns placeholder when render fails', async () => {
    const result = await renderDiagram({
      kind: 'tech-radar',
      data: {/* invalid — missing required fields */},
      tokens: lightEditorial(),
    });
    expect(result.success).toBe(false);
    expect(result.svg).toContain('Diagram unavailable');
    expect(result.svg).toContain('font-family="Inter, &quot;Inter Display&quot;, system-ui, -apple-system, sans-serif"');
    expect(result.svg).not.toContain('font-family="Inter, "Inter Display"');
    // The failure reason must surface as structured `error`, not only be
    // painted into the placeholder SVG — callers (and the coverage harness)
    // report it to the agent so the data can be fixed.
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});
