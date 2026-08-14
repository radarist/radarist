/**
 * @file report-design-contrast.test.ts
 * @description REPORT-003 — deterministic WCAG-contrast gate over authored CSS.
 *
 * This analyzer flags CONFIDENTLY RESOLVABLE low-contrast cases
 * such as pale text on white. It covers
 * that class statically (no DOM): same-selector color/background pairs,
 * inline style pairs, page-level text on a declared page background, and a
 * page-sweep of colors that have no plausible authored surface. Ratios below
 * 3.0:1 are hard violations; 3.0–4.5 are advisories. Browser acceptance
 * (Playwright) proves the same fixture against real computed styles.
 */

import { analyzeReportContrast, contrastRatio } from '../report-design-contrast';

const wrap = (css: string, body = '<h1>Title</h1><p>Body text</p>') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;

describe('contrastRatio', () => {
  it('computes the canonical white/black extremes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('reproduces the retained 1.20:1 failure (#e8eaf0 on white)', () => {
    const ratio = contrastRatio('#e8eaf0', '#ffffff');
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.3);
  });
});

describe('analyzeReportContrast', () => {
  it('flags a same-rule pair below 3.0:1 as a hard violation', () => {
    const verdict = analyzeReportContrast(wrap('.final-verdict-title { color: #e8eaf0; background-color: #ffffff; }'));
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0]).toMatchObject({ check: 'minimum-contrast' });
    expect(verdict.violations[0].detail).toContain('.final-verdict-title');
    expect(verdict.violations[0].detail).toMatch(/1\.2/);
  });

  it('pairs a color-only rule with a background declared for the SAME selector elsewhere', () => {
    const verdict = analyzeReportContrast(wrap('.rec { background: #ffffff; } .rec { color: #e8eaf0; }'));
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].detail).toContain('.rec');
  });

  it('flags body-level text against the declared page background', () => {
    const verdict = analyzeReportContrast(wrap('body { background: #ffffff; color: #f0f1f5; }'));
    expect(verdict.ok).toBe(false);
  });

  it('flags an inline style pair below the floor', () => {
    const verdict = analyzeReportContrast(
      `<!doctype html><html><body><div style="color:#e8eaf0;background:#ffffff">Recommendation</div></body></html>`
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].detail).toContain('inline style');
  });

  it('page sweep: flags a light text color on a light declared page with no plausible dark surface', () => {
    const verdict = analyzeReportContrast(wrap('body { background: #ffffff; } .recommendation h2 { color: #e8eaf0; }'));
    expect(verdict.ok).toBe(false);
  });

  it('page sweep: does NOT flag light text when a plausible dark authored surface exists', () => {
    const verdict = analyzeReportContrast(
      wrap('body { background: #ffffff; } .hero { background: #10141f; } .hero-title { color: #e8eaf0; }')
    );
    expect(verdict.ok).toBe(true);
  });

  it('reports 3.0–4.5 pairs as advisories, not violations', () => {
    // #757575 on white ≈ 4.6:1; use #8a8a8a ≈ 3.5:1 for the advisory band.
    const verdict = analyzeReportContrast(wrap('.muted { color: #8a8a8a; background: #ffffff; }'));
    expect(verdict.ok).toBe(true);
    expect(verdict.advisories.length).toBeGreaterThan(0);
    expect(verdict.advisories[0]).toMatchObject({ check: 'minimum-contrast', severity: 'advise' });
  });

  it('passes a clean high-contrast document', () => {
    const verdict = analyzeReportContrast(
      wrap('body { background: #ffffff; color: #16181d; } .card { background: #f4f5f7; color: #1a1d24; }')
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.advisories).toHaveLength(0);
  });

  it('stays silent without authored CSS (brand stylesheet owns the page)', () => {
    const verdict = analyzeReportContrast('<!doctype html><html><body><h1>Plain</h1></body></html>');
    expect(verdict.ok).toBe(true);
  });

  it('ignores colors it cannot resolve confidently (var(), gradients, unknown names)', () => {
    const verdict = analyzeReportContrast(
      wrap('.x { color: var(--text-primary); background: linear-gradient(#fff, #000); }')
    );
    expect(verdict.ok).toBe(true);
  });
});

/**
 * COORD-021 — this analyzer grades the SCREEN palette.
 *
 * The page-theme suffix pins `html,body` last in document order and now carries
 * a print-scoped remap after it. Before this suite, `@media` openers were
 * deleted with a regex, so the print remap would have become the last page
 * background for every themed export — the analyzer would have graded paper and
 * stopped seeing screen contrast at all.
 */
describe('analyzeReportContrast — media scoping', () => {
  it('does not let a print-only page background mask a screen violation', () => {
    // Screen is white-on-white (1:1). Paper is legible. Only screen may be graded.
    const verdict = analyzeReportContrast(
      wrap(
        'html,body{background:#ffffff;color:#ffffff;}' + '@media print{html,body{background:#ffffff;color:#111318;}}'
      )
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].detail).toMatch(/1\.00:1/);
  });

  it('does not invent a violation from a print-only rule when screen is legible', () => {
    const verdict = analyzeReportContrast(
      wrap('html,body{background:#ffffff;color:#111318;}@media print{.x{color:#eee;background:#fff;}}')
    );
    expect(verdict.ok).toBe(true);
  });

  it('still grades screen-applicable media blocks (width queries, screen, not print)', () => {
    for (const query of ['(max-width: 768px)', 'screen', 'not print', 'print, screen']) {
      const verdict = analyzeReportContrast(wrap(`@media ${query}{.x{color:#e8eaf0;background:#ffffff;}}`));
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0].detail).toContain('.x');
    }
  });

  it('excises the whole print block, including nested at-rules', () => {
    const verdict = analyzeReportContrast(
      wrap('@media print{@supports (display:grid){.x{color:#eee;background:#fff;}}}.safe{color:#111;background:#fff;}')
    );
    expect(verdict.ok).toBe(true);
  });

  it('does not swallow rules that follow an unbalanced print block', () => {
    const verdict = analyzeReportContrast(wrap('@media print{.x{color:#eee;background:#fff;}'));
    expect(verdict.ok).toBe(true);
  });
});
