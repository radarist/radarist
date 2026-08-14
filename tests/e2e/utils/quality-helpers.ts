/**
 * @file tests/e2e/utils/quality-helpers.ts
 * @description Shared assertions + testid conventions for quality-arc E2E specs.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export type QualityVerdict = 'PASS' | 'REVISE' | 'FAIL';
export type QualityLevel = 'L1' | 'L2';

export function qualityBadgeTestId(missionId: string, level: QualityLevel): string {
  return `quality-badge-${level}-${missionId}`;
}

export function chainGroupTestId(chainId: string): string {
  return `chain-group-${chainId}`;
}

export function verdictExpectedClass(verdict: QualityVerdict): string {
  // Anchored Tailwind tokens so the regex match can't accidentally include
  // `non-destructive`, `emerald-foreground`, etc. These match the exact
  // background class the Badge uses in AgentLog.tsx's getQualityBadgeClass.
  if (verdict === 'PASS') return 'bg-emerald-500/';
  if (verdict === 'REVISE') return 'bg-amber-500/';
  return 'bg-destructive/';
}

export async function waitForHydration(page: Page): Promise<void> {
  // Canonical main-app-shell selector. Only rendered on authenticated, hydrated pages —
  // works across all protected routes. Defined in tests/e2e/utils/selectors.ts as
  // SELECTORS.sidebar; duplicated here as a literal to keep quality-helpers.ts free of
  // internal test-util imports that could churn.
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10_000 });
}

export async function dismissOverlays(page: Page): Promise<void> {
  const closeSelectors = [
    '[data-testid="onboarding-dismiss"]',
    'button:has-text("Got it")',
    'button[aria-label="Close"]',
  ];
  for (const sel of closeSelectors) {
    const loc = page.locator(sel);
    try {
      if (await loc.first().isVisible()) {
        await loc.first().click({ timeout: 2_000 });
      }
    } catch {
      // Optional overlays may detach between visibility and click. Their
      // absence is acceptable; a browser-test assertion never depends on it.
    }
  }
}

export async function expectQualityBadge(
  page: Page,
  missionId: string,
  level: QualityLevel,
  verdict: QualityVerdict
): Promise<void> {
  const badge = page.locator(`[data-testid="${qualityBadgeTestId(missionId, level)}"]`);
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(`${level}: ${verdict}`);
  await expect(badge).toHaveClass(new RegExp(verdictExpectedClass(verdict)));
}

/**
 * Assert that NO chain-group wrapper is rendered.
 *
 * `AgentLog`'s `ChainGroup` needs two-plus entries sharing a chainId, and its
 * only call site (the run-detail Event Log fallback) always passes exactly one
 * entry — while `AgentRunRow` carries no chain fields at all, so the list
 * cannot group either. Chain-member grouping therefore has no live surface;
 * this pins that as a checked fact rather than a comment. `chainGroupTestId`
 * still names the id the wrapper WOULD use, so a restored grouping surface is
 * asserted against the same convention.
 */
export async function expectNoChainGroup(page: Page): Promise<void> {
  const anyChainGroupPrefix = chainGroupTestId('').replace(/"/g, '');
  await expect(page.locator(`[data-testid^="${anyChainGroupPrefix}"]`)).toHaveCount(0);
}

// ============================================================================
// RunsTable (Task 21) helpers — the UI-design-sprint replaced the old
// card-feed (AgentLog rendered directly on /agents/runs) with a sortable
// table (RunsTable) as the PRIMARY surface; per-run detail (including the
// legacy AgentLog quality/chain rendering) moved to /agents/runs/[id]. The
// helpers above still work verbatim on the run detail page's fallback
// render path (see the `expectQualityBadge` call sites in the quality specs)
// because that path still mounts the original AgentLog component with its
// original testids. RunsTable's own row/pill markup has
// no equivalent stable testid on the pill itself, so it's asserted by
// visible text + Tailwind verdict class instead.
// ============================================================================

export function runRowTestId(missionId: string): string {
  return `run-row-${missionId}`;
}

/**
 * Asserts the RunsTable list row for `missionId` shows the given L1 verdict
 * in its Quality column — the table-row equivalent of the old
 * `quality-badge-L1-*` testid assertion. `RunsTable`'s `L1Pill`
 * (`src/components/activity/RunsTable.tsx`) carries no stable testid of its
 * own, so this is anchored on the pill's exact visible text ("L1 PASS" /
 * "L1 REVISE" / "L1 FAIL") plus the same verdict-tint class convention
 * `verdictExpectedClass` already encodes.
 */
export async function expectRunRowL1Pill(page: Page, missionId: string, verdict: QualityVerdict): Promise<void> {
  const row = page.locator(`[data-testid="${runRowTestId(missionId)}"]`);
  await expect(row).toBeVisible();
  const pill = row.getByText(`L1 ${verdict}`, { exact: true });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(new RegExp(verdictExpectedClass(verdict)));
}
