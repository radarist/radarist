/**
 * @file mcp/__tests__/debug.test.ts
 * @description Tests for MCP debug endpoint
 */

// Mock Firebase to avoid initialization issues in tests
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
  storage: {},
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(),
  },
  adminAuth: {
    verifyIdToken: jest.fn(),
  },
}));

import { canExecuteTool, TOOL_PERMISSIONS } from '../permissions';
import { ALL_AI_TOOLS } from '@/lib/ai/tools';
import type { ApiKeyPermission } from '../types';

describe('MCP Debug Endpoint Logic', () => {
  describe('Tool Access Calculation', () => {
    it('should correctly count accessible tools for read-only key', () => {
      const permissions: ApiKeyPermission[] = ['read'];
      const allToolNames = ALL_AI_TOOLS.map((t) => t.name);

      const accessibleTools = allToolNames.filter((name) =>
        canExecuteTool(permissions, name)
      );
      const blockedTools = allToolNames.filter(
        (name) => !canExecuteTool(permissions, name)
      );

      // Read-only should have access to ~70 tools (research, list, search, get)
      expect(accessibleTools.length).toBeGreaterThan(50);
      expect(blockedTools.length).toBeGreaterThan(30); // write, delete, signals, admin tools blocked
    });

    it('should correctly count accessible tools for default permissions', () => {
      const permissions: ApiKeyPermission[] = ['read', 'write', 'signals'];
      const allToolNames = ALL_AI_TOOLS.map((t) => t.name);

      const accessibleTools = allToolNames.filter((name) =>
        canExecuteTool(permissions, name)
      );
      const blockedTools = allToolNames.filter(
        (name) => !canExecuteTool(permissions, name)
      );

      // Default permissions should have access to most tools
      expect(accessibleTools.length).toBeGreaterThan(100);
      // Only delete and admin tools should be blocked
      expect(blockedTools.length).toBeLessThan(20);
    });

    it('should correctly count accessible tools for full permissions', () => {
      const permissions: ApiKeyPermission[] = ['read', 'write', 'delete', 'signals'];
      const allToolNames = ALL_AI_TOOLS.map((t) => t.name);

      const accessibleTools = allToolNames.filter((name) =>
        canExecuteTool(permissions, name)
      );
      const blockedTools = allToolNames.filter(
        (name) => !canExecuteTool(permissions, name)
      );

      // Full permissions (except admin) should have access to almost all tools
      expect(accessibleTools.length).toBeGreaterThan(110);
      // Only admin tools should be blocked
      expect(blockedTools.length).toBeLessThan(10);
    });

    it('should give admin access to all tools', () => {
      const permissions: ApiKeyPermission[] = ['admin'];
      const allToolNames = ALL_AI_TOOLS.map((t) => t.name);

      const accessibleTools = allToolNames.filter((name) =>
        canExecuteTool(permissions, name)
      );

      // Admin should have access to ALL tools
      expect(accessibleTools.length).toBe(allToolNames.length);
    });
  });

  describe('Permission Categories', () => {
    it('should have correct number of explicitly mapped tools', () => {
      const explicitlyMapped = Object.keys(TOOL_PERMISSIONS).length;

      // We should have ~100+ tools explicitly mapped
      expect(explicitlyMapped).toBeGreaterThan(80);
    });

    it('should have tools in each permission category', () => {
      const categories = {
        read: [] as string[],
        write: [] as string[],
        delete: [] as string[],
        signals: [] as string[],
        admin: [] as string[],
      };

      for (const [toolName, perms] of Object.entries(TOOL_PERMISSIONS)) {
        for (const perm of perms) {
          categories[perm].push(toolName);
        }
      }

      expect(categories.read.length).toBeGreaterThan(30);
      expect(categories.write.length).toBeGreaterThan(30);
      expect(categories.delete.length).toBeGreaterThan(5);
      expect(categories.signals.length).toBeGreaterThan(5);
      expect(categories.admin.length).toBeGreaterThan(0);
    });
  });

  describe('ALL_AI_TOOLS', () => {
    it('should have expected number of tools', () => {
      // Should have ~116 tools total
      expect(ALL_AI_TOOLS.length).toBeGreaterThan(100);
      expect(ALL_AI_TOOLS.length).toBeLessThan(200);
    });

    it('should have unique tool names', () => {
      const names = ALL_AI_TOOLS.map((t) => t.name);
      const uniqueNames = new Set(names);

      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have required fields for each tool', () => {
      for (const tool of ALL_AI_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description).toBeDefined();
      }
    });
  });
});
