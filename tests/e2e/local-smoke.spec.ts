/**
 * @file local-smoke.spec.ts
 * @description Dead-simple "is the local platform up?" smoke.
 *
 * Assumptions:
 *  - You have `npm run dev` running in another terminal on localhost:9002.
 *  - Whatever Firebase / Neo4j config you happen to have is fine — this
 *    test does not seed, does not boot emulators, does not sign in.
 *
 * What it asserts:
 *  - `/api/health?shallow=true` returns 200 (skips Firestore/Neo4j/Inngest
 *    probing so the smoke does not depend on local services being up).
 *  - `/login` renders the email field (proves the React tree mounted).
 *  - `/` returns a sensible response (200 / 302 / 307, not 500).
 *
 * Run: npm run e2e:local
 *      (assumes `npm run dev` is up; reuses any existing server)
 */

import { test, expect } from './network-only-fixtures';

test.describe('Local platform smoke', () => {
  test('health endpoint responds with 200', async ({ request }) => {
    const res = await request.get('/api/health?shallow=true');
    expect(res.status()).toBe(200);
  });

  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    // The email input is the most stable thing on this page.
    await expect(page.locator('#email')).toBeVisible({ timeout: 15_000 });
  });

  test('root route responds without server error', async ({ page }) => {
    const res = await page.goto('/');
    expect(res, 'page.goto should return a response').not.toBeNull();
    // 200 (rendered), 302/307 (redirect to /login or /dashboard) all fine.
    // A 5xx means the server is broken.
    const status = res?.status() ?? 0;
    expect(status, `got HTTP ${status} for /`).toBeLessThan(500);
  });
});
