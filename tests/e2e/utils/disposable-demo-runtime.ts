/**
 * TEST-023 — the normal browser-acceptance Bolt endpoint stays pinned to the
 * disposable graph on 17692. TEST-020's clean-archive bootstrap owns a distinct
 * tmpfs graph on 17687, which is also the retained selftest port; admitting that
 * port therefore requires the complete per-run ownership tuple created only
 * after the bootstrap runner has inspected its labelled container.
 */
const REQUIRED_DEMO_RUNTIME = Object.freeze({
  E2E_DEMO_JOURNEY: 'true',
  E2E_DEMO_DISPOSABLE: 'true',
  NEO4J_INTEGRATION_DISPOSABLE: 'true',
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
  INNGEST_ENABLED: 'false',
});

const DEMO_NEO4J_URI = 'bolt://127.0.0.1:17692';
const RELEASE_BOOTSTRAP_NEO4J_URI = 'bolt://127.0.0.1:17687';
const SHA_RE = /^[a-f0-9]{40}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;

const FIREBASE_PROFILES = Object.freeze({
  default: Object.freeze({
    projectId: 'demo-radarist',
    firestoreHost: '127.0.0.1:8080',
    authHost: '127.0.0.1:9099',
    storageHost: '127.0.0.1:9199',
  }),
  selftest: Object.freeze({
    projectId: 'demo-radarist-selftest',
    firestoreHost: '127.0.0.1:18080',
    authHost: '127.0.0.1:19099',
    storageHost: '127.0.0.1:19199',
  }),
});

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface DisposableDemoRuntime {
  firebaseProfile: 'default' | 'selftest';
  projectId: string;
  firestoreHost: string;
  authHost: string;
  storageHost: string;
  neo4jUri: string;
}

function resolveOwnedNeo4jUri(
  env: RuntimeEnvironment,
  profileName: DisposableDemoRuntime['firebaseProfile']
): string {
  if (env.NEO4J_URI === DEMO_NEO4J_URI) {
    const strayOwnershipKey = [
      'E2E_RELEASE_BOOTSTRAP_SHA',
      'E2E_RELEASE_BOOTSTRAP_RUN_TOKEN',
      'E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER',
      'E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER_ID',
    ].find((name) => env[name] !== undefined);
    if (strayOwnershipKey) {
      throw new Error(`Demo user journey rejects ${strayOwnershipKey} outside the release-bootstrap graph target.`);
    }
    return DEMO_NEO4J_URI;
  }

  if (env.NEO4J_URI !== RELEASE_BOOTSTRAP_NEO4J_URI || profileName !== 'selftest') {
    throw new Error(`Demo user journey requires NEO4J_URI=${DEMO_NEO4J_URI}, or the owned release-bootstrap tuple.`);
  }

  const sha = env.E2E_RELEASE_BOOTSTRAP_SHA ?? '';
  const runToken = env.E2E_RELEASE_BOOTSTRAP_RUN_TOKEN ?? '';
  const containerName = env.E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER ?? '';
  const containerId = env.E2E_RELEASE_BOOTSTRAP_NEO4J_CONTAINER_ID ?? '';
  if (!SHA_RE.test(sha)) throw new Error('Release-bootstrap demo runtime requires its exact lowercase SHA.');
  if (!UUID_RE.test(runToken)) throw new Error('Release-bootstrap demo runtime requires its exact run token.');
  if (containerName !== `radarist-test020-${sha.slice(0, 12)}-${runToken.slice(0, 8)}`) {
    throw new Error('Release-bootstrap demo runtime container name does not match its SHA and run token.');
  }
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new Error('Release-bootstrap demo runtime requires its inspected 64-character container ID.');
  }
  return RELEASE_BOOTSTRAP_NEO4J_URI;
}

/**
 * Fail before any namespace-wide cleanup unless the canonical script owns each
 * disposable local dependency. Exact values keep an opt-in flag from being
 * combined with a persistent emulator project or the protected default graph.
 */
export function assertDisposableDemoRuntime(env: RuntimeEnvironment): DisposableDemoRuntime {
  const profileName = env.E2E_DEMO_RUNTIME_PROFILE ?? 'default';
  if (profileName !== 'default' && profileName !== 'selftest') {
    throw new Error('Demo user journey requires E2E_DEMO_RUNTIME_PROFILE=default or selftest.');
  }
  const profile = FIREBASE_PROFILES[profileName];
  const neo4jUri = resolveOwnedNeo4jUri(env, profileName);

  for (const [name, expected] of Object.entries(REQUIRED_DEMO_RUNTIME)) {
    if (env[name] !== expected) {
      throw new Error(`Demo user journey requires ${name}=${expected}. Run npm run e2e:demo.`);
    }
  }

  const firebaseRequirements = {
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: profile.projectId,
    FIRESTORE_EMULATOR_HOST: profile.firestoreHost,
    FIREBASE_AUTH_EMULATOR_HOST: profile.authHost,
    FIREBASE_STORAGE_EMULATOR_HOST: profile.storageHost,
  };
  for (const [name, expected] of Object.entries(firebaseRequirements)) {
    if (env[name] !== expected) {
      throw new Error(`Demo user journey requires ${name}=${expected}. Run npm run e2e:demo.`);
    }
  }

  return {
    firebaseProfile: profileName,
    projectId: profile.projectId,
    firestoreHost: profile.firestoreHost,
    authHost: profile.authHost,
    storageHost: profile.storageHost,
    neo4jUri,
  };
}
