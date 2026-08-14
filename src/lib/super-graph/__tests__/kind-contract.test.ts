/**
 * @file super-graph/__tests__/kind-contract.test.ts
 * @description AI-050 — the declared diagram contract must match the schema
 * that actually validates the data.
 *
 * If the tool declaration and Zod schema disagree, a model has no reliable way
 * to learn the accepted shape and can fall back to hand-authored output. These
 * tests pin the contract at both boundaries.
 *
 * These tests pin the contract from BOTH ends, so a third hand-typed copy of a
 * shape cannot drift again:
 *   1. every kind's published example parses against that kind's own schema;
 *   2. every kind reachable through the tool is published;
 *   3. the rendered declaration text a model reads is generated from the same
 *      catalog, not retyped.
 */
import { CATALOG } from '../catalog';
import { DIAGRAM_KIND_IDS, describeDiagramKinds, diagramKindExample, formatDiagramDataError } from '../kind-contract';

describe('AI-050 — diagram kind contract', () => {
  it('publishes an example for every catalog kind', () => {
    const documented = new Set(DIAGRAM_KIND_IDS);
    const catalogKinds = CATALOG.map((entry) => entry.kind);
    expect([...catalogKinds].sort()).toEqual([...documented].sort());
  });

  // The regression that shipped: `bubble` was documented as
  // `{points:[{x,y,size,label?,group?}]}` while the schema requires a `name` on
  // every point and knows nothing about `label`/`group`; `tech-radar` was
  // documented with bare `quadrants`/`items[].quadrant` while the schema needs
  // `{id,name,order}` quadrant objects and `items[].quadrantId`; `risk-matrix`
  // was documented with a 2-D `cells` array while the schema takes
  // `[{row,col,value}]` records. Parsing each published example against its own
  // schema is what makes that class of drift impossible.
  it.each(CATALOG.map((entry) => entry.kind))('example for %s parses against its own schema', (kind) => {
    const entry = CATALOG.find((e) => e.kind === kind)!;
    const example = diagramKindExample(kind);
    expect(example).toBeDefined();
    const parsed = entry.schema.safeParse(example);
    if (!parsed.success) {
      throw new Error(
        `published ${kind} example does not satisfy its schema: ${JSON.stringify(parsed.error.issues, null, 2)}`
      );
    }
  });

  it('renders one model-legible block naming each kind and its required keys', () => {
    const text = describeDiagramKinds();
    for (const kind of DIAGRAM_KIND_IDS) {
      expect(text).toContain(kind);
    }
    // Compact enough to sit inside a tool declaration without crowding out the
    // rest of the surface, but complete enough to copy from.
    expect(text.length).toBeLessThan(4000);
    // The three shapes the live model got wrong must be unambiguous in the text.
    expect(text).toContain('quadrantId');
    expect(text).toContain('"name"');
    expect(text).toContain('"row"');
  });
});

describe('AI-050 — bounded, actionable validation errors', () => {
  it('names the offending path, the expectation and the corrective example', () => {
    const message = formatDiagramDataError('bubble', { points: [{ x: 1, y: 2, size: 3 }] });
    expect(message).toContain('bubble');
    // The exact missing field, not a raw Zod dump.
    expect(message).toMatch(/points\[0\]\.name/);
    expect(message).toContain('Required shape');
    // The corrective example must be present so the next call can succeed.
    expect(message).toContain('"name"');
  });

  it('bounds the message so a large invalid payload cannot flood the event log', () => {
    const huge = { points: Array.from({ length: 400 }, (_, i) => ({ x: i, y: i, size: i })) };
    const message = formatDiagramDataError('bubble', huge);
    expect(message).not.toBeNull();
    expect((message ?? '').length).toBeLessThan(1200);
    // Truncation must be disclosed, never silent.
    expect(message).toMatch(/\+\d+ more/);
  });

  it('reports an unknown kind with the list of supported kinds', () => {
    const message = formatDiagramDataError('pie-chart', {});
    expect(message).toContain('pie-chart');
    expect(message).toContain('tech-radar');
  });

  it('returns null for data that already satisfies the schema', () => {
    expect(formatDiagramDataError('bubble', diagramKindExample('bubble'))).toBeNull();
  });
});
