/** @jest-environment node */

export {};

const mockSettings = jest.fn();
const mockInitializeApp = jest.fn(() => ({ name: '[DEFAULT]' }));
const mockGetFirestore = jest.fn(() => ({ settings: mockSettings }));

jest.mock('server-only', () => ({}));
jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(() => 'adc'),
  cert: jest.fn((value) => value),
  getApps: jest.fn(() => []),
  initializeApp: mockInitializeApp,
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: mockGetFirestore }));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn(() => ({ verifyIdToken: jest.fn() })) }));
jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  })),
}));

const originalEnv = process.env;

function loadFirebaseAdmin(): void {
  jest.isolateModules(() => {
    require('@/lib/firebase-admin');
  });
}

describe('Firebase Admin transport selection', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSettings.mockClear();
    mockInitializeApp.mockClear();
    mockGetFirestore.mockClear();
    process.env = { ...originalEnv };
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    { NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080' },
  ])('keeps emulator runtime %o on credential-less gRPC', (environment) => {
    Object.assign(process.env, environment);

    loadFirebaseAdmin();

    expect(mockGetFirestore).toHaveBeenCalledTimes(1);
    expect(mockSettings).not.toHaveBeenCalled();
  });

  it('retains preferRest for live Firestore', () => {
    loadFirebaseAdmin();

    expect(mockGetFirestore).toHaveBeenCalledTimes(1);
    expect(mockSettings).toHaveBeenCalledWith({ preferRest: true });
  });
});
