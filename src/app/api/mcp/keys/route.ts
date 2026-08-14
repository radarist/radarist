/**
 * @file app/api/mcp/keys/route.ts
 * @description API routes for managing MCP API keys
 *
 * Provides endpoints for users to create, list, and revoke their MCP API keys.
 * All endpoints require Firebase authentication via ID token.
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { adminAuth } from '@/lib/firebase-admin';

const log = createLogger('api/mcp/keys');
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  updateApiKeyPermissions,
} from '@/lib/mcp/api-keys';
import type { ApiKeyPermission } from '@/lib/mcp/types';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Auth verification result
 */
interface AuthResult {
  userId: string | null;
  error?: string;
}

/**
 * Verify Firebase ID token and extract user ID
 */
async function verifyAuth(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader) {
    return { userId: null, error: 'No authorization header provided' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { userId: null, error: 'Invalid authorization format. Use: Bearer <token>' };
  }

  const idToken = authHeader.slice(7);

  if (!idToken) {
    return { userId: null, error: 'Empty token provided' };
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    return { userId: decodedToken.uid };
  } catch (error) {
    log.error('Token verification failed', error instanceof Error ? error : undefined);
    const message = error instanceof Error ? error.message : 'Token verification failed';
    return { userId: null, error: message };
  }
}

/**
 * Create error response
 */
function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { success: false, error: message },
    { status }
  );
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * GET /api/mcp/keys
 *
 * List all API keys for the authenticated user
 *
 * Headers:
 * - Authorization: Bearer <firebase-id-token>
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": [
 *     {
 *       "id": "key-123",
 *       "name": "My API Key",
 *       "prefix": "tp_live_********",
 *       "permissions": ["read", "write"],
 *       "createdAt": 1234567890,
 *       "lastUsedAt": 1234567890,
 *       "expiresAt": null
 *     }
 *   ]
 * }
 * ```
 */
export async function GET(request: NextRequest) {
  // Verify authentication
  const authResult = await verifyAuth(request);
  if (!authResult.userId) {
    return errorResponse(authResult.error || 'Authentication required', 401);
  }
  const userId = authResult.userId;

  try {
    const keys = await listApiKeys(userId);

    return NextResponse.json({
      success: true,
      data: keys,
      count: keys.length,
    });
  } catch (error) {
    log.error('Failed to list API keys', error instanceof Error ? error : undefined);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list API keys',
      500
    );
  }
}

/**
 * POST /api/mcp/keys
 *
 * Create a new API key for the authenticated user
 *
 * Headers:
 * - Authorization: Bearer <firebase-id-token>
 *
 * Request body:
 * ```json
 * {
 *   "name": "My API Key",
 *   "permissions": ["read", "write", "signals"],
 *   "expiresInDays": 90
 * }
 * ```
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "key": "tp_live_abc123...",
 *     "apiKey": {
 *       "id": "key-123",
 *       "name": "My API Key",
 *       "permissions": ["read", "write", "signals"],
 *       "createdAt": 1234567890,
 *       "expiresAt": null,
 *       "prefix": "tp_live_********"
 *     }
 *   },
 *   "message": "API key created. Store the key securely - it cannot be retrieved again."
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  // Verify authentication
  const authResult = await verifyAuth(request);
  if (!authResult.userId) {
    return errorResponse(authResult.error || 'Authentication required', 401);
  }
  const userId = authResult.userId;

  try {
    const body = await request.json();
    const { name, permissions, expiresInDays } = body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('name is required', 400);
    }

    if (name.length > 100) {
      return errorResponse('name must be 100 characters or less', 400);
    }

    // Validate permissions if provided
    const validPermissions: ApiKeyPermission[] = [
      'read',
      'write',
      'delete',
      'signals',
      'admin',
    ];

    if (permissions) {
      if (!Array.isArray(permissions)) {
        return errorResponse('permissions must be an array', 400);
      }

      for (const perm of permissions) {
        if (!validPermissions.includes(perm)) {
          return errorResponse(
            `Invalid permission: ${perm}. Valid options: ${validPermissions.join(', ')}`,
            400
          );
        }
      }

      // Don't allow admin permission for regular users (future: check user role)
      if (permissions.includes('admin')) {
        return errorResponse('admin permission cannot be self-assigned', 403);
      }
    }

    // Validate expiresInDays if provided
    if (expiresInDays !== undefined) {
      if (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 365) {
        return errorResponse('expiresInDays must be between 1 and 365', 400);
      }
    }

    const result = await createApiKey({
      userId,
      name: name.trim(),
      permissions,
      expiresInDays,
    });

    return NextResponse.json(
      {
        success: true,
        data: result,
        message:
          'API key created. Store the key securely - it cannot be retrieved again.',
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('Failed to create API key', error instanceof Error ? error : undefined);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to create API key',
      500
    );
  }
}

/**
 * DELETE /api/mcp/keys
 *
 * Revoke or delete an API key
 *
 * Headers:
 * - Authorization: Bearer <firebase-id-token>
 *
 * Query parameters:
 * - id: The API key ID to revoke/delete
 * - permanent: If "true", permanently deletes instead of revoking (optional)
 *
 * Example: DELETE /api/mcp/keys?id=key-123
 * Example: DELETE /api/mcp/keys?id=key-123&permanent=true
 */
export async function DELETE(request: NextRequest) {
  // Verify authentication
  const authResult = await verifyAuth(request);
  if (!authResult.userId) {
    return errorResponse(authResult.error || 'Authentication required', 401);
  }
  const userId = authResult.userId;

  try {
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('id');
    const permanent = searchParams.get('permanent') === 'true';

    if (!keyId) {
      return errorResponse('id query parameter is required', 400);
    }

    let success: boolean;

    if (permanent) {
      success = await deleteApiKey(keyId, userId);
    } else {
      success = await revokeApiKey(keyId, userId);
    }

    if (!success) {
      return errorResponse(
        'API key not found or you do not have permission to delete it',
        404
      );
    }

    return NextResponse.json({
      success: true,
      message: permanent
        ? 'API key permanently deleted'
        : 'API key revoked successfully',
    });
  } catch (error) {
    log.error('Failed to delete API key', error instanceof Error ? error : undefined);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to delete API key',
      500
    );
  }
}

/**
 * PATCH /api/mcp/keys
 *
 * Update an API key's permissions
 *
 * Headers:
 * - Authorization: Bearer <firebase-id-token>
 *
 * Request body:
 * ```json
 * {
 *   "id": "key-123",
 *   "permissions": ["read", "write"]
 * }
 * ```
 */
export async function PATCH(request: NextRequest) {
  // Verify authentication
  const authResult = await verifyAuth(request);
  if (!authResult.userId) {
    return errorResponse(authResult.error || 'Authentication required', 401);
  }
  const userId = authResult.userId;

  try {
    const body = await request.json();
    const { id, permissions } = body;

    if (!id) {
      return errorResponse('id is required', 400);
    }

    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return errorResponse('permissions array is required', 400);
    }

    // Validate permissions
    const validPermissions: ApiKeyPermission[] = [
      'read',
      'write',
      'delete',
      'signals',
      'admin',
    ];

    for (const perm of permissions) {
      if (!validPermissions.includes(perm)) {
        return errorResponse(
          `Invalid permission: ${perm}. Valid options: ${validPermissions.join(', ')}`,
          400
        );
      }
    }

    // Don't allow admin permission
    if (permissions.includes('admin')) {
      return errorResponse('admin permission cannot be self-assigned', 403);
    }

    const success = await updateApiKeyPermissions(id, userId, permissions);

    if (!success) {
      return errorResponse(
        'API key not found or you do not have permission to update it',
        404
      );
    }

    return NextResponse.json({
      success: true,
      message: 'API key permissions updated',
    });
  } catch (error) {
    log.error('Failed to update API key', error instanceof Error ? error : undefined);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update API key',
      500
    );
  }
}
