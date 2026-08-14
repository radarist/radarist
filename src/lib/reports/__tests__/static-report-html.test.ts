/**
 * @jest-environment jsdom
 */
/**
 * The static viewer transform must preserve
 * `url(data:…)` in CSS (the CSP already allows `font-src data:` / `img-src
 * data:`, and attribute-side handling already preserves embedded URLs) while
 * still stripping network-capable urls and @import.
 */
import { buildStaticReportHtml } from '../static-report-html';

const page = (head: string, body = '<p>content</p>') => `<html><head>${head}</head><body>${body}</body></html>`;

describe('buildStaticReportHtml css url handling', () => {
  it('preserves data: URIs in CSS (embedded @font-face survives the transform)', () => {
    const brandCss = "@font-face { font-family: 'Inter'; src: url(data:font/woff2;base64,AAAA) format('woff2'); }";
    const out = buildStaticReportHtml(page(''), { brandCss });
    expect(out).toContain('url(data:font/woff2;base64,AAAA)');
  });

  it('still strips network urls and @import from CSS', () => {
    const brandCss =
      "@import url('https://fonts.googleapis.com/css2?family=Inter'); .x { background: url(https://evil.example/x.png); }";
    const out = buildStaticReportHtml(page(''), { brandCss });
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).not.toContain('evil.example');
  });

  it('preserves data: URIs in author <style> blocks too', () => {
    const html = page('<style>.hero { background-image: url("data:image/png;base64,BBBB"); }</style>');
    const out = buildStaticReportHtml(html, {});
    expect(out).toContain('data:image/png;base64,BBBB');
  });

  it('strips network urls from inline style attributes but keeps data: ones', () => {
    const html = page(
      '',
      '<div style="background:url(https://evil.example/a.png)">a</div><div style="background:url(data:image/gif;base64,CCCC)">b</div>'
    );
    const out = buildStaticReportHtml(html, {});
    expect(out).not.toContain('evil.example');
    expect(out).toContain('data:image/gif;base64,CCCC');
  });

  it('preserves strict same-document CSS fragment references', () => {
    const out = buildStaticReportHtml(
      page('<style>.a{fill:url(#gradient);filter:url("#glow");mask:url(#mask)}</style>'),
      {}
    );
    expect(out).toContain('url(#gradient)');
    expect(out).toContain('url("#glow")');
    expect(out).toContain('url(#mask)');
  });

  it('does not allow a network URL merely because it has a fragment', () => {
    const out = buildStaticReportHtml(
      page('<style>.a{fill:url(https://evil.example/image.svg#gradient)}</style>'),
      {}
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('url("")');
  });
});
