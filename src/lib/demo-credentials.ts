/**
 * @file demo-credentials.ts
 * @description Single source of truth for the local-demo login identity.
 *
 * Pure constants only — no SDK imports — so the module is safe to import from
 * BOTH sides of the client/server boundary:
 * - the login page (`src/app/login/page.tsx`, a `"use client"` component)
 *   advertises these credentials in its "Local demo mode" hint;
 * - the seed scripts (`scripts/seed-auth-emulator.ts`, `scripts/seed-demo.ts`,
 *   via the `scripts/lib/local-demo.ts` re-export) create the matching
 *   auth-emulator user and demo data.
 *
 * Local emulator use only — these are intentionally public, non-secret values.
 */

/** Email of the canonical demo user the login page advertises. */
export const DEMO_USER_EMAIL = 'demo@radarist.local';

/** Password of the canonical demo user the login page advertises. */
export const DEMO_USER_PASSWORD = 'radarist-demo-password';

/**
 * Pinned auth uid of the canonical demo user. The seed data
 * (`scripts/seed-demo.ts` missions, agent runs, reports) is owned by this uid,
 * so `seed-auth-emulator.ts` pins the auth account to it — otherwise the
 * emulator assigns a random uid and the signed-in user does not own the
 * seeded content.
 */
export const DEMO_USER_UID = 'demo-user';
