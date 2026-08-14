/**
 * Unit Tests for MCP API Keys
 *
 * Tests API key management including creation, validation, and permission checking.
 *
 * @jest-environment node
 */

// Mock firebase-admin before imports
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    add: jest.fn(),
    get: jest.fn(),
  },
}));

// Mock crypto for deterministic testing
jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mockedhash123456'),
  })),
  randomBytes: jest.fn(() => ({
    toString: jest.fn().mockReturnValue('mockedrandomstring'),
  })),
}));

import { db } from '@/lib/firebase-admin';
import {
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  hasPermission,
  hasAllPermissions,
  hasAnyPermission,
} from '../api-keys';
import type { ApiKey } from '../types';

describe('MCP API Keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createApiKey', () => {
    it('should create an API key with default permissions', async () => {
      const mockDocRef = { id: 'key-123' };
      (db.collection as jest.Mock).mockReturnValue({
        add: jest.fn().mockResolvedValue(mockDocRef),
      });

      const result = await createApiKey({
        userId: 'user-456',
        name: 'My API Key',
      });

      expect(result.key).toMatch(/^tp_live_/);
      expect(result.apiKey.id).toBe('key-123');
      expect(result.apiKey.name).toBe('My API Key');
      expect(result.apiKey.permissions).toEqual(['read', 'write', 'signals']);
    });

    it('should create an API key with custom permissions', async () => {
      const mockDocRef = { id: 'key-789' };
      (db.collection as jest.Mock).mockReturnValue({
        add: jest.fn().mockResolvedValue(mockDocRef),
      });

      const result = await createApiKey({
        userId: 'user-456',
        name: 'Admin Key',
        permissions: ['admin'],
      });

      expect(result.apiKey.permissions).toEqual(['admin']);
    });

    it('should throw error if userId is missing', async () => {
      await expect(createApiKey({ userId: '', name: 'Test Key' })).rejects.toThrow('userId is required');
    });

    it('should throw error if name is missing', async () => {
      await expect(createApiKey({ userId: 'user-123', name: '' })).rejects.toThrow('name is required');
    });

    it('should set expiration date when expiresInDays is provided', async () => {
      const mockDocRef = { id: 'key-exp' };
      let capturedData: Record<string, unknown> | null = null;

      (db.collection as jest.Mock).mockReturnValue({
        add: jest.fn().mockImplementation((data) => {
          capturedData = data;
          return Promise.resolve(mockDocRef);
        }),
      });

      await createApiKey({
        userId: 'user-456',
        name: 'Expiring Key',
        expiresInDays: 30,
      });

      expect(capturedData).not.toBeNull();
      expect(capturedData!.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('validateApiKey', () => {
    it('should return null for invalid key format', async () => {
      const result = await validateApiKey('invalid-key');
      expect(result).toBeNull();
    });

    it('should return null for empty key', async () => {
      const result = await validateApiKey('');
      expect(result).toBeNull();
    });

    it('should return null for key without correct prefix', async () => {
      const result = await validateApiKey('wrong_prefix_key123');
      expect(result).toBeNull();
    });

    it('should return null for non-existent key', async () => {
      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await validateApiKey('tp_live_validkeyformat123');
      expect(result).toBeNull();
    });

    it('should return null for revoked key', async () => {
      const mockDoc = {
        id: 'key-123',
        data: () => ({
          hashedKey: 'mockedhash123456',
          userId: 'user-456',
          name: 'Test Key',
          permissions: ['read'],
          createdAt: Date.now(),
          revokedAt: Date.now() - 1000, // Revoked
          expiresAt: null,
        }),
        ref: { update: jest.fn() },
      };

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: false,
          docs: [mockDoc],
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await validateApiKey('tp_live_validkeyformat123');
      expect(result).toBeNull();
    });

    it('should return null for expired key', async () => {
      const mockDoc = {
        id: 'key-123',
        data: () => ({
          hashedKey: 'mockedhash123456',
          userId: 'user-456',
          name: 'Test Key',
          permissions: ['read'],
          createdAt: Date.now() - 100000,
          revokedAt: null,
          expiresAt: Date.now() - 1000, // Expired
        }),
        ref: { update: jest.fn() },
      };

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: false,
          docs: [mockDoc],
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await validateApiKey('tp_live_validkeyformat123');
      expect(result).toBeNull();
    });

    it('should return API key data for valid key', async () => {
      const keyData = {
        hashedKey: 'mockedhash123456',
        userId: 'user-456',
        name: 'Valid Key',
        permissions: ['read', 'write'],
        createdAt: Date.now(),
        revokedAt: null,
        expiresAt: null,
      };

      const mockDoc = {
        id: 'key-123',
        data: () => keyData,
        ref: { update: jest.fn().mockResolvedValue(undefined) },
      };

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: false,
          docs: [mockDoc],
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await validateApiKey('tp_live_validkeyformat123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('key-123');
      expect(result?.userId).toBe('user-456');
      expect(result?.permissions).toEqual(['read', 'write']);
    });
  });

  describe('hasPermission', () => {
    const baseKey: ApiKey = {
      id: 'key-123',
      hashedKey: 'hash',
      userId: 'user-456',
      name: 'Test Key',
      permissions: ['read', 'write'],
      createdAt: Date.now(),
      revokedAt: null,
      expiresAt: null,
    };

    it('should return true for included permissions', () => {
      expect(hasPermission(baseKey, 'read')).toBe(true);
      expect(hasPermission(baseKey, 'write')).toBe(true);
    });

    it('should return false for excluded permissions', () => {
      expect(hasPermission(baseKey, 'delete')).toBe(false);
      expect(hasPermission(baseKey, 'admin')).toBe(false);
    });

    it('should return true for any permission if admin', () => {
      const adminKey: ApiKey = { ...baseKey, permissions: ['admin'] };
      expect(hasPermission(adminKey, 'read')).toBe(true);
      expect(hasPermission(adminKey, 'write')).toBe(true);
      expect(hasPermission(adminKey, 'delete')).toBe(true);
      expect(hasPermission(adminKey, 'signals')).toBe(true);
    });
  });

  describe('hasAllPermissions', () => {
    const baseKey: ApiKey = {
      id: 'key-123',
      hashedKey: 'hash',
      userId: 'user-456',
      name: 'Test Key',
      permissions: ['read', 'write', 'signals'],
      createdAt: Date.now(),
      revokedAt: null,
      expiresAt: null,
    };

    it('should return true when all permissions are present', () => {
      expect(hasAllPermissions(baseKey, ['read', 'write'])).toBe(true);
      expect(hasAllPermissions(baseKey, ['read'])).toBe(true);
    });

    it('should return false when any permission is missing', () => {
      expect(hasAllPermissions(baseKey, ['read', 'delete'])).toBe(false);
      expect(hasAllPermissions(baseKey, ['admin'])).toBe(false);
    });

    it('should return true for admin key with any permissions', () => {
      const adminKey: ApiKey = { ...baseKey, permissions: ['admin'] };
      expect(hasAllPermissions(adminKey, ['read', 'write', 'delete', 'signals'])).toBe(true);
    });
  });

  describe('hasAnyPermission', () => {
    const baseKey: ApiKey = {
      id: 'key-123',
      hashedKey: 'hash',
      userId: 'user-456',
      name: 'Test Key',
      permissions: ['read'],
      createdAt: Date.now(),
      revokedAt: null,
      expiresAt: null,
    };

    it('should return true when any permission matches', () => {
      expect(hasAnyPermission(baseKey, ['read', 'write'])).toBe(true);
      expect(hasAnyPermission(baseKey, ['delete', 'read'])).toBe(true);
    });

    it('should return false when no permissions match', () => {
      expect(hasAnyPermission(baseKey, ['write', 'delete'])).toBe(false);
    });

    it('should return true for admin key', () => {
      const adminKey: ApiKey = { ...baseKey, permissions: ['admin'] };
      expect(hasAnyPermission(adminKey, ['delete'])).toBe(true);
    });
  });

  describe('listApiKeys', () => {
    it('should throw error if userId is missing', async () => {
      await expect(listApiKeys('')).rejects.toThrow('userId is required');
    });

    it('should return empty array when no keys exist', async () => {
      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await listApiKeys('user-456');
      expect(result).toEqual([]);
    });

    it('should return masked key info', async () => {
      // Distinct timestamps: Key 1 is newer so it must sort first under
      // the implementation's b.createdAt - a.createdAt comparator
      // (api-keys.ts:217). Using `Date.now()` for both made the assertion
      // flaky when the two calls landed in the same millisecond.
      const now = Date.now();
      const mockDocs = [
        {
          id: 'key-1',
          data: () => ({
            name: 'Key 1',
            permissions: ['read'],
            createdAt: now,
            expiresAt: null,
          }),
        },
        {
          id: 'key-2',
          data: () => ({
            name: 'Key 2',
            permissions: ['write'],
            createdAt: now - 1000,
            expiresAt: null,
          }),
        },
      ];

      const mockCollection = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: mockDocs }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await listApiKeys('user-456');

      expect(result).toHaveLength(2);
      expect(result[0].prefix).toMatch(/^tp_live_\*+$/);
      expect(result[0].name).toBe('Key 1');
    });
  });

  describe('revokeApiKey', () => {
    it('should return false for invalid inputs', async () => {
      expect(await revokeApiKey('', 'user-123')).toBe(false);
      expect(await revokeApiKey('key-123', '')).toBe(false);
    });

    it('should return false for non-existent key', async () => {
      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false }),
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await revokeApiKey('key-123', 'user-456');
      expect(result).toBe(false);
    });

    it('should return false if user does not own the key', async () => {
      const mockDoc = {
        exists: true,
        data: () => ({
          userId: 'other-user',
          revokedAt: null,
        }),
      };

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(mockDoc),
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await revokeApiKey('key-123', 'user-456');
      expect(result).toBe(false);
    });

    it('should revoke key successfully', async () => {
      const mockUpdate = jest.fn().mockResolvedValue(undefined);
      const mockDoc = {
        exists: true,
        data: () => ({
          userId: 'user-456',
          revokedAt: null,
        }),
        ref: { update: mockUpdate },
      };

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(mockDoc),
        }),
      };
      (db.collection as jest.Mock).mockReturnValue(mockCollection);

      const result = await revokeApiKey('key-123', 'user-456');

      expect(result).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Number) }));
    });
  });
});
