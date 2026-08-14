/**
 * @file mcp/servers/radar-server.ts
 * @description Impulse Radar Domain MCP Server
 *
 * Wraps existing radar management and technology-decoupled tools
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
import { externalToolFailureToMcp, externalToolResultToMcp } from '@/lib/mcp/external-tool-result';
import { RADAR_MANAGEMENT_TOOLS } from '@/lib/ai/tools/radar-management';
import { TECHNOLOGY_DECOUPLED_TOOLS } from '@/lib/ai/tools/technology-decoupled';
import { executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/radar-server');

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the radar domain.
 */
function collectRadarToolDeclarations(): FunctionDeclaration[] {
  const allDeclarations = [...RADAR_MANAGEMENT_TOOLS, ...TECHNOLOGY_DECOUPLED_TOOLS];

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
 * Create the impulse-radar domain MCP server.
 *
 * This factory collects radar-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for radar operations
 */
export function createRadarServer(): DomainMcpServer {
  const declarations = collectRadarToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  log.info('Radar MCP server created', { toolCount: mcpTools.length });

  return {
    name: 'impulse-radar',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...mcpTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-radar server.`);
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
