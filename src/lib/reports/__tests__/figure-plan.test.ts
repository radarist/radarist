import type { ScoutBundle } from '@/lib/schemas/scout-bundle';
import {
  bindFigurePlanToHtml,
  evaluateRichExecutiveFigurePlan,
  figurePlanSha256,
  parseFigurePlan,
} from '@/lib/reports/figure-plan';

const bundle: ScoutBundle = {
  queries: ['q1', 'q2', 'q3'],
  sources: [
    {
      id: 1,
      title: 'Primary source',
      url: 'https://example.com/primary',
      fetched_via: 'exa',
      tool_call_id: 'call-1',
      admiralty: 'A1',
      date_accessed: '2026-08-05',
    },
    {
      id: 3,
      title: 'Corroborating source',
      url: 'https://example.com/corroborating',
      fetched_via: 'firecrawl',
      tool_call_id: 'call-3',
      admiralty: 'B2',
      date_accessed: '2026-08-05',
    },
  ],
  findings: ['Adoption moved from pilot to scale [1].', 'Delivery risk remains material [1, 3].'],
  unresolved: [],
};

const planJson = JSON.stringify([
  {
    figureId: 'fig-adoption-curve',
    readerQuestion: 'Where is adoption on the maturity path?',
    visualKind: 's-curve',
    findingIds: [1],
    sourceIds: [1],
  },
  {
    figureId: 'fig-risk-position',
    readerQuestion: 'Which risks change the decision most?',
    visualKind: 'labeled-scatter',
    findingIds: [2],
    sourceIds: [1, 3],
  },
  {
    figureId: 'fig-evidence-table',
    readerQuestion: 'Which evidence supports each conclusion?',
    visualKind: 'table',
    findingIds: [1, 2],
    sourceIds: [1, 3],
  },
]);

describe('evidence-bound figure plan', () => {
  it('validates every finding and source against the exact bundle and yields a stable hash', () => {
    const first = parseFigurePlan(planJson, bundle);
    const reorderedKeys = JSON.stringify(
      JSON.parse(planJson).map((entry: Record<string, unknown>) => ({
        sourceIds: entry.sourceIds,
        visualKind: entry.visualKind,
        readerQuestion: entry.readerQuestion,
        findingIds: entry.findingIds,
        figureId: entry.figureId,
      }))
    );
    const second = parseFigurePlan(reorderedKeys, bundle);
    expect(figurePlanSha256(first)).toBe(figurePlanSha256(second));
  });

  it('rejects absent ids and sources that do not support the selected finding', () => {
    const absent = JSON.stringify([
      {
        figureId: 'fig-invalid',
        readerQuestion: 'What does the absent evidence show?',
        visualKind: 's-curve',
        findingIds: [4],
        sourceIds: [9],
      },
    ]);
    expect(() => parseFigurePlan(absent, bundle)).toThrow(/finding 4 is absent.*source 9 is absent/i);

    const unrelated = JSON.stringify([
      {
        figureId: 'fig-unrelated',
        readerQuestion: 'What does source three say here?',
        visualKind: 'comparison',
        findingIds: [1],
        sourceIds: [3],
      },
    ]);
    expect(() => parseFigurePlan(unrelated, bundle)).toThrow(/cites none.*source 3 is not cited/i);
  });

  it('rejects unsupported, duplicate, and decorative-looking plan entries', () => {
    const invalid = JSON.stringify([
      {
        figureId: 'fig-same',
        readerQuestion: 'What decision does this figure answer?',
        visualKind: 'decorative-orbit',
        findingIds: [],
        sourceIds: [],
      },
      {
        figureId: 'fig-same',
        readerQuestion: 'What decision does this figure answer?',
        visualKind: 'table',
        findingIds: [1],
        sourceIds: [1],
      },
    ]);
    expect(() => parseFigurePlan(invalid, bundle)).toThrow(/supported chart|at least 1|duplicate/i);
  });

  it('binds each rendered figure exactly once and appends canonical provenance idempotently', () => {
    const plan = parseFigurePlan(planJson, bundle);
    const html = `<!doctype html><body>
      <figure data-figure-id="fig-adoption-curve"><svg><text>Curve</text></svg><figcaption>Adoption</figcaption></figure>
      <figure id="fig-risk-position"><svg><text>Risk</text></svg></figure>
      <figure data-figure-id="fig-evidence-table"><table><tr><td>Evidence</td></tr></table></figure>
    </body>`;
    const once = bindFigurePlanToHtml(html, plan);
    const twice = bindFigurePlanToHtml(once, plan);
    expect(twice).toBe(once);
    expect(once.match(/data-figure-provenance=/g)).toHaveLength(3);
    expect(once).toContain('data-visual-kind="labeled-scatter"');
    expect(once).toContain('Evidence: findings F2; sources [1], [3].');
  });

  it('replaces an adversarial prior provenance span without wildcard backtracking', () => {
    const [entry] = parseFigurePlan(planJson, bundle);
    const repeatedAttributes = ' data-figure-provenance=""'.repeat(5_000);
    const html = `<figure data-figure-id="${entry.figureId}"><figcaption>Adoption<span${repeatedAttributes}>old</span></figcaption></figure>`;

    const bound = bindFigurePlanToHtml(html, [entry]);

    expect(bound.match(/data-figure-provenance=/g)).toHaveLength(1);
    expect(bound).not.toContain('>old</span>');
  });

  it('preserves Unicode offsets and trailing caption text around a prior span', () => {
    const [entry] = parseFigurePlan(planJson, bundle);
    const html = `<figure data-figure-id="${entry.figureId}"><figcaption>İstanbul <span data-figure-provenance="old">old</span>AFTER</figcaption></figure>`;

    const bound = bindFigurePlanToHtml(html, [entry]);

    expect(bound).toContain('İstanbul AFTER');
    expect(bound).not.toContain('>old</span>');
  });

  it('preserves repeated unclosed provenance spans without rescanning suffixes', () => {
    const [entry] = parseFigurePlan(planJson, bundle);
    const unclosed = '<span data-figure-provenance="old">'.repeat(5_000);
    const html = `<figure data-figure-id="${entry.figureId}"><figcaption>${unclosed}caption</figcaption></figure>`;

    const bound = bindFigurePlanToHtml(html, [entry]);

    expect(bound).toContain(unclosed);
    expect(bound.match(/data-figure-provenance=/g)).toHaveLength(5_001);
  });

  it('fails closed when a planned figure is missing or duplicated', () => {
    const [entry] = parseFigurePlan(planJson, bundle);
    expect(() => bindFigurePlanToHtml('<body></body>', [entry])).toThrow(/found 0/);
    const duplicate = `<figure data-figure-id="${entry.figureId}"></figure><figure data-figure-id="${entry.figureId}"></figure>`;
    expect(() => bindFigurePlanToHtml(duplicate, [entry])).toThrow(/found 2/);
  });

  it('keeps the rich-executive count as battle acceptance, not a publication rule', () => {
    const accepted = evaluateRichExecutiveFigurePlan(parseFigurePlan(planJson, bundle));
    expect(accepted).toMatchObject({ ok: true, figureCount: 3, nonTabularCount: 2, distinctKindCount: 3 });

    const oneFigure = parseFigurePlan(planJson, bundle).slice(0, 1);
    expect(evaluateRichExecutiveFigurePlan(oneFigure)).toMatchObject({ ok: false, figureCount: 1 });
  });
});
