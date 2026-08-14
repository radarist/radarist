/**
 * @jest-environment node
 */
import { verifyComposition, templateContrastPairs } from '../composer-verify';
import { reportBlocksDocSchema } from '@/lib/schemas/report-blocks';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';

const doc = (blocks: unknown[]) => reportBlocksDocSchema.parse({ title: 'Verify test doc', blocks });

const okDoc = doc([
  { type: 'section', label: 'Summary', title: 'Summary' },
  { type: 'prose', body: 'Adoption is rising [1].' },
  { type: 'references', items: [{ n: 1, text: 'Gartner 2026' }] },
]);

describe('verifyComposition (REPORT-012 T2.5)', () => {
  it('passes both brand briefs (dark and light) — the defaults are provably readable', () => {
    for (const brief of [resolveDesignBrief('u'), resolveDesignBrief('u', { theme: 'brand-light' })]) {
      const v = verifyComposition(okDoc, brief, []);
      expect(v.findings).toEqual([]);
      expect(v.ok).toBe(true);
    }
  });

  it('blocks a custom palette whose ink≈bg with a named pair', () => {
    const bad = resolveDesignBrief('u', {
      theme: 'custom',
      palette: { bg: '#ffffff', surface: '#ffffff', ink: '#e8eaf0', accent: '#f0f0f0', sequence: ['#ffffff'] },
    });
    const v = verifyComposition(okDoc, bad, []);
    expect(v.ok).toBe(false);
    expect(v.findings.join('\n')).toContain('palette-contrast: body text on page');
  });

  it('flags cite markers with no matching reference item', () => {
    const d = doc([
      { type: 'section', label: 'S', title: 'S' },
      { type: 'prose', body: 'Claim [2] and claim [5].' },
      { type: 'references', items: [{ n: 2, text: 'src' }] },
    ]);
    const v = verifyComposition(d, resolveDesignBrief('u'), []);
    expect(v.ok).toBe(false);
    expect(v.findings.join('\n')).toContain('[5]');
    expect(v.findings.join('\n')).not.toContain('[2]');
  });

  it('flags cites with no references block at all', () => {
    const d = doc([
      { type: 'section', label: 'S', title: 'S' },
      { type: 'prose', body: 'Claim [1].' },
      { type: 'prose', body: 'More.' },
    ]);
    const v = verifyComposition(d, resolveDesignBrief('u'), []);
    expect(v.findings.join('\n')).toContain('no references block');
  });

  it('strict mode blocks unresolved refs; lenient mode does not', () => {
    const warnings = ['unresolved chart-ref: sankey-x-1'];
    expect(verifyComposition(okDoc, resolveDesignBrief('u'), warnings).ok).toBe(false);
    expect(verifyComposition(okDoc, resolveDesignBrief('u'), warnings, { strict: false }).ok).toBe(true);
  });

  it('enumerates at least the core template pairs', () => {
    const pairs = templateContrastPairs(resolveDesignBrief('u'));
    expect(pairs.map((p) => p.name)).toEqual(
      expect.arrayContaining(['body text on page', 'body text on card', 'accent (titles/cites) on page'])
    );
  });
});

describe('adversarial review fixes (2026-07-20)', () => {
  it('flags dangling cites inside table cells and action items', () => {
    const d = doc([
      { type: 'section', label: 'S', title: 'S' },
      { type: 'table', header: ['A'], rows: [['claim [9]']] },
      { type: 'action-grid', cards: [{ phase: 'P', title: 'T', items: ['do it [8]'] }] },
      { type: 'references', items: [{ n: 1, text: 'src' }] },
    ]);
    const v = verifyComposition(d, resolveDesignBrief('u'), []);
    expect(v.ok).toBe(false);
    expect(v.findings.join('\n')).toContain('[8, 9]');
  });

  it('unresolved image-refs do NOT block; unresolved chart-refs do', () => {
    const chartWarn = ['unresolved chart-ref: sankey-1'];
    const imageWarn = ['unresolved image-ref: hero-1'];
    expect(verifyComposition(okDoc, resolveDesignBrief('u'), chartWarn).ok).toBe(false);
    expect(verifyComposition(okDoc, resolveDesignBrief('u'), imageWarn).ok).toBe(true);
  });
});
