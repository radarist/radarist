/**
 * @jest-environment node
 *
 * SEC-007 — malicious-SVG browser acceptance.
 *
 * The visualization export route validates stored SVG bytes before returning
 * them and returns them under a hard same-origin download policy. This suite
 * proves both halves are load-bearing against a REAL headless Chromium:
 *
 *   1. Each malicious SVG genuinely executes when a browser renders it as a
 *      top-level document with no protection — so the guard is not vacuous.
 *   2. `assertVisualizationExportPayload` (the download boundary) rejects every
 *      one of those payloads.
 *   3. Served under the route's exact response headers
 *      (`Content-Disposition: attachment`, `Content-Security-Policy:
 *      default-src 'none'; sandbox`), the same payload never executes in the
 *      browser — defence in depth if a payload ever slipped past validation.
 *
 * Guarded: it needs a Chromium binary and is skipped unless
 * `RUN_SECURITY_BROWSER=1`, so the normal coverage gate never launches a
 * browser. Run with:
 *   npm run test:security:browser
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { assertVisualizationExportPayload } from '@/lib/visualization-export-validation';

const enabled = process.env.RUN_SECURITY_BROWSER === '1';
const describeBrowser = enabled ? describe : describe.skip;

// The exact response headers the export route sets for an SVG payload.
const ROUTE_SVG_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  'Content-Disposition': 'attachment; filename="diagram.svg"',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Type': 'image/svg+xml',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Malicious SVG payloads that set `window.__svgExecuted` when a browser runs
 * them. Each is a distinct active-content vector the export validator must
 * refuse.
 */
const MALICIOUS_SVGS: Array<{ label: string; svg: string }> = [
  {
    label: 'inline <script>',
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgExecuted = true;</script></svg>`,
  },
  {
    label: 'event handler on <svg>',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgExecuted = true"></svg>`,
  },
  {
    label: 'animate + set active element',
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<set attributeName="x" onbegin="window.__svgExecuted = true"/></svg>`,
  },
  {
    label: 'foreignObject with script',
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>` +
      `<script xmlns="http://www.w3.org/1999/xhtml">window.__svgExecuted = true;</script>` +
      `</foreignObject></svg>`,
  },
];

describeBrowser('SEC-007 malicious SVG is neutralized in a real browser', () => {
  jest.setTimeout(120_000);

  let browser: import('playwright').Browser;
  let server: Server | undefined;
  let baseUrl: string;
  // Set per request by the handler so a single server serves every payload.
  let currentBody = '';
  let currentHeaders: Record<string, string> = {};

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const createdServer = createServer((_req, res) => {
      res.writeHead(200, currentHeaders);
      res.end(currentBody);
    });
    server = createdServer;
    await new Promise<void>((resolve) => createdServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(createdServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser?.close();
    const activeServer = server;
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    }
  });

  /** Render one payload+headers top-level; report whether the script executed. */
  async function renderTopLevel(
    svg: string,
    headers: Record<string, string>
  ): Promise<{ executed: boolean; downloaded: boolean }> {
    currentBody = svg;
    currentHeaders = headers;
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    let downloaded = false;
    page.on('download', (download) => {
      downloaded = true;
      void download.cancel().catch(() => undefined);
    });
    try {
      // A download response aborts navigation; that abort IS the neutralization.
      await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 15_000 }).catch(() => undefined);
    } finally {
      // Give any inline/deferred handler a tick to run before we read the flag.
      await page.waitForTimeout(300);
    }
    const executed = (await page
      .evaluate(() => (window as unknown as { __svgExecuted?: boolean }).__svgExecuted === true)
      .catch(() => false)) as boolean;
    await context.close();
    return { executed, downloaded };
  }

  it.each(MALICIOUS_SVGS)(
    'unprotected render of $label genuinely executes (guard is load-bearing)',
    async ({ svg }) => {
      const { executed } = await renderTopLevel(svg, { 'Content-Type': 'image/svg+xml' });
      expect(executed).toBe(true);
    }
  );

  it.each(MALICIOUS_SVGS)('the export validator rejects $label at the download boundary', ({ svg }) => {
    const bytes = new TextEncoder().encode(svg);
    expect(() => assertVisualizationExportPayload(bytes, 'image/svg+xml', 'image/svg+xml', {})).toThrow();
    // Even the legacy compatibility path (no provenance requirement) refuses it.
    expect(() =>
      assertVisualizationExportPayload(bytes, 'image/svg+xml', 'image/svg+xml', { allowLegacyStaticSvg: true })
    ).toThrow();
  });

  it.each(MALICIOUS_SVGS)('under the route response policy $label never executes', async ({ svg }) => {
    const { executed } = await renderTopLevel(svg, ROUTE_SVG_HEADERS);
    expect(executed).toBe(false);
  });

  it('the route response policy turns a served SVG into a download rather than a rendered document', async () => {
    const { downloaded, executed } = await renderTopLevel(MALICIOUS_SVGS[0].svg, ROUTE_SVG_HEADERS);
    expect(downloaded).toBe(true);
    expect(executed).toBe(false);
  });
});
