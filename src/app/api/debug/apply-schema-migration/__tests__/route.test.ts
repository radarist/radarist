/**
 * @file route.test.ts
 * @description Security and dispatch tests for the schema-migration debug API.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { POST } from '../route';

jest.mock('@/lib/auth-utils', () => ({
  requireAdmin: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'admin-123',
    email: 'admin@example.com',
  }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
  }),
}));

const automaticResult = {
  name: '2026-07-05-confidence-two-field-backfill',
  description: 'Automatic migration',
  alreadyApplied: false,
  passes: [],
  durationMs: 1,
  appliedAt: 123,
};

const mockApplyMigrationByName = jest.fn().mockResolvedValue(automaticResult);
const mockApplyPendingMigrations = jest.fn().mockResolvedValue([automaticResult]);

jest.mock('@/lib/graph/schema-migrations', () => ({
  MIGRATIONS: [
    {
      name: '2026-07-05-confidence-two-field-backfill',
      description: 'Automatic migration',
    },
  ],
  MANUAL_MIGRATIONS: [
    {
      name: '2026-07-12-user-preference-identity',
      description: 'Manual operator migration',
    },
  ],
  applyMigrationByName: (...args: unknown[]) => mockApplyMigrationByName(...args),
  applyPendingMigrations: () => mockApplyPendingMigrations(),
  listAppliedMigrations: jest.fn().mockResolvedValue([]),
}));

const { requireAdmin } = jest.requireMock('@/lib/auth-utils');
const originalNodeEnv = process.env.NODE_ENV;

function createPostRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/debug/apply-schema-migration${query}`, {
    method: 'POST',
  });
}

describe('POST /api/debug/apply-schema-migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: originalNodeEnv, configurable: true });
  });

  it('requires admin authentication before evaluating the debug route', async () => {
    requireAdmin.mockResolvedValueOnce({ authenticated: false, error: 'Admin access required' });
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });

    const response = await POST(createPostRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Admin access required' });
    expect(mockApplyMigrationByName).not.toHaveBeenCalled();
    expect(mockApplyPendingMigrations).not.toHaveBeenCalled();
  });

  it('rejects POST outside development without applying migrations', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });

    const response = await POST(createPostRequest('?name=2026-07-05-confidence-two-field-backfill'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Debug endpoints are only available in development mode',
    });
    expect(mockApplyMigrationByName).not.toHaveBeenCalled();
    expect(mockApplyPendingMigrations).not.toHaveBeenCalled();
  });

  it('rejects manual migrations in development before invoking the runner', async () => {
    const response = await POST(createPostRequest('?name=2026-07-12-user-preference-identity&force=true'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Manual migrations must be run through the operator CLI',
    });
    expect(mockApplyMigrationByName).not.toHaveBeenCalled();
    expect(mockApplyPendingMigrations).not.toHaveBeenCalled();
  });

  it('applies a named automatic migration and forwards force in development', async () => {
    const response = await POST(
      createPostRequest('?name=2026-07-05-confidence-two-field-backfill&force=true')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(automaticResult);
    expect(mockApplyMigrationByName).toHaveBeenCalledWith(
      '2026-07-05-confidence-two-field-backfill',
      { force: true }
    );
    expect(mockApplyPendingMigrations).not.toHaveBeenCalled();
  });

  it('applies pending automatic migrations in development', async () => {
    const response = await POST(createPostRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [automaticResult] });
    expect(mockApplyPendingMigrations).toHaveBeenCalledTimes(1);
    expect(mockApplyMigrationByName).not.toHaveBeenCalled();
  });
});
