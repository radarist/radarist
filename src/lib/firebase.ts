// Boundary enforcement note: `import 'client-only'` was attempted as a
// build-time seal on 2026-05-12 and reverted in the same hour. The current
// codebase shares several service modules (visualizations, digests,
// proposed-relations, signals/feedback) between client and server entry
// points; Next.js still evaluates `'use client'` pages in the Server
// Component bundle when extracting route metadata, so `client-only` flagged
// every shared module as a server-import. Splitting each service into
// `*-client.ts` + `*-server.ts` variants would close it but is a multi-day
// refactor out of v0.1.0-prototype scope. The boundary is therefore enforced
// at lint time only (`no-restricted-imports` at error severity in
// eslint.config.mjs) plus the completed admin-SDK migration of every
// `src/app/api/**` and `src/lib/inngest/**` call site
// (8b79ad12 / cefe25fb / cacc197f).
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_FIREBASE_EMULATOR_HOSTS,
  formatEmulatorOrigin,
  parseEmulatorHost,
} from '@/lib/firebase-emulator-config';
const log = createLogger('firebase');

/**
 * Firebase configuration object.
 * All values must be provided via NEXT_PUBLIC_FIREBASE_* environment variables.
 * See .env.example for the full list.
 *
 * Tests and explicit full-emulator mode use safe demo values when public
 * Firebase variables are absent. Production and auth-only mode still require
 * real configuration. The demo values do NOT connect to any real project.
 */
const isTest = process.env.NODE_ENV === 'test';
const useFirebaseEmulator = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';
const useSafeLocalDefaults = isTest || useFirebaseEmulator;

const firebaseConfig = {
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || (useSafeLocalDefaults ? 'demo-radarist' : ''),
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ||
    (useSafeLocalDefaults ? '1:000000000000:web:0000000000000000000000' : ''),
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || (useSafeLocalDefaults ? 'demo-radarist.appspot.com' : ''),
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || (useSafeLocalDefaults ? 'demo-api-key' : ''),
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || (useSafeLocalDefaults ? 'demo-radarist.firebaseapp.com' : ''),
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || '',
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || (useSafeLocalDefaults ? '000000000000' : ''),
};

// Validate required config in all non-test environments.
//
// Two cases trigger:
//   1. Empty / undefined — the variable was never set.
//   2. Unedited `<your-...>` placeholder — the user copied .env.example but
//      forgot to fill in a value. (Modern .env.example ships with emulator
//      defaults, but a long-running .env.local from before that change can
//      still carry the placeholders.)
//
// Server-side throws so scripts and Inngest functions surface the cause
// clearly instead of getting the cryptic `auth/invalid-api-key` from
// getAuth(). Browser-side logs the same message so dev-tools console shows it.
const PLACEHOLDER_RE = /^<.*>$/;
function valueIsRealistic(v: string | undefined): boolean {
  if (!v) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  return true;
}

if (!isTest) {
  const requiredKeys = ['projectId', 'apiKey', 'authDomain'] as const;
  const invalid = requiredKeys.filter((key) => !valueIsRealistic(firebaseConfig[key]));
  if (invalid.length > 0) {
    const message =
      `[Firebase] Missing or placeholder environment variables: ` +
      invalid.map((k) => `NEXT_PUBLIC_FIREBASE_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`).join(', ') +
      '. Copy .env.example to .env.local and fill in your Firebase config — ' +
      'or set NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true to use the emulator with shipped defaults.';
    if (typeof window === 'undefined') {
      throw new Error(message);
    } else {
      log.error(message);
    }
  }
}

/**
 * The Firebase App instance.
 * Initializes a new app if one doesn't exist, otherwise retrieves the existing one.
 */
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// `db` and `storage`: eager in the browser, lazy on the server.
//
// **The problem we're solving (server)**: eager `getFirestore(app)` at
// module-init opens a gRPC connection unconditionally — even during SSR,
// where there's no auth context for the Write stream queue.
// firebase-js-sdk's `ExponentialBackoff` then retries forever
// (~1s/2s/.../60s-capped), emitting `GrpcConnection RPC 'Write' stream …
// error. Code: undefined` lines into the dev terminal indefinitely. The
// connection is never *used* server-side (every API route / Inngest function
// is on the admin SDK), so deferring init silences the noise without
// breaking anything.
//
// **Why we can't do the same in the browser**: firebase-js-sdk's
// `FirebaseAuthCredentialsProvider` must wire auth credentials *during*
// `configureFirestore`, which only runs on first `getFirestore(app)`. If
// that happens *after* an `onAuthStateChanged` callback has already fired
// (e.g. user is already signed in when the page loads and the first
// `db.collection(...)` call lands), Firestore throws "INTERNAL ASSERTION
// FAILED: Unexpected state (ID: a540)". Eager init in the browser keeps the
// credentials provider in lockstep with auth state.
//
// Net effect: server SSR no longer triggers `getFirestore`, so no gRPC
// noise. Browser keeps the same eager init order it always had.
function createLazyProxy<T extends object>(factory: () => T): T {
  let instance: T | null = null;
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      if (!instance) instance = factory();
      const value = Reflect.get(instance, prop, receiver);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    has(_target, prop) {
      if (!instance) instance = factory();
      return Reflect.has(instance, prop);
    },
    getPrototypeOf() {
      if (!instance) instance = factory();
      return Reflect.getPrototypeOf(instance);
    },
    ownKeys() {
      if (!instance) instance = factory();
      return Reflect.ownKeys(instance);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!instance) instance = factory();
      return Reflect.getOwnPropertyDescriptor(instance, prop);
    },
  });
}

const isBrowser = typeof window !== 'undefined';

/**
 * The Firestore database instance associated with the Firebase App.
 * Eager in the browser, lazy on the server — see comment above.
 */
const db = isBrowser ? getFirestore(app) : createLazyProxy(() => getFirestore(app));

/**
 * The Firebase Storage instance for file uploads.
 * Eager in the browser, lazy on the server — same rationale as `db`.
 */
const storage = isBrowser ? getStorage(app) : createLazyProxy(() => getStorage(app));

/**
 * The Firebase Auth instance for authentication.
 * Eager in both environments: AuthProvider reads `auth.currentUser`
 * synchronously on first render and registers `onAuthStateChanged(auth, …)`
 * immediately afterwards. Auth's REST/JSON footprint doesn't produce the
 * gRPC noise we worry about for Firestore.
 */
const auth = getAuth(app);

/**
 * Emulator connection modes:
 *
 * 1. NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true — Full emulator suite (Firestore + Storage + Auth)
 *    Start with: npm run firebase:emulators
 *
 * 2. NEXT_PUBLIC_USE_AUTH_EMULATOR=true — Auth emulator only (production Firestore/Storage)
 *    Start with: firebase emulators:start --only auth
 *    Use for E2E tests that need real data but emulator auth (no quota limits).
 */
const useFullEmulator = useFirebaseEmulator;
const useAuthEmulatorOnly = process.env.NEXT_PUBLIC_USE_AUTH_EMULATOR === 'true';
let emulatorConnected = false;

const firestoreEmulator = parseEmulatorHost(
  process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST,
  DEFAULT_FIREBASE_EMULATOR_HOSTS.firestore
);
const storageEmulator = parseEmulatorHost(
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST,
  DEFAULT_FIREBASE_EMULATOR_HOSTS.storage
);
const authEmulatorUrl = formatEmulatorOrigin(
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST,
  DEFAULT_FIREBASE_EMULATOR_HOSTS.auth
);

/**
 * Exact build-time identity carried by emulator bundles. The release canary
 * searches for this uniquely-marked object rather than treating the always
 * compiled fallback host literals as proof of the effective build tuple.
 *
 * Deliberately use only NEXT_PUBLIC values here: server-only Firebase host
 * variables are runtime inputs and cannot attest what Turbopack inlined into
 * the browser bundle.
 */
const compiledFirebaseIdentity = Object.freeze({
  marker: 'radarist-firebase-build-identity-v1',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '<unset>',
  authHost: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST || '<unset>',
  firestoreHost: process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST || '<unset>',
});

// E2E test helpers are attached to the browser `window` (emulator modes only)
// so Playwright fixtures can drive sign-in / data setup via page.evaluate.
// Type the augmentation instead of casting each assignment through `any`
// (HYGIENE-001) — every helper is optional (present only in emulator builds).
declare global {
  interface Window {
    __e2eSignIn?: (email: string, password: string) => Promise<unknown>;
    __e2eFirebaseRuntime?: Readonly<{
      projectId: string | null;
      authEmulatorOrigin: string | null;
      firestoreEmulatorOrigin: string | null;
      compiledIdentity: Readonly<{
        marker: string;
        projectId: string;
        authHost: string;
        firestoreHost: string;
      }>;
    }>;
    __getAuthToken?: () => Promise<string>;
    __firestoreSet?: (collection: string, id: string, data: Record<string, unknown>) => Promise<void>;
    __firestoreDelete?: (collection: string, id: string) => Promise<void>;
    __deleteDocument?: (documentId: string) => Promise<void>;
  }
}

/**
 * Expose E2E test helpers on window (browser only, emulator modes only).
 * __e2eSignIn: programmatic sign-in for Playwright fixtures
 */
function exposeE2eHelpers() {
  if (typeof window === 'undefined') return;

  const authEmulator = auth.emulatorConfig;
  window.__e2eFirebaseRuntime = Object.freeze({
    projectId: app.options?.projectId ?? null,
    authEmulatorOrigin: authEmulator
      ? `${authEmulator.protocol}://${authEmulator.host}${authEmulator.port === null ? '' : `:${authEmulator.port}`}`
      : null,
    firestoreEmulatorOrigin: useFullEmulator
      ? `http://${firestoreEmulator.host}:${firestoreEmulator.port}`
      : null,
    compiledIdentity: compiledFirebaseIdentity,
  });

  window.__e2eSignIn = async (email: string, password: string) => {
    const { signInWithEmailAndPassword } = await import('firebase/auth');
    return signInWithEmailAndPassword(auth, email, password);
  };

  window.__getAuthToken = async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user');
    return user.getIdToken();
  };
}

// Mode 1: Full emulator — Firestore + Storage + Auth
if (useFullEmulator && !emulatorConnected) {
  try {
    connectFirestoreEmulator(db, firestoreEmulator.host, firestoreEmulator.port);
    emulatorConnected = true;
    log.info(`Connected to Firestore emulator at ${firestoreEmulator.host}:${firestoreEmulator.port}`);

    if (typeof window !== 'undefined') {
      connectStorageEmulator(storage, storageEmulator.host, storageEmulator.port);
      // A complete local workspace deliberately keeps Auth, Firestore, and
      // Storage on loopback. Suppress the SDK's permanent production-warning
      // footer only for that fully-local contract; auth-only/mixed mode below
      // keeps the warning because writes may still reach production services.
      connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
      log.info(`Connected to Storage emulator at ${storageEmulator.host}:${storageEmulator.port}`);
      log.info(`Connected to Auth emulator at ${authEmulatorUrl}`);

      exposeE2eHelpers();

      // Firestore helpers for test data setup (full emulator only)
      window.__firestoreSet = async (collection: string, id: string, data: Record<string, unknown>) => {
        const { doc, setDoc, Timestamp } = await import('firebase/firestore');
        const converted = { ...data };
        for (const [key, value] of Object.entries(converted)) {
          if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
            converted[key] = Timestamp.fromDate(new Date(value));
          }
        }
        await setDoc(doc(db, collection, id), converted);
      };
      window.__firestoreDelete = async (collection: string, id: string) => {
        const { doc, deleteDoc } = await import('firebase/firestore');
        await deleteDoc(doc(db, collection, id));
      };
      window.__deleteDocument = async (documentId: string) => {
        const { deleteDocument } = await import('@/lib/document-service');
        await deleteDocument(documentId);
      };
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already'))) {
      log.error('Failed to connect to emulator', error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Mode 2: Auth emulator only — production Firestore/Storage, emulator Auth
if (useAuthEmulatorOnly && !useFullEmulator && !emulatorConnected) {
  try {
    if (typeof window !== 'undefined') {
      connectAuthEmulator(auth, authEmulatorUrl);
      log.info(`Connected to Auth emulator at ${authEmulatorUrl} (auth-only mode, production Firestore)`);
      exposeE2eHelpers();
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already'))) {
      log.error('Failed to connect to Auth emulator', error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Dev-mode test helpers against production Firebase. Gated by NODE_ENV so
// no auth inspection hooks ship in production bundles. E2E tests that need
// to read the live user's ID token (e.g. to authenticate direct API calls
// from Playwright context) rely on these.
if (
  typeof window !== 'undefined' &&
  process.env.NODE_ENV !== 'production' &&
  !useFullEmulator &&
  !useAuthEmulatorOnly
) {
  exposeE2eHelpers();
}

/**
 * Removes undefined values from an object to prevent Firestore errors.
 * Firestore doesn't allow undefined values - they must be omitted or set to null.
 *
 * @param obj - Object to clean
 * @param deep - Whether to recursively clean nested objects (default: true)
 * @returns Cleaned object without undefined values
 *
 * @example
 * ```typescript
 * const updates = { name: "Test", notes: undefined, metadata: { id: 1, value: undefined } };
 * const clean = removeUndefinedFields(updates);
 * // Result: { name: "Test", metadata: { id: 1 } }
 * await updateDoc(docRef, clean);
 * ```
 */
export function removeUndefinedFields<T extends Record<string, any>>(obj: T, deep: boolean = true): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        // Recursively clean nested objects if deep cleaning is enabled
        if (deep && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          return [key, removeUndefinedFields(value, deep)];
        }
        return [key, value];
      })
  ) as Partial<T>;
}

export { app, db, storage, auth };
