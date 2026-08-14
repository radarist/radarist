/**
 * Unit Tests for Radar Domain MCP Server
 *
 * Tests the impulse-radar domain MCP server that wraps existing
 * radar management and technology-decoupled tools in MCP format.
 *
 * @jest-environment node
 */

// Must mock BEFORE imports due to jest hoisting
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/entity-factory', () => ({
  createEntity: jest.fn(),
}));

// Mock the executeTool function from tools.ts
jest.mock('@/lib/ai/tools', () => ({
  executeTool: jest.fn().mockResolvedValue({
    success: true,
    data: { radar: {} },
  }),
  AI_TOOLS: [],
  ALL_AI_TOOLS: [],
}));

// Mock tool declaration arrays
jest.mock('@/lib/ai/tools/radar-management', () => ({
  RADAR_MANAGEMENT_TOOLS: [
    { name: 'createRadar', description: 'Create a new radar', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
    { name: 'deleteRadar', description: 'Delete a radar', parameters: { type: 'OBJECT', properties: { radarId: { type: 'STRING' } }, required: ['radarId'] } },
    { name: 'updateRadarSettings', description: 'Update radar settings', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'listRadars', description: 'List all radars', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getRadarDetails', description: 'Get radar details', parameters: { type: 'OBJECT', properties: { radarId: { type: 'STRING' } }, required: ['radarId'] } },
    { name: 'searchTechnologiesAdvanced', description: 'Advanced technology search', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'addTechnologiesToRadar', description: 'Add technologies to a radar', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'updateTechnologyOnRadar', description: 'Update technology on a radar', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'populateRadarFromContext', description: 'Populate radar from context', parameters: { type: 'OBJECT', properties: {} } },
  ],
}));

jest.mock('@/lib/ai/tools/technology-decoupled', () => ({
  TECHNOLOGY_DECOUPLED_TOOLS: [
    { name: 'createDecoupledTechnology', description: 'Create a decoupled technology', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
    { name: 'updateDecoupledTechnology', description: 'Update a decoupled technology', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'placeTechnologyOnRadar', description: 'Place technology on a radar', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'moveDecoupledTechnologyRing', description: 'Move technology ring', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'searchDecoupledTechnologies', description: 'Search decoupled technologies', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getDecoupledTechnologyDetails', description: 'Get decoupled technology details', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'deleteDecoupledTechnology', description: 'Delete decoupled technology', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'removeTechnologyFromRadar', description: 'Remove technology from radar', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'researchTechnologyComprehensive', description: 'Comprehensive technology research', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'confirmPlacement', description: 'Confirm a radar placement', parameters: { type: 'OBJECT', properties: {} } },
  ],
}));

import { createRadarServer } from '../radar-server';
import { executeTool } from '@/lib/ai/tools';

const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>;

describe('RadarMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Server Identity
  // ========================================================================

  describe('server identity', () => {
    it('should have the correct server name', () => {
      const server = createRadarServer();
      expect(server.name).toBe('impulse-radar');
    });

    it('should have a version', () => {
      const server = createRadarServer();
      expect(server.version).toBe('1.0.0');
    });
  });

  // ========================================================================
  // Tool Listing
  // ========================================================================

  describe('getTools()', () => {
    it('should list available tools', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include radar management tools', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('createRadar');
      expect(toolNames).toContain('deleteRadar');
      expect(toolNames).toContain('updateRadarSettings');
      expect(toolNames).toContain('listRadars');
      expect(toolNames).toContain('getRadarDetails');
      expect(toolNames).toContain('searchTechnologiesAdvanced');
      expect(toolNames).toContain('addTechnologiesToRadar');
      expect(toolNames).toContain('updateTechnologyOnRadar');
      expect(toolNames).toContain('populateRadarFromContext');
    });

    it('should include technology-decoupled tools', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('createDecoupledTechnology');
      expect(toolNames).toContain('updateDecoupledTechnology');
      expect(toolNames).toContain('placeTechnologyOnRadar');
      expect(toolNames).toContain('moveDecoupledTechnologyRing');
      expect(toolNames).toContain('searchDecoupledTechnologies');
      expect(toolNames).toContain('getDecoupledTechnologyDetails');
      expect(toolNames).toContain('deleteDecoupledTechnology');
      expect(toolNames).toContain('removeTechnologyFromRadar');
      expect(toolNames).toContain('researchTechnologyComprehensive');
      expect(toolNames).toContain('confirmPlacement');
    });

    it('should NOT include tools from other domains', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).not.toContain('createCompany');
      expect(toolNames).not.toContain('webSearch');
      expect(toolNames).not.toContain('queryGraph');
      expect(toolNames).not.toContain('listSignals');
      expect(toolNames).not.toContain('searchDocuments');
    });

    it('should have correct tool shape (name, description, inputSchema)', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema).toHaveProperty('type');
      }
    });

    it('should not have duplicate tool names', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      const names = tools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  // ========================================================================
  // Tool Execution
  // ========================================================================

  describe('callTool()', () => {
    it('should execute a known tool via executeTool', async () => {
      const server = createRadarServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { id: 'radar-1', name: 'AI Radar' },
      });

      const result = await server.callTool('createRadar', { name: 'AI Radar' });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'createRadar', args: { name: 'AI Radar' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.name).toBe('AI Radar');
    });

    it('should execute technology-decoupled tools', async () => {
      const server = createRadarServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { id: 'tech-1', name: 'React' },
      });

      const result = await server.callTool('createDecoupledTechnology', { name: 'React' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'createDecoupledTechnology', args: { name: 'React' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it('should reject unknown tool names', async () => {
      const server = createRadarServer();
      await expect(server.callTool('nonExistentTool', {})).rejects.toThrow(
        /unknown tool.*nonExistentTool/i
      );
    });

    it('should reject tools from other domains', async () => {
      const server = createRadarServer();
      await expect(server.callTool('webSearch', { query: 'test' })).rejects.toThrow(
        /unknown tool.*webSearch/i
      );
    });

    it('should return error content when executeTool fails', async () => {
      const server = createRadarServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: false,
        error: 'Radar not found',
      });

      const result = await server.callTool('getRadarDetails', { radarId: 'bad-id' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Radar not found');
    });

    it('should handle executeTool throwing an exception', async () => {
      const server = createRadarServer();
      mockExecuteTool.mockRejectedValueOnce(new Error('Firestore write failed'));

      const result = await server.callTool('createRadar', { name: 'Bad Radar' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Firestore write failed');
    });

    it('should pass empty args when none provided', async () => {
      const server = createRadarServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: [] });

      await server.callTool('listRadars', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'listRadars', args: {} }),
        expect.anything()
      );
    });
  });

  // ========================================================================
  // Tool Count
  // ========================================================================

  describe('tool count', () => {
    it('should register the expected number of radar tools', () => {
      const server = createRadarServer();
      const tools = server.getTools();
      // radar-management: 9
      // technology-decoupled: 10
      // Total: 19
      expect(tools.length).toBe(19);
    });
  });
});
