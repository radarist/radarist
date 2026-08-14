import {
  assertReportPublicationConformance,
  inspectReportPublicationConformance,
  ReportPublicationConformanceError,
} from '../publication-conformance';

const body = (extra = '') =>
  `<!doctype html><html><head><title>Decision</title><link rel="stylesheet" href="/css/report-brand.css"></head>
  <body><h1>Decision report</h1><p>${'Evidence supports the recommendation. '.repeat(20)}</p>${extra}</body></html>`;

describe('report publication conformance', () => {
  it('accepts authored, self-contained report source', () => {
    expect(inspectReportPublicationConformance(body('<svg viewBox="0 0 10 10"><circle r="2"/></svg>'))).toEqual([]);
  });

  it.each([
    ['self-containment', '<link rel="stylesheet" href="/other.css">'],
    ['image-materialization', '<img src="/missing.png" alt="missing">'],
    ['figure-placeholders', '[[figure placeholder: evidence map]]'],
    [
      'figure-placeholders',
      '<p class="figure-unavailable">[Figure unavailable — generated visual could not be embedded]</p>',
    ],
    ['process-debris', '<p>Design review: PASS</p>'],
    ['duplicate-theme-variables', '<style>:root{--report-ink:#111}:root{--report-ink:#eee}</style>'],
  ])('rejects %s failures before persistence', (check, extra) => {
    expect(inspectReportPublicationConformance(body(extra)).map((violation) => violation.check)).toContain(check);
  });

  it('returns an actionable typed error', () => {
    expect(() => assertReportPublicationConformance(body('<img data-image-id="pending">'))).toThrow(
      ReportPublicationConformanceError
    );
  });

  /**
   * COORD-021 — a print `:root` restates the screen variables with paper values.
   * That is a media override, not two authors fighting over one cascade, which is
   * what this check exists to catch. Without this the page-theme suffix's own
   * print block would fail publication for conflicting with itself.
   */
  it('accepts a print-scoped :root that restates the screen variables', () => {
    expect(
      inspectReportPublicationConformance(
        body('<style>:root{--report-ink:#eee}@media print{:root{--report-ink:#111}}</style>')
      )
    ).toEqual([]);
  });

  it('still rejects two conflicting screen :root blocks inside media queries', () => {
    expect(
      inspectReportPublicationConformance(
        body('<style>:root{--report-ink:#111}@media (max-width:768px){:root{--report-ink:#eee}}</style>')
      ).map((violation) => violation.check)
    ).toContain('duplicate-theme-variables');
  });

  it('ignores conflicting trusted product theme layers only after raw author checks', () => {
    const exactExport = body(
      '<style data-source="report-brand.css">:root{--report-ink:#111}</style>' +
        '<style data-design-pass="page-theme">:root{--report-ink:#eee}</style>'
    );
    expect(inspectReportPublicationConformance(exactExport).map((violation) => violation.check)).toContain(
      'duplicate-theme-variables'
    );
    expect(inspectReportPublicationConformance(exactExport, { trustProductStyles: true })).toEqual([]);
  });
});
