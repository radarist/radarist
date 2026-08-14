/**
 * Shared Firebase Web SDK config for one-shot scripts (`npx tsx scripts/foo.ts`).
 *
 * Reads `NEXT_PUBLIC_FIREBASE_*` env vars from `.env.local` (auto-loaded via
 * dotenv) and throws a clear error when a required variable is missing.
 *
 * NEVER hardcode project IDs, API keys, or app IDs in script files. Add new
 * scripts that need Firebase to import `getScriptFirebaseConfig()` from here.
 */

import * as dotenv from 'dotenv';

// Load .env.local once for all script consumers. Idempotent — dotenv merges
// rather than overwrites already-set env vars.
dotenv.config({ path: '.env.local' });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[scripts] Missing required env var ${name}. ` +
        `Copy .env.example to .env.local and fill in your Firebase project values, ` +
        `or export ${name} in your shell before running this script.`
    );
  }
  return value;
}

/**
 * Returns a Firebase Web SDK config object built from environment variables.
 * Throws if any required variable is unset. Optional fields fall back to ''.
 */
export function getScriptFirebaseConfig(): {
  projectId: string;
  appId: string;
  storageBucket: string;
  apiKey: string;
  authDomain: string;
  measurementId: string;
  messagingSenderId: string;
} {
  return {
    projectId: requireEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID'),
    appId: requireEnv('NEXT_PUBLIC_FIREBASE_APP_ID'),
    storageBucket: requireEnv('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'),
    apiKey: requireEnv('NEXT_PUBLIC_FIREBASE_API_KEY'),
    authDomain: requireEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'),
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || '',
    messagingSenderId: requireEnv('NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
  };
}

/**
 * Returns just the Firebase project ID — for `firebase-admin` scripts that
 * only need `projectId`. Throws if `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (or
 * `GOOGLE_CLOUD_PROJECT`) is unset.
 */
export function getScriptFirebaseProjectId(): string {
  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error(
      '[scripts] Missing Firebase project ID. ' +
        'Set NEXT_PUBLIC_FIREBASE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) in .env.local ' +
        'or export it in your shell before running this script.'
    );
  }
  return projectId;
}
