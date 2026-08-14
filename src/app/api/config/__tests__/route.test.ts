/**
 * @jest-environment node
 */

/**
 * @file /api/config tests
 * @description Unit tests for the runtime configuration endpoint.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(),
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

const { getAuthenticatedUser: mockGetAuthenticatedUser } = jest.requireMock<{
  getAuthenticatedUser: jest.Mock;
}>('@/lib/auth-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

function createRequest(): Request {
  return new Request('http://localhost/api/config', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

interface ConfigBody {
  environment: string;
  firebase: {
    useEmulator: boolean;
    projectId: string;
  };
  neo4j: {
    configured: boolean;
  };
  inngest: {
    devServer: boolean;
  };
  impulse: {
    enabled: boolean;
    featureFlags: Record<string, boolean>;
  };
  version: string;
  error?: string;
}

async function parseBody(response: Response): Promise<ConfigBody> {
  return response.json() as Promise<ConfigBody>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    // Default: authenticated
    mockGetAuthenticatedUser.mockResolvedValue({
      authenticated: true,
      uid: 'test-user-123',
      email: 'test@example.com',
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ---- 1. Returns 401 when not authenticated ----

  it('returns 401 when not authenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const response = await GET(createRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('No authorization header provided');
  });

  // ---- 2. Returns config with correct environment value ----

  it('returns config with correct environment value', async () => {
    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.environment).toBe('test'); // NODE_ENV is 'test' in Jest
  });

  // ---- 3. Detects Firebase emulator when FIREBASE_AUTH_EMULATOR_HOST is set ----

  it('detects Firebase emulator when FIREBASE_AUTH_EMULATOR_HOST is set', async () => {
    setEnv('FIREBASE_AUTH_EMULATOR_HOST', 'localhost:9099');

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.firebase.useEmulator).toBe(true);
  });

  // ---- 4. Reports Firebase not using emulator when env var is unset ----

  it('reports Firebase not using emulator when env var is unset', async () => {
    setEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.firebase.useEmulator).toBe(false);
  });

  // ---- 5. Reports Neo4j as configured when NEO4J_URI is set ----

  it('reports Neo4j as configured when NEO4J_URI is set', async () => {
    setEnv('NEO4J_URI', 'bolt://localhost:7687');

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.neo4j.configured).toBe(true);
  });

  // ---- 6. Reports Neo4j as not configured when NEO4J_URI is unset ----

  it('reports Neo4j as not configured when NEO4J_URI is unset', async () => {
    setEnv('NEO4J_URI', undefined);

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.neo4j.configured).toBe(false);
  });

  // ---- 7. Reports Inngest devServer when INNGEST_DEV_SERVER_URL is set ----

  it('reports Inngest devServer when INNGEST_DEV_SERVER_URL is set', async () => {
    setEnv('INNGEST_DEV_SERVER_URL', 'http://localhost:8288');

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.inngest.devServer).toBe(true);
  });

  // ---- 8. Returns empty impulse feature flags (all impulse flags baked in) ----

  it('returns empty impulse feature flags (all impulse flags baked in)', async () => {
    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);

    // The whole feature-flag system was deleted in D4.1; impulse.featureFlags
    // is now a stable empty object kept for response-shape compatibility.
    expect(body.impulse.featureFlags).toEqual({});
  });

  // ---- 9. Sets impulse.enabled to false when no impulse flags exist ----

  it('sets impulse.enabled to false when no impulse flags exist', async () => {
    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.impulse.enabled).toBe(false);
  });

  // ---- 11. Returns Firebase projectId from env or 'unknown' ----

  it('returns Firebase projectId from env or defaults to unknown', async () => {
    setEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', undefined);

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.firebase.projectId).toBe('unknown');
  });

  // ---- 12. Returns version from APP_VERSION ----

  it('returns version from APP_VERSION env var', async () => {
    setEnv('APP_VERSION', '2.1.0');

    const response = await GET(createRequest() as never);
    const body = await parseBody(response);

    expect(response.status).toBe(200);
    expect(body.version).toBe('2.1.0');
  });
});
