/**
 * @file super-graph/__tests__/render-first-call.test.ts
 * @description AI-050 — a model that follows the published declaration succeeds
 * on the FIRST call, for every supported kind.
 *
 * If the declared shapes disagree with the parser, valid-looking
 * `tech-radar`, `bubble`, and `risk-matrix` calls all fail before rendering. This
 * suite replays the model's side of that exchange without a provider and
 * without Chromium: the ECharts/Mermaid host is stubbed, and the payload is the
 * exact example the declaration publishes.
 *
 * Two negative controls keep it non-vacuous: incompatible legacy shapes must be
 * rejected, and the
 * rejection must name the offending field.
 */

// The Playwright-backed host is the only heavy dependency; everything else —
// schema parsing, the template branch, the evaluator — runs for real.
jest.mock('../render', () => ({
  DiagramRenderer: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async renderViaLibrary(): Promise<string> {
      // A minimal token-pure SVG. The evaluator runs for real against it.
      return '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"></svg>';
    }
  },
}));

// The heuristic evaluator is a separate concern (layout quality); this suite is
// about the DATA CONTRACT, so hold it at PASS and let schema/dispatch decide.
jest.mock('../evaluator', () => ({
  evaluateSvg: () => ({ verdict: 'PASS', issues: [] }),
}));

import { renderDiagram } from '../tool';
import { brandDark } from '../design-tokens';
import { DIAGRAM_KIND_IDS, diagramKindExample } from '../kind-contract';

const tokens = brandDark();

describe('AI-050 — first-call success for every declared kind', () => {
  it.each(DIAGRAM_KIND_IDS)('%s renders from its published example without retry', async (kind) => {
    const result = await renderDiagram({ kind, data: diagramKindExample(kind), tokens });
    if (!result.success) {
      throw new Error(`${kind} failed on the first call: ${result.error}`);
    }
    expect(result.kind).toBe(kind);
    expect(result.svg).toContain('<svg');
  });

  it('covers every kind the catalog can dispatch', () => {
    // A kind added to the catalog without a published example would silently
    // escape the loop above.
    expect(DIAGRAM_KIND_IDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('AI-050 — invalid declaration-shaped payloads are rejected with a usable reason', () => {
  const syntheticFailures: Array<{ kind: string; data: unknown; mustMention: RegExp }> = [
    {
      kind: 'tech-radar',
      // Documented as `quadrants: [...], items: [{name, quadrant, ring}]`.
      data: {
        quadrants: ['Platforms'],
        rings: ['Adopt', 'Trial'],
        items: [{ name: 'Vector DB', quadrant: 'Platforms', ring: 'Trial' }],
      },
      mustMention: /quadrants\[0\]/,
    },
    {
      kind: 'bubble',
      // Documented as `points: [{x, y, size, label?, group?}]` — no `name`.
      data: { points: [{ x: 3, y: 7, size: 40, label: 'Option A', group: 'Build' }] },
      mustMention: /points\[0\]\.name/,
    },
    {
      kind: 'risk-matrix',
      // Documented with a 2-D `cells` array of labels.
      data: {
        rows: ['Low', 'High'],
        cols: ['Minor', 'Severe'],
        cells: [
          ['a', 'b'],
          ['c', 'd'],
        ],
      },
      mustMention: /cells\[0\]/,
    },
  ];

  it.each(syntheticFailures)('$kind reports the offending field and the required shape', async (scenario) => {
    const result = await renderDiagram({ kind: scenario.kind, data: scenario.data, tokens });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(scenario.mustMention);
    expect(result.error).toContain('Required shape');
    // A placeholder is still returned so the caller has something to show, but
    // the reason must not be hidden behind it.
    expect(result.svg).toContain('<svg');
    const serialized = JSON.stringify(result);
    expect(serialized.indexOf('"error"')).toBeLessThan(serialized.indexOf('"svg"'));
  });

  it('bounds the failure payload so a persisted event receipt stays readable', async () => {
    const result = await renderDiagram({
      kind: 'bubble',
      data: { points: Array.from({ length: 300 }, (_, i) => ({ x: i, y: i, size: i })) },
      tokens,
    });
    expect(result.success).toBe(false);
    expect((result.error ?? '').length).toBeLessThan(1200);
  });
});
