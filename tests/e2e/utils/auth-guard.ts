/**
 * @file auth-guard.ts
 * @description Auth guard utilities for E2E tests.
 *
 * Every protected-route test should call assertAuthenticated() after navigation
 * to ensure it's not silently running on the login page.
 *
 * @author Radarist Team
 * @created 2026-02-21
 */

import { expect, Page } from '@playwright/test';

/**
 * Assert that the current page is NOT the login page.
 * Uses pathname check to catch /login, /login?redirect=..., /login#hash, etc.
 */
export async function assertAuthenticated(page: Page) {
  const url = new URL(page.url());
  expect(
    url.pathname,
    `Expected authenticated page but got ${url.pathname}. Auth may have failed.`
  ).not.toBe('/login');
}

/**
 * Navigate to a protected route and assert authentication.
 * Waits for domcontentloaded after navigation.
 */
export async function navigateAuthenticated(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await assertAuthenticated(page);
}
