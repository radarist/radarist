/**
 * Playwright fixture for specialized lanes that own authentication/runtime
 * setup but still require the shared loopback-only browser-egress contract.
 * It never signs in and never fulfills application API routes: every allowed
 * loopback request continues unchanged.
 */
import { test as base } from '@playwright/test';
import {
  assertNoExternalBrowserRequests,
  createLoopbackNetworkAudit,
  installLoopbackNetworkAudit,
} from '../harness/audited-context';

export const test = base.extend({
  page: async ({ page }, use) => {
    const audit = createLoopbackNetworkAudit();
    await installLoopbackNetworkAudit(page, audit);
    try {
      await use(page);
    } finally {
      assertNoExternalBrowserRequests(audit, 'Network-only Playwright page');
    }
  },
});

export { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
