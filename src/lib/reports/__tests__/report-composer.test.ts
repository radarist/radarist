/**
 * @jest-environment node
 */
/**
 * REPORT-012 Task 2.3 — composer core: escaping, inline semantics, chart
 * by-reference byte-identity, section rhythm/TOC, L1 marker preservation.
 */
import { composeReport, applyInlineSemantics, type ComposeInput } from '../report-composer';
import { reportBlocksDocSchema } from '@/lib/schemas/report-blocks';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const SIGNED_SVG =
  '<svg data-radarist-super-graph-sha256="deadbeef" viewBox="0 0 100 60"><rect fill="#d4a84b" width="10" height="10"/></svg>';

function baseInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  const doc = reportBlocksDocSchema.parse({
    title: 'Composer Golden',
    subtitle: 'For unit tests',
    audience: 'Engineering leadership',
    blocks: [
      { type: 'section', label: 'Executive Summary', title: 'The bet in one page' },
      {
        type: 'prose',
        body: 'LangGraph leads [1]. <script>alert(1)</script> [validated, Gartner 2026] Confidence: 0.8',
      },
      {
        type: 'stat-grid',
        stats: [
          { number: '40%', label: 'apps with agents by 2026' },
          { number: '$58.9B', label: 'market by 2033' },
        ],
      },
      { type: 'chart-ref', chartId: 'sankey-value-chain-abc1', title: 'Value chain', caption: 'Flows 2026' },
      {
        type: 'references',
        items: [{ n: 1, text: 'Gartner, Hype Cycle 2026', url: 'https://gartner.example/hc', admiralty: 'B2' }],
      },
    ],
  });
  return {
    doc,
    brief: resolveDesignBrief('u'),
    missionId: 'mission-test-1',
    charts: jest.fn(async (id: string) => (id === 'sankey-value-chain-abc1' ? SIGNED_SVG : null)),
    images: jest.fn(async () => null),
    generatedAt: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('applyInlineSemantics', () => {
  it('renders cite anchors in the exact critique-report shape', () => {
    const out = applyInlineSemantics('Adoption is rising [3] and [4, 7].');
    expect(out).toContain('<a class="cite-link" href="#ref-3"><sup class="cite">[3]</sup></a>');
    expect(out).toContain('href="#ref-4"');
    expect(out).toContain('href="#ref-7"');
  });

  it('renders provenance brackets and confidence badges', () => {
    const out = applyInlineSemantics('Market is $9.76B [validated, Grand View 2024]. Confidence: 0.75');
    expect(out).toContain('class="prov prov-validated"');
    expect(out).toContain('class="confidence-badge"');
  });

  it('preserves commas and escaped apostrophes inside provenance brackets', () => {
    const out = applyInlineSemantics('[validated, O&#39;Brien, primary source]');
    expect(out).toContain('>validated, O&#39;Brien, primary source</span>');
  });

  it('leaves a maximum-size unclosed provenance marker unchanged', () => {
    const input = `${'[validated'.repeat(5_000)}${','.repeat(20_000)}`;
    expect(applyInlineSemantics(input)).toBe(input);
  });

  it('does not turn provenance-bracket numerals into cites', () => {
    const out = applyInlineSemantics('[assumption, retire-by Q3 2027]');
    expect(out).toContain('prov-assumption');
    expect(out).not.toContain('cite-link');
  });
});

describe('composeReport', () => {
  it('escapes authored HTML in prose (script becomes text, never markup)', async () => {
    const { html } = await composeReport(baseInput());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('inlines cached chart svg byte-identically (provenance survives)', async () => {
    const { html, warnings } = await composeReport(baseInput());
    expect(html).toContain(SIGNED_SVG);
    expect(warnings).toHaveLength(0);
  });

  it('carries a planned chart figure id into rendered HTML', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Planned figure',
      blocks: [
        { type: 'section', label: 'Evidence', title: 'Evidence' },
        { type: 'prose', body: 'Supported analysis [1].' },
        {
          type: 'chart-ref',
          chartId: 'sankey-value-chain-abc1',
          figureId: 'fig-value-chain',
          title: 'Value chain',
          caption: 'Evidence flow [1]',
        },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).toContain('<figure id="fig-value-chain" data-figure-id="fig-value-chain">');
  });

  it('renders a labeled placeholder + warning for an unresolved chart-ref', async () => {
    const input = baseInput({ charts: jest.fn(async () => null) });
    const { html, warnings } = await composeReport(input);
    expect(html).toContain('chart-missing');
    expect(warnings).toEqual([expect.stringContaining('unresolved chart-ref')]);
  });

  it('links the brand stylesheet, binds the brief suffix, and stamps the composed marker', async () => {
    const { html } = await composeReport(baseInput());
    expect(html).toContain('<link rel="stylesheet" href="/css/report-brand.css">');
    expect(html).toContain('data-design-pass="page-theme"');
    expect(html).toContain('template@v1');
    expect(html).toContain('data-composer="v1"');
  });

  it('auto-numbers sections and emits a TOC only at 6+ sections', async () => {
    const few = await composeReport(baseInput());
    expect(few.html).toContain('01 &middot; Executive Summary');
    expect(few.html).not.toContain('class="toc"');

    const manyBlocks = Array.from({ length: 6 }, (_, i) => [
      { type: 'section' as const, label: `Part ${i + 1}`, title: `Section ${i + 1}` },
      { type: 'prose' as const, body: `Body ${i + 1}` },
    ]).flat();
    const doc = reportBlocksDocSchema.parse({ title: 'Six sections', blocks: manyBlocks });
    const many = await composeReport(baseInput({ doc }));
    expect(many.html).toContain('class="toc"');
    expect(many.html).toContain('href="#s-6"');
  });

  it('preserves the literal L1 evolution-stage marker', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Markers',
      blocks: [
        { type: 'section', label: 'Maturity', title: 'Wardley placement' },
        {
          type: 'evolution-tag',
          technology: 'LangGraph',
          stage: 'Product',
          rationale: 'Multiple named production references.',
          methodFit: 'Lean',
        },
        { type: 'prose', body: 'See above.' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).toContain('Evolution stage:');
  });

  it('html-embed passes inline-styled svg through with handlers stripped', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Embed',
      blocks: [
        { type: 'section', label: 'Custom', title: 'Hype curve' },
        {
          type: 'html-embed',
          rationale: 'hype-cycle curve has no renderer kind yet',
          html: '<svg viewBox="0 0 10 10" onclick="x()"><path d="M0 0L10 10" style="stroke:#d4a84b"/></svg>',
        },
        { type: 'prose', body: 'end' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).toContain('class="report-embed"');
    expect(html).toContain('style="stroke:#d4a84b"');
    expect(html).not.toContain('onclick');
  });

  it('groups consecutive horizon-cards into one action grid', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Horizons',
      blocks: [
        { type: 'section', label: 'Portfolio', title: 'Three horizons' },
        {
          type: 'horizon-card',
          bet: 'Adopt LangGraph',
          horizon: 'H1',
          timeToRevenue: '0-12 months',
          evidenceBar: 'hard ROI',
          method: 'Stage-Gate',
          implication: 'Fund from the ops budget.',
        },
        {
          type: 'horizon-card',
          bet: 'Watch neuromorphic',
          horizon: 'H3',
          timeToRevenue: '3-5 years',
          evidenceBar: 'weak-signal monitoring',
          method: 'thesis-and-watchlist',
          implication: 'No CapEx before 2028.',
        },
        { type: 'prose', body: 'end' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    const grids = html.match(/class="action-grid"/g) ?? [];
    expect(grids).toHaveLength(1);
    expect(html).toContain('horizon-badge');
  });
});

describe('template polish regressions (Playwright review 2026-07-20)', () => {
  it('long stat values get the --long modifier so they never clip', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Stats',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        {
          type: 'stat-grid',
          stats: [
            { number: '€180/kWh', label: 'long value' },
            { number: '34%', label: 'short value' },
          ],
        },
        { type: 'prose', body: 'end' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).toContain('stat-number stat-number--long">€180/kWh');
    expect(html).toMatch(/stat-number">34%/);
  });
});

describe('adversarial review fixes (2026-07-20)', () => {
  // REPORT-013: sources stay UNLINKED, but the COMPLETE url is preserved as
  // copyable text. Hostname-only discarded the provenance a citation exists to
  // carry, so a reader could neither reach nor reconstruct the source.
  it('references print the complete url as muted text, never off-origin anchors', async () => {
    const { html } = await composeReport(baseInput());
    expect(html).not.toMatch(/href="https?:\/\//);
    expect(html).toContain('<span class="ref-source">https://gartner.example/hc</span>');
  });

  it('markdown links in prose render as text + complete url, not anchors', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Links',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        { type: 'prose', body: 'See [the FT audit](https://ft.example/audit) for details.' },
        { type: 'prose', body: 'end' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).not.toMatch(/href="https?:\/\//);
    expect(html).toContain('the FT audit <span class="ref-source">https://ft.example/audit</span>');
  });

  it('html-embed drops non-fragment hrefs', async () => {
    const doc = reportBlocksDocSchema.parse({
      title: 'Embed hrefs',
      blocks: [
        { type: 'section', label: 'S', title: 'S' },
        {
          type: 'html-embed',
          rationale: 'custom svg with a link',
          html: '<svg viewBox="0 0 10 10"><a href="https://evil.example/x"><text>go</text></a></svg>',
        },
        { type: 'prose', body: 'end' },
      ],
    });
    const { html } = await composeReport(baseInput({ doc }));
    expect(html).not.toContain('evil.example');
  });
});
