/**
 * @jest-environment node
 */

const mockGetVerificationForEntity = jest.fn();
const mockResolveGraphRuntime = jest.fn();

jest.mock('@/lib/graph/verification', () => ({
  __esModule: true,
  getVerificationForEntity: (...args: unknown[]) => mockGetVerificationForEntity(...args),
}));

jest.mock('@/lib/graph/runtime-mode', () => ({
  __esModule: true,
  resolveGraphRuntime: (...args: unknown[]) => mockResolveGraphRuntime(...args),
}));

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'test@test.com' }),
}));

import { NextRequest } from 'next/server';
import { GraphUnavailableError, graphDegradedBody } from '@/lib/graph/errors';
const { GET } = require('../route');

const makeParams = (entityId: string) => ({
  params: Promise.resolve({ entityId }),
});

describe('GET /api/verification/[entityId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGraphRuntime.mockReturnValue({ mode: 'neo4j', uri: 'bolt://neo4j.test:7687' });
  });

  it('should return verification result for entity', async () => {
    mockGetVerificationForEntity.mockResolvedValue({
      id: 'vr-1',
      status: 'verified',
      score: 85,
      sourcesChecked: 3,
      sourcesConfirming: 2,
      sourcesContradicting: 0,
    });

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.verification.status).toBe('verified');
    expect(mockGetVerificationForEntity).toHaveBeenCalledWith('tech-1');
  });

  it('should return null verification if entity has no result', async () => {
    mockGetVerificationForEntity.mockResolvedValue(null);

    const request = new NextRequest('http://localhost/api/verification/tech-2');
    const response = await GET(request, makeParams('tech-2'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.verification).toBeNull();
  });

  it('should return 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = require('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No token',
    });

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));

    expect(response.status).toBe(401);
    expect(mockResolveGraphRuntime).not.toHaveBeenCalled();
    expect(mockGetVerificationForEntity).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', 'graph-disabled'],
    ['unconfigured', 'graph-unconfigured'],
  ] as const)('returns an honest no-op when the graph runtime is %s', async (mode, reason) => {
    mockResolveGraphRuntime.mockReturnValue({ mode });

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ verification: null, available: false, reason });
    expect(mockGetVerificationForEntity).not.toHaveBeenCalled();
  });

  it('keeps invalid runtime configuration fail-loud', async () => {
    mockResolveGraphRuntime.mockImplementation(() => {
      throw new Error('Invalid graph runtime configuration');
    });

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));

    expect(response.status).toBe(500);
    expect(mockGetVerificationForEntity).not.toHaveBeenCalled();
  });

  it('returns 500 for an unexpected graph verification failure', async () => {
    mockGetVerificationForEntity.mockRejectedValue(new Error('Invalid verification query: MATCH (secret)'));

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data).toEqual({ error: 'Internal error' });
  });

  it('returns the canonical sanitized 503 contract for a typed configured-graph outage', async () => {
    const outage = new GraphUnavailableError(
      'getVerificationForEntity',
      'neo4j',
      'Failed to connect: connect ECONNREFUSED [host]'
    );
    mockGetVerificationForEntity.mockRejectedValue(outage);

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data).toEqual(graphDegradedBody(outage));
    expect(data).toEqual({
      degraded: true,
      error: 'Graph backend unavailable',
      message: 'Failed to connect: connect ECONNREFUSED [host]',
      backend: 'neo4j',
    });
  });

  it('keeps an untyped thrown value behind the generic 500 boundary', async () => {
    mockGetVerificationForEntity.mockRejectedValue('raw driver detail: secret-token');

    const request = new NextRequest('http://localhost/api/verification/tech-1');
    const response = await GET(request, makeParams('tech-1'));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data).toEqual({ error: 'Internal error' });
  });
});
