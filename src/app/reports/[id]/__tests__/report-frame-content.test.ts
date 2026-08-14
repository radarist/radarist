import {
  buildReportPreviewHtml,
  buildReportPrintHtml,
} from '../report-frame-content';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('buildReportPreviewHtml', () => {
  it('keeps static report content inside a deny-by-default document', () => {
    const output = buildReportPreviewHtml(
      `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://attacker.invalid">
        <meta http-equiv="Content-Security-Policy" content="default-src *">
        <base href="https://attacker.invalid/">
        <link rel="stylesheet" href="https://attacker.invalid/report.css">
        <style id="network-css">
          @im/**/port url("https://attacker.invalid/import.css");
          .external { background-image: u\\72l("https://attacker.invalid/background.png"); }
          .responsive { background-image: image-set("https://attacker.invalid/1x.png" 1x); }
          .static { color: rgb(1, 2, 3); }
        </style>
        <script src="https://attacker.invalid/report.js"></script>
        <script id="inline-script">document.body.dataset.scriptRan = 'true'</script>
      </head><body>
        <button id="interactive" onclick="this.dataset.clicked='true'">Filter</button>
        <div id="inline-css" style="background: url(https://attacker.invalid/inline.png); color: red">Styled</div>
        <details id="native-disclosure"><summary>Evidence</summary><p>Static detail</p></details>
        <svg id="inline-chart"><circle cx="5" cy="5" r="5"></circle></svg>
        <a id="external-link" href="https://attacker.invalid/open" target="_top" download ping="/ping">External</a>
        <a id="section-link" href="#section">Section</a>
        <img id="external-image" src="https://attacker.invalid/pixel.png" onerror="this.dataset.failed='true'">
        <img id="embedded-image" src="data:image/png;base64,AA==">
        <form action="/api/mutate"><button>Submit</button></form>
        <iframe src="https://attacker.invalid/frame"></iframe>
        <object data="https://attacker.invalid/object"></object>
      </body></html>`,
      {
        brandCss: `
          @import url("https://attacker.invalid/brand-import.css");
          :root { --brand: red; background: url("https://attacker.invalid/brand.png"); }
        `,
      }
    );

    const document = parse(output);
    const policy = document.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(document.head.firstElementChild).toBe(policy);
    expect(policy?.getAttribute('content')).toContain("default-src 'none'");
    expect(policy?.getAttribute('content')).toContain("connect-src 'none'");
    expect(policy?.getAttribute('content')).toContain("script-src 'none'");
    expect(policy?.getAttribute('content')).toContain("form-action 'none'");

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('#interactive')?.getAttribute('onclick')).toBeNull();
    expect(document.querySelector('#native-disclosure p')?.textContent).toBe('Static detail');
    expect(document.querySelector('#inline-chart circle')).not.toBeNull();
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.querySelector('base, form, iframe, link, object')).toBeNull();
    expect(document.querySelector('#external-image')?.getAttribute('src')).toBeNull();
    expect(document.querySelector('#embedded-image')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(document.querySelector('#external-link')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('#external-link')?.getAttribute('target')).toBeNull();
    expect(document.querySelector('#external-link')?.getAttribute('download')).toBeNull();
    expect(document.querySelector('#external-link')?.getAttribute('ping')).toBeNull();
    expect(document.querySelector('#section-link')?.getAttribute('href')).toBe('#section');
    const brandCss = document.querySelector('style[data-source="report-brand.css"]')?.textContent;
    expect(brandCss).toContain('--brand');
    expect(brandCss).not.toContain('attacker.invalid');
    expect(document.querySelector('#network-css')?.textContent).not.toContain('attacker.invalid');
    expect(document.querySelector('#network-css')?.textContent).not.toMatch(/@import|image-set|url\s*\([^"']+/i);
    expect(document.querySelector('#network-css')?.textContent).toContain('color: rgb(1, 2, 3)');
    expect(document.querySelector('#inline-css')?.getAttribute('style')).not.toContain('attacker.invalid');
    expect(document.querySelector('#inline-css')?.getAttribute('style')).toContain('color: red');
  });
});

describe('buildReportPrintHtml', () => {
  it('keeps styled report content but strips every executable or navigational surface', () => {
    const output = buildReportPrintHtml(
      `<!doctype html><html><head><script>parent.document.body.dataset.pwned='true'</script></head><body>
        <h1 onclick="alert('x')">Printable report</h1>
        <svg onload="alert('svg')"><circle cx="5" cy="5" r="5"></circle></svg>
        <img src="data:image/png;base64,AA==" onerror="alert('image')">
        <a href="https://attacker.invalid" target="_top">Leave</a>
        <embed src="https://attacker.invalid/file">
      </body></html>`,
      '<script>Unsafe title</script>',
      { brandCss: 'body { color: black; }' }
    );

    const document = parse(output);
    const policy = document.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute('content')).toContain("script-src 'none'");
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[onclick], [onload], [onerror]')).toBeNull();
    expect(document.querySelector('embed')).toBeNull();
    expect(document.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('a')?.getAttribute('target')).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('Printable report');
    expect(document.querySelector('svg circle')).not.toBeNull();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(document.querySelector('style[data-source="report-brand.css"]')?.textContent).toContain('color: black');
    expect(document.title).toBe('<script>Unsafe title</script>');
    expect(output).not.toContain('<title><script>');
  });
});
