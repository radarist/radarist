/**
 * @file route.test.ts
 * @description Security and read-only behavior tests for the orphan diagnostic API.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { GET, POST } from '../route';

jest.mock('@/lib/auth-utils', () => ({
  requireAdmin: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
  }),
}));

const { requireAdmin } = jest.requireMock('@/lib/auth-utils');
const { db } = jest.requireMock('@/lib/firebase-admin');
const { checkHealth, runReadTransaction, runWriteTransaction } = jest.requireMock('@/lib/graph');

const originalNodeEnv = process.env.NODE_ENV;

const firestoreIdsByCollection: Record<string, string[]> = {
  technologies: ['tech-shared'],
  companies: ['company-shared'],
};

const neo4jIdsByLabel: Record<string, string[]> = {
  Technology: ['tech-shared', 'tech-orphan'],
  Company: ['company-shared'],
  Document: ['document-orphan'],
};

function createRequest(method: 'GET' | 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/debug/cleanup-neo4j-orphans', { method });
}

describe('/api/debug/cleanup-neo4j-orphans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });

    requireAdmin.mockResolvedValue({
      authenticated: true,
      uid: 'admin-123',
      email: 'admin@example.com',
    });
    checkHealth.mockResolvedValue({ healthy: true });
    db.collection.mockImplementation((collection: string) => ({
      get: jest.fn().mockResolvedValue({
        docs: (firestoreIdsByCollection[collection] ?? []).map((id) => ({ id })),
      }),
    }));
    runReadTransaction.mockImplementation((query: string) => {
      const label = query.match(/MATCH \(n:(\w+)\)/)?.[1] ?? '';
      return Promise.resolve({
        records: (neo4jIdsByLabel[label] ?? []).map((id) => ({ id })),
      });
    });
  });

  afterAll(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: originalNodeEnv, configurable: true });
  });

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('requires admin authentication before handling %s', async (method, handler) => {
    requireAdmin.mockResolvedValueOnce({ authenticated: false, error: 'Admin access required' });
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });

    const response = await handler(createRequest(method));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Admin access required' });
    expect(checkHealth).not.toHaveBeenCalled();
    expect(runReadTransaction).not.toHaveBeenCalled();
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', GET],
    ['POST', POST],
  ] as const)('rejects %s outside development', async (method, handler) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });

    const response = await handler(createRequest(method));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Debug endpoints are only available in development mode',
    });
    expect(checkHealth).not.toHaveBeenCalled();
    expect(runReadTransaction).not.toHaveBeenCalled();
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('returns a read-only inventory of Neo4j nodes missing from Firestore', async () => {
    const response = await GET(createRequest('GET'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      totalOrphans: 2,
      orphans: {
        Technology: ['tech-orphan'],
        Document: ['document-orphan'],
      },
      usage: 'Read-only diagnostic; automatic deletion is disabled',
    });
    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(db.collection).toHaveBeenCalledTimes(9);
    expect(runReadTransaction).toHaveBeenCalledTimes(9);
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('rejects POST without reading or writing graph data', async () => {
    const response = await POST(createRequest('POST'));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    await expect(response.json()).resolves.toEqual({
      error: 'Orphan cleanup is read-only; use GET for diagnostics',
    });
    expect(checkHealth).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
    expect(runReadTransaction).not.toHaveBeenCalled();
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });
});
