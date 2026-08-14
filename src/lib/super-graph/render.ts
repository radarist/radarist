import { chromium, type Browser, type BrowserContext } from 'playwright';
import { buildHostHtml, type HostInput } from './host-html';
import './types';

// Render the chart canvas close to the width it's actually displayed at in the
// report (content maxes ~1100px). Previously 1600×900: the SVG viewBox was
// 1600 wide but the report scales it down to ~820–900px (~0.5×), which halved
// every label — a 12px font rendered at ~6px on screen (unreadable). At ~1000px
// the displayed scale is ~0.9–1.0, so label fonts render at their intended size.
const DEFAULT_VIEWPORT = { width: 1000, height: 600 };
const DEFAULT_RENDER_TIMEOUT_MS = 15_000;

export class DiagramRenderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  /**
   * Boot Chromium and create the shared browser context. Single-call contract:
   * calling `start()` while already started is a no-op. Concurrent calls are
   * not supported — callers should serialize lifecycle.
   */
  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: 2,
    });
  }

  async stop(): Promise<void> {
    // Wrap each shutdown step so a failure on one doesn't mask the other,
    // and so a misbehaving context can't leak the browser process.
    try {
      await this.context?.close();
    } catch {
      // best-effort cleanup; do not surface
    }
    try {
      await this.browser?.close();
    } catch {
      // best-effort cleanup; do not surface
    }
    this.browser = null;
    this.context = null;
  }

  async renderViaLibrary(input: HostInput): Promise<string> {
    if (!this.context) throw new Error('DiagramRenderer.start() must be called first');
    const page = await this.context.newPage();

    // Surface JS errors and console.error messages from the host page so a
    // `waitForFunction` timeout becomes diagnosable instead of opaque.
    let lastPageError: Error | null = null;
    let lastConsoleError: string | null = null;
    page.on('pageerror', (e) => {
      lastPageError = e;
    });
    page.on('console', (m) => {
      if (m.type() === 'error') lastConsoleError = m.text();
    });

    try {
      const html = buildHostHtml(input);
      await page.setContent(html, { waitUntil: 'networkidle', timeout: DEFAULT_RENDER_TIMEOUT_MS });
      try {
        // istanbul ignore next: function is serialised to the Playwright
        // browser context, which has no `cov_*` instrumentation globals.
        await page.waitForFunction(() => window.__SUPER_GRAPH_READY__ === true, {
          timeout: DEFAULT_RENDER_TIMEOUT_MS,
        });
      } catch (err) {
        const original = err instanceof Error ? err : new Error(String(err));
        const parts: string[] = [original.message];
        if (lastPageError) parts.push(`[page error: ${(lastPageError as Error).message}]`);
        if (lastConsoleError) parts.push(`[console error: ${lastConsoleError}]`);
        const wrapped = new Error(`Render failed (${input.branch}/${input.kind}): ${parts.join(' ')}`, {
          cause: original,
        });
        throw wrapped;
      }
      // istanbul ignore next: function is serialised to the Playwright
      // browser context, which has no `cov_*` instrumentation globals.
      const svg = await page.evaluate(() => {
        const node = document.querySelector('#target svg') ?? document.querySelector('#target');
        if (!node) throw new Error('No SVG produced');
        if (node.tagName.toLowerCase() === 'svg') return node.outerHTML;
        const inner = node.querySelector('svg');
        if (inner) return inner.outerHTML;
        throw new Error('Render target missing <svg>');
      });
      return svg;
    } finally {
      try {
        await page.close();
      } catch {
        // best-effort cleanup; do not mask the original error
      }
    }
  }

  /**
   * Rasterize a finished SVG string to a PNG buffer. Used by the Layer B
   * vision-LLM critic to score the rendered output against an editorial
   * design rubric. Mounts the SVG in a minimal HTML wrapper sized to its
   * intrinsic viewBox (or DEFAULT_VIEWPORT if no viewBox), takes a
   * screenshot, and returns the PNG bytes.
   */
  async rasterizeSvg(svg: string, opts: { width?: number; height?: number } = {}): Promise<Buffer> {
    if (!this.context) throw new Error('DiagramRenderer.start() must be called first');

    const vb = svg.match(/viewBox="([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
    const width = opts.width ?? (vb ? Math.round(parseFloat(vb[3])) : DEFAULT_VIEWPORT.width);
    const height = opts.height ?? (vb ? Math.round(parseFloat(vb[4])) : DEFAULT_VIEWPORT.height);

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; background: white; }
#target { width: ${width}px; height: ${height}px; }
#target svg { width: 100%; height: 100%; display: block; }
</style></head>
<body><div id="target">${svg}</div></body></html>`;

    const page = await this.context.newPage();
    try {
      await page.setViewportSize({ width, height });
      await page.setContent(html, { waitUntil: 'load', timeout: DEFAULT_RENDER_TIMEOUT_MS });
      const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      return buf;
    } finally {
      try {
        await page.close();
      } catch {
        // best-effort cleanup; do not mask the original error
      }
    }
  }
}
