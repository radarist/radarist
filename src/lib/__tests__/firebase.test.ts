/**
 * @jest-environment node
 *
 * @file firebase.test.ts
 * @description Validation tests for the firebase.ts env-validation block
 * introduced in Change 4 of the OSS onboarding plan. Confirms missing AND
 * placeholder values fail loud server-side, log loud browser-side, and stay
 * quiet under NODE_ENV=test. Runs under the Node environment so
 * `typeof window === 'undefined'` matches a real server runtime; browser
 * cases install a stub window on globalThis.
 */

const mockInitializeApp = jest.fn((options: Record<string, unknown>) => ({ options }));

// Mock the Firebase SDK packages so requiring firebase.ts in a Node test
// environment doesn't fail on the SDK's ESM `firebase/auth` entry. We only
// care about the validation block at the top of the module.
jest.mock('firebase/app', () => ({
  initializeApp: (options: Record<string, unknown>) => mockInitializeApp(options),
  getApps: jest.fn(() => []),
  getApp: jest.fn(() => ({ options: {} })),
}));
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
}));
jest.mock('firebase/storage', () => ({
  getStorage: jest.fn(() => ({})),
  connectStorageEmulator: jest.fn(),
}));
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({ emulatorConfig: null })),
  connectAuthEmulator: jest.fn(
    (auth: { emulatorConfig: unknown }, url: string, options?: { disableWarnings?: boolean }) => {
    const parsed = new URL(url);
    auth.emulatorConfig = {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : null,
        options: { disableWarnings: options?.disableWarnings === true },
    };
    }
  ),
}));

describe('firebase.ts env validation', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    if (ORIGINAL_WINDOW === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
    }
  });

  function clearFirebaseEnv() {
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    delete process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    delete process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
    delete process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
    delete process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;
    delete process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
    delete process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST;
  }

  function setEmulatorDefaults() {
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'demo-api-key';
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'demo-radarist.firebaseapp.com';
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-radarist';
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'demo-radarist.appspot.com';
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '000000000000';
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID = '1:000000000000:web:0000000000000000000000';
  }

  function asServer() {
    delete (globalThis as { window?: unknown }).window;
  }

  function asBrowser() {
    (globalThis as { window?: unknown }).window = {};
  }

  it('passes silently when all required values are realistic (server, non-test)', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    asServer();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).not.toThrow();
  });

  it('throws server-side when apiKey is empty', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';
    asServer();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).toThrow(/Missing or placeholder environment variables.*NEXT_PUBLIC_FIREBASE_API_KEY/);
  });

  it('throws server-side when apiKey is the legacy placeholder', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '<your-firebase-web-api-key>';
    asServer();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).toThrow(/Missing or placeholder environment variables.*NEXT_PUBLIC_FIREBASE_API_KEY/);
  });

  it('logs (does not throw) browser-side when a required key is missing', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = '';
    asBrowser();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).not.toThrow();
  });

  it('stays quiet under NODE_ENV=test even when required keys are empty', () => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
    clearFirebaseEnv();
    asServer();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).not.toThrow();
  });

  it('uses safe demo config when full emulator mode is enabled without public Firebase values', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR = 'true';
    asServer();

    expect(() => {
      jest.isolateModules(() => require('../firebase'));
    }).not.toThrow();

    expect(mockInitializeApp).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'demo-api-key',
        authDomain: 'demo-radarist.firebaseapp.com',
        projectId: 'demo-radarist',
        storageBucket: 'demo-radarist.appspot.com',
      })
    );
  });

  it('attests that a development browser without emulator wiring targets production Auth', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    delete process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR;
    delete process.env.NEXT_PUBLIC_USE_AUTH_EMULATOR;
    asBrowser();

    jest.isolateModules(() => require('../firebase'));

    expect((globalThis.window as Window).__e2eFirebaseRuntime).toEqual({
      projectId: 'demo-radarist',
      authEmulatorOrigin: null,
      firestoreEmulatorOrigin: null,
      compiledIdentity: {
        marker: 'radarist-firebase-build-identity-v1',
        projectId: 'demo-radarist',
        authHost: '<unset>',
        firestoreHost: '<unset>',
      },
    });
  });

  it('uses env-configured emulator ports', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR = 'true';
    process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST = '127.0.0.1:18080';
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:19199';
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:19099';
    asBrowser();

    let firestore: typeof import('firebase/firestore');
    let storage: typeof import('firebase/storage');
    let auth: typeof import('firebase/auth');

    jest.isolateModules(() => {
      require('../firebase');
      firestore = require('firebase/firestore');
      storage = require('firebase/storage');
      auth = require('firebase/auth');
    });

    expect(firestore!.connectFirestoreEmulator).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', 18080);
    expect(storage!.connectStorageEmulator).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', 19199);
    expect(auth!.connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://127.0.0.1:19099', {
      disableWarnings: true,
    });
    expect((globalThis.window as Window).__e2eFirebaseRuntime).toEqual({
      projectId: 'demo-radarist',
      authEmulatorOrigin: 'http://127.0.0.1:19099',
      firestoreEmulatorOrigin: 'http://127.0.0.1:18080',
      compiledIdentity: {
        marker: 'radarist-firebase-build-identity-v1',
        projectId: 'demo-radarist',
        authHost: '127.0.0.1:19099',
        firestoreHost: '127.0.0.1:18080',
      },
    });
  });

  it('keeps the Firebase warning in auth-only mixed-service mode', () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    clearFirebaseEnv();
    setEmulatorDefaults();
    delete process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR;
    process.env.NEXT_PUBLIC_USE_AUTH_EMULATOR = 'true';
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:19099';
    asBrowser();

    let auth: typeof import('firebase/auth');
    jest.isolateModules(() => {
      require('../firebase');
      auth = require('firebase/auth');
    });

    expect(auth!.connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://127.0.0.1:19099');
    expect(auth!.connectAuthEmulator).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ disableWarnings: true })
    );
  });
});
