/**
 * @file accessibility-sweep.spec.ts
 * @description App-owned accessibility sweep (UX-040 / ACCESS-001 / UX-044).
 *
 * Walks the app-owned surfaces that the final browser sweep flagged —
 * Signals triage, Assessments, Relations triage, Settings, an entity sheet,
 * external document linking, and radar deletion — and FAILS on any Radix
 * accessibility console warning (missing dialog description/title wiring).
 *
 * Third-party UI (e.g. the Inngest dev tools) is outside the app-owned
 * contract and is not visited here.
 */

import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { test, expect, type Page } from './fixtures';

const ACCESSIBILITY_RADAR_ID = `radar-accessibility-alert-${randomUUID()}`;
const ACCESSIBILITY_RADAR_NAME = 'Accessibility Alert Fixture';

function assertDisposableAccessibilityRuntime(): void {
  const requirements = {
    ACCESSIBILITY_E2E_DISPOSABLE: 'true',
    RADARIST_GRAPH_RUNTIME_MODE: 'disabled',
    NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  } as const;

  for (const [name, expected] of Object.entries(requirements)) {
    if (process.env[name] !== expected) {
      throw new Error(`Accessibility acceptance requires ${name}=${expected}. Run npm run e2e:accessibility.`);
    }
  }
  if (process.env.NEO4J_URI?.trim()) {
    throw new Error('Accessibility acceptance requires an empty NEO4J_URI in addition to disabled graph mode.');
  }
}

async function withAccessibilityFirestore<T>(run: (db: Firestore) => Promise<T>): Promise<T> {
  assertDisposableAccessibilityRuntime();
  const app = initializeApp({ projectId: 'demo-radarist' }, `accessibility-${randomUUID()}`);
  try {
    return await run(getFirestore(app));
  } finally {
    await deleteApp(app);
  }
}

async function seedAccessibilityRadar(): Promise<void> {
  await withAccessibilityFirestore(async (db) => {
    await db.collection('radars').doc(ACCESSIBILITY_RADAR_ID).set({
      id: ACCESSIBILITY_RADAR_ID,
      name: ACCESSIBILITY_RADAR_NAME,
      quadrants: [
        { id: 'q_accessibility_1', name: 'Observe', order: 0 },
        { id: 'q_accessibility_2', name: 'Evaluate', order: 1 },
        { id: 'q_accessibility_3', name: 'Trial', order: 2 },
        { id: 'q_accessibility_4', name: 'Adopt', order: 3 },
      ],
      entries: [],
      ringSystem: 'Standard',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function accessibilityRadarExists(): Promise<boolean> {
  return withAccessibilityFirestore(async (db) =>
    (await db.collection('radars').doc(ACCESSIBILITY_RADAR_ID).get()).exists
  );
}

async function removeAccessibilityRadar(): Promise<void> {
  await withAccessibilityFirestore(async (db) => {
    await db.collection('radars').doc(ACCESSIBILITY_RADAR_ID).delete();
  });
}

/**
 * Radix emits these warnings via console.warn/console.error when a dialog
 * or alert-dialog is missing its accessible title/description wiring.
 */
const RADIX_A11Y_WARNING =
  /Missing `Description`|aria-describedby=\{undefined\}|requires a `DialogTitle`|requires a `Title`|for \{?(Dialog|AlertDialog|Sheet)Content\}?/i;

/** App-owned browser/runtime failures that must fail the sweep. */
function collectRadixWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'warning' && msg.type() !== 'error') return;
    const text = msg.text();
    if (RADIX_A11Y_WARNING.test(text)) warnings.push(`[${msg.type()}] ${text}`);
  });
  page.on('pageerror', (error) => warnings.push(`[pageerror] ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500 && new URL(response.url()).origin === 'http://localhost:9002') {
      warnings.push(`[http ${response.status()}] ${response.request().method()} ${response.url()}`);
    }
  });
  return warnings;
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('main').first()).toBeVisible();
  // Radix warnings are emitted during hydrated mount. Two animation frames
  // synchronize with that mount without a fixed sleep that can pass too early.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

test.describe('accessibility sweep — app-owned surfaces', () => {
  test.beforeAll(async () => {
    assertDisposableAccessibilityRuntime();
    await seedAccessibilityRadar();
  });

  test.afterAll(async () => {
    await removeAccessibilityRadar();
  });

  test('signals triage renders without Radix a11y warnings', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/triage/signals');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('assessments triage renders without Radix a11y warnings', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/triage/assessment');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('relations triage renders without Radix a11y warnings and keeps contextual row actions', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    // The page persists its view mode. Start from a known triage state, wait
    // for the real loaded header (the loading skeleton has no heading), then
    // exercise the explicit list-view transition used to reach row actions.
    await page.addInitScript(() => localStorage.removeItem('radarist-linker-view-mode'));
    await page.goto('/triage/relations');
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Linker' })).toBeVisible();
    await page.getByRole('button', { name: 'Switch to list view' }).click();
    await expect(page.getByRole('button', { name: 'Switch to triage view' })).toBeVisible();

    // The demo seed owns pending proposal rows. Require every contextual row
    // action shape so the check cannot pass on an empty table or generic icon.
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: /^Approve relation: .+ to .+$/ }).count()).toBe(rowCount);
    expect(await page.getByRole('button', { name: /^Reject relation: .+ to .+$/ }).count()).toBe(rowCount);
    expect(await page.getByRole('button', { name: /^More actions for relation: .+ to .+$/ }).count()).toBe(rowCount);
    expect(warnings).toEqual([]);
  });

  test('settings renders without Radix a11y warnings', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/settings');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('entity sheet opens with described dialog and named tab controls', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/library/technologies');
    await settle(page);

    // Open the first technology's sheet.
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.first()).toBeVisible();
    // The sheet must carry real description wiring.
    const describedBy = await sheet.first().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // ContextualGraph is reachable from the real entity sheet. Its icon-only
    // viewport actions must remain named even while the graph backend is
    // intentionally disabled and the map degrades to Firestore relations.
    await sheet.first().getByRole('button', { name: 'Graph' }).click();
    const relationshipMap = page.getByRole('dialog', { name: /^Relationship Map:/ });
    await expect(relationshipMap).toBeVisible();
    // Query the page-level accessibility tree. In a nested Radix dialog stack,
    // portal ownership and aria-hidden boundaries need not mirror DOM ancestry.
    await expect(page.getByRole('button', { name: 'Zoom out relationship map' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in relationship map' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fit relationship map to view' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(relationshipMap).not.toBeVisible();

    await page.keyboard.press('Escape');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('documents expose named orphan, preview, download, delete, and metadata-copy actions', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    const title = 'Claude 4.5 SWE-bench Results: Verified Analysis';
    await page.goto('/library/documents');
    await settle(page);

    const orphanFilter = page.getByRole('button', { name: 'Show unlinked documents only' });
    await expect(orphanFilter).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Grid view' }).click();
    const card = page.getByRole('button', { name: `View ${title} details` });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: `Preview ${title}` })).toBeVisible();
    await expect(card.getByRole('button', { name: `Download original: ${title}` })).toBeVisible();
    await expect(card.getByRole('button', { name: `Delete ${title}` })).toBeVisible();

    await card.getByText(title).click();
    const sheet = page.getByRole('dialog', { name: title });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Copy Original URL' })).toBeVisible();

    await page.keyboard.press('Escape');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('external document linking dialog is described', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/library/documents');
    await settle(page);

    // The documents library exposes an app-owned add/link entry point.
    const addButton = page.getByRole('button', { name: /add document|upload|add link|link document/i }).first();
    await expect(addButton).toBeVisible();
    await addButton.click();

    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    const describedBy = await dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    await page.keyboard.press('Escape');
    await settle(page);
    expect(warnings).toEqual([]);
  });

  test('radar deletion confirms through a described AlertDialog; cancel keeps the radar', async ({ page }) => {
    const warnings = collectRadixWarnings(page);
    await page.goto('/radar');
    await settle(page);

    // Toolbar triggers must be named (UX-040).
    await expect(page.getByRole('button', { name: 'Manage radars' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share radar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Radar settings' })).toBeVisible();

    // Select the exact-owned second radar so the delete path is guaranteed to
    // be enabled; no fixture-dependent branch or early return is allowed.
    const radarSelector = page.getByRole('combobox', { name: 'Select radar' });
    await radarSelector.click();
    await page.getByRole('option', { name: ACCESSIBILITY_RADAR_NAME }).click();
    await expect(radarSelector).toContainText(ACCESSIBILITY_RADAR_NAME);

    // Open the manage menu and start deletion.
    await page.getByRole('button', { name: 'Manage radars' }).click();
    const deleteItem = page.getByRole('menuitem', { name: /delete radar/i });
    await expect(deleteItem).toBeVisible();
    await expect(deleteItem).toBeEnabled();
    await deleteItem.click();

    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    const describedBy = await alert.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // Cancel must not delete.
    await alert.getByRole('button', { name: /cancel/i }).click();
    await expect(alert).not.toBeVisible();
    expect(await accessibilityRadarExists()).toBe(true);
    await expect(radarSelector).toContainText(ACCESSIBILITY_RADAR_NAME);

    await settle(page);
    expect(warnings).toEqual([]);
  });
});
