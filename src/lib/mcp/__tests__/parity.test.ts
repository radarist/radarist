/**
 * MCP Parity Tests — Old (Monolithic) vs New (Domain) Servers
 *
 * Verifies that the 6 new domain MCP servers collectively cover all tools
 * from the old monolithic MCP handler (CORE_AI_TOOLS) with matching schemas.
 *
 * Parity dimensions:
 *  1. Tool coverage — every CORE_AI_TOOL exists in at least one domain server
 *  2. Schema parity — name, description, inputSchema match for key tools
 *  3. No orphaned tools — domain servers only expose tools from ALL_AI_TOOLS
 *  4. No duplicate tools within a single server
 *  5. Server metadata — all 6 servers have correct names and versions
 *  6. Execution delegation — both old and new use the same executeTool()
 *
 * @jest-environment node
 */

// ============================================================================
// Mocks — must come before imports
// ============================================================================

// Break the Firebase auth initialisation chain
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/entity-factory', () => ({ createEntity: jest.fn() }));

// Mock firebase/firestore to prevent real Firestore init
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  Timestamp: { now: jest.fn(() => ({ toDate: () => new Date() })) },
}));

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(),
}));

// ============================================================================
// Imports
// ============================================================================

import { CORE_AI_TOOLS, ALL_AI_TOOLS } from '@/lib/ai/tools';
import { convertGeminiToolsToMcpTools } from '../schema-converter';
import { createEntitiesServer } from '../servers/entities-server';
import { createGraphServer } from '../servers/graph-server';
import { createSignalsServer } from '../servers/signals-server';
import { createResearchServer } from '../servers/research-server';
import { createRadarServer } from '../servers/radar-server';
import { createReportsServer } from '../servers/reports-server';
import type { DomainMcpServer } from '../servers/entities-server';
import type { McpTool } from '../types';

// ============================================================================
// Helpers
// ============================================================================

/** Instantiate all 6 domain servers once for the whole suite. */
let servers: DomainMcpServer[];
let allDomainTools: McpTool[];
let allDomainToolNames: Set<string>;

beforeAll(() => {
  servers = [
    createEntitiesServer(),
    createGraphServer(),
    createSignalsServer(),
    createResearchServer(),
    createRadarServer(),
    createReportsServer(),
  ];

  // Flatten all domain tools into a single list
  allDomainTools = servers.flatMap((s) => s.getTools());

  // Unique names across all domain servers
  allDomainToolNames = new Set(allDomainTools.map((t) => t.name));
});

/**
 * Find a tool by name across all domain servers.
 * Returns the first match (tools should not be duplicated across servers for
 * the parity check, but reports-server and entities-server share createRelation).
 */
function findToolInDomainServers(toolName: string): McpTool | undefined {
  for (const server of servers) {
    const tool = server.getTools().find((t) => t.name === toolName);
    if (tool) return tool;
  }
  return undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('MCP Parity — Old (Monolithic) vs New (Domain Servers)', () => {
  // --------------------------------------------------------------------------
  // 1. Tool Coverage
  // --------------------------------------------------------------------------
  /**
   * CORE_AI_TOOLS members that intentionally are NOT bundled into the 6 aggregated
   * domain servers under test. These live elsewhere or were deliberately excluded:
   *  - renderDiagram / renderRadarDiagram / saveDiagram: live in their own server (super-graph-server.ts), not the 6 aggregates
   *  - generateInfographic: deliberately removed from reports-server as a
   *    duplicate image-generation surface — see reports-server.ts for rationale
   */
  const MCP_NATIVE_OR_OUT_OF_SCOPE = new Set([
    'renderDiagram',
    'renderRadarDiagram',
    'saveDiagram',
    'generateInfographic',
  ]);

  describe('Tool Coverage', () => {
    it('every CORE_AI_TOOL should exist in at least one domain server', () => {
      const coreToolNames = CORE_AI_TOOLS.map((t) => t.name);
      const missing = coreToolNames.filter(
        (name) => !allDomainToolNames.has(name) && !MCP_NATIVE_OR_OUT_OF_SCOPE.has(name)
      );

      // Provide a helpful failure message
      if (missing.length > 0) {
        console.error(`[PARITY] Missing tools in domain servers: ${missing.join(', ')}`);
      }

      expect(missing).toEqual([]);
    });

    it('should cover a non-trivial number of tools', () => {
      // CORE_AI_TOOLS is described as ~60 tools. Guard against it becoming empty.
      expect(CORE_AI_TOOLS.length).toBeGreaterThanOrEqual(50);
      expect(allDomainToolNames.size).toBeGreaterThanOrEqual(50);
    });

    it('domain servers should collectively expose >= as many tools as CORE_AI_TOOLS', () => {
      expect(allDomainToolNames.size).toBeGreaterThanOrEqual(CORE_AI_TOOLS.length);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Schema Parity
  // --------------------------------------------------------------------------
  describe('Schema Parity', () => {
    // Use the same schema converter the old server uses
    const oldMcpTools = convertGeminiToolsToMcpTools(CORE_AI_TOOLS);

    /**
     * Key tools sampled from different categories to ensure schema conversion
     * is consistent between the old monolithic path and the domain server path.
     */
    const keyToolNames = [
      'searchEntities',
      'listEntities',
      'createCompany',
      'webSearch',
      'listSignals',
      'createRadar',
      'listRadars',
      // Note: 'generateCypher' is intentionally OMITTED from CORE_AI_TOOLS
      // (see src/lib/ai/tools.ts:1945-1949 — chat default avoids raw Cypher).
      // We sample 'getEntityDetails' instead — same schema-parity coverage.
      'getEntityDetails',
      'searchKnowledgeGraph',
      'createOrgUnit',
      'createRelation',
    ];

    it.each(keyToolNames)('schema for "%s" should match between old and new', (toolName) => {
      const oldTool = oldMcpTools.find((t) => t.name === toolName);
      const newTool = findToolInDomainServers(toolName);

      // Both should exist
      expect(oldTool).toBeDefined();
      expect(newTool).toBeDefined();

      if (oldTool && newTool) {
        expect(newTool.name).toBe(oldTool.name);
        expect(newTool.description).toBe(oldTool.description);
        expect(newTool.inputSchema).toEqual(oldTool.inputSchema);
      }
    });

    it('all CORE_AI_TOOLS schemas should match between old and new', () => {
      const mismatches: string[] = [];

      for (const oldTool of oldMcpTools) {
        const newTool = findToolInDomainServers(oldTool.name);
        if (!newTool) {
          // Coverage test already catches this, skip here
          continue;
        }

        if (newTool.description !== oldTool.description) {
          mismatches.push(`${oldTool.name}: description mismatch`);
        }

        try {
          expect(newTool.inputSchema).toEqual(oldTool.inputSchema);
        } catch {
          mismatches.push(`${oldTool.name}: inputSchema mismatch`);
        }
      }

      expect(mismatches).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // 3. No Orphaned Tools
  // --------------------------------------------------------------------------
  describe('No Orphaned Tools', () => {
    it('domain servers should only expose tools from ALL_AI_TOOLS (+ MCP-native tools)', () => {
      const allToolNames = new Set(ALL_AI_TOOLS.map((t) => t.name));
      // Task 3.10: MCP-native tools not in Gemini registry are allowed
      const MCP_NATIVE_TOOLS = new Set(['queryRecentMissions', 'getMissionResults']);
      const orphaned = [...allDomainToolNames].filter((name) => !allToolNames.has(name) && !MCP_NATIVE_TOOLS.has(name));

      if (orphaned.length > 0) {
        console.error(`[PARITY] Orphaned tools in domain servers (not in ALL_AI_TOOLS): ${orphaned.join(', ')}`);
      }

      expect(orphaned).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // 4. No Duplicate Tools Within A Server
  // --------------------------------------------------------------------------
  describe('No Duplicate Tools Within A Server', () => {
    it.each([
      ['impulse-entities', 0],
      ['impulse-graph', 1],
      ['impulse-signals', 2],
      ['impulse-research', 3],
      ['impulse-radar', 4],
      ['impulse-reports', 5],
    ])('%s should have no duplicate tool names', (serverName, serverIndex) => {
      const server = servers[serverIndex];
      expect(server.name).toBe(serverName);

      const tools = server.getTools();
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);

      const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx);

      if (duplicates.length > 0) {
        console.error(`[PARITY] Duplicate tools in ${serverName}: ${duplicates.join(', ')}`);
      }

      expect(duplicates).toEqual([]);
      expect(names.length).toBe(uniqueNames.size);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Server Metadata
  // --------------------------------------------------------------------------
  describe('Server Metadata', () => {
    const expectedServers = [
      { name: 'impulse-entities', minTools: 5 },
      { name: 'impulse-graph', minTools: 5 },
      { name: 'impulse-signals', minTools: 5 },
      { name: 'impulse-research', minTools: 2 },
      { name: 'impulse-radar', minTools: 5 },
      { name: 'impulse-reports', minTools: 5 },
    ];

    it('should have exactly 6 domain servers', () => {
      expect(servers).toHaveLength(6);
    });

    it.each(expectedServers)('$name should have correct name, version, and minimum tools', ({ name, minTools }) => {
      const server = servers.find((s) => s.name === name);
      expect(server).toBeDefined();
      expect(server!.version).toBe('1.0.0');
      expect(server!.getTools().length).toBeGreaterThanOrEqual(minTools);
    });

    it('all servers should return consistent tool arrays (immutability)', () => {
      for (const server of servers) {
        const first = server.getTools();
        const second = server.getTools();

        // Should return equal arrays
        expect(first.map((t) => t.name)).toEqual(second.map((t) => t.name));

        // But different array references (getTools returns a copy)
        expect(first).not.toBe(second);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. Execution Delegation
  // --------------------------------------------------------------------------
  describe('Execution Delegation', () => {
    it('all domain servers should have a callable callTool method', () => {
      for (const server of servers) {
        expect(typeof server.callTool).toBe('function');
      }
    });

    it('callTool should reject unknown tool names', async () => {
      for (const server of servers) {
        await expect(server.callTool('nonExistentTool_12345', {})).rejects.toThrow(/unknown tool/i);
      }
    });

    it('domain servers should only accept their own tools', async () => {
      // Each server should reject tools that belong to another server
      const entitiesServer = servers.find((s) => s.name === 'impulse-entities')!;
      const graphServer = servers.find((s) => s.name === 'impulse-graph')!;

      // Get a graph tool name that is NOT in entities
      const graphToolNames = new Set(graphServer.getTools().map((t) => t.name));
      const entitiesToolNames = new Set(entitiesServer.getTools().map((t) => t.name));

      const graphOnlyTool = [...graphToolNames].find((name) => !entitiesToolNames.has(name));

      if (graphOnlyTool) {
        await expect(entitiesServer.callTool(graphOnlyTool, {})).rejects.toThrow(/unknown tool/i);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 7. Cross-server Tool Distribution
  // --------------------------------------------------------------------------
  describe('Cross-server Tool Distribution', () => {
    it('should not have excessive cross-server overlap', () => {
      // Some overlap is expected (e.g. createRelation in both entities and reports).
      // But most tools should appear in exactly one server.
      const toolServerMap = new Map<string, string[]>();

      for (const server of servers) {
        for (const tool of server.getTools()) {
          const existing = toolServerMap.get(tool.name) ?? [];
          existing.push(server.name);
          toolServerMap.set(tool.name, existing);
        }
      }

      const duplicatedAcrossServers = [...toolServerMap.entries()]
        .filter(([, serverNames]) => serverNames.length > 1)
        .map(([name, serverNames]) => `${name} -> [${serverNames.join(', ')}]`);

      // Allow up to a small number of cross-server duplicates (e.g. createRelation)
      expect(duplicatedAcrossServers.length).toBeLessThanOrEqual(10);
    });

    it('every non-empty server should contribute unique tools', () => {
      // Each server should have at least 1 tool that no other server has
      for (const server of servers) {
        const myTools = new Set(server.getTools().map((t) => t.name));
        const otherTools = new Set(
          servers.filter((s) => s.name !== server.name).flatMap((s) => s.getTools().map((t) => t.name))
        );

        const uniqueToThisServer = [...myTools].filter((name) => !otherTools.has(name));

        expect(uniqueToThisServer.length).toBeGreaterThan(0);
      }
    });
  });
});
