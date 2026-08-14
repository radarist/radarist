/**
 * REPORT-013 — browser acceptance for in-report images and reference sources.
 *
 * Deterministic and self-contained, like the REPORT-003 design lane: no app
 * server, no emulators, no provider calls. It drives the REAL publish-path
 * transforms in Node (`resolveReportImageEmbeds`, the publication gate, the
 * reference-integrity gate) and the REAL viewer shell (`buildStaticReportHtml`,
 * transpiled into the page because it requires a browser DOMParser) with the
 * REAL `public/css/report-brand.css`, then asserts what a reader actually gets:
 *
 *  1. A report published through the DEFAULT (legacy) path carries a bounded
 *     embedded image, and that image really decodes and paints in Chromium —
 *     the state that regressed to zero in July 2026.
 *  2. Preview, print, share and download all run this one shell transform, so
 *     proving the shell output renders proves every surface; print emulation is
 *     asserted explicitly because that is where the earlier composer round
 *     failed.
 *  3. Sources are readable and copyable in full, with no off-origin anchors.
 *  4. Every citation resolves to exactly one reference target, in the browser.
 *  5. A dangling or duplicated target is refused at publication — gate ↔
 *     browser agreement, the same shape the design lane proves for contrast.
 *  6. No external request escapes the report frame (enforced for every page by
 *     the loopback audit in `network-only-fixtures`), no console errors, no
 *     page exceptions, and no horizontal overflow at 390/768/1440 in light and
 *     dark themes.
 *
 * Run through the report-design acceptance command declared by the public package.
 */

import { test, expect, type Page } from './network-only-fixtures';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';
import { resolveReportImageEmbeds } from '../../src/lib/reports/report-image-embed';
import { assertPublishableReportHtml, detectExecutableReportContent } from '../../src/lib/reports/publication-policy';
import {
  assertReportReferenceIntegrity,
  detectReferenceIntegrityViolations,
} from '../../src/lib/reports/reference-integrity';

test.skip(process.env.REPORT_DESIGN_E2E !== '1', 'REPORT-013 browser acceptance — set REPORT_DESIGN_E2E=1 to run');

const ROOT = path.resolve(__dirname, '..', '..');
const BRAND_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'report-brand.css'), 'utf8');

const SHELL_MODULE_JS = ts.transpileModule(
  fs.readFileSync(path.join(ROOT, 'src', 'lib', 'reports', 'static-report-html.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText;

const SOURCE_URL = 'https://arxiv.org/abs/2601.12345v2';
/** A real source whose query string would otherwise trip the gate's own scan. */
const REDIRECT_SOURCE_URL = 'https://news.example.com/r?url=https://target.example.com/paper';

/** A real, bounded JPEG — not a fake string, so the browser must actually decode it. */
async function boundedJpegDataUri(): Promise<{ dataUri: string; bytes: number }> {
  const jpeg = await sharp({
    create: { width: 240, height: 120, channels: 3, background: { r: 212, g: 168, b: 75 } },
  })
    .jpeg({ quality: 78 })
    .toBuffer();
  return { dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`, bytes: jpeg.byteLength };
}

/** The document an agent drafts on the default path: image by id, sources as text. */
function draftedReport(): string {
  return `<!doctype html><html><head><title>Quantum readiness</title>
  <link rel="stylesheet" href="/css/report-brand.css" /></head>
  <body>
    <div class="container">
      <h1 class="report-title">Quantum readiness</h1>
      <p>Error-corrected logical qubits remain the gate
        <a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>, and the roadmap slipped again
        <a class="cite-link" href="#ref-2"><sup class="cite">[2]</sup></a>.</p>
      <figure><img data-image-id="img-adoption" alt="Logical qubit adoption curve 2024-2027"></figure>
      <ol class="references-list">
        <li id="ref-1"><span class="ref-num">[1]</span> A. Smith, "Error correction at scale," 2026. &mdash;
          <span class="ref-source">${SOURCE_URL}</span></li>
        <li id="ref-2"><span class="ref-num">[2]</span> Vendor roadmap coverage, 2026. &mdash;
          <span class="ref-source">${REDIRECT_SOURCE_URL.replace(/=/g, '&#61;')}</span></li>
      </ol>
    </div>
  </body></html>`;
}

/** Run the REAL legacy publish transforms and both real gates. */
async function publishThroughReleasePath(draft: string): Promise<{ html: string; bytes: number }> {
  const image = await boundedJpegDataUri();
  const embedded = await resolveReportImageEmbeds(draft, {
    resolveImageUrl: async (id) =>
      id === 'img-adoption' ? 'https://firebasestorage.googleapis.com/v0/b/b/o/infographics%2Fu1%2Fa.png' : null,
    inlineImage: async () => image,
  });
  expect(embedded.embedded).toBe(1);
  expect(embedded.failures).toEqual([]);
  // The stored bytes must clear the same gates every published report clears.
  assertPublishableReportHtml(embedded.html);
  assertReportReferenceIntegrity(embedded.html);
  return { html: embedded.html, bytes: image.bytes };
}

/** Render stored HTML through the REAL viewer shell used by preview/print/share/download. */
async function renderThroughViewerShell(page: Page, storedHtml: string): Promise<void> {
  await page.addInitScript({
    content: `window.__shell = (() => { const exports = {}; const module = { exports }; ${SHELL_MODULE_JS}; return module.exports; })();`,
  });
  await page.goto('about:blank');
  const composed = await page.evaluate(
    ([html, css]) =>
      (
        window as unknown as { __shell: { buildStaticReportHtml: (h: string, o: object) => string } }
      ).__shell.buildStaticReportHtml(html, { brandCss: css }),
    [storedHtml, BRAND_CSS] as const
  );
  expect(composed).toContain('data-source="report-brand.css"');
  await page.setContent(composed, { waitUntil: 'domcontentloaded' });
}

function watchForPageFailures(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { errors };
}

test.describe('REPORT-013 — published report in a real browser', () => {
  test('the embedded infographic decodes and paints', async ({ page }) => {
    const failures = watchForPageFailures(page);
    const { html, bytes } = await publishThroughReleasePath(draftedReport());
    await renderThroughViewerShell(page, html);

    const image = page.locator('figure img');
    await expect(image).toHaveCount(1);

    // Survived the shell: the CSP allows img-src data: blob: and nothing else.
    const src = await image.getAttribute('src');
    expect(src?.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(bytes).toBeLessThanOrEqual(250_000);

    // Actually decoded — a broken image reports naturalWidth 0.
    await expect.poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', /adoption curve/i);

    expect(failures.errors).toEqual([]);
  });

  test('sources are readable in full and no off-origin anchor survives', async ({ page }) => {
    const { html } = await publishThroughReleasePath(draftedReport());
    await renderThroughViewerShell(page, html);

    // The complete url is present as text a reader can select and copy.
    const references = page.locator('.references-list');
    await expect(references).toContainText(SOURCE_URL);
    await expect(references).toContainText(REDIRECT_SOURCE_URL);

    // Nothing off-origin is navigable, in the stored bytes or in the DOM.
    expect(html).not.toMatch(/href="https?:\/\//);
    const offOriginAnchors = await page.locator('a[href^="http"], a[href^="//"]').count();
    expect(offOriginAnchors).toBe(0);
    expect(detectExecutableReportContent(html)).toEqual([]);
  });

  test('every citation resolves to exactly one reference target', async ({ page }) => {
    const { html } = await publishThroughReleasePath(draftedReport());
    await renderThroughViewerShell(page, html);

    const resolution = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="#ref-"]')].map((anchor) => {
        const id = (anchor.getAttribute('href') ?? '').slice(1);
        return { id, targets: document.querySelectorAll(`[id="${id}"]`).length };
      })
    );

    expect(resolution.length).toBeGreaterThan(0);
    for (const { id, targets } of resolution) {
      expect(targets, `citation #${id} must resolve to exactly one entry`).toBe(1);
    }
  });

  test('a dangling or duplicated reference target is refused at publication', async () => {
    const dangling = draftedReport().replace('id="ref-2"', 'id="ref-99"');
    expect(detectReferenceIntegrityViolations(dangling).map((v) => v.kind)).toContain('dangling-citation');
    expect(() => assertReportReferenceIntegrity(dangling)).toThrow(/ref-2/);

    const duplicated = draftedReport().replace('id="ref-2"', 'id="ref-1"');
    expect(detectReferenceIntegrityViolations(duplicated).map((v) => v.kind)).toContain('duplicate-reference-target');
    expect(() => assertReportReferenceIntegrity(duplicated)).toThrow(/ref-1/);
  });

  test('print output keeps the figure and the sources', async ({ page }) => {
    const { html } = await publishThroughReleasePath(draftedReport());
    await renderThroughViewerShell(page, html);
    await page.emulateMedia({ media: 'print' });

    await expect(page.locator('figure img')).toBeVisible();
    await expect(page.locator('.references-list')).toContainText(SOURCE_URL);
    // Chromium can actually produce the PDF the viewer's Print action offers.
    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.byteLength).toBeGreaterThan(1000);
    await page.emulateMedia({ media: 'screen' });
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [390, 768, 1440]) {
      test(`renders without horizontal overflow at ${width}px in ${theme} mode`, async ({ page }) => {
        const failures = watchForPageFailures(page);
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });

        const { html } = await publishThroughReleasePath(draftedReport());
        await renderThroughViewerShell(page, html);

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

        await expect(page.locator('figure img')).toBeVisible();
        expect(failures.errors).toEqual([]);
      });
    }
  }
});
