/**
 * @file auth.setup.ts
 * @description Playwright auth setup — creates emulator user for E2E tests.
 *
 * Firebase Auth stores tokens in IndexedDB, which Playwright's storageState()
 * cannot capture. Instead, each test page signs in programmatically via the
 * custom fixture in fixtures.ts. This setup only ensures the emulator user exists.
 *
 * @author Radarist Team
 * @created 2026-02-21
 */

import { test as setup } from '@playwright/test';

const E2E_EMAIL = process.env.E2E_USER_EMAIL || 'e2e-test@radarist.local';
const E2E_PASSWORD = process.env.E2E_USER_PASSWORD || 'e2e-test-password-123';

setup('create emulator user', async ({ request }) => {
  const useEmulator =
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true' ||
    process.env.NEXT_PUBLIC_USE_AUTH_EMULATOR === 'true' ||
    Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

  if (!useEmulator) {
    // Production mode — no emulator user creation needed.
    // Tests will sign in via the login form UI using E2E_USER_EMAIL/E2E_USER_PASSWORD.
    console.log('[auth.setup] Skipping emulator user creation — production mode');
    return;
  }

  const authEmulatorHost =
    process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

  // Create user (idempotent — ignores "already exists" errors)
  await request.post(
    `http://${authEmulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      data: {
        email: E2E_EMAIL,
        password: E2E_PASSWORD,
        returnSecureToken: true,
      },
      failOnStatusCode: false,
    }
  );
});
