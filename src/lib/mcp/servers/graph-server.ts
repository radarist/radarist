/**
 * @file mcp/servers/graph-server.ts
 * @description Impulse Graph Domain MCP Server
 *
 * Wraps existing GraphRAG, Knowledge Graph, and Cypher query tools
 * into the MCP protocol format.
 *
 * This is a thin wrapper around existing tool infrastructure:
 * - Tool declarations are converted from Gemini FunctionDeclaration to MCP format
 * - Tool execution delegates to the existing executeTool() from tools.ts
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { FunctionDeclaration } from '@google/generative-ai';
import { GRAPH_TOOLS } from '@/lib/ai/tools/graph-tools';
import { KNOWLEDGE_TOOLS } from '@/lib/ai/tools/knowledge-tools';
import { CYPHER_TOOLS } from '@/lib/ai/tools/cypher-tools';
import { ANALYTICS_TOOLS } from '@/lib/ai/tools/analytics-tools';
import { GDS_TOOLS } from '@/lib/ai/tools/gds-tools';
import { TEMPORAL_TOOLS } from '@/lib/ai/tools/temporal-tools';
import { ASSERTIONS_TOOLS } from '@/lib/ai/tools/assertions-tools';
import { INTEREST_TOOLS } from '@/lib/ai/tools/interest-tools';
import { executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';
import { sanitizeNeo4jErrorMessage } from '@/lib/graph/neo4j-client';

const log = createLogger('mcp/graph-server');

function toolPayload(result: Awaited<ReturnType<typeof executeTool>>): unknown {
  if (result.data !== undefined) return result.data;

  // Several legacy executors, including the Cypher tools, return their
  // contract fields at the top level. Preserve that real dispatcher shape at
  // the MCP boundary instead of silently serializing `data: undefined`.
  const { success: _success, ...payload } = result as Awaited<ReturnType<typeof executeTool>> &
    Record<string, unknown>;
  return payload;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the graph domain.
 */
function collectGraphToolDeclarations(): FunctionDeclaration[] {
  const allDeclarations = [
    ...GRAPH_TOOLS,
    ...KNOWLEDGE_TOOLS,
    ...CYPHER_TOOLS,
    ...ANALYTICS_TOOLS,
    ...GDS_TOOLS,
    ...TEMPORAL_TOOLS,
    ...ASSERTIONS_TOOLS,
    ...INTEREST_TOOLS,
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
 * Create the impulse-graph domain MCP server.
 *
 * This factory collects graph-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for graph operations
 */
export function createGraphServer(): DomainMcpServer {
  const declarations = collectGraphToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  // Task 3.10: Agent memory tools for chat to query mission history
  const MEMORY_TOOLS: McpTool[] = [
    {
      name: 'queryRecentMissions',
      description:
        'Query recent agent missions/episodes. Use when user asks "what did Scout find?" or "what happened in the last sweep?"',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Filter by agent name (scout, evaluator, linker, etc.)' },
          hours: { type: 'number', description: 'Look back N hours (default: 24)' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
    {
      name: 'getMissionResults',
      description: 'Get detailed results from a specific mission/episode including discovered entities.',
      inputSchema: {
        type: 'object',
        properties: {
          episodeId: { type: 'string', description: 'Episode ID to look up' },
        },
        required: ['episodeId'],
      },
    },
  ];

  const allTools = [...mcpTools, ...MEMORY_TOOLS];
  const _allToolNames = new Set(allTools.map((t) => t.name));

  log.info('Graph MCP server created', { toolCount: allTools.length });

  return {
    name: 'impulse-graph',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...allTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      // Task 3.10: Handle memory tools directly (not in Gemini tool registry)
      if (name === 'queryRecentMissions') {
        try {
          const { queryEpisodes } = await import('@/lib/graph/episodes');
          const hours = (args.hours as number) ?? 24;
          const episodes = await queryEpisodes({
            userId: context?.userId,
            agentName: args.agentName as string | undefined,
            since: new Date(Date.now() - hours * 60 * 60 * 1000),
            limit: (args.limit as number) ?? 10,
            // Agent/MCP surface (M14): sweep/discovery episodes run as system
            // principals — without this, "what happened in the last sweep?"
            // is guaranteed empty for every caller.
            includeSystem: true,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, episodes }) }] };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: (error as Error).message }) }],
            isError: true,
          };
        }
      }

      if (name === 'getMissionResults') {
        try {
          // H13: traverse CONTAINS so the tool returns what the mission
          // actually observed, not an empty Episode shell.
          const { getEpisodeWithObservations } = await import('@/lib/graph/episodes');
          const result = await getEpisodeWithObservations(args.episodeId as string);
          if (!result) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Episode not found' }) }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, episode: result.episode, observations: result.observations }),
              },
            ],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: (error as Error).message }) }],
            isError: true,
          };
        }
      }

      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-graph server.`);
      }

      try {
        // missionId/slots intentionally not forwarded — only reports-server tools
        // consume them as of Task 5; revisit when a tool on this server needs them.
        const result = await executeTool({ name, args }, { userId: context?.userId ?? 'anonymous' });

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: sanitizeNeo4jErrorMessage(result.error ?? 'Tool execution failed'),
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
                data: toolPayload(result),
              }),
            },
          ],
        };
      } catch (error) {
        const message = sanitizeNeo4jErrorMessage(error instanceof Error ? error.message : String(error));
        const errorObj = new Error(message);
        log.error('Tool execution error', errorObj, { tool: name });

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
