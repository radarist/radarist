import { assertDisposableDemoRuntime } from '../../tests/e2e/utils/disposable-demo-runtime';

const SAFE_ENV = {
  E2E_DEMO_JOURNEY: 'true',
  E2E_DEMO_DISPOSABLE: 'true',
  NEO4J_INTEGRATION_DISPOSABLE: 'true',
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
  INNGEST_ENABLED: 'false',
  NEO4J_URI: 'bolt://127.0.0.1:17692',
};

const BOOTSTRAP_SHA = 'a'.repeat(40);
const BOOTSTRAP_RUN_TOKEN = '12345678-1234-4123-8123-123456789abc';
const BOOTSTRAP_ENV = {
  ...SAFE_ENV,
  E2E_DEMO_RUNTIME_PROFILE: 'selftest',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
  NEO4J_URI: 'bolt://127.0.0.1:17687',
  E2E_RELEASE_BOOTSTRAP_SHA: BOOTSTRAP_SHA,
  E2E_RELEASE_BOOTSTRAP_RUN_TOKEN: BOOTSTRAP_RUN_TOKEN,
  E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER: `radarist-test020-${BOOTSTRAP_SHA.slice(0, 12)}-${BOOTSTRAP_RUN_TOKEN.slice(0, 8)}`,
  E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER_ID: 'b'.repeat(64),
};

describe('disposable demo E2E target guard', () => {
  it('accepts only the canonical disposable local stack', () => {
    expect(assertDisposableDemoRuntime(SAFE_ENV)).toEqual({
      firebaseProfile: 'default',
      projectId: 'demo-radarist',
      firestoreHost: '127.0.0.1:8080',
      authHost: '127.0.0.1:9099',
      storageHost: '127.0.0.1:9199',
      neo4jUri: 'bolt://127.0.0.1:17692',
    });
  });

  it('accepts the exact isolated selftest Firebase profile when explicitly selected', () => {
    expect(
      assertDisposableDemoRuntime({
        ...SAFE_ENV,
        E2E_DEMO_RUNTIME_PROFILE: 'selftest',
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
        FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
      })
    ).toEqual({
      firebaseProfile: 'selftest',
      projectId: 'demo-radarist-selftest',
      firestoreHost: '127.0.0.1:18080',
      authHost: '127.0.0.1:19099',
      storageHost: '127.0.0.1:19199',
      neo4jUri: 'bolt://127.0.0.1:17692',
    });
  });

  it('accepts bootstrap port 17687 only with the complete owned-container identity', () => {
    expect(assertDisposableDemoRuntime(BOOTSTRAP_ENV)).toEqual({
      firebaseProfile: 'selftest',
      projectId: 'demo-radarist-selftest',
      firestoreHost: '127.0.0.1:18080',
      authHost: '127.0.0.1:19099',
      storageHost: '127.0.0.1:19199',
      neo4jUri: 'bolt://127.0.0.1:17687',
    });
  });

  it.each([
    ['E2E_RELEASE_BOOTSTRAP_SHA', undefined],
    ['E2E_RELEASE_BOOTSTRAP_SHA', 'A'.repeat(40)],
    ['E2E_RELEASE_BOOTSTRAP_RUN_TOKEN', undefined],
    ['E2E_RELEASE_BOOTSTRAP_RUN_TOKEN', 'not-a-uuid'],
    ['E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER', 'radarist-neo4j-selftest'],
    ['E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER_ID', undefined],
    ['E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER_ID', 'short'],
  ])('rejects bootstrap port 17687 with invalid ownership field %s', (name, value) => {
    expect(() => assertDisposableDemoRuntime({ ...BOOTSTRAP_ENV, [name]: value })).toThrow(/Release-bootstrap/);
  });

  it('rejects release-bootstrap ownership markers on the standalone demo graph', () => {
    expect(() =>
      assertDisposableDemoRuntime({ ...SAFE_ENV, E2E_RELEASE_BOOTSTRAP_SHA: BOOTSTRAP_SHA })
    ).toThrow('outside the release-bootstrap graph target');
  });

  it('rejects unsupported runtime profiles', () => {
    expect(() =>
      assertDisposableDemoRuntime({
        ...SAFE_ENV,
        E2E_DEMO_RUNTIME_PROFILE: 'custom',
      })
    ).toThrow('E2E_DEMO_RUNTIME_PROFILE=default or selftest');
  });

  it.each([
    ['E2E_DEMO_DISPOSABLE', undefined],
    ['NEO4J_INTEGRATION_DISPOSABLE', undefined],
    ['NEXT_PUBLIC_USE_FIREBASE_EMULATOR', 'false'],
    ['NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'persistent-project'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8180'],
    ['FIREBASE_AUTH_EMULATOR_HOST', 'localhost:9099'],
    ['FIREBASE_STORAGE_EMULATOR_HOST', 'storage.example:9199'],
    ['INNGEST_ENABLED', 'true'],
    ['NEO4J_URI', 'bolt://127.0.0.1:7687'],
    ['NEO4J_URI', 'bolt://127.0.0.1:17687'],
  ])('rejects a non-disposable %s target', (name, value) => {
    expect(() =>
      assertDisposableDemoRuntime({
        ...SAFE_ENV,
        [name]: value,
      })
    ).toThrow(`Demo user journey requires ${name}=`);
  });
});
