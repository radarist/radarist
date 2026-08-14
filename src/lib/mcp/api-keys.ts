/**
 * @file mcp/api-keys.ts
 * @description API Key management for MCP server authentication
 *
 * Provides secure API key creation, validation, and management.
 * Keys are hashed before storage (SHA-256) and linked to Firebase Auth users.
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import { db } from '@/lib/firebase-admin';
import { createHash, randomBytes } from 'crypto';
import type {
  ApiKey,
  ApiKeyPublic,
  ApiKeyPermission,
  CreateApiKeyInput,
  CreateApiKeyResult,
} from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/api-keys');

// ============================================================================
// Constants
// ============================================================================

const COLLECTION = 'apiKeys';
const KEY_PREFIX = 'tp_live_';
const DEFAULT_PERMISSIONS: ApiKeyPermission[] = ['read', 'write', 'signals'];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Hash an API key using SHA-256
 * Keys are never stored in plaintext
 */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a secure random API key string
 * Format: tp_live_<32 base64url chars>
 */
function generateKeyString(): string {
  const random = randomBytes(24).toString('base64url');
  return `${KEY_PREFIX}${random}`;
}

/**
 * Mask a key for display (show prefix + first few chars)
 */
function maskKey(key: string): string {
  if (key.startsWith(KEY_PREFIX)) {
    return `${key.slice(0, 16)}${'*'.repeat(16)}`;
  }
  return `${KEY_PREFIX}${'*'.repeat(24)}`;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a new API key for a user
 *
 * @param input - Key creation parameters
 * @returns The unhashed key (shown only once) and public key info
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const {
    userId,
    name,
    permissions = DEFAULT_PERMISSIONS,
    expiresInDays,
  } = input;

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!name || name.trim().length === 0) {
    throw new Error('name is required');
  }

  const key = generateKeyString();
  const hashed = hashKey(key);
  const now = Date.now();

  const data: Omit<ApiKey, 'id'> = {
    hashedKey: hashed,
    userId,
    name: name.trim(),
    permissions,
    createdAt: now,
    expiresAt: expiresInDays
      ? now + expiresInDays * 24 * 60 * 60 * 1000
      : null,
    revokedAt: null,
  };

  try {
    const docRef = await db.collection(COLLECTION).add(data);

    log.info('Created API key', { userId, keyId: docRef.id });

    return {
      key, // Only time user sees the full key
      apiKey: {
        id: docRef.id,
        name: data.name,
        permissions: data.permissions,
        createdAt: data.createdAt,
        expiresAt: data.expiresAt,
        prefix: maskKey(key),
      },
    };
  } catch (error) {
    log.error('Failed to create API key', error instanceof Error ? error : undefined);
    throw new Error('Failed to create API key');
  }
}

/**
 * Validate an API key and return its data if valid
 *
 * @param key - The raw API key string
 * @returns The API key data if valid, null otherwise
 */
export async function validateApiKey(key: string): Promise<ApiKey | null> {
  // Quick validation - check prefix
  if (!key || typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    return null;
  }

  const hashed = hashKey(key);

  try {
    const snapshot = await db
      .collection(COLLECTION)
      .where('hashedKey', '==', hashed)
      .limit(1)
      .get();

    if (snapshot.empty) {
      log.debug('API key not found');
      return null;
    }

    const doc = snapshot.docs[0];
    const data = doc.data() as Omit<ApiKey, 'id'>;

    // Check if revoked
    if (data.revokedAt) {
      log.debug('API key has been revoked');
      return null;
    }

    // Check expiry
    if (data.expiresAt && data.expiresAt < Date.now()) {
      log.debug('API key has expired');
      return null;
    }

    // Update last used timestamp (fire and forget)
    doc.ref.update({ lastUsedAt: Date.now() }).catch((err) => {
      log.warn('Failed to update lastUsedAt', { error: String(err) });
    });

    return { ...data, id: doc.id };
  } catch (error) {
    log.error('API key validation error', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * List all API keys for a user (without hashed keys)
 *
 * @param userId - The Firebase Auth user ID
 * @returns Array of public API key info
 */
export async function listApiKeys(userId: string): Promise<ApiKeyPublic[]> {
  if (!userId) {
    throw new Error('userId is required');
  }

  try {
    // Simple query by userId only - avoids needing composite index
    // Filter and sort in JavaScript
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', '==', userId)
      .get();

    const keys = snapshot.docs
      .map((doc) => {
        const data = doc.data() as ApiKey;
        return {
          id: doc.id,
          name: data.name,
          permissions: data.permissions,
          createdAt: data.createdAt,
          lastUsedAt: data.lastUsedAt,
          expiresAt: data.expiresAt,
          revokedAt: data.revokedAt,
          prefix: `${KEY_PREFIX}${'*'.repeat(16)}`, // Masked
        };
      })
      // Filter out revoked keys
      .filter((key) => !key.revokedAt)
      // Sort by createdAt descending
      .sort((a, b) => b.createdAt - a.createdAt)
      // Remove revokedAt from output
      .map(({ revokedAt: _revokedAt, ...rest }) => rest);

    return keys;
  } catch (error) {
    log.error('Failed to list API keys', error instanceof Error ? error : undefined);
    throw new Error('Failed to list API keys');
  }
}

/**
 * Revoke an API key (soft delete)
 *
 * @param keyId - The Firestore document ID of the key
 * @param userId - The requesting user's ID (for security check)
 * @returns true if revoked, false if not found or not owned
 */
export async function revokeApiKey(
  keyId: string,
  userId: string
): Promise<boolean> {
  if (!keyId || !userId) {
    return false;
  }

  try {
    const doc = await db.collection(COLLECTION).doc(keyId).get();

    if (!doc.exists) {
      log.debug('API key not found for revocation');
      return false;
    }

    const data = doc.data() as ApiKey;

    // Security check - only owner can revoke
    if (data.userId !== userId) {
      log.warn('User attempted to revoke key they do not own');
      return false;
    }

    // Already revoked
    if (data.revokedAt) {
      return false;
    }

    await doc.ref.update({ revokedAt: Date.now() });

    log.info('Revoked API key', { keyId, userId });
    return true;
  } catch (error) {
    log.error('Failed to revoke API key', error instanceof Error ? error : undefined);
    return false;
  }
}

/**
 * Delete an API key permanently (hard delete)
 * Use with caution - prefer revokeApiKey for audit trail
 *
 * @param keyId - The Firestore document ID of the key
 * @param userId - The requesting user's ID (for security check)
 * @returns true if deleted, false if not found or not owned
 */
export async function deleteApiKey(
  keyId: string,
  userId: string
): Promise<boolean> {
  if (!keyId || !userId) {
    return false;
  }

  try {
    const doc = await db.collection(COLLECTION).doc(keyId).get();

    if (!doc.exists) {
      return false;
    }

    const data = doc.data() as ApiKey;

    // Security check - only owner can delete
    if (data.userId !== userId) {
      log.warn('User attempted to delete key they do not own');
      return false;
    }

    await doc.ref.delete();

    log.info('Deleted API key', { keyId, userId });
    return true;
  } catch (error) {
    log.error('Failed to delete API key', error instanceof Error ? error : undefined);
    return false;
  }
}

/**
 * Update API key permissions
 *
 * @param keyId - The Firestore document ID of the key
 * @param userId - The requesting user's ID (for security check)
 * @param permissions - New permissions array
 * @returns true if updated, false if not found or not owned
 */
export async function updateApiKeyPermissions(
  keyId: string,
  userId: string,
  permissions: ApiKeyPermission[]
): Promise<boolean> {
  if (!keyId || !userId || !permissions || permissions.length === 0) {
    return false;
  }

  try {
    const doc = await db.collection(COLLECTION).doc(keyId).get();

    if (!doc.exists) {
      return false;
    }

    const data = doc.data() as ApiKey;

    // Security check - only owner can update
    if (data.userId !== userId) {
      log.warn('User attempted to update key they do not own');
      return false;
    }

    // Can't update revoked keys
    if (data.revokedAt) {
      return false;
    }

    await doc.ref.update({ permissions });

    log.info('Updated permissions for API key', { keyId });
    return true;
  } catch (error) {
    log.error('Failed to update API key permissions', error instanceof Error ? error : undefined);
    return false;
  }
}

// ============================================================================
// Permission Checking
// ============================================================================

/**
 * Check if an API key has a specific permission
 *
 * @param apiKey - The API key object
 * @param required - The required permission
 * @returns true if the key has the permission
 */
export function hasPermission(
  apiKey: ApiKey,
  required: ApiKeyPermission
): boolean {
  // Admin has all permissions
  if (apiKey.permissions.includes('admin')) {
    return true;
  }

  return apiKey.permissions.includes(required);
}

/**
 * Check if an API key has all required permissions
 *
 * @param apiKey - The API key object
 * @param required - Array of required permissions
 * @returns true if the key has all permissions
 */
export function hasAllPermissions(
  apiKey: ApiKey,
  required: ApiKeyPermission[]
): boolean {
  return required.every((perm) => hasPermission(apiKey, perm));
}

/**
 * Check if an API key has any of the specified permissions
 *
 * @param apiKey - The API key object
 * @param permissions - Array of permissions to check
 * @returns true if the key has at least one of the permissions
 */
export function hasAnyPermission(
  apiKey: ApiKey,
  permissions: ApiKeyPermission[]
): boolean {
  return permissions.some((perm) => hasPermission(apiKey, perm));
}
