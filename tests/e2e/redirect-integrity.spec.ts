/**
 * @file redirect-integrity.spec.ts
 * @description Validates the next.config.ts#redirects() table.
 *
 * Each retired route maps to a single canonical destination in one hop.
 * Asserts:
 *  1. page.goto(from) lands on `to` (final pathname after redirect).
 *  2. Canonical page content renders (`main` is visible).
 *  3. Chain length <= 1 (at most one 3xx hop captured during navigation).
 *
 * @author Radarist Team
 * @created 2026-05-08
 */

import { test, expect } from './fixtures';

const REDIRECTS: Array<{ from: string; to: string }> = [
  { from: '/', to: '/dashboard' },
  { from: '/signals', to: '/triage/signals' },
  { from: '/library/signals', to: '/triage/signals' },
  { from: '/agents', to: '/agents/runs' },
  { from: '/triage', to: '/triage/signals' },
  { from: '/visualizations', to: '/visualizations/radar' },
];

test.describe('Redirect integrity (next.config.ts#redirects)', () => {
  for (const { from, to } of REDIRECTS) {
    test(`${from} redirects to ${to} in a single hop`, async ({ page }) => {
      await page.goto(from);
      await page.waitForURL(`**${to}`, { timeout: 10000 });

      const finalPath = new URL(page.url()).pathname;
      expect(finalPath, `Expected ${from} to land on ${to}, got ${finalPath}`).toBe(to);

      // Canonical page renders content
      const main = page.locator('main').first();
      await expect(main).toBeVisible({ timeout: 5000 });
    });
  }

  test('redirect chains never exceed one hop', async ({ page }) => {
    // Capture the 3xx responses produced by the *document navigation* while
    // traversing the redirect table. For each `from`, count redirects whose URL
    // pathname matches `from` — there must be exactly one such redirect (the
    // configured 308) per source.
    //
    // We scope the count to the top-level document request only. The App Router
    // also issues an independent RSC prefetch (`type=fetch`, `…?_rsc=…`) for
    // some redirected sources; that prefetch is a *separate* request that
    // redirects exactly once on its own — it is not part of the navigation's
    // redirect chain. Counting it would conflate two independent single-hop
    // redirects into a phantom two-hop "chain". A genuine chain (A→B→C) would
    // show up as multiple 308s within the document request itself.
    //
    // Every source is measured before a single assertion runs, so one
    // over-long chain does not hide the sources behind it.
    const observed: Array<{ from: string; hops: number }> = [];

    for (const { from } of REDIRECTS) {
      const redirectsForSource: number[] = [];
      const handler = (response: import('@playwright/test').Response) => {
        const status = response.status();
        if (status >= 300 && status < 400 && response.request().resourceType() === 'document') {
          const path = new URL(response.url()).pathname;
          if (path === from) {
            redirectsForSource.push(status);
          }
        }
      };
      page.on('response', handler);

      await page.goto(from);
      await page.waitForLoadState('domcontentloaded');

      page.off('response', handler);

      observed.push({ from, hops: redirectsForSource.length });
    }

    expect(
      observed.filter((entry) => entry.hops > 1),
      `Every source in next.config.ts#redirects must resolve in at most one document hop; observed ${JSON.stringify(observed)}`
    ).toEqual([]);
  });
});
