/**
 * @jest-environment node
 */

/**
 * @file /api/health tests
 * @description Unit tests for the unified health check endpoint.
 */

// ---------------------------------------------------------------------------
// Mocks — jest.mock factories are hoisted above `const`, so use jest.fn()
// inline in factories, then access via jest.requireMock after imports.
// ---------------------------------------------------------------------------

// Admin-SDK fake: route calls `db.collection('__health').limit(1).get()`.
// `mockGet` is the controllable promise; the chain returns `this`.
jest.mock('@/lib/firebase-admin', () => {
  const mockGet = jest.fn();
  return {
    __esModule: true,
    db: {
      collection: () => ({
        limit: function () {
          return this;
        },
        get: mockGet,
      }),
    },
    __mockGet: mockGet,
  };
});

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { GET } from '../route';
import packageJson from '../../../../../package.json';

const { __mockGet: mockGetDocs } = jest.requireMock<{
  __mockGet: jest.Mock;
}>('@/lib/firebase-admin');

const { checkHealth: mockCheckHealth } = jest.requireMock<{
  checkHealth: jest.Mock;
}>('@/lib/graph');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function mockFetch(impl: typeof global.fetch) {
  global.fetch = impl;
}

function setInngestUrl(url: string | undefined) {
  if (url === undefined) {
    delete process.env.INNGEST_DEV_SERVER_URL;
  } else {
    process.env.INNGEST_DEV_SERVER_URL = url;
  }
}

interface HealthBody {
  status: string;
  timestamp: string;
  version: string;
  services: {
    firestore: { status: string; latencyMs?: number; error?: string };
    auth: { status: string; latencyMs?: number; error?: string };
    storage: { status: string; latencyMs?: number; error?: string };
    neo4j: { status: string; latencyMs?: number; error?: string };
    inngest: { status: string; latencyMs?: number; error?: string };
    runtime: { status: string; checkpoint: string; error?: string };
  };
}

async function parseBody(response: Response): Promise<HealthBody> {
  return response.json() as Promise<HealthBody>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    delete process.env.RADARIST_LOCAL_RUNTIME_STATUS_FILE;
    global.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  // ---- 1. Healthy when all services are up ----

  it('returns degraded when dependencies are up but launcher supervision is not configured', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 5 });
    setInngestUrl('http://localhost:8288');
    mockFetch(jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.firestore.status).toBe('up');
    expect(body.services.auth.status).toBe('up');
    expect(body.services.storage.status).toBe('up');
    expect(body.services.neo4j.status).toBe('up');
    expect(body.services.inngest.status).toBe('up');
    expect(body.services.runtime.status).toBe('not-configured');
  });

  it.each([
    ['auth', 'FIREBASE_AUTH_EMULATOR_HOST'],
    ['storage', 'FIREBASE_STORAGE_EMULATOR_HOST'],
  ] as const)('returns unhealthy when the local %s service is down', async (service, envKey) => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 2 });
    setInngestUrl(undefined);
    process.env[envKey] = '127.0.0.1:9999';
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.services[service]).toMatchObject({ status: 'down', error: 'HTTP 503' });
  });

  // ---- 2. Degraded when Neo4j is down ----

  it('returns degraded when Neo4j is down but Firestore is up', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: false, latencyMs: 10, error: 'Connection refused' });
    setInngestUrl(undefined);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.firestore.status).toBe('up');
    expect(body.services.neo4j.status).toBe('down');
    expect(body.services.neo4j.error).toBe('Connection refused');
  });

  // ---- 3. Degraded when Inngest is down ----

  it('returns degraded when Inngest is down but Firestore is up', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 3 });
    setInngestUrl('http://localhost:8288');
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.firestore.status).toBe('up');
    expect(body.services.inngest.status).toBe('down');
    expect(body.services.inngest.error).toBe('HTTP 502');
  });

  // ---- 4. Unhealthy (503) when Firestore is down ----

  it('returns unhealthy (503) when Firestore is down', async () => {
    mockGetDocs.mockRejectedValue(new Error('PERMISSION_DENIED'));
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 2 });
    setInngestUrl(undefined);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.services.firestore.status).toBe('down');
    expect(body.services.firestore.error).toBe('PERMISSION_DENIED');
  });

  // ---- 5. Unhealthy (503) when Firestore throws ----

  it('returns unhealthy (503) when Firestore throws a generic error', async () => {
    mockGetDocs.mockRejectedValue(new Error('Network timeout'));
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 4 });
    setInngestUrl(undefined);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.services.firestore.status).toBe('down');
    expect(body.services.firestore.error).toBe('Network timeout');
  });

  // ---- 6. Neo4j checkHealth throwing an exception ----

  it('handles Neo4j checkHealth throwing an exception', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockRejectedValue(new Error('Driver not initialised'));
    setInngestUrl(undefined);

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.neo4j.status).toBe('down');
    expect(body.services.neo4j.error).toBe('Driver not initialised');
  });

  // ---- 7. Inngest fetch timeout ----

  it('handles Inngest fetch timeout', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 1 });
    setInngestUrl('http://localhost:8288');
    mockFetch(
      jest.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')) as unknown as typeof fetch
    );

    const response = await GET();
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.services.inngest.status).toBe('down');
    expect(body.services.inngest.error).toBe('The operation was aborted due to timeout');
  });

  // ---- 8. Includes timestamp and version ----

  it('includes timestamp and version in response', async () => {
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 2 });
    setInngestUrl(undefined);

    const before = new Date().toISOString();
    const response = await GET();
    const body = await parseBody(response);
    const after = new Date().toISOString();

    expect(body.timestamp).toBeDefined();
    expect(body.timestamp >= before).toBe(true);
    expect(body.timestamp <= after).toBe(true);
    expect(body.version).toBe(packageJson.version);
  });
});
