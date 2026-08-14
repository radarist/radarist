/**
 * Unit Tests for Graph Domain MCP Server
 *
 * Tests the impulse-graph domain MCP server that wraps existing
 * GraphRAG, Knowledge Graph, and Cypher tools in MCP format.
 *
 * @jest-environment node
 */

// Must mock BEFORE imports due to jest hoisting
jest.mock('@/lib/firebase', () => ({ db: {} }));

// Mock the executeTool function from tools.ts
jest.mock('@/lib/ai/tools', () => ({
  executeTool: jest.fn().mockResolvedValue({
    success: true,
    data: { nodes: [], edges: [] },
  }),
  AI_TOOLS: [],
  ALL_AI_TOOLS: [],
}));

// Mock tool declaration arrays
jest.mock('@/lib/ai/tools/graph-tools', () => ({
  GRAPH_TOOLS: [
    {
      name: 'queryGraph',
      description: 'Query the knowledge graph',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
    },
    {
      name: 'findGraphPath',
      description: 'Find path between entities',
      parameters: {
        type: 'OBJECT',
        properties: { from: { type: 'STRING' }, to: { type: 'STRING' } },
        required: ['from', 'to'],
      },
    },
    {
      name: 'getGraphNeighbors',
      description: 'Get graph neighbors',
      parameters: { type: 'OBJECT', properties: { nodeId: { type: 'STRING' } }, required: ['nodeId'] },
    },
    {
      name: 'checkGraphConnection',
      description: 'Check if entities are connected',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'analyzeImpact',
      description: 'Analyze impact of a technology',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'findSolutions',
      description: 'Find solutions for pain points',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'findAlignedTechnologies',
      description: 'Find technologies aligned with strategy',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'getGapAnalysis', description: 'Perform gap analysis', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'findVendors',
      description: 'Find vendors for a technology',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'compareCompetitors', description: 'Compare competitors', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'recommendTechInvestments',
      description: 'Recommend tech investments',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'getTechSummary', description: 'Get technology summary', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getGraphHealth', description: 'Get graph health status', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'askGraphQuestion',
      description: 'Ask a question about the graph',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/knowledge-tools', () => ({
  KNOWLEDGE_TOOLS: [
    {
      name: 'searchKnowledgeGraph',
      description: 'Search the knowledge graph',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
    },
    {
      name: 'getEntityContext',
      description: 'Get entity context from graph',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'formatCitations',
      description: 'Format citations for responses',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/cypher-tools', () => ({
  CYPHER_TOOLS: [
    {
      name: 'generateCypher',
      description: 'Generate Cypher from natural language',
      parameters: { type: 'OBJECT', properties: { question: { type: 'STRING' } }, required: ['question'] },
    },
    { name: 'explainCypher', description: 'Explain a Cypher query', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'validateCypher', description: 'Validate a Cypher query', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getCypherSchema', description: 'Get the Cypher schema', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'executeCypher', description: 'Execute a Cypher query', parameters: { type: 'OBJECT', properties: {} } },
  ],
}));

jest.mock('@/lib/ai/tools/analytics-tools', () => ({
  ANALYTICS_TOOLS: [
    { name: 'getGraphAnalytics', description: 'Get graph analytics', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getClaimHealth', description: 'Get claim health stats', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'findDataGaps',
      description: 'Find data gaps',
      parameters: { type: 'OBJECT', properties: { limit: { type: 'NUMBER' } } },
    },
  ],
}));

// Memory tools (queryRecentMissions / getMissionResults) dynamically import
// the episodes module — mock it so no Neo4j driver is touched.
jest.mock('@/lib/graph/episodes', () => ({
  queryEpisodes: jest.fn(),
  getEpisode: jest.fn(),
  getEpisodeWithObservations: jest.fn(),
}));

import { createGraphServer } from '../graph-server';
import { executeTool } from '@/lib/ai/tools';
import * as episodesModule from '@/lib/graph/episodes';

const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>;
const mockQueryEpisodes = episodesModule.queryEpisodes as jest.MockedFunction<typeof episodesModule.queryEpisodes>;
const mockGetEpisodeWithObservations = (episodesModule as unknown as { getEpisodeWithObservations: jest.Mock })
  .getEpisodeWithObservations;

describe('GraphMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Server Identity
  // ========================================================================

  describe('server identity', () => {
    it('should have the correct server name', () => {
      const server = createGraphServer();
      expect(server.name).toBe('impulse-graph');
    });

    it('should have a version', () => {
      const server = createGraphServer();
      expect(server.version).toBe('1.0.0');
    });
  });

  // ========================================================================
  // Tool Listing
  // ========================================================================

  describe('getTools()', () => {
    it('should list available tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include graph tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('queryGraph');
      expect(toolNames).toContain('findGraphPath');
      expect(toolNames).toContain('getGraphNeighbors');
      expect(toolNames).toContain('checkGraphConnection');
      expect(toolNames).toContain('analyzeImpact');
      expect(toolNames).toContain('findSolutions');
      expect(toolNames).toContain('findAlignedTechnologies');
      expect(toolNames).toContain('getGapAnalysis');
      expect(toolNames).toContain('findVendors');
      expect(toolNames).toContain('compareCompetitors');
      expect(toolNames).toContain('recommendTechInvestments');
      expect(toolNames).toContain('getTechSummary');
      expect(toolNames).toContain('getGraphHealth');
      expect(toolNames).toContain('askGraphQuestion');
    });

    it('should include knowledge tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('searchKnowledgeGraph');
      expect(toolNames).toContain('getEntityContext');
      expect(toolNames).toContain('formatCitations');
    });

    it('should include cypher tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('generateCypher');
      expect(toolNames).toContain('explainCypher');
      expect(toolNames).toContain('validateCypher');
      expect(toolNames).toContain('getCypherSchema');
      expect(toolNames).toContain('executeCypher');
    });

    it('should include analytics tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('getGraphAnalytics');
      expect(toolNames).toContain('getClaimHealth');
      expect(toolNames).toContain('findDataGaps');
    });

    it('should NOT include tools from other domains', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).not.toContain('createCompany');
      expect(toolNames).not.toContain('webSearch');
      expect(toolNames).not.toContain('listSignals');
      expect(toolNames).not.toContain('createRadar');
      expect(toolNames).not.toContain('searchDocuments');
    });

    it('should have correct tool shape (name, description, inputSchema)', () => {
      const server = createGraphServer();
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
      const server = createGraphServer();
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
      const server = createGraphServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { nodes: [{ id: 'n1', label: 'React' }], edges: [] },
      });

      const result = await server.callTool('queryGraph', { query: 'React ecosystem' });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'queryGraph', args: { query: 'React ecosystem' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.nodes).toHaveLength(1);
    });

    it('should execute cypher tools', async () => {
      const server = createGraphServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { cypher: 'MATCH (n) RETURN n' },
      });

      const result = await server.callTool('generateCypher', { question: 'Show all technologies' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'generateCypher', args: { question: 'Show all technologies' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it.each([
      [
        'executeCypher',
        { cypher: 'RETURN 1 AS value' },
        { results: [{ value: 1 }], resultCount: 1, truncated: false, payloadBytes: 13 },
      ],
      [
        'generateCypher',
        { question: 'Count entities' },
        { cypher: 'MATCH (n) RETURN count(n)', executed: false, explanation: 'Counts nodes' },
      ],
      ['validateCypher', { cypher: 'RETURN 1' }, { isValid: true, isSafe: true, issues: undefined }],
    ])('preserves the real top-level %s executor payload through MCP', async (name, args, payload) => {
      const server = createGraphServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, ...payload } as never);

      const result = await server.callTool(name, args);
      const envelope = JSON.parse(result.content[0].text as string);

      expect(envelope).toEqual({ success: true, data: payload });
      expect(result.isError).toBeUndefined();
    });

    it('should reject unknown tool names', async () => {
      const server = createGraphServer();
      await expect(server.callTool('nonExistentTool', {})).rejects.toThrow(/unknown tool.*nonExistentTool/i);
    });

    it('should reject tools from other domains', async () => {
      const server = createGraphServer();
      await expect(server.callTool('createCompany', { name: 'test' })).rejects.toThrow(/unknown tool.*createCompany/i);
    });

    it('should return error content when executeTool fails', async () => {
      const server = createGraphServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: false,
        error: 'Neo4j connection failed',
      });

      const result = await server.callTool('queryGraph', { query: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('Neo4j connection failed');
    });

    it('should handle executeTool throwing an exception', async () => {
      const server = createGraphServer();
      mockExecuteTool.mockRejectedValueOnce(new Error('Graph service unavailable'));

      const result = await server.callTool('queryGraph', { query: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Graph service unavailable');
    });

    it('should pass empty args when none provided', async () => {
      const server = createGraphServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: {} });

      await server.callTool('getGraphHealth', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'getGraphHealth', args: {} }),
        expect.anything()
      );
    });
  });

  // ========================================================================
  // Memory tools (Task 3.10 + P5-B H13/M14)
  // ========================================================================

  describe('memory tools', () => {
    it('getMissionResults traverses CONTAINS and returns the episode observations (H13)', async () => {
      mockGetEpisodeWithObservations.mockResolvedValue({
        episode: { id: 'ep-1', agentName: 'scout', summary: 'found things', observationCount: 2 },
        observations: [
          { id: 'obs-1', entityId: 'tech-1', verdict: 'confirming' },
          { id: 'obs-2', entityId: 'tech-2', verdict: 'inconclusive' },
        ],
      });

      const server = createGraphServer();
      const result = await server.callTool('getMissionResults', { episodeId: 'ep-1' }, { userId: 'user-1' });

      expect(mockGetEpisodeWithObservations).toHaveBeenCalledWith('ep-1');
      const payload = JSON.parse(result.content[0].text as string);
      expect(payload.success).toBe(true);
      expect(payload.episode.id).toBe('ep-1');
      expect(payload.observations).toHaveLength(2);
      expect(payload.observations[0].id).toBe('obs-1');
    });

    it('getMissionResults returns isError when the episode does not exist', async () => {
      mockGetEpisodeWithObservations.mockResolvedValue(null);

      const server = createGraphServer();
      const result = await server.callTool('getMissionResults', { episodeId: 'ep-missing' }, { userId: 'user-1' });

      expect(result.isError).toBe(true);
    });

    it('queryRecentMissions includes system principals so sweep episodes are visible (M14)', async () => {
      mockQueryEpisodes.mockResolvedValue([]);

      const server = createGraphServer();
      await server.callTool('queryRecentMissions', { hours: 24 }, { userId: 'user-1' });

      expect(mockQueryEpisodes).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', includeSystem: true })
      );
    });
  });

  // ========================================================================
  // Tool Count
  // ========================================================================

  describe('tool count', () => {
    it('should register the expected number of graph tools', () => {
      const server = createGraphServer();
      const tools = server.getTools();
      // Updated 2026-05-01: graph-tools grew to ~27 after CuriosityGap, concept-graph,
      // findOrphanedEntities, structured-findGraphPath, and other additions across
      // earlier work. The exact breakdown drifts faster than this comment can keep
      // pace with — assert the total only.
      // Total: 49 (was 40; +5 on 2026-07-02 — INTEREST_TOOLS registered in the
      // graph server so the interest/insight tools are reachable over the
      // per-server MCP route, closing the CORE_AI_TOOLS parity gap; +1 on
      // 2026-07-05 — recordAgentObservation added to INTEREST_TOOLS; +3 on
      // 2026-07-13 — the AI-007 working-style memory trio
      // save/list/clearWorkingStylePreferences added to INTEREST_TOOLS; +2 on
      // 2026-08-01 — SKILL-043 added the observation read-back pair
      // getAgentObservations / getSourceVerificationObservations).
      expect(tools.length).toBe(51);
    });
  });
});
