/**
 * Unit Tests for Reports Domain MCP Server
 *
 * Tests the impulse-reports domain MCP server that wraps existing
 * document, claims, and linker triage tools in MCP format.
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
    data: { documents: [] },
  }),
  AI_TOOLS: [],
  ALL_AI_TOOLS: [],
}));

// Mock tool declaration arrays
jest.mock('@/lib/ai/tools/document-tools', () => ({
  DOCUMENT_TOOLS: [
    {
      name: 'searchDocuments',
      description: 'Search document chunks',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
    },
    { name: 'listDocuments', description: 'List documents', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'getDocumentDetails',
      description: 'Get document details',
      parameters: { type: 'OBJECT', properties: { documentId: { type: 'STRING' } }, required: ['documentId'] },
    },
    {
      name: 'captureEvidence',
      description: 'Capture evidence linking chunks to entities',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'getChunkContent', description: 'Get chunk content', parameters: { type: 'OBJECT', properties: {} } },
  ],
  DOCUMENT_WRITE_TOOLS: [
    {
      name: 'draftDocument',
      description: 'Persist a markdown Document (mission-scoped)',
      parameters: { type: 'OBJECT', properties: { title: { type: 'STRING' } }, required: ['title'] },
    },
  ],
}));

jest.mock('@/lib/ai/tools/assertions-tools', () => ({
  ASSERTIONS_TOOLS: [
    {
      name: 'explainRelation',
      description: 'Explain why entities are related',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'createRelationWithEvidence',
      description: 'Create relation with evidence',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'getRelationEvidence',
      description: 'Get evidence for a relation',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'curateRelation', description: 'Curate a relation claim', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'getEntityAssertions',
      description: 'Get claims for an entity',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/linker-tools', () => ({
  LINKER_TOOLS: [
    {
      name: 'listPendingProposedRelations',
      description: 'List pending proposed relations',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'approveProposedRelation',
      description: 'Approve a proposed relation',
      parameters: { type: 'OBJECT', properties: { proposalId: { type: 'STRING' } }, required: ['proposalId'] },
    },
    {
      name: 'rejectProposedRelation',
      description: 'Reject a proposed relation',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'dismissProposedRelation',
      description: 'Dismiss a proposed relation',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'bulkApproveHighConfidenceProposals',
      description: 'Bulk approve high confidence proposals',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'createRelation',
      description: 'Create a relation between entities',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'getProposedRelationDetails',
      description: 'Get proposed relation details',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/visualization-tools', () => ({
  VISUALIZATION_TOOLS: [
    {
      name: 'generateInfographic',
      description: 'Generate a visual infographic',
      parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] },
    },
    {
      name: 'generateVisualization',
      description: 'Generate and save a visualization',
      parameters: { type: 'OBJECT', properties: { prompt: { type: 'STRING' } }, required: ['prompt'] },
    },
  ],
}));

import { createReportsServer } from '../reports-server';
import { executeTool } from '@/lib/ai/tools';

const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>;

describe('ReportsMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Server Identity
  // ========================================================================

  describe('server identity', () => {
    it('should have the correct server name', () => {
      const server = createReportsServer();
      expect(server.name).toBe('impulse-reports');
    });

    it('should have a version', () => {
      const server = createReportsServer();
      expect(server.version).toBe('1.0.0');
    });
  });

  // ========================================================================
  // Tool Listing
  // ========================================================================

  describe('getTools()', () => {
    it('should list available tools', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include document tools', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('searchDocuments');
      expect(toolNames).toContain('listDocuments');
      expect(toolNames).toContain('getDocumentDetails');
      expect(toolNames).toContain('captureEvidence');
      expect(toolNames).toContain('getChunkContent');
    });

    it('should include the mission-scoped document write tool (draftDocument)', () => {
      const server = createReportsServer();
      const toolNames = server.getTools().map((t) => t.name);
      // Asserted by name, not just the tool-count pin: a swap that drops
      // draftDocument while adding another tool keeps the count but would
      // silently remove the mission Document-writer from the reports surface.
      expect(toolNames).toContain('draftDocument');
    });

    it('should include claims tools', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('explainRelation');
      expect(toolNames).toContain('createRelationWithEvidence');
      expect(toolNames).toContain('getRelationEvidence');
      expect(toolNames).toContain('curateRelation');
      expect(toolNames).toContain('getEntityAssertions');
    });

    it('should include linker tools', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('listPendingProposedRelations');
      expect(toolNames).toContain('approveProposedRelation');
      expect(toolNames).toContain('rejectProposedRelation');
      expect(toolNames).toContain('dismissProposedRelation');
      expect(toolNames).toContain('bulkApproveHighConfidenceProposals');
      expect(toolNames).toContain('createRelation');
      expect(toolNames).toContain('getProposedRelationDetails');
    });

    it('should NOT include tools from other domains', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).not.toContain('createCompany');
      expect(toolNames).not.toContain('webSearch');
      expect(toolNames).not.toContain('queryGraph');
      expect(toolNames).not.toContain('listSignals');
      expect(toolNames).not.toContain('createRadar');
    });

    it('should have correct tool shape (name, description, inputSchema)', () => {
      const server = createReportsServer();
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
      const server = createReportsServer();
      const tools = server.getTools();
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  // ========================================================================
  // Tool Execution
  // ========================================================================

  describe('callTool()', () => {
    it('should execute a known tool via executeTool', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { documents: [{ id: 'doc-1', title: 'Q4 Report' }] },
      });

      const result = await server.callTool('searchDocuments', { query: 'quarterly report' });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'searchDocuments', args: { query: 'quarterly report' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.documents).toHaveLength(1);
    });

    it('REPORT-006: serializes the publishReport payload exactly as the mission prompts promise', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { reportId: 'report-abc', reportUrl: '/reports/report-abc', isUpsert: false },
      });

      const result = await server.callTool('publishReport', { slotName: 'main', title: 'T', description: 'd' });

      // Deep-equal (not objectContaining) pins the FULL payload the Creator
      // agent sees — {success, data:{reportId, reportUrl, isUpsert}}, the exact
      // field set agent/src/publish-contract.ts (PUBLISH_RESULT_FIELDS) spells
      // into the prompts. No shareUrl exists at publish time.
      expect(JSON.parse(result.content[0].text!)).toEqual({
        success: true,
        data: { reportId: 'report-abc', reportUrl: '/reports/report-abc', isUpsert: false },
      });
    });

    it('should execute claims tools', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { explanation: 'Connected via technology adoption' },
      });

      const result = await server.callTool('explainRelation', { relationId: 'rel-1' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'explainRelation', args: { relationId: 'rel-1' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it('should execute linker triage tools', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { approved: true },
      });

      const result = await server.callTool('approveProposedRelation', { proposalId: 'prop-1' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'approveProposedRelation', args: { proposalId: 'prop-1' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it('should reject unknown tool names', async () => {
      const server = createReportsServer();
      await expect(server.callTool('nonExistentTool', {})).rejects.toThrow(/unknown tool.*nonExistentTool/i);
    });

    it('should reject tools from other domains', async () => {
      const server = createReportsServer();
      await expect(server.callTool('createCompany', { name: 'test' })).rejects.toThrow(/unknown tool.*createCompany/i);
    });

    it('should return error content when executeTool fails', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: false,
        error: 'Document not found',
      });

      const result = await server.callTool('getDocumentDetails', { documentId: 'bad-id' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Document not found');
    });

    it('should handle executeTool throwing an exception', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockRejectedValueOnce(new Error('Firestore read failed'));

      const result = await server.callTool('listDocuments', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Firestore read failed');
    });

    it('should pass empty args when none provided', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: [] });

      await server.callTool('listDocuments', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'listDocuments', args: {} }),
        expect.anything()
      );
    });
  });

  // ========================================================================
  // Context Propagation
  // ========================================================================

  describe('context propagation', () => {
    it('forwards missionId and slots from McpCallContext into executeTool context', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: {} });
      await server.callTool(
        'listDocuments',
        {},
        { userId: 'u1', missionId: 'mission-1', slots: [{ name: 'main', intent: 'x' }] }
      );
      expect(mockExecuteTool).toHaveBeenCalledWith(
        { name: 'listDocuments', args: {} },
        expect.objectContaining({
          userId: 'u1',
          missionId: 'mission-1',
          slots: [{ name: 'main', intent: 'x' }],
        })
      );
    });

    it('omits missionId and slots when not provided in context', async () => {
      const server = createReportsServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: {} });
      await server.callTool('listDocuments', {}, { userId: 'u1' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        { name: 'listDocuments', args: {} },
        expect.objectContaining({ userId: 'u1', missionId: undefined, slots: undefined })
      );
    });
  });

  // ========================================================================
  // Tool Count
  // ========================================================================

  describe('tool count', () => {
    it('should register the expected number of reports tools', () => {
      const server = createReportsServer();
      const tools = server.getTools();
      // document-tools: 5
      // claims-tools: 5
      // linker-tools: 7
      // report-tools: 7 (draftReport + publishReport + listReports + getReportById + updateReport + restoreReport + deleteReport)
      // mission-tools: 8 (startMission + getMissionStatus + listUserMissions + getArtifactFindings + dispatchTechnologyEvaluation + dispatchBuildMission + iterateBuildArtifact + approveAssessment)
      // visualization-tools: 1 (generateVisualization only — Bug I dropped
      //   generateInfographic from this server because mcp__gemini-image__
      //   generate_image is the canonical non-persistent path)
      // document-write-tools: 1 (draftDocument — mission-scoped Document writer)
      // Total: 34
      expect(tools.length).toBe(34);
    });
  });
});
