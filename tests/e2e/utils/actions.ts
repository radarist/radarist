import { Page, expect, Locator } from '@playwright/test';

/**
 * Encapsulates the logic for selecting an item from a Shadcn Select component.
 * @param page The Playwright Page object
 * @param labelOrLocator The label of the select trigger or its locator
 * @param optionText The text of the option to select
 */
export async function selectOption(page: Page, triggerLocator: Locator, optionText: string) {
    // Click the trigger to open the dropdown
    await triggerLocator.click();

    // Wait for the content to appear and select the option
    // We use getByRole('option') which is standard for Shadcn/Radix selects
    const option = page.getByRole('option', { name: optionText, exact: true });
    await expect(option).toBeVisible();
    await option.click();
}

/**
 * Fills a standard dialog form.
 * @param page 
 * @param fields Record of label -> value to fill
 * @param submitButtonName Name of the submit button
 */
export async function fillDialog(page: Page, fields: Record<string, string>, submitButtonName: string) {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    for (const [label, value] of Object.entries(fields)) {
        // Try to find by label first, fallback to placeholder if needed
        const input = dialog.getByLabel(label).or(dialog.getByPlaceholder(label));
        await input.fill(value);
    }

    await dialog.getByRole('button', { name: submitButtonName }).click();
}

/**
 * Robustly opens the Radar Management menu using its Test ID.
 */
export async function openRadarMenu(page: Page) {
    await page.getByTestId('radar-menu-trigger').click();
}

/**
 * Verification helper to check if a toast appeared
 */
export async function expectToast(page: Page, messagePattern: RegExp | string) {
    const toast = page.locator('[role="status"]'); // Default role for toasts
    await expect(toast).toContainText(messagePattern);
}
