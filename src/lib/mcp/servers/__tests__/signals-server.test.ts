/**
 * Unit Tests for Signals Domain MCP Server
 *
 * Tests the impulse-signals domain MCP server that wraps existing
 * signal management and pipeline tools in MCP format.
 *
 * @jest-environment node
 */

// Must mock BEFORE imports due to jest hoisting
jest.mock('@/lib/firebase', () => ({ db: {} }));

// Mock the executeTool function from tools.ts
jest.mock('@/lib/ai/tools', () => ({
  executeTool: jest.fn().mockResolvedValue({
    success: true,
    data: { signals: [] },
  }),
  AI_TOOLS: [],
  ALL_AI_TOOLS: [],
}));

// Mock tool declaration arrays
jest.mock('@/lib/ai/tools/signal-management', () => ({
  SIGNAL_MANAGEMENT_TOOLS: [
    { name: 'listSignals', description: 'List signals with filters', parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' } }, required: [] } },
    { name: 'approveSignalForImport', description: 'Approve a signal for import', parameters: { type: 'OBJECT', properties: { signalId: { type: 'STRING' } }, required: ['signalId'] } },
    { name: 'rejectSignalWithReason', description: 'Reject a signal with reason', parameters: { type: 'OBJECT', properties: { signalId: { type: 'STRING' }, reason: { type: 'STRING' } }, required: ['signalId', 'reason'] } },
    { name: 'bulkApproveSignals', description: 'Bulk approve signals', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'bulkRejectSignals', description: 'Bulk reject signals', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getSignalDetails', description: 'Get signal details', parameters: { type: 'OBJECT', properties: { signalId: { type: 'STRING' } }, required: ['signalId'] } },
    { name: 'resetSignalToDetected', description: 'Reset signal to detected status', parameters: { type: 'OBJECT', properties: {} } },
  ],
}));

jest.mock('@/lib/ai/tools/pipeline-tools', () => ({
  PIPELINE_TOOLS: [
    { name: 'getPipelineStatus', description: 'Get pipeline status', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'triggerPipeline', description: 'Trigger a pipeline run', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getTrends', description: 'Get trend data', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getTrendDetails', description: 'Get trend details', parameters: { type: 'OBJECT', properties: { trendId: { type: 'STRING' } }, required: ['trendId'] } },
    { name: 'getTrendSummary', description: 'Get trend summary', parameters: { type: 'OBJECT', properties: {} } },
  ],
}));

import { createSignalsServer } from '../signals-server';
import { executeTool } from '@/lib/ai/tools';

const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>;

describe('SignalsMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Server Identity
  // ========================================================================

  describe('server identity', () => {
    it('should have the correct server name', () => {
      const server = createSignalsServer();
      expect(server.name).toBe('impulse-signals');
    });

    it('should have a version', () => {
      const server = createSignalsServer();
      expect(server.version).toBe('1.0.0');
    });
  });

  // ========================================================================
  // Tool Listing
  // ========================================================================

  describe('getTools()', () => {
    it('should list available tools', () => {
      const server = createSignalsServer();
      const tools = server.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include signal management tools', () => {
      const server = createSignalsServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('listSignals');
      expect(toolNames).toContain('approveSignalForImport');
      expect(toolNames).toContain('rejectSignalWithReason');
      expect(toolNames).toContain('bulkApproveSignals');
      expect(toolNames).toContain('bulkRejectSignals');
      expect(toolNames).toContain('getSignalDetails');
      expect(toolNames).toContain('resetSignalToDetected');
    });

    it('should include pipeline tools', () => {
      const server = createSignalsServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('getPipelineStatus');
      expect(toolNames).toContain('triggerPipeline');
      expect(toolNames).toContain('getTrends');
      expect(toolNames).toContain('getTrendDetails');
      expect(toolNames).toContain('getTrendSummary');
    });

    it('should NOT include tools from other domains', () => {
      const server = createSignalsServer();
      const tools = server.getTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).not.toContain('createCompany');
      expect(toolNames).not.toContain('webSearch');
      expect(toolNames).not.toContain('queryGraph');
      expect(toolNames).not.toContain('createRadar');
      expect(toolNames).not.toContain('searchDocuments');
    });

    it('should have correct tool shape (name, description, inputSchema)', () => {
      const server = createSignalsServer();
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
      const server = createSignalsServer();
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
      const server = createSignalsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { signals: [{ id: 's1', title: 'AI Breakthrough' }] },
      });

      const result = await server.callTool('listSignals', { status: 'detected' });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'listSignals', args: { status: 'detected' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.signals).toHaveLength(1);
    });

    it('should execute pipeline tools', async () => {
      const server = createSignalsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { status: 'healthy', lastRun: '2026-02-23' },
      });

      const result = await server.callTool('getPipelineStatus', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'getPipelineStatus', args: {} }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it('should reject unknown tool names', async () => {
      const server = createSignalsServer();
      await expect(server.callTool('nonExistentTool', {})).rejects.toThrow(
        /unknown tool.*nonExistentTool/i
      );
    });

    it('should reject tools from other domains', async () => {
      const server = createSignalsServer();
      await expect(server.callTool('createCompany', { name: 'test' })).rejects.toThrow(
        /unknown tool.*createCompany/i
      );
    });

    it('should return error content when executeTool fails', async () => {
      const server = createSignalsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: false,
        error: 'Signal not found',
      });

      const result = await server.callTool('getSignalDetails', { signalId: 'bad-id' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Signal not found');
    });

    it('should handle executeTool throwing an exception', async () => {
      const server = createSignalsServer();
      mockExecuteTool.mockRejectedValueOnce(new Error('Inngest connection failed'));

      const result = await server.callTool('triggerPipeline', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Inngest connection failed');
    });

    it('should pass empty args when none provided', async () => {
      const server = createSignalsServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: [] });

      await server.callTool('listSignals', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'listSignals', args: {} }),
        expect.anything()
      );
    });
  });

  // ========================================================================
  // Tool Count
  // ========================================================================

  describe('tool count', () => {
    it('should register the expected number of signal tools', () => {
      const server = createSignalsServer();
      const tools = server.getTools();
      // signal-management: 7
      // pipeline-tools: 5
      // Total: 12
      expect(tools.length).toBe(12);
    });
  });
});
