/**
 * @file publication-policy.test.ts
 * @description UX-021 — the publication gate rejects every executable/off-origin
 * report construct with an actionable error, never flags trusted static content,
 * and the migration staticizer produces output that always clears the gate
 * (idempotently) while preserving inline SVG/CSS, embedded images, fragment
 * anchors, and native disclosure.
 */

import {
  detectExecutableReportContent,
  assertPublishableReportHtml,
  staticizeReportHtml,
  ReportPublicationError,
  type ReportViolationKind,
} from '../publication-policy';

const EXECUTABLE: Record<ReportViolationKind, string> = {
  script: '<div><script>fetch("//evil.example/x")</script></div>',
  'event-handler': '<button onclick="steal()">Go</button>',
  'javascript-url': '<a href="javascript:alert(1)">x</a>',
  mermaid: '<div class="mermaid">graph TD; A-->B;</div>',
  chartjs: '<div>const c = new Chart(ctx, {});</div>',
  canvas: '<canvas id="chart" width="400" height="200"></canvas>',
  'active-embed': '<iframe src="https://evil.example/frame"></iframe>',
  'external-resource': '<img src="https://cdn.example/logo.png" alt="logo">',
  'meta-refresh': '<meta http-equiv="refresh" content="0;url=https://evil.example">',
};

const STATIC_REPORT = `<!doctype html>
<html>
  <head>
    <style>h1 { color: #123; } .box { background: url("data:image/png;base64,AAAA"); }</style>
  </head>
  <body>
    <h1>Quarterly landscape</h1>
    <p>We evaluated Chart.js and Mermaid as options in prose, then chose inline SVG.</p>
    <svg width="20" height="20"><circle cx="10" cy="10" r="8"></circle></svg>
    <img src="data:image/png;base64,iVBORw0KGgoAAAANS" alt="embedded chart">
    <details><summary>Evidence</summary><p>Static detail</p></details>
    <a href="#section-2">Jump to section 2</a>
  </body>
</html>`;

describe('detectExecutableReportContent', () => {
  it.each(Object.entries(EXECUTABLE))('flags %s content', (kind, html) => {
    const violations = detectExecutableReportContent(html);
    expect(violations.map((v) => v.kind)).toContain(kind as ReportViolationKind);
  });

  it('returns no violations for trusted static report HTML', () => {
    expect(detectExecutableReportContent(STATIC_REPORT)).toEqual([]);
  });

  it('does not flag prose that merely mentions Chart.js or mermaid', () => {
    const html = '<p>This report was built without Chart.js or a mermaid runtime.</p>';
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('ignores executable constructs that are inside HTML comments', () => {
    const html = '<!-- <script>evil()</script> --><p>Clean body</p>';
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('ignores multiple closed comments without changing surrounding static HTML', () => {
    const html = '<p>Before</p><!-- <script>one()</script> --><!-- <canvas></canvas> --><p>After</p>';
    expect(detectExecutableReportContent(html)).toEqual([]);
    expect(staticizeReportHtml(html)).toBe('<p>Before</p><p>After</p>');
  });

  it('preserves unmatched comment openers and still detects later executable content', () => {
    const html = `${'<!--'.repeat(5_000)}<script>evil()</script>`;
    expect(detectExecutableReportContent(html).map((violation) => violation.kind)).toContain('script');
  });

  it('allows data:, blob:, fragment, and relative URLs (only off-origin is rejected)', () => {
    const html =
      '<img src="data:image/png;base64,AAAA"><img src="blob:xyz"><a href="#top">t</a><img src="/local/x.png">';
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  it('catches a handler placed immediately after a closing attribute quote', () => {
    const html = '<a href="#x"onmouseover="evil()">x</a>';
    expect(detectExecutableReportContent(html).map((v) => v.kind)).toContain('event-handler');
  });

  it('returns each violated kind once, with a sample and a fix', () => {
    const violations = detectExecutableReportContent('<script>a</script><canvas></canvas>');
    const kinds = violations.map((v) => v.kind);
    expect(kinds).toEqual([...new Set(kinds)]);
    for (const v of violations) {
      expect(v.sample.length).toBeGreaterThan(0);
      expect(v.fix.length).toBeGreaterThan(10);
    }
  });
});

describe('assertPublishableReportHtml', () => {
  it('throws ReportPublicationError with an actionable, multi-line message', () => {
    let caught: unknown;
    try {
      assertPublishableReportHtml('<script>x</script>');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReportPublicationError);
    const err = caught as ReportPublicationError;
    expect(err.violations.map((v) => v.kind)).toContain('script');
    expect(err.message).toMatch(/cannot be published/i);
    expect(err.message).toMatch(/inline <svg>|static/i);
  });

  it('does not throw for trusted static HTML or empty input', () => {
    expect(() => assertPublishableReportHtml(STATIC_REPORT)).not.toThrow();
    expect(() => assertPublishableReportHtml('')).not.toThrow();
  });
});

describe('staticizeReportHtml', () => {
  it('output always clears the publication gate for every executable kind', () => {
    for (const html of Object.values(EXECUTABLE)) {
      const staticized = staticizeReportHtml(html);
      expect(detectExecutableReportContent(staticized)).toEqual([]);
    }
  });

  it('output clears the gate for a document combining every violation at once', () => {
    const combined = Object.values(EXECUTABLE).join('\n');
    expect(detectExecutableReportContent(combined).length).toBeGreaterThan(3);
    expect(detectExecutableReportContent(staticizeReportHtml(combined))).toEqual([]);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const combined = Object.values(EXECUTABLE).join('\n');
    const once = staticizeReportHtml(combined);
    expect(staticizeReportHtml(once)).toBe(once);
  });

  it('leaves trusted static HTML untouched', () => {
    expect(staticizeReportHtml(STATIC_REPORT)).toBe(STATIC_REPORT);
  });

  it('preserves inline SVG, embedded images, fragment anchors, and disclosure while removing scripts', () => {
    const html =
      '<svg><rect/></svg><img src="data:image/png;base64,AA"><details><summary>s</summary>d</details><a href="#x">x</a><script>evil()</script>';
    const out = staticizeReportHtml(html);
    expect(out).toContain('<svg>');
    expect(out).toContain('data:image/png;base64,AA');
    expect(out).toContain('<details>');
    expect(out).toContain('href="#x"');
    expect(out).not.toMatch(/<script/i);
  });

  it('drops off-origin resources but keeps the surrounding element', () => {
    const out = staticizeReportHtml('<img src="https://cdn.example/x.png" alt="chart">');
    expect(out).not.toContain('https://cdn.example');
    expect(out).toContain('alt="chart"');
  });
});
