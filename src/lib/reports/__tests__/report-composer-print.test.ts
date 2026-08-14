/**
 * @file report-composer-print.test.ts
 * @description REPORT-012 A/B round-1 regression — the composed page printed
 * its dark theme's near-white headings on a white page because the print rule
 * reset only the base color while headings/accents kept reading the theme
 * suffix's variables. These tests make the print theme provable:
 *  1. WCAG: every print text/surface pairing clears its floor.
 *  2. Drift guard: every variable the theme suffix emits is remapped in print.
 *  3. Structure: the remap is element-scoped (.composed) inside @media print,
 *     which is what beats the suffix's later :root by inheritance.
 */
import { contrastRatio } from '@/lib/mission-quality/analyzers/report-design-contrast';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { reportThemeStyleForBrief } from '@/lib/report-theme';
import { COMPOSER_PRINT_THEME, composeReport } from '../report-composer';
import type { ReportBlocksDoc } from '@/lib/schemas/report-blocks';

const BODY_FLOOR = 4.5;
const LARGE_FLOOR = 3.0;

const SURFACES = ['--bg-primary', '--bg-secondary', '--bg-card', '--bg-card-alt'] as const;
/** Text roles rendered at body size somewhere in the template. */
const BODY_TEXT_ROLES = ['--text-primary', '--text-secondary', '--text-muted', '--text', '--muted'] as const;
/** Accent roles used for titles, labels, badges, and toned table cells. */
const ACCENT_ROLES = [
  '--accent-gold',
  '--accent-strong',
  '--green-strong',
  '--red-strong',
  '--blue-strong',
  '--accent-blue',
  '--accent-green',
  '--accent-red',
  '--accent-purple',
  '--accent',
  '--gold',
  '--green',
  '--red',
  '--purple',
  '--cyan',
  '--magenta',
  '--lime',
  '--amber',
] as const;

describe('COMPOSER_PRINT_THEME contrast (provable print palette)', () => {
  it.each(SURFACES.flatMap((surface) => BODY_TEXT_ROLES.map((role) => [role, surface] as const)))(
    'body text %s clears 4.5:1 on %s',
    (role, surface) => {
      const ratio = contrastRatio(COMPOSER_PRINT_THEME[role], COMPOSER_PRINT_THEME[surface]);
      expect(ratio).toBeGreaterThanOrEqual(BODY_FLOOR);
    }
  );

  it.each(SURFACES.flatMap((surface) => ACCENT_ROLES.map((role) => [role, surface] as const)))(
    'accent %s clears 3.0:1 on %s',
    (role, surface) => {
      const ratio = contrastRatio(COMPOSER_PRINT_THEME[role], COMPOSER_PRINT_THEME[surface]);
      expect(ratio).toBeGreaterThanOrEqual(LARGE_FLOOR);
    }
  );
});

describe('print remap covers every theme-suffix variable (drift guard)', () => {
  it('remaps each --var the suffix emits for a resolved brief', () => {
    const suffix = reportThemeStyleForBrief(resolveDesignBrief('print-test-user'));
    const emitted = [...new Set([...suffix.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]))];
    expect(emitted.length).toBeGreaterThan(10);
    for (const varName of emitted) {
      expect(COMPOSER_PRINT_THEME[varName]).toBeDefined();
    }
  });
});

describe('mobile overflow regression (A/B round 1): tables scroll internally', () => {
  it('wraps table and compare-table in an overflow-x scroll container', async () => {
    const doc: ReportBlocksDoc = {
      title: 'Table scroll regression fixture',
      blocks: [
        { type: 'section', label: 'T', title: 'Tables' },
        {
          type: 'table',
          header: ['A', 'B'],
          rows: [['left cell content', 'right cell content']],
        },
        {
          type: 'compare-table',
          header: ['Criterion', 'One', 'Two'],
          rows: [
            {
              label: 'Row',
              cells: [
                { text: 'x', tone: 'neutral' },
                { text: 'y', tone: 'neutral' },
              ],
            },
          ],
        },
      ],
    };
    const result = await composeReport({
      doc,
      brief: resolveDesignBrief('print-test-user'),
      missionId: 'mission-print-test',
      charts: async () => null,
      images: async () => null,
      generatedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(result.html).toContain('<div class="table-scroll"><table class="report-table">');
    expect(result.html).toContain('<div class="table-scroll"><table class="compare-table">');
    expect(result.html).toContain('.composed .table-scroll { overflow-x: auto;');
  });
});

describe('composed html carries the element-scoped print remap', () => {
  const doc: ReportBlocksDoc = {
    title: 'Print theme regression fixture',
    blocks: [
      { type: 'section', label: 'P', title: 'Print section' },
      { type: 'prose', body: 'Body text for the print regression fixture.' },
      { type: 'prose', body: 'Second body block to satisfy the minimum.' },
    ],
  };

  it('emits the remap inside @media print scoped to .composed', async () => {
    const result = await composeReport({
      doc,
      brief: resolveDesignBrief('print-test-user'),
      missionId: 'mission-print-test',
      charts: async () => null,
      images: async () => null,
      generatedAt: '2026-07-20T00:00:00.000Z',
    });
    const printBlock = result.html.match(/@media print \{([\s\S]*?)\n\}/);
    expect(printBlock).not.toBeNull();
    const block = printBlock?.[1] ?? '';
    expect(block).toContain('.composed {');
    for (const [varName, value] of Object.entries(COMPOSER_PRINT_THEME)) {
      expect(block).toContain(`${varName}: ${value};`);
    }
  });
});
