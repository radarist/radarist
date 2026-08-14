/**
 * @file mcp/servers/entities-server.ts
 * @description Impulse Entities Domain MCP Server
 *
 * First of 6 domain MCP servers. Wraps existing entity CRUD tools
 * (creation, enrichment, company operations, org units, initiatives,
 * pain points) into the MCP protocol format.
 *
 * This is a thin wrapper around existing tool infrastructure:
 * - Tool declarations are converted from Gemini FunctionDeclaration to MCP format
 * - Tool execution delegates to the existing executeTool() from tools.ts
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { FunctionDeclaration } from '@google/generative-ai';
import { externalToolFailureToMcp, externalToolResultToMcp } from '@/lib/mcp/external-tool-result';
import { ENTITY_CREATION_TOOLS } from '@/lib/ai/tools/entity-creation';
import { ENRICHMENT_TOOLS } from '@/lib/ai/tools/enrichment';
import { COMPANY_REVIEW_TOOLS } from '@/lib/ai/tools/company-review-tools';
import { COMPANY_TOOLS } from '@/lib/ai/tools/company-tools';
import { NEW_ENTITIES_TOOLS } from '@/lib/ai/tools/new-entities-tools';
import { LINKER_TOOLS } from '@/lib/ai/tools/linker-tools';
import { AI_TOOLS, executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { Slot } from '@/lib/schemas/mission';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/entities-server');

// ============================================================================
// Types
// ============================================================================

/**
 * Domain MCP Server interface.
 *
 * This abstraction allows testing tool registration and execution
 * independently of the transport layer (HTTP/SSE). Task 2.8 will
 * wire these into actual MCP SDK McpServer instances with transports.
 */
/**
 * Context passed from the MCP HTTP route to domain server tool execution.
 * Carries the authenticated userId so tools that require it (startMission,
 * listUserMissions, createResearchDocument, generateInfographic,
 * generateVisualization) receive proper auth context.
 */
export interface McpCallContext {
  /** Authenticated user ID from API key or IMPULSE_INTERNAL_KEY */
  userId: string;
  /** Mission ID when the MCP call originates from a mission orchestrator */
  missionId?: string;
  /** Frozen slot manifest from the mission record */
  slots?: Slot[];
  /** Visual design brief from the mission record (design-pass) — read by the
   *  chart renderer (super-graph) and the infographic generator (gemini-image). */
  designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
  /** Exact research bundle parsed from the persisted mission input. */
  evidenceBundle?: import('@/lib/schemas/scout-bundle').ScoutBundle;
  /** Firestore-resolution receipt for the exact persisted evidence bundle. */
  evidenceProvenance?: import('@/lib/schemas/scout-bundle').EvidenceProvenanceReceipt;
}

export interface DomainMcpServer {
  /** Server name (e.g., 'impulse-entities') */
  readonly name: string;
  /** Server version */
  readonly version: string;
  /** List all registered tools in MCP format */
  getTools(): McpTool[];
  /** Execute a tool by name with the given arguments and auth context */
  callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult>;
}

// ============================================================================
// Tool Selection
// ============================================================================

/**
 * Original CRUD tool names from AI_TOOLS (defined inline in tools.ts).
 * These are the generic entity operations that belong in the entities domain.
 */
const ORIGINAL_CRUD_TOOL_NAMES = [
  'searchEntities',
  'listEntities',
  'getEntityDetails',
  'getRelatedEntities',
  'updateEntity',
] as const;

/**
 * Tool names from LINKER_TOOLS that belong in the entities domain.
 *
 * `createRelation` is the direct, human-authorized write. SKILL-049 adds the
 * REVIEW-PRESERVING pair beside it, because the alternative was worse: they
 * mounted only on `impulse-reports`, which only the creator profile carries, so
 * the **linker** profile — whose entire job is discovering relationships — could
 * not propose one. Six served skills instructed it to, and it had to fall back
 * to `recordAgentObservation`.
 *
 * The pair is deliberately narrow, and it widens no profile's authority:
 *
 * - `proposeVerifiedRelation` (`write`) can only reach a PENDING proposal that
 *   still needs a separate human decision. Every profile mounting this universal
 *   server already holds `bulkCreateRelations`, `createRelationsByName`,
 *   `findAndLinkRelatedEntities` (no principal gate, real edge) and
 *   `createRelationWithEvidence` (universal via `impulse-graph`). The proposal
 *   path is therefore a strictly WEAKER terminal state than what is already
 *   reachable — a safer route to something already permitted, not a new power.
 * - `listPendingProposedRelations` (`read`) reads back the proposals those same
 *   agents author. Reading the outcome of a write you already hold is not an
 *   escalation, and there is no mutation path from it.
 *
 * Deliberately NOT here: `approveProposedRelation`, `rejectProposedRelation`,
 * `dismissProposedRelation`, `bulkApproveHighConfidenceProposals` — the
 * `signals`-class DECISION tools. Approval additionally refuses every
 * `principal !== 'human'` caller before it reads the proposal, and no MCP or
 * mission surface can set `principal: 'human'`, so existing authorization
 * permits machine approval nowhere; mounting it here would publish a tool that
 * could only ever refuse. Reject/dismiss ARE machine-executable and would be a
 * real widening.
 *
 * Pinned by `src/lib/ai/__tests__/linker-relation-proposal-authority.test.ts`,
 * which derives the whole profile/server/tool matrix from the live registries.
 */
const LINKER_ENTITY_TOOL_NAMES = ['createRelation', 'proposeVerifiedRelation', 'listPendingProposedRelations'] as const;

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the entities domain.
 */
function collectEntityToolDeclarations(): FunctionDeclaration[] {
  // Original CRUD tools from AI_TOOLS (inline in tools.ts)
  const originalCrudTools = AI_TOOLS.filter((t) => (ORIGINAL_CRUD_TOOL_NAMES as readonly string[]).includes(t.name));

  // createRelation from LINKER_TOOLS
  const linkerEntityTools = LINKER_TOOLS.filter((t) =>
    (LINKER_ENTITY_TOOL_NAMES as readonly string[]).includes(t.name)
  );

  // Combine all entity domain tools
  const allDeclarations = [
    ...ENTITY_CREATION_TOOLS,
    ...ENRICHMENT_TOOLS,
    ...COMPANY_REVIEW_TOOLS,
    ...COMPANY_TOOLS,
    ...NEW_ENTITIES_TOOLS,
    ...originalCrudTools,
    ...linkerEntityTools,
  ];

  // Deduplicate by name (first occurrence wins)
  const seen = new Set<string>();
  const deduped: FunctionDeclaration[] = [];
  for (const decl of allDeclarations) {
    if (!seen.has(decl.name)) {
      seen.add(decl.name);
      deduped.push(decl);
    }
  }

  return deduped;
}

/**
 * Create the impulse-entities domain MCP server.
 *
 * This factory collects entity-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for entity operations
 */
export function createEntitiesServer(): DomainMcpServer {
  const declarations = collectEntityToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  log.info('Entities MCP server created', { toolCount: mcpTools.length });

  return {
    name: 'impulse-entities',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...mcpTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-entities server.`);
      }

      try {
        // missionId/slots intentionally not forwarded — only reports-server tools
        // consume them as of Task 5; revisit when a tool on this server needs them.
        const result = await executeTool({ name, args }, { userId: context?.userId ?? 'anonymous' });

        const externalResult = externalToolResultToMcp(name, result);
        if (externalResult) return externalResult;

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: result.error ?? 'Tool execution failed',
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                data: result.data,
              }),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorObj = error instanceof Error ? error : new Error(message);
        log.error('Tool execution error', errorObj, { tool: name });

        const externalFailure = externalToolFailureToMcp(name, error);
        if (externalFailure) return externalFailure;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  };
}
