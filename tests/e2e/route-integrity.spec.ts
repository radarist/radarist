/**
 * @file route-integrity.spec.ts
 * @description Validates auth/public boundaries, redirects, and navigation contracts.
 *
 * Tests both authenticated and unauthenticated states to ensure:
 * - Protected routes redirect to /login when unauthenticated
 * - Public routes remain accessible
 * - Redirect chains resolve correctly
 * - Sidebar navigation reaches expected destinations
 *
 * @author Radarist Team
 * @created 2026-02-21
 */

import { test, expect } from './fixtures';
import { newAuditedContext } from '../harness/audited-context';

test.describe('Route Integrity', () => {
  test.describe('Auth boundaries (unauthenticated)', () => {
    test('protected routes redirect to /login', async ({ browser }) => {
      // Fresh context without storageState = unauthenticated
      const context = await newAuditedContext(browser);
      const page = await context.newPage();

      const protectedRoutes = [
        '/dashboard',
        '/library',
        '/library/companies',
        '/library/technologies',
        '/library/strategies',
        '/radar',
        '/agents',
        '/settings',
      ];

      // Collect every landing so a single assertion reports the full map —
      // one failing route no longer hides the routes behind it.
      const landings: string[] = [];

      for (const route of protectedRoutes) {
        await page.goto(route);
        // Auth gating is client-side (AuthProvider redirects once Firebase
        // resolves onAuthStateChanged), so the push to /login lands after
        // `domcontentloaded`. Wait for the URL instead of reading it eagerly.
        await page.waitForURL('**/login', { timeout: 10000 });
        landings.push(`${route} -> ${new URL(page.url()).pathname}`);
      }

      await context.close();

      // AuthProvider (src/components/providers/AuthProvider.tsx) treats only
      // /login, /signup and /share/* as public, so every route above must land
      // on /login for an unauthenticated context.
      expect(landings).toEqual(protectedRoutes.map((route) => `${route} -> /login`));
    });

    test('public routes do NOT redirect to login', async ({ browser }) => {
      const context = await newAuditedContext(browser);
      const page = await context.newPage();

      await page.goto('/login');
      await page.waitForLoadState('domcontentloaded');
      expect(new URL(page.url()).pathname).toBe('/login');

      await page.goto('/signup');
      await page.waitForLoadState('domcontentloaded');
      expect(new URL(page.url()).pathname).toBe('/signup');

      await context.close();
    });
  });

  test.describe('Redirects (authenticated)', () => {
    test('/ redirects to /dashboard', async ({ page }) => {
      await page.goto('/');
      await page.waitForURL('**/dashboard', { timeout: 10000 });
      expect(new URL(page.url()).pathname).toBe('/dashboard');
    });

    test('/signals redirects to /triage/signals', async ({ page }) => {
      // next.config.ts redirects /signals -> /triage/signals (Triage is the
      // canonical signals surface; the legacy /agents/signals stub now also
      // redirects here).
      await page.goto('/signals');
      await page.waitForURL('**/triage/signals', { timeout: 10000 });
      expect(new URL(page.url()).pathname).toBe('/triage/signals');
    });
  });

  test.describe('Navigation (authenticated)', () => {
    test('sidebar links resolve to correct routes', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForLoadState('domcontentloaded');

      // Verify we're authenticated
      expect(new URL(page.url()).pathname).not.toBe('/login');

      // Sidebar exposes direct (non-collapsible) links for these destinations.
      // "Library"/"Activity" are collapsible parent buttons (not links) in the
      // current UI, so target the standalone link items that resolve to a
      // deterministic route.
      const navLinks = [
        { name: /^reports$/i, expectedPath: '/reports' },
        { name: /^artifacts$/i, expectedPath: '/artifacts' },
      ];

      const landings: string[] = [];

      for (const link of navLinks) {
        const nav = page.getByRole('link', { name: link.name }).first();
        // "Artifacts" and "Reports" are unconditional standalone entries in
        // AppSidebar#getNavMain (no `items`), so NavMain renders each as a
        // plain <Link> — the link is always present, never a collapse trigger.
        await nav.waitFor({ state: 'visible', timeout: 10000 });
        await nav.click();
        // Sidebar entries are Next <Link>s — clicking does a client-side
        // (SPA) navigation that does not fire a fresh `domcontentloaded`, so
        // wait on the URL instead of the load state.
        await page.waitForURL(`**${link.expectedPath}`, { timeout: 10000 });
        landings.push(new URL(page.url()).pathname);
        await page.goto('/dashboard');
        await page.waitForLoadState('domcontentloaded');
      }

      expect(landings).toEqual(navLinks.map((link) => link.expectedPath));
    });

    test('authenticated pages show main content, not login form', async ({ page }) => {
      // '/agents' is a permanent redirect to '/agents/runs'
      // (next.config.ts#redirects), so its landing path differs from the
      // requested one; the other two serve their own page.
      const routes = [
        { request: '/dashboard', landsOn: '/dashboard' },
        { request: '/library', landsOn: '/library' },
        { request: '/agents', landsOn: '/agents/runs' },
      ];

      const landings: string[] = [];
      const mainCounts: number[] = [];

      for (const route of routes) {
        await page.goto(route.request);
        await page.waitForLoadState('domcontentloaded');
        // SidebarInset (src/components/ui/sidebar.tsx) is the ONLY <main> in
        // the app and is rendered by the authenticated SmartLayout shell; the
        // /login screen renders none. A visible <main> therefore proves the
        // authenticated shell rendered rather than the login form.
        await page.locator('main').first().waitFor({ state: 'visible', timeout: 10000 });
        landings.push(new URL(page.url()).pathname);
        mainCounts.push(await page.locator('main').count());
      }

      expect(landings).toEqual(routes.map((route) => route.landsOn));
      expect(mainCounts).toEqual(routes.map(() => 1));
    });
  });
});
