/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock firebase-admin - this route uses its own verifyAuth() with adminAuth.verifyIdToken()
jest.mock('@/lib/firebase-admin', () => ({
  adminAuth: {
    verifyIdToken: jest.fn().mockResolvedValue({ uid: 'test-user-123' }),
  },
}));

// Mock MCP API key service
jest.mock('@/lib/mcp/api-keys', () => ({
  createApiKey: jest.fn().mockResolvedValue({
    key: 'tp_live_abc123',
    apiKey: { id: 'key-1', name: 'Test Key', prefix: 'tp_live_********' },
  }),
  listApiKeys: jest.fn().mockResolvedValue([]),
  revokeApiKey: jest.fn().mockResolvedValue(true),
  deleteApiKey: jest.fn().mockResolvedValue(true),
  updateApiKeyPermissions: jest.fn().mockResolvedValue(true),
}));

const { adminAuth } = jest.requireMock('@/lib/firebase-admin');
const {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  updateApiKeyPermissions,
} = jest.requireMock('@/lib/mcp/api-keys');

import { GET, POST, DELETE, PATCH } from '../route';

function createRequest(
  method: string,
  path?: string,
  body?: unknown
): NextRequest {
  const url = `http://localhost:3000/api/mcp/keys${path || ''}`;
  const headers: Record<string, string> = { Authorization: 'Bearer valid-token' };
  if (body) headers['Content-Type'] = 'application/json';
  return new NextRequest(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function createUnauthenticatedRequest(
  method: string,
  path?: string,
  body?: unknown
): NextRequest {
  const url = `http://localhost:3000/api/mcp/keys${path || ''}`;
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  return new NextRequest(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ============================================================================
// GET /api/mcp/keys
// ============================================================================

describe('GET /api/mcp/keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth header', async () => {
    const res = await GET(createUnauthenticatedRequest('GET'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.error).toBe('No authorization header provided');
  });

  it('returns 401 when token verification fails', async () => {
    adminAuth.verifyIdToken.mockRejectedValueOnce(
      new Error('Invalid token')
    );

    const res = await GET(createRequest('GET'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Invalid token');
  });

  it('returns empty key list for authenticated user', async () => {
    listApiKeys.mockResolvedValue([]);

    const res = await GET(createRequest('GET'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
    expect(json.count).toBe(0);
    expect(listApiKeys).toHaveBeenCalledWith('test-user-123');
  });

  it('returns populated key list', async () => {
    const mockKeys = [
      { id: 'key-1', name: 'Dev Key', prefix: 'tp_live_****', permissions: ['read'] },
      { id: 'key-2', name: 'CI Key', prefix: 'tp_live_****', permissions: ['read', 'write'] },
    ];
    listApiKeys.mockResolvedValue(mockKeys);

    const res = await GET(createRequest('GET'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    expect(json.count).toBe(2);
  });

  it('returns 500 on server error', async () => {
    listApiKeys.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createRequest('GET'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Firestore unavailable');
  });
});

// ============================================================================
// POST /api/mcp/keys
// ============================================================================

describe('POST /api/mcp/keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth header', async () => {
    const res = await POST(
      createUnauthenticatedRequest('POST', '', { name: 'Test' })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('returns 400 when name missing', async () => {
    const res = await POST(createRequest('POST', '', {}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('name is required');
  });

  it('returns 400 when name is empty string', async () => {
    const res = await POST(createRequest('POST', '', { name: '   ' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('name is required');
  });

  it('returns 400 when name exceeds 100 characters', async () => {
    const longName = 'A'.repeat(101);
    const res = await POST(createRequest('POST', '', { name: longName }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('name must be 100 characters or less');
  });

  it('returns 403 when trying to assign admin permission', async () => {
    const res = await POST(
      createRequest('POST', '', {
        name: 'Admin Key',
        permissions: ['read', 'admin'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('admin permission cannot be self-assigned');
  });

  it('returns 400 when permissions contains invalid value', async () => {
    const res = await POST(
      createRequest('POST', '', {
        name: 'Bad Key',
        permissions: ['read', 'superpower'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Invalid permission: superpower');
  });

  it('returns 400 when permissions is not an array', async () => {
    const res = await POST(
      createRequest('POST', '', {
        name: 'Bad Key',
        permissions: 'read',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('permissions must be an array');
  });

  it('returns 400 when expiresInDays is out of range', async () => {
    const res = await POST(
      createRequest('POST', '', {
        name: 'Expired Key',
        expiresInDays: 500,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('expiresInDays must be between 1 and 365');
  });

  it('creates key with valid params (201 status)', async () => {
    createApiKey.mockResolvedValue({
      key: 'tp_live_xyz789',
      apiKey: {
        id: 'key-new',
        name: 'My Key',
        prefix: 'tp_live_********',
        permissions: ['read', 'write'],
      },
    });

    const res = await POST(
      createRequest('POST', '', {
        name: 'My Key',
        permissions: ['read', 'write'],
        expiresInDays: 90,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.key).toBe('tp_live_xyz789');
    expect(json.data.apiKey.name).toBe('My Key');
    expect(json.message).toContain('Store the key securely');
    expect(createApiKey).toHaveBeenCalledWith({
      userId: 'test-user-123',
      name: 'My Key',
      permissions: ['read', 'write'],
      expiresInDays: 90,
    });
  });

  it('creates key without optional permissions', async () => {
    const res = await POST(
      createRequest('POST', '', { name: 'Minimal Key' })
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-123',
        name: 'Minimal Key',
        permissions: undefined,
      })
    );
  });
});

// ============================================================================
// DELETE /api/mcp/keys
// ============================================================================

describe('DELETE /api/mcp/keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth header', async () => {
    const res = await DELETE(
      createUnauthenticatedRequest('DELETE', '?id=key-1')
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('returns 400 when id missing', async () => {
    const res = await DELETE(createRequest('DELETE'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('id query parameter is required');
  });

  it('revokes key successfully (soft delete)', async () => {
    revokeApiKey.mockResolvedValue(true);

    const res = await DELETE(createRequest('DELETE', '?id=key-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toBe('API key revoked successfully');
    expect(revokeApiKey).toHaveBeenCalledWith('key-1', 'test-user-123');
  });

  it('permanently deletes key when permanent=true', async () => {
    deleteApiKey.mockResolvedValue(true);

    const res = await DELETE(
      createRequest('DELETE', '?id=key-1&permanent=true')
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toBe('API key permanently deleted');
    expect(deleteApiKey).toHaveBeenCalledWith('key-1', 'test-user-123');
  });

  it('returns 404 when key not found or unauthorized', async () => {
    revokeApiKey.mockResolvedValue(false);

    const res = await DELETE(createRequest('DELETE', '?id=nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
  });
});

// ============================================================================
// PATCH /api/mcp/keys
// ============================================================================

describe('PATCH /api/mcp/keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth header', async () => {
    const res = await PATCH(
      createUnauthenticatedRequest('PATCH', '', {
        id: 'key-1',
        permissions: ['read'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('returns 400 when id missing', async () => {
    const res = await PATCH(
      createRequest('PATCH', '', { permissions: ['read'] })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('id is required');
  });

  it('returns 400 when permissions empty', async () => {
    const res = await PATCH(
      createRequest('PATCH', '', { id: 'key-1', permissions: [] })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('permissions array is required');
  });

  it('returns 400 when permissions not provided', async () => {
    const res = await PATCH(createRequest('PATCH', '', { id: 'key-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('permissions array is required');
  });

  it('returns 403 when trying to set admin permission', async () => {
    const res = await PATCH(
      createRequest('PATCH', '', {
        id: 'key-1',
        permissions: ['read', 'admin'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('admin permission cannot be self-assigned');
  });

  it('updates permissions successfully', async () => {
    updateApiKeyPermissions.mockResolvedValue(true);

    const res = await PATCH(
      createRequest('PATCH', '', {
        id: 'key-1',
        permissions: ['read', 'write', 'signals'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toBe('API key permissions updated');
    expect(updateApiKeyPermissions).toHaveBeenCalledWith(
      'key-1',
      'test-user-123',
      ['read', 'write', 'signals']
    );
  });

  it('returns 404 when key not found for update', async () => {
    updateApiKeyPermissions.mockResolvedValue(false);

    const res = await PATCH(
      createRequest('PATCH', '', {
        id: 'nonexistent',
        permissions: ['read'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
  });
});
