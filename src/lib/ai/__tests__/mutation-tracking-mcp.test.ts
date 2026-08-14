/**
 * Tests for MCP tool name normalization in mutation tracking (Task 2.3)
 */

import { normalizeToolName, getToolMutatedTypes, isMutationTool } from '../mutation-tracking';

describe('MCP Tool Name Normalization', () => {
  describe('normalizeToolName', () => {
    it('should strip MCP prefix from tool name', () => {
      expect(normalizeToolName('mcp__impulse-entities__createCompany')).toBe('createCompany');
    });

    it('should handle multiple underscores in server name', () => {
      expect(normalizeToolName('mcp__gemini-image__generate_image')).toBe('generate_image');
    });

    it('should pass through regular tool names unchanged', () => {
      expect(normalizeToolName('createCompany')).toBe('createCompany');
    });

    it('should pass through empty string', () => {
      expect(normalizeToolName('')).toBe('');
    });

    it('should handle tool names that start with mcp but not mcp__', () => {
      expect(normalizeToolName('mcpTool')).toBe('mcpTool');
    });
  });

  describe('getToolMutatedTypes with MCP names', () => {
    it('should detect mutations from MCP-prefixed company tools', () => {
      const types = getToolMutatedTypes('mcp__impulse-entities__createCompany');
      expect(types).toContain('company');
    });

    it('should detect mutations from MCP-prefixed signal tools', () => {
      const types = getToolMutatedTypes('mcp__impulse-signals__approveSignalForImport');
      expect(types).toContain('signal');
    });

    it('should detect mutations from MCP-prefixed radar tools', () => {
      const types = getToolMutatedTypes('mcp__impulse-radar__placeTechnologyOnRadar');
      expect(types).toContain('radarPlacement');
      expect(types).toContain('technology');
    });

    it('should work with regular (non-MCP) tool names', () => {
      const types = getToolMutatedTypes('createCompany');
      expect(types).toContain('company');
    });

    it('should handle generic updateEntity with MCP prefix', () => {
      const types = getToolMutatedTypes('mcp__impulse-entities__updateEntity', {
        entityType: 'technology',
      });
      expect(types).toContain('technology');
    });
  });

  describe('isMutationTool with MCP names', () => {
    it('should detect MCP-prefixed mutation tools', () => {
      expect(isMutationTool('mcp__impulse-entities__createCompany')).toBe(true);
    });

    it('should not flag MCP-prefixed read tools', () => {
      expect(isMutationTool('mcp__impulse-entities__searchEntities')).toBe(false);
    });

    it('should detect regular mutation tools', () => {
      expect(isMutationTool('createCompany')).toBe(true);
    });
  });
});
