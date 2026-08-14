/**
 * @file feature-flags.ts
 * @description Test helpers for managing feature flags in E2E tests.
 *
 * Enables or disables feature flags by manipulating localStorage before
 * page navigation. Must be called BEFORE page.goto() using addInitScript.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { Page } from '@playwright/test';

/**
 * Impulse agent feature flags needed for Impulse pages.
 * All impulse flags have been baked in (permanently enabled).
 */
export const IMPULSE_FLAGS = [] as const;

/**
 * Agent-related feature flags for AI assistant and agent research flows.
 * All agent flags have been baked in (permanently enabled).
 */
export const AGENT_FLAGS = [] as const;

/**
 * Enable specific feature flags via localStorage override.
 *
 * This sets a `featureFlagOverrides` key in localStorage that the app's
 * feature-flags.ts reads on boot. Must be called BEFORE page.goto().
 *
 * @param page - Playwright page
 * @param flags - Array of flag names to enable
 */
export async function enableFeatureFlags(page: Page, flags: ReadonlyArray<string>): Promise<void> {
  await page.addInitScript(
    (flagNames: string[]) => {
      const overrides: Record<string, boolean> = {};
      for (const flag of flagNames) {
        overrides[flag] = true;
      }
      localStorage.setItem('featureFlagOverrides', JSON.stringify(overrides));
    },
    [...flags]
  );
}

/**
 * Disable specific feature flags via localStorage override.
 *
 * @param page - Playwright page
 * @param flags - Array of flag names to disable
 */
export async function disableFeatureFlags(page: Page, flags: ReadonlyArray<string>): Promise<void> {
  await page.addInitScript(
    (flagNames: string[]) => {
      const overrides: Record<string, boolean> = {};
      for (const flag of flagNames) {
        overrides[flag] = false;
      }
      localStorage.setItem('featureFlagOverrides', JSON.stringify(overrides));
    },
    [...flags]
  );
}
