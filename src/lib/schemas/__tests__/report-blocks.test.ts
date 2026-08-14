/**
 * REPORT-012 Task 2.1 — the typed-block authoring contract.
 */
import { reportBlockSchema, reportBlocksDocSchema } from '../report-blocks';

const validDoc = {
  title: 'AI Agent Orchestration: Strategic Landscape',
  subtitle: 'For enterprise engineering leadership',
  blocks: [
    { type: 'section', label: '01 · Executive Summary', title: 'The bet in one page' },
    { type: 'prose', body: 'LangGraph leads production adoption [1]. Confidence: 0.8' },
    {
      type: 'stat-grid',
      stats: [
        { number: '40%', label: 'enterprise apps with agents by 2026', source: 'Gartner [2]' },
        { number: '$58.9B', label: 'orchestration market by 2033' },
      ],
    },
  ],
};

describe('reportBlocksDocSchema', () => {
  it('parses a valid minimal doc', () => {
    const parsed = reportBlocksDocSchema.safeParse(validDoc);
    expect(parsed.success).toBe(true);
  });

  it('rejects fewer than 3 blocks', () => {
    expect(reportBlocksDocSchema.safeParse({ ...validDoc, blocks: validDoc.blocks.slice(0, 2) }).success).toBe(false);
  });

  it('rejects unknown block types', () => {
    expect(reportBlockSchema.safeParse({ type: 'marquee', text: 'nope' }).success).toBe(false);
  });

  it('accepts 20k-char prose and rejects 21k', () => {
    expect(reportBlockSchema.safeParse({ type: 'prose', body: 'x'.repeat(20_000) }).success).toBe(true);
    expect(reportBlockSchema.safeParse({ type: 'prose', body: 'x'.repeat(21_000) }).success).toBe(false);
  });

  it('html-embed rejects script/style/link/iframe but allows inline-styled svg', () => {
    const bad = { type: 'html-embed', rationale: 'custom curve', html: '<style>.x{}</style><svg></svg>' };
    const good = {
      type: 'html-embed',
      rationale: 'hype-cycle curve',
      html: '<svg viewBox="0 0 10 10"><path d="M0 0" style="stroke:#d4a84b"/></svg>',
    };
    expect(reportBlockSchema.safeParse(bad).success).toBe(false);
    expect(reportBlockSchema.safeParse(good).success).toBe(true);
  });

  it('jtbd-block mirrors the fenced skill contract fields', () => {
    const parsed = reportBlockSchema.safeParse({
      type: 'jtbd-block',
      technology: 'LangGraph',
      job: 'minimize the time it takes to ship a reliable multi-agent workflow',
      context: 'platform teams at 1000+ engineer orgs',
      competing: ['CrewAI', 'AutoGen', 'Non-consumption: hand-rolled orchestration'],
      struggling: 'Our prototype agents loop forever and burn budget without visibility.',
    });
    expect(parsed.success).toBe(true);
  });

  it('chart-ref/image-ref enforce id shape', () => {
    expect(reportBlockSchema.safeParse({ type: 'chart-ref', chartId: 'ok-chart-1', title: 'Adoption' }).success).toBe(
      true
    );
    expect(reportBlockSchema.safeParse({ type: 'chart-ref', chartId: '../etc', title: 'nope' }).success).toBe(false);
    expect(
      reportBlockSchema.safeParse({ type: 'image-ref', imageId: 'hero-1', alt: 'Factory floor with sensors' }).success
    ).toBe(true);
  });

  it('references items carry optional admiralty grades', () => {
    const parsed = reportBlockSchema.safeParse({
      type: 'references',
      items: [{ n: 1, text: 'Gartner, "Hype Cycle 2025"', url: 'https://gartner.com/x', admiralty: 'B2' }],
    });
    expect(parsed.success).toBe(true);
    expect(
      reportBlockSchema.safeParse({ type: 'references', items: [{ n: 1, text: 'x', admiralty: 'Z9' }] }).success
    ).toBe(false);
  });
});
