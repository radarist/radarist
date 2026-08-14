/**
 * @file fixtures.ts
 * @description Custom Playwright fixtures with per-page Firebase Auth sign-in.
 *
 * Supports three modes:
 * 1. **Full emulator** (NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true):
 *    Signs in via window.__e2eSignIn() — all emulators active.
 * 2. **Auth emulator only** (NEXT_PUBLIC_USE_AUTH_EMULATOR=true):
 *    Signs in via window.__e2eSignIn() — auth emulator + production Firestore.
 * 3. **Production mode** (default):
 *    Signs in via the login form UI (email/password).
 *
 * Auth persists within a browser context via IndexedDB. After the first test
 * in a worker signs in, subsequent tests detect the existing auth and skip
 * re-authentication — avoids Firebase rate limiting.
 *
 * Usage in spec files:
 *   import { test, expect } from './fixtures';
 *
 * @author Radarist Team
 * @created 2026-02-21
 */

import { test as base, expect, type Page } from '@playwright/test';
import {
  createLoopbackNetworkAudit,
  installLoopbackNetworkAudit,
  type LoopbackNetworkAudit,
} from '../harness/audited-context';

const E2E_EMAIL = process.env.E2E_USER_EMAIL || 'e2e-test@radarist.local';
const E2E_PASSWORD = process.env.E2E_USER_PASSWORD || 'e2e-test-password-123';
const USE_EMULATOR =
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true' || process.env.NEXT_PUBLIC_USE_AUTH_EMULATOR === 'true';
const AUDIT_DEMO_NETWORK = process.env.E2E_DEMO_JOURNEY === 'true';
const BLOCK_EXTERNAL_NETWORK =
  AUDIT_DEMO_NETWORK || process.env.E2E_BLOCK_EXTERNAL_NETWORK === 'true';
const DEFAULT_E2E_APP_ORIGIN = 'http://localhost:9002';

/** Resolve the local app origin without allowing an audit target to point off-machine. */
export function resolveE2EAppOrigin(value: string | undefined): string {
  const configured = value?.trim() || DEFAULT_E2E_APP_ORIGIN;
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`E2E_APP_ORIGIN must be a valid loopback HTTP URL, received ${JSON.stringify(configured)}`);
  }

  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') ||
    !parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `E2E_APP_ORIGIN must use loopback HTTP with an explicit port, received ${JSON.stringify(configured)}`
    );
  }

  // localhost and 127.0.0.1 address the same guarded local server. Canonicalize
  // them so a setup-generated 127.0.0.1 URL still audits Playwright's localhost URL.
  return `http://127.0.0.1:${parsed.port}`;
}

const DEMO_E2E_APP_ORIGIN = BLOCK_EXTERNAL_NETWORK
  ? resolveE2EAppOrigin(process.env.E2E_APP_ORIGIN)
  : undefined;

export interface DemoNetworkAudit extends LoopbackNetworkAudit {
  pageErrors: string[];
  serverErrors: string[];
}

const demoNetworkAudits = new WeakMap<Page, DemoNetworkAudit>();

async function installDemoNetworkAudit(page: Page): Promise<void> {
  if (!DEMO_E2E_APP_ORIGIN) {
    throw new Error('E2E network audit requires an explicitly guarded browser lane.');
  }
  const audit: DemoNetworkAudit = {
    ...createLoopbackNetworkAudit(),
    pageErrors: [],
    serverErrors: [],
  };
  demoNetworkAudits.set(page, audit);
  await installLoopbackNetworkAudit(page, audit);
  page.on('pageerror', (error) => audit.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() < 500) return;
    try {
      if (resolveE2EAppOrigin(response.url()) === DEMO_E2E_APP_ORIGIN) {
        audit.serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    } catch {
      // Non-loopback responses are captured by the external-request audit.
    }
  });
}

/** Return the audit installed before authentication for the guarded demo lane. */
export function getDemoNetworkAudit(page: Page): DemoNetworkAudit {
  const audit = demoNetworkAudits.get(page);
  if (!audit) throw new Error('Demo network audit was not installed before authentication.');
  return audit;
}

/**
 * Sign in via the login form UI.
 * Used when the Firebase Auth Emulator is not active.
 */
async function signInViaLoginForm(page: import('@playwright/test').Page) {
  // Navigate to /login — if already authenticated, AuthProvider will redirect
  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  // Wait for AuthProvider to settle: either show login form or redirect away
  try {
    await page.waitForFunction(
      () => {
        // Check if we've been redirected away from /login (already authenticated)
        if (!window.location.pathname.includes('/login')) return true;
        // Check if the login form is visible (not authenticated, need to sign in)
        const emailInput = document.getElementById('email');
        return emailInput !== null;
      },
      { timeout: 15000 }
    );
  } catch {
    // Timeout — page is still loading, proceed with login attempt
  }

  // If already redirected away from /login, we're authenticated
  if (!page.url().includes('/login')) {
    return;
  }

  // Wait for the login form to be interactive
  // 20s timeout — under test load, Firebase Auth SDK can be slow to render
  const emailInput = page.locator('#email');
  await emailInput.waitFor({ state: 'visible', timeout: 20000 });

  const signInBtn = page.getByRole('button', { name: 'Sign in' });
  await signInBtn.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[type="submit"]');
      return btn && !btn.hasAttribute('disabled');
    },
    { timeout: 20000 }
  );

  // Fill email and password. The login form pre-fills demo credentials (a
  // controlled React input) and the browser may autofill a saved value — either
  // can clobber a single .fill(). Clear first, then fill, then verify the email
  // actually holds our value and re-fill if a re-render/autofill overwrote it.
  const passwordInput = page.locator('#password');
  await emailInput.fill('');
  await emailInput.fill(E2E_EMAIL);
  await passwordInput.fill('');
  await passwordInput.fill(E2E_PASSWORD);
  for (let i = 0; i < 3 && (await emailInput.inputValue()) !== E2E_EMAIL; i++) {
    await emailInput.fill(E2E_EMAIL);
    await passwordInput.fill(E2E_PASSWORD);
  }

  // Click sign in
  await signInBtn.click();

  // Wait for redirect away from /login (success).
  try {
    await page.waitForURL((url) => !new URL(url).pathname.includes('/login'), { timeout: 30000 });
  } catch {
    // Check if a login error is visible
    const errorAlert = page.locator('.backdrop-blur-xl [role="alert"]');
    if (await errorAlert.isVisible()) {
      const errorText = await errorAlert.textContent();
      throw new Error(
        `E2E login failed for ${E2E_EMAIL}: ${errorText?.trim()}. ` +
          'Check E2E_USER_EMAIL/E2E_USER_PASSWORD in .env.local'
      );
    }
    throw new Error(
      `E2E login timed out for ${E2E_EMAIL} — page stayed on /login. ` +
        'Check E2E_USER_EMAIL/E2E_USER_PASSWORD in .env.local'
    );
  }

  await page.waitForLoadState('domcontentloaded');
}

/**
 * Sign in via Firebase Auth emulator on the current page.
 * Calls window.__e2eSignIn() exposed by firebase.ts in emulator mode.
 * Works with both full emulator and auth-emulator-only modes.
 */
async function signInViaEmulator(page: import('@playwright/test').Page) {
  let authRequestTarget = 'no identity-toolkit request observed';
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname.includes('identitytoolkit') || url.pathname.includes('identitytoolkit.googleapis.com')) {
      authRequestTarget = `${url.origin}${url.pathname}`;
    }
  });

  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  // The helper proves Firebase initialized. Runtime attestation below rejects
  // a stale `next dev` bundle before any credential is submitted.
  await page.waitForFunction(() => typeof (window as any).__e2eSignIn === 'function', { timeout: 15000 });

  const runtime = await page.evaluate(() => (window as any).__e2eFirebaseRuntime as {
    projectId: string | null;
    authEmulatorOrigin: string | null;
  } | undefined);
  const expectedProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-radarist';
  const expectedAuthHost =
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ??
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??
    '127.0.0.1:9099';
  const expectedAuthOrigin = /^https?:\/\//.test(expectedAuthHost)
    ? expectedAuthHost.replace(/\/$/, '')
    : `http://${expectedAuthHost}`;

  if (runtime?.projectId !== expectedProjectId || runtime?.authEmulatorOrigin !== expectedAuthOrigin) {
    throw new Error(
      `E2E Firebase runtime mismatch: expected project ${expectedProjectId} and Auth ${expectedAuthOrigin}; ` +
        `browser reported project ${runtime?.projectId ?? 'unset'} and Auth ${runtime?.authEmulatorOrigin ?? 'production'}. ` +
        `Stop the server at ${DEMO_E2E_APP_ORIGIN ?? 'the configured E2E app URL'} ` +
        'or start it with the matching guarded E2E command.'
    );
  }

  // If already redirected (auth persisted in context), attestation still ran.
  if (!page.url().includes('/login')) {
    return;
  }

  // Sign in programmatically via emulator
  try {
    await page.evaluate(({ email, password }) => (window as any).__e2eSignIn(email, password), {
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });
  } catch (error) {
    throw new Error(
      `E2E emulator sign-in failed via ${authRequestTarget}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  // Wait for AuthProvider to process the sign-in and redirect away from /login
  await page.waitForURL((url) => new URL(url).pathname !== '/login', { timeout: 10000 });
}

/**
 * Sign in via Firebase Auth on the current page.
 * Automatically selects emulator or UI-based sign-in.
 */
export async function signInViaFirebase(page: import('@playwright/test').Page) {
  if (USE_EMULATOR) {
    await signInViaEmulator(page);
  } else {
    await signInViaLoginForm(page);
  }
}

/** Extended test fixture that auto-authenticates each page */
export const test = base.extend({
  page: async ({ page }, use) => {
    if (BLOCK_EXTERNAL_NETWORK) await installDemoNetworkAudit(page);
    await signInViaFirebase(page);
    await use(page);
    if (!AUDIT_DEMO_NETWORK && BLOCK_EXTERNAL_NETWORK) {
      const violations = getDemoNetworkAudit(page).externalRequests;
      expect(violations, 'The generic E2E lane must not attempt external browser requests').toEqual([]);
    }
  },
});

export { expect, type Page, type BrowserContext, type Locator } from '@playwright/test';
