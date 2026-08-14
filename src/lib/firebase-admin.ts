/**
 * @file lib/firebase-admin.ts
 * @description Firebase Admin SDK initialization for server-side operations
 *
 * This module provides server-side Firestore access using the Firebase Admin SDK.
 * It handles credential loading based on the environment (emulator, local dev, production).
 *
 * IMPORTANT: This module should ONLY be imported in server-side code:
 * - API routes (app/api/*)
 * - Server components
 * - Inngest functions
 * - Scripts
 *
 * For client-side code, use firebase.ts instead.
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import 'server-only';
import { initializeApp, getApps, cert, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { createLogger } from '@/lib/logger';
import { shouldUseFirebaseAdminEmulator } from '@/lib/firebase-admin-environment';
const log = createLogger('firebase-admin');

// ============================================================================
// Environment Configuration
// ============================================================================

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'radarist-local';
const useEmulator = shouldUseFirebaseAdminEmulator({
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
});

// ============================================================================
// Admin SDK Initialization
// ============================================================================

/**
 * Initialize or get the Firebase Admin app instance
 */
function getAdminApp(): App {
  // Return existing app if already initialized
  if (getApps().length > 0) {
    return getApps()[0];
  }

  // Emulator mode - no credentials needed.
  //
  // Honor user-set env vars: only fill defaults when the var is unset, so
  // alt-hostname setups (Docker, non-default ports) survive. Pre-2026-05-13
  // this block overrode every value unconditionally, which silently broke
  // any non-127.0.0.1 emulator topology.
  if (useEmulator) {
    log.info('Connecting to Firebase emulators');
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    }
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    }
    if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
      process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
    }
    return initializeApp({ projectId: PROJECT_ID });
  }

  // Pin the GCS/Firestore quota (billing) project to THIS Firebase project so
  // admin writes never depend on a developer's gcloud ADC quota project. When
  // ADC's quota_project_id drifts to an unrelated project (e.g. another GCP
  // project the dev logged into), every admin Storage write fails with GCS 400
  // "User project specified in the request is invalid" — which silently kills
  // infographics, deep-research documents, and report assets. google-auth honors
  // GOOGLE_CLOUD_QUOTA_PROJECT over the ADC file's quota_project_id (verified),
  // so this is the durable fix. Only set when unset, so explicit env/CI wins.
  if (PROJECT_ID && PROJECT_ID !== 'radarist-local' && !process.env.GOOGLE_CLOUD_QUOTA_PROJECT) {
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = PROJECT_ID;
  }

  // Production/Staging - try different credential methods
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath) {
    // Explicit service account file path
    log.info('Using service account from GOOGLE_APPLICATION_CREDENTIALS');

    const serviceAccount = require(serviceAccountPath);
    return initializeApp({
      credential: cert(serviceAccount),
      projectId: PROJECT_ID,
    });
  }

  // Check for inline service account JSON (e.g., from Vercel secrets)
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountJson) {
    log.info('Using service account from environment variable');
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      return initializeApp({
        credential: cert(serviceAccount),
        projectId: PROJECT_ID,
      });
    } catch (error) {
      log.error(
        'Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  // Try Application Default Credentials (works in GCP environments).
  // Logged at debug because it fires on every server start during normal
  // local development and would otherwise spam the build/startup output.
  try {
    log.debug('Using Application Default Credentials');
    return initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  } catch (_error) {
    log.warn('No credentials found, initializing with project ID only');
    return initializeApp({ projectId: PROJECT_ID });
  }
}

// ============================================================================
// Exports
// ============================================================================

/**
 * The Firebase Admin app instance
 */
const adminApp: App = getAdminApp();

/**
 * The Firestore Admin instance for server-side database operations
 *
 * @example
 * ```typescript
 * import { db } from '@/lib/firebase-admin';
 *
 * // Read a document
 * const doc = await db.collection('users').doc('user-id').get();
 *
 * // Query documents
 * const snapshot = await db
 *   .collection('signals')
 *   .where('status', '==', 'pending')
 *   .get();
 *
 * // Write a document
 * await db.collection('apiKeys').add({ ... });
 * ```
 */
const db: Firestore = getFirestore(adminApp);

// Prefer REST over gRPC for live Firestore. Under concurrent mission load the
// shared gRPC channel can saturate and stall. The emulator is the exception:
// google-gax's REST fallback requests Application Default Credentials even for
// FIRESTORE_EMULATOR_HOST, while gRPC correctly uses its credential-less local
// channel. Wrapped because settings() throws after the client has been used.
if (!useEmulator) {
  try {
    db.settings({ preferRest: true });
  } catch {
    // already initialized (hot-reload) — safe to ignore
  }
}

/**
 * The Firebase Auth Admin instance for server-side authentication
 *
 * @example
 * ```typescript
 * import { adminAuth } from '@/lib/firebase-admin';
 *
 * // Verify an ID token
 * const decodedToken = await adminAuth.verifyIdToken(idToken);
 * const userId = decodedToken.uid;
 * ```
 */
const adminAuth: Auth = getAuth(adminApp);

export { adminApp, db, adminAuth };
