/**
 * @file build-download-html.test.ts
 * @description Locks the static download security boundary and brand fidelity.
 * Downloads use the same parser-normalized transform as preview/print so legacy
 * stored HTML cannot regain script execution or network access on disk.
 */

import { buildDownloadHtml } from '../build-download-html';

const SAMPLE_CSS = ':root { --bg: #000; }';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('buildDownloadHtml — document shell', () => {
  it('normalizes a body-only fragment into a complete static document', () => {
    const result = buildDownloadHtml('<div><h1>Hello</h1></div>', 'My Report');
    expect(result).toMatch(/^<!doctype html>/);
    expect(result).toContain('<html>');
    expect(result).toContain('<meta charset="utf-8">');
    expect(result).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(result).toContain('<title>My Report</title>');
    expect(result).toContain('<div><h1>Hello</h1></div>');
    expect(parse(result).head.firstElementChild?.getAttribute('content')).toContain("default-src 'none'");
  });

  it('normalizes a full document and replaces its title through the DOM', () => {
    const result = buildDownloadHtml(
      '<!DOCTYPE html><html><head><title>Stored title</title></head><body><p>Body</p></body></html>',
      'Download title'
    );
    const document = parse(result);
    expect(document.title).toBe('Download title');
    expect(document.body.textContent).toContain('Body');
    expect(document.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
  });

  it('strips a leading BOM before parser normalization', () => {
    const full = '﻿<!doctype html><html><body>x</body></html>';
    const out = buildDownloadHtml(full, 'My Report');
    expect(out.startsWith('﻿')).toBe(false);
    expect(parse(out).title).toBe('My Report');
  });

  it('escapes the title so it cannot break out into <head>', () => {
    const out = buildDownloadHtml('<p>body</p>', '<script>evil()</script>');
    expect(out).toContain('<title>&lt;script&gt;evil()&lt;/script&gt;</title>');
    expect(out).not.toContain('<title><script>evil()');
  });
});

describe('buildDownloadHtml — executable legacy content', () => {
  it('removes active and network capabilities from a malicious full document', () => {
    const result = buildDownloadHtml(
      `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://attacker.invalid/refresh">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <meta http-equiv="content-type" content="text/html; charset=iso-8859-1">
        <meta charset="iso-8859-1">
        <meta name="viewport" content="width=9999">
        <base href="https://attacker.invalid/">
        <link rel="stylesheet" href="https://attacker.invalid/report.css">
        <style>
          @import url("https://attacker.invalid/import.css");
          .network { background: url("https://attacker.invalid/background.png"); }
          .static { color: rgb(1, 2, 3); }
        </style>
        <script>globalThis.reportDownloadExecuted = true</script>
      </head><body onload="fetch('https://attacker.invalid/load')">
        <button onclick="alert('download')">Run</button>
        <a id="external" href="https://attacker.invalid/open" target="_top" download>Leave</a>
        <a id="data-document" href="data:text/html,<script>alert('escaped')</script>">Data document</a>
        <a id="fragment" href="#evidence">Evidence</a>
        <img id="external-image" src="https://attacker.invalid/pixel.png" onerror="alert('image')">
        <img id="embedded-image" src="data:image/png;base64,AA==">
        <form action="https://attacker.invalid/mutate"><button>Submit</button></form>
        <iframe src="https://attacker.invalid/frame"></iframe>
        <object data="https://attacker.invalid/object"></object>
        <details><summary>Static disclosure</summary><p>Preserved evidence</p></details>
        <svg id="chart"><circle cx="5" cy="5" r="5"></circle></svg>
      </body></html>`,
      'Safe download'
    );

    const document = parse(result);
    const policy = document.head.firstElementChild;
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(policy?.getAttribute('content')).toContain("default-src 'none'");
    expect(policy?.getAttribute('content')).toContain("connect-src 'none'");
    expect(policy?.getAttribute('content')).toContain("script-src 'none'");
    expect(policy?.getAttribute('content')).toContain("form-action 'none'");
    expect(document.querySelectorAll('meta[charset]')).toHaveLength(1);
    expect(document.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(
      'width=device-width, initial-scale=1'
    );
    expect(document.querySelector('script, form, iframe, object, base, link')).toBeNull();
    expect(document.querySelector('[onload], [onclick], [onerror]')).toBeNull();
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.querySelector('#external')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('#external')?.getAttribute('target')).toBeNull();
    expect(document.querySelector('#external')?.getAttribute('download')).toBeNull();
    expect(document.querySelector('#data-document')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('#external-image')?.getAttribute('src')).toBeNull();
    expect(document.querySelector('#fragment')?.getAttribute('href')).toBe('#evidence');
    expect(document.querySelector('#embedded-image')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(document.querySelector('details p')?.textContent).toBe('Preserved evidence');
    expect(document.querySelector('#chart circle')).not.toBeNull();
    expect(document.querySelector('style')?.textContent).toContain('color: rgb(1, 2, 3)');
    expect(result).not.toContain('attacker.invalid');
  });

  it('removes executable content from a fragment without losing static fidelity', () => {
    const result = buildDownloadHtml(
      `<script>globalThis.fragmentExecuted = true</script>
       <article onmouseenter="alert('x')">
         <h1>Legacy fragment</h1>
         <details><summary>Method</summary><p>Static method</p></details>
         <svg><rect width="20" height="10"></rect></svg>
         <a href="javascript:alert('x')">Unsafe link</a>
       </article>`,
      'Legacy fragment'
    );

    const document = parse(result);
    expect(result).toMatch(/^<!doctype html>/);
    expect(document.querySelector('script, [onmouseenter]')).toBeNull();
    expect(document.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('details p')?.textContent).toBe('Static method');
    expect(document.querySelector('svg rect')).not.toBeNull();
  });
});

describe('buildDownloadHtml — brand stylesheet inlining', () => {
  it('replaces the brand <link> tag with an inline <style> block', () => {
    const html = `<!DOCTYPE html><html><head><title>X</title><link rel="stylesheet" href="/css/report-brand.css"></head><body>x</body></html>`;
    const out = buildDownloadHtml(html, 'X', { brandCss: SAMPLE_CSS });
    expect(out).not.toContain('href="/css/report-brand.css"');
    expect(out).toContain('<style data-source="report-brand.css">');
    expect(out).toContain(':root { --bg: #000; }');
  });

  it('replaces the brand link regardless of attribute order or self-closing slash', () => {
    const html = `<head><link href='/css/report-brand.css' rel="stylesheet" /></head><body></body>`;
    const out = buildDownloadHtml(html, 'X', { brandCss: SAMPLE_CSS });
    expect(out).not.toContain("href='/css/report-brand.css'");
    expect(out).toContain(':root { --bg: #000; }');
  });

  it('injects the brand <style> into <head> when no brand link is present', () => {
    // A defensive path: a future report variant without the brand link
    // still gets the editorial styling on download.
    const html = `<!DOCTYPE html><html><head><title>X</title></head><body>x</body></html>`;
    const out = buildDownloadHtml(html, 'X', { brandCss: SAMPLE_CSS });
    expect(out).toContain('<style data-source="report-brand.css">');
    expect(out.indexOf('<style')).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf('<style')).toBeLessThan(out.indexOf('</head>'));
  });

  it('keeps the mission page-theme after the inlined brand CSS in cascade order', () => {
    const html =
      '<html><head><link rel="stylesheet" href="/css/report-brand.css">' +
      '<style data-design-pass="page-theme">:root{--bg:#123456}</style></head><body>x</body></html>';
    const out = buildDownloadHtml(html, 'X', { brandCss: SAMPLE_CSS });
    expect(out.indexOf('data-source="report-brand.css"')).toBeLessThan(
      out.indexOf('data-design-pass="page-theme"')
    );
  });

  it('removes the relative stylesheet when brandCss is unavailable instead of leaving file/network access', () => {
    const html = `<head><link rel="stylesheet" href="/css/report-brand.css"></head><body>x</body>`;
    const out = buildDownloadHtml(html, 'X');
    expect(parse(out).querySelector('link')).toBeNull();
    expect(out).not.toContain('/css/report-brand.css');
  });

  it('strips network capabilities from trusted brand CSS before inlining it', () => {
    const out = buildDownloadHtml('<h1>Report</h1>', 'X', {
      brandCss: '@import url("https://attacker.invalid/brand.css"); h1 { color: red; }',
    });
    const css = parse(out).querySelector('style[data-source="report-brand.css"]')?.textContent;
    expect(css).toContain('color: red');
    expect(css).not.toContain('attacker.invalid');
  });
});
