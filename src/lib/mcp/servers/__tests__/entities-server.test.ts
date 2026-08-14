/**
 * Unit Tests for Entities Domain MCP Server
 *
 * Tests the impulse-entities domain MCP server that wraps existing
 * entity CRUD tools in MCP format.
 *
 * @jest-environment node
 */

// Must mock BEFORE imports due to jest hoisting
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/entity-factory', () => ({
  createEntity: jest.fn(),
}));

// Mock the executeTool function from tools.ts
// AI_TOOLS must include the original CRUD tools that entities-server filters
jest.mock('@/lib/ai/tools', () => ({
  executeTool: jest.fn().mockResolvedValue({
    success: true,
    data: { id: 'test-123', name: 'Test Entity' },
  }),
  AI_TOOLS: [
    {
      name: 'searchEntities',
      description: 'Search for entities',
      parameters: {
        type: 'OBJECT',
        properties: { entityType: { type: 'STRING' }, query: { type: 'STRING' } },
        required: ['entityType', 'query'],
      },
    },
    {
      name: 'listEntities',
      description: 'List all entities of a type',
      parameters: { type: 'OBJECT', properties: { entityType: { type: 'STRING' } }, required: ['entityType'] },
    },
    {
      name: 'getEntityDetails',
      description: 'Get entity details',
      parameters: {
        type: 'OBJECT',
        properties: { entityType: { type: 'STRING' }, id: { type: 'STRING' } },
        required: ['entityType', 'id'],
      },
    },
    {
      name: 'getRelatedEntities',
      description: 'Get related entities',
      parameters: {
        type: 'OBJECT',
        properties: { entityType: { type: 'STRING' }, id: { type: 'STRING' } },
        required: ['entityType', 'id'],
      },
    },
    {
      name: 'updateEntity',
      description: 'Update an entity',
      parameters: {
        type: 'OBJECT',
        properties: { entityType: { type: 'STRING' }, updates: { type: 'OBJECT' } },
        required: ['entityType', 'updates'],
      },
    },
  ],
  ALL_AI_TOOLS: [],
}));

// Mock tool declaration arrays used to build the server's tool catalog
jest.mock('@/lib/ai/tools/entity-creation', () => ({
  ENTITY_CREATION_TOOLS: [
    {
      name: 'createCompany',
      description: 'Create a company',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
    {
      name: 'createTechnology',
      description: 'Create a technology',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
    {
      name: 'createUseCase',
      description: 'Create a use case',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
    {
      name: 'createPrototype',
      description: 'Create a prototype',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
    {
      name: 'createStrategy',
      description: 'Create a strategy',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
    {
      name: 'createSignalManual',
      description: 'Create a signal manually',
      parameters: { type: 'OBJECT', properties: { title: { type: 'STRING' } }, required: ['title'] },
    },
    {
      name: 'deleteEntity',
      description: 'Delete an entity',
      parameters: {
        type: 'OBJECT',
        properties: { entityType: { type: 'STRING' }, id: { type: 'STRING' } },
        required: ['entityType', 'id'],
      },
    },
    {
      name: 'createCompanyWithResearch',
      description: 'Create company with research',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
    },
  ],
}));

jest.mock('@/lib/ai/tools/enrichment', () => ({
  // enrichCompanyFromResearch was removed (AI-043) — not exposed on the entities MCP.
  ENRICHMENT_TOOLS: [
    {
      name: 'enrichTechnologyFromResearch',
      description: 'Enrich technology',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'bulkCreateRelations',
      description: 'Bulk create relations',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'bulkUpdateEntities', description: 'Bulk update entities', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'findAndLinkRelatedEntities',
      description: 'Find and link related entities',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'createRelationsByName',
      description: 'Create relations by name',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/company-review-tools', () => ({
  COMPANY_REVIEW_TOOLS: [
    {
      name: 'listCompanyReviewItems',
      description: 'List review items',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'prepareCompanyReviewDecision',
      description: 'Prepare review decision',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'recordCompanyReviewDecision',
      description: 'Record review decision',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/company-tools', () => ({
  COMPANY_TOOLS: [
    { name: 'researchCompany', description: 'Research a company', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'discoverCompanyRelations',
      description: 'Discover company relations',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'addCompanyNote', description: 'Add company note', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'updateCompanyResearch',
      description: 'Update company research',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

jest.mock('@/lib/ai/tools/new-entities-tools', () => ({
  NEW_ENTITIES_TOOLS: [
    { name: 'searchOrgUnits', description: 'Search org units', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getOrgUnitDetails', description: 'Get org unit details', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'createOrgUnit', description: 'Create org unit', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'updateOrgUnit', description: 'Update org unit', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'deleteOrgUnit', description: 'Delete org unit', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'searchInitiatives', description: 'Search initiatives', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'getInitiativeDetails',
      description: 'Get initiative details',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'createInitiative', description: 'Create initiative', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'updateInitiative', description: 'Update initiative', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'deleteInitiative', description: 'Delete initiative', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'searchPainPoints', description: 'Search pain points', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'getPainPointDetails',
      description: 'Get pain point details',
      parameters: { type: 'OBJECT', properties: {} },
    },
    { name: 'createPainPoint', description: 'Create pain point', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'updatePainPoint', description: 'Update pain point', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'deletePainPoint', description: 'Delete pain point', parameters: { type: 'OBJECT', properties: {} } },
    {
      name: 'listInitiativesByOrgUnit',
      description: 'List initiatives by org unit',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'listPainPointsByOrgUnit',
      description: 'List pain points by org unit',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

// Mock the inline CRUD tools from tools.ts by providing them via a helper
// These are searchEntities, listEntities, getEntityDetails, getRelatedEntities, updateEntity, createRelation
jest.mock('@/lib/ai/tools/linker-tools', () => ({
  LINKER_TOOLS: [
    { name: 'createRelation', description: 'Create a relation', parameters: { type: 'OBJECT', properties: {} } },
    // SKILL-049 — the review-preserving pair the entities server now selects.
    {
      name: 'listPendingProposedRelations',
      description: 'List pending proposed relations',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'proposeVerifiedRelation',
      description: 'Propose a relation for review',
      parameters: { type: 'OBJECT', properties: {} },
    },
    // A triage DECISION tool, deliberately left unselected by this server.
    {
      name: 'approveProposedRelation',
      description: 'Approve a proposed relation',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
}));

import { createEntitiesServer } from '../entities-server';
import { executeTool } from '@/lib/ai/tools';
import type {} from '../../types';

const mockExecuteTool = executeTool as jest.MockedFunction<typeof executeTool>;

describe('EntitiesMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Server Identity
  // ========================================================================

  describe('server identity', () => {
    it('should have the correct server name', () => {
      const server = createEntitiesServer();
      expect(server.name).toBe('impulse-entities');
    });

    it('should have a version', () => {
      const server = createEntitiesServer();
      expect(server.version).toBe('1.0.0');
    });
  });

  // ========================================================================
  // Tool Listing
  // ========================================================================

  describe('getTools()', () => {
    it('should list available tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include entity creation tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('createCompany');
      expect(toolNames).toContain('createTechnology');
      expect(toolNames).toContain('createUseCase');
      expect(toolNames).toContain('createPrototype');
      expect(toolNames).toContain('createStrategy');
      expect(toolNames).toContain('createSignalManual');
      expect(toolNames).toContain('deleteEntity');
      expect(toolNames).toContain('createCompanyWithResearch');
    });

    it('should include enrichment tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      // enrichCompanyFromResearch was removed (AI-043).
      expect(toolNames).not.toContain('enrichCompanyFromResearch');
      expect(toolNames).toContain('enrichTechnologyFromResearch');
      expect(toolNames).toContain('bulkCreateRelations');
      expect(toolNames).toContain('bulkUpdateEntities');
      expect(toolNames).toContain('findAndLinkRelatedEntities');
      expect(toolNames).toContain('createRelationsByName');
    });

    it('should include company tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('researchCompany');
      expect(toolNames).toContain('discoverCompanyRelations');
      expect(toolNames).toContain('addCompanyNote');
      expect(toolNames).toContain('updateCompanyResearch');
    });

    it('should include new entity tools (OrgUnit, Initiative, PainPoint)', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      // OrgUnit CRUD
      expect(toolNames).toContain('searchOrgUnits');
      expect(toolNames).toContain('getOrgUnitDetails');
      expect(toolNames).toContain('createOrgUnit');
      expect(toolNames).toContain('updateOrgUnit');
      expect(toolNames).toContain('deleteOrgUnit');
      // Initiative CRUD
      expect(toolNames).toContain('searchInitiatives');
      expect(toolNames).toContain('getInitiativeDetails');
      expect(toolNames).toContain('createInitiative');
      expect(toolNames).toContain('updateInitiative');
      expect(toolNames).toContain('deleteInitiative');
      // PainPoint CRUD
      expect(toolNames).toContain('searchPainPoints');
      expect(toolNames).toContain('getPainPointDetails');
      expect(toolNames).toContain('createPainPoint');
      expect(toolNames).toContain('updatePainPoint');
      expect(toolNames).toContain('deletePainPoint');
      // Cross-entity queries
      expect(toolNames).toContain('listInitiativesByOrgUnit');
      expect(toolNames).toContain('listPainPointsByOrgUnit');
    });

    it('should include original CRUD tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('searchEntities');
      expect(toolNames).toContain('listEntities');
      expect(toolNames).toContain('getEntityDetails');
      expect(toolNames).toContain('getRelatedEntities');
      expect(toolNames).toContain('updateEntity');
      expect(toolNames).toContain('createRelation');
    });

    it('should NOT include tools from other domains', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      const toolNames = tools.map((t) => t.name);
      // These belong to other domain servers
      expect(toolNames).not.toContain('webSearch');
      expect(toolNames).not.toContain('listSignals');
      expect(toolNames).not.toContain('queryGraph');
      expect(toolNames).not.toContain('generateCypher');
      expect(toolNames).not.toContain('createRadar');
      // SKILL-049 — the review-preserving pair belongs here, but the triage
      // DECISION tools must not follow them onto this universal server.
      expect(toolNames).toContain('listPendingProposedRelations');
      expect(toolNames).toContain('proposeVerifiedRelation');
      expect(toolNames).not.toContain('approveProposedRelation');
    });

    it('should have correct tool shape (name, description, inputSchema)', () => {
      const server = createEntitiesServer();
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
      const server = createEntitiesServer();
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
      const server = createEntitiesServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { id: 'company-1', name: 'Acme Corp' },
      });

      const result = await server.callTool('createCompany', { name: 'Acme Corp' });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'createCompany', args: { name: 'Acme Corp' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBeDefined();
      // Should contain the data as JSON
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.name).toBe('Acme Corp');
    });

    it('should execute enrichment tools', async () => {
      const server = createEntitiesServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: true,
        data: { enriched: true },
      });

      const result = await server.callTool('enrichTechnologyFromResearch', { technologyId: 't-1' });
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'enrichTechnologyFromResearch', args: { technologyId: 't-1' } }),
        expect.anything()
      );
      expect(result.isError).toBeUndefined();
    });

    it('no longer exposes the removed enrichCompanyFromResearch tool (AI-043)', async () => {
      const server = createEntitiesServer();
      await expect(server.callTool('enrichCompanyFromResearch', { companyId: 'c-1' })).rejects.toThrow(
        /unknown tool.*enrichCompanyFromResearch/i
      );
    });

    it('should reject unknown tool names', async () => {
      const server = createEntitiesServer();
      await expect(server.callTool('nonExistentTool', {})).rejects.toThrow(/unknown tool.*nonExistentTool/i);
    });

    it('should reject tools from other domains', async () => {
      const server = createEntitiesServer();
      await expect(server.callTool('webSearch', { query: 'test' })).rejects.toThrow(/unknown tool.*webSearch/i);
    });

    it('should return error content when executeTool fails', async () => {
      const server = createEntitiesServer();
      mockExecuteTool.mockResolvedValueOnce({
        success: false,
        error: 'Entity not found',
      });

      const result = await server.callTool('createCompany', { name: 'Bad Corp' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Entity not found');
    });

    it('should handle executeTool throwing an exception', async () => {
      const server = createEntitiesServer();
      mockExecuteTool.mockRejectedValueOnce(new Error('Firestore connection failed'));

      const result = await server.callTool('createCompany', { name: 'Crash Corp' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Firestore connection failed');
    });

    it('should pass empty args when none provided', async () => {
      const server = createEntitiesServer();
      mockExecuteTool.mockResolvedValueOnce({ success: true, data: [] });

      await server.callTool('searchEntities', {});
      expect(mockExecuteTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'searchEntities', args: {} }),
        expect.anything()
      );
    });
  });

  // ========================================================================
  // Tool Count
  // ========================================================================

  describe('tool count', () => {
    it('should register the expected number of entity tools', () => {
      const server = createEntitiesServer();
      const tools = server.getTools();
      // entity-creation: 8
      // enrichment: 5 (enrichCompanyFromResearch removed — AI-043)
      // company-review-tools: 3 (AI-043)
      // company-tools: 4
      // new-entities-tools: 17
      // original CRUD: 6 (searchEntities, listEntities, getEntityDetails, getRelatedEntities, updateEntity, createRelation)
      // linker review-preserving pair: 2 (SKILL-049 — listPendingProposedRelations, proposeVerifiedRelation)
      // Total: 45
      expect(tools.length).toBe(45);
    });
  });
});
