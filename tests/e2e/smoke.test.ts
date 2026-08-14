/**
 * @file smoke.test.ts
 * @description Smoke tests for critical application flows
 *
 * These tests verify that the core pages load correctly and
 * basic navigation works. Run these before every deploy to
 * catch regressions early.
 *
 * Run: npx playwright test smoke
 * Debug: npx playwright test smoke --debug
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { test, expect } from './fixtures';
import { assertAuthenticated } from './utils/auth-guard';

// =============================================================================
// APP NAVIGATION SMOKE TESTS
// =============================================================================

test.describe('App Navigation', () => {
  test('should redirect root to dashboard', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL('/dashboard');
    await assertAuthenticated(page);
    await expect(page).toHaveURL('/dashboard');
  });

  test('should have sidebar navigation visible', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page.locator('a[href="/dashboard"]').first()).toBeVisible();
    await expect(page.locator('a[href="/settings"]').first()).toBeVisible();
  });

  test('should navigate via sidebar links', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // "Overview" is the Library parent's explicit sidebar destination.
    const libraryLink = page.locator('a[href="/library"]').first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL('/library');
  });

  test('should have breadcrumb navigation', async ({ page }) => {
    await page.goto('/library/companies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Breadcrumbs should show navigation path
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"], [data-testid="breadcrumbs"]');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText(/Library/i);
    await expect(breadcrumb).toContainText(/Companies/i);
  });
});

// =============================================================================
// DASHBOARD SMOKE TESTS
// =============================================================================

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);
  });

  test('should load dashboard page', async ({ page }) => {
    // Page should have loaded without error
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });

  test('should display KPI cards or dashboard widgets', async ({ page }) => {
    const main = page.locator('#main-content, main').first();
    await expect(main.getByText('Technologies', { exact: true })).toBeVisible();
    await expect(main.getByText('Companies', { exact: true })).toBeVisible();
    const asyncPanelTimeout = 15_000;
    await expect(main.getByText(/^Needs Attention(?:\s*\d+)?$/)).toBeVisible({
      timeout: asyncPanelTimeout,
    });
    await expect(main.getByText('AI Agent Feed', { exact: true })).toBeVisible({
      timeout: asyncPanelTimeout,
    });
    await expect(main.getByText('Recent Updates', { exact: true })).toBeVisible({
      timeout: asyncPanelTimeout,
    });
  });

  test('should not show critical error state', async ({ page }) => {
    // Check there's no error boundary or critical error message
    const errorBoundary = page.locator('[data-testid="error-boundary"]');
    const errorText = page.getByText(/something went wrong/i);
    await expect(errorBoundary).toHaveCount(0);
    await expect(errorText).toHaveCount(0);
  });
});

// =============================================================================
// LIBRARY SECTION SMOKE TESTS
// =============================================================================

test.describe('Library Section', () => {
  test('should load library landing page', async ({ page }) => {
    await page.goto('/library');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Should have main content
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });

  test('should display section cards on library landing', async ({ page }) => {
    await page.goto('/library');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // The landing page's full entity navigation contract is nine cards.
    const sectionLinks = page.locator('main a[href^="/library/"]');
    await expect(sectionLinks).toHaveCount(9);
    await expect(page.getByRole('link', { name: 'Browse Companies' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse Technologies' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse Documents' })).toBeVisible();
  });

  test('should navigate to companies page', async ({ page }) => {
    await page.goto('/library/companies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Page should load with heading
    const heading = page.locator('h1, [data-testid="page-title"]').first();
    await expect(heading).toContainText(/Companies/i);
  });

  test('should navigate to technologies page', async ({ page }) => {
    await page.goto('/library/technologies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page.getByTestId('page-title')).toHaveText('Scouted Tech');
  });

  test('should navigate to strategies page', async ({ page }) => {
    await page.goto('/library/strategies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page.getByTestId('page-title')).toHaveText('Innovation Directives');
  });

  test('should navigate to use-cases page', async ({ page }) => {
    await page.goto('/library/use-cases');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page.getByTestId('page-title')).toHaveText('Opportunity Areas');
  });

  test('should navigate to prototypes page', async ({ page }) => {
    await page.goto('/library/prototypes');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Page should load with heading
    const heading = page.locator('h1, [data-testid="page-title"]').first();
    await expect(heading).toContainText(/Experiments|Prototypes/i);
  });

  test('should display table or grid view on entity pages', async ({ page }) => {
    await page.goto('/library/companies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    const populatedTable = page.locator('main table');
    const actionableEmptyState = page.getByRole('heading', { name: 'No companies yet' });
    await expect(populatedTable.or(actionableEmptyState).first()).toBeVisible({ timeout: 10000 });
  });
});

// =============================================================================
// VISUALIZATIONS SMOKE TESTS
// =============================================================================

test.describe('Visualizations', () => {
  test('should load radar visualization page', async ({ page }) => {
    await page.goto('/visualizations/radar');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Page should load without error
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });

  test('should display radar or empty state', async ({ page }) => {
    await page.goto('/visualizations/radar');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page.getByRole('heading', { name: 'Tech Radar' })).toBeVisible({ timeout: 10000 });
    const radarCanvas = page.getByTestId('radar-canvas');
    const zeroState = page.getByText('No radars yet', { exact: true });
    await expect(radarCanvas.or(zeroState).first()).toBeVisible();
  });

  test('should render and focus a deterministic knowledge graph', async ({ page }) => {
    await page.route('**/api/graph/query', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          nodes: [
            { id: 'company-1', labels: ['Company'], properties: { name: 'Acme Labs' }, caption: 'Acme Labs' },
            {
              id: 'technology-1',
              labels: ['Technology'],
              properties: { name: 'Edge AI' },
              caption: 'Edge AI',
            },
            {
              id: 'signal-1',
              labels: ['Signal'],
              properties: { title: 'On-device adoption' },
              caption: 'On-device adoption',
            },
          ],
          relationships: [
            { id: 'uses-1', from: 'company-1', to: 'technology-1', type: 'USES', properties: {} },
            { id: 'enables-1', from: 'technology-1', to: 'signal-1', type: 'ENABLES', properties: {} },
          ],
          stats: {
            nodeCount: 3,
            relationshipCount: 2,
            labelCounts: { Company: 1, Technology: 1, Signal: 1 },
            typeCounts: { USES: 1, ENABLES: 1 },
          },
          executionTimeMs: 4,
        }),
      });
    });

    await page.goto('/visualizations/graph');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);
    await page.getByTestId('run-query-button').click();

    const graph = page.getByTestId('graph-container');
    await expect(graph).toBeVisible({ timeout: 10000 });
    await expect(graph).toHaveAttribute('aria-busy', 'false');

    await expect
      .poll(
        () =>
          graph.locator('canvas').evaluateAll((canvases) =>
            canvases.some((canvas) => {
              const context = canvas.getContext('2d');
              if (!context || canvas.width === 0 || canvas.height === 0) return false;
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
              for (let index = 3; index < pixels.length; index += 64) {
                if (pixels[index] > 0) return true;
              }
              return false;
            })
          ),
        { timeout: 10000, message: 'expected Cytoscape to paint non-transparent pixels' }
      )
      .toBe(true);

    // GRAPH-071 — the Overview cockpit is already open at this (desktop) width;
    // there is no `Show graph sidebar` button to click here any more.
    const overview = page.getByRole('region', { name: 'Graph overview' });
    const companyFocus = overview.getByRole('button', { name: 'Focus Company nodes (1)' });
    await companyFocus.click();
    await expect(companyFocus).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Interactive knowledge graph' })).toBeVisible();

    await page.getByRole('button', { name: 'Hide graph sidebar' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const countBounds = await graph.getByTestId('graph-count').boundingBox();
    const legendBounds = await graph.getByTestId('graph-legend').boundingBox();
    const mobileGraphBounds = await graph.boundingBox();
    expect(countBounds).not.toBeNull();
    expect(legendBounds).not.toBeNull();
    expect(mobileGraphBounds).not.toBeNull();
    expect(countBounds!.y + countBounds!.height).toBeLessThanOrEqual(legendBounds!.y);

    await page.getByRole('button', { name: 'Show graph sidebar' }).click();
    const mobileSidebarBounds = await page.getByTestId('graph-sidebar').boundingBox();
    const graphWithSidebarBounds = await graph.boundingBox();
    expect(mobileSidebarBounds).not.toBeNull();
    expect(graphWithSidebarBounds).not.toBeNull();
    expect(graphWithSidebarBounds!.width).toBeGreaterThanOrEqual(mobileGraphBounds!.width - 1);
    expect(mobileSidebarBounds!.x + mobileSidebarBounds!.width).toBeLessThanOrEqual(390);
  });
});

// =============================================================================
// AGENTS SECTION SMOKE TESTS
// =============================================================================

test.describe('Agents Section', () => {
  test('should load agents hub page', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page).toHaveURL('/agents/runs');
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Runs' })).toBeVisible();
  });

  test('should navigate to signal triage', async ({ page }) => {
    await page.goto('/triage/signals');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Page should load with signals-related heading
    const heading = page.locator('h1, [data-testid="page-title"]').first();
    await expect(heading).toContainText(/Signal/i);
  });

  // The former /agents/monitor and /agents/settings routes remain intentionally
  // absent. The live graph workbench is release-gated above.
});

// =============================================================================
// SETTINGS SMOKE TESTS
// =============================================================================

test.describe('Settings', () => {
  test('should load settings page', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Should have main content
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });

  test('should render the six settings tabs', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    const tablist = page.getByRole('tablist');
    await expect(tablist).toBeVisible();
    // src/app/settings/page.tsx renders exactly these six TabsTriggers in this
    // order once the platform config resolves. Asserting the whole set at once
    // (rather than one tab per loop iteration) reports every missing tab in a
    // single failure and keeps the assertion unconditional.
    await expect(tablist.getByRole('tab')).toHaveText([
      'General',
      'AI Assistant',
      'Agent Config',
      'Profiles',
      'MCP Servers',
      'Token Budget',
    ]);
  });
});

// =============================================================================
// ROUTE REDIRECTS SMOKE TESTS
// =============================================================================

test.describe('Legacy Route Redirects', () => {
  test('should redirect /signals to /triage/signals', async ({ page }) => {
    await page.goto('/signals');
    await expect(page).toHaveURL('/triage/signals');
    await assertAuthenticated(page);
  });

  test('should handle /agent-activities route', async ({ page }) => {
    await page.goto('/agent-activities');
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL('/agent-activities');
    await expect(page.getByText(/404|not found|could not be found/i).first()).toBeVisible();
  });
});

// =============================================================================
// ERROR HANDLING SMOKE TESTS
// =============================================================================

test.describe('Error Handling', () => {
  test('should handle 404 gracefully', async ({ page }) => {
    await page.goto('/non-existent-page-xyz');
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveURL('/non-existent-page-xyz');
    await expect(page.getByText(/404|not found|could not be found/i).first()).toBeVisible();
  });

  test('should not crash on invalid entity ID', async ({ page }) => {
    await page.goto('/library/companies?company=invalid-id-123');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    await expect(page).toHaveURL(/\/library\/companies\?company=invalid-id-123$/);
    await expect(page.getByTestId('page-title')).toHaveText('Scouted Companies');
    await expect(page.locator('[data-testid="error-boundary"]')).toHaveCount(0);
  });
});

// =============================================================================
// RESPONSIVE DESIGN SMOKE TESTS
// =============================================================================

test.describe('Responsive Design', () => {
  test('should be usable on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Main content should still be visible
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });

  test('should be usable on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    // Main content should still be visible
    await expect(page.locator('#main-content, main').first()).toBeVisible();
  });
});

// =============================================================================
// PERFORMANCE SMOKE TESTS
// =============================================================================

test.describe('Performance', () => {
  test('should load dashboard within 10 seconds', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    const loadTime = Date.now() - startTime;

    // Should load within 10 seconds (generous for CI)
    expect(loadTime).toBeLessThan(10000);
  });

  test('should load library page within 10 seconds', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/library/companies');
    await page.waitForLoadState('domcontentloaded');
    await assertAuthenticated(page);

    const loadTime = Date.now() - startTime;

    expect(loadTime).toBeLessThan(10000);
  });
});
