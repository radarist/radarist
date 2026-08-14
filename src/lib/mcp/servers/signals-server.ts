/**
 * @file mcp/servers/signals-server.ts
 * @description Impulse Signals Domain MCP Server
 *
 * Wraps existing signal management and pipeline tools
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
import { SIGNAL_MANAGEMENT_TOOLS } from '@/lib/ai/tools/signal-management';
import { PIPELINE_TOOLS } from '@/lib/ai/tools/pipeline-tools';
import { executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/signals-server');

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the signals domain.
 */
function collectSignalsToolDeclarations(): FunctionDeclaration[] {
  const allDeclarations = [...SIGNAL_MANAGEMENT_TOOLS, ...PIPELINE_TOOLS];

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
 * Create the impulse-signals domain MCP server.
 *
 * This factory collects signal-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for signal operations
 */
export function createSignalsServer(): DomainMcpServer {
  const declarations = collectSignalsToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  log.info('Signals MCP server created', { toolCount: mcpTools.length });

  return {
    name: 'impulse-signals',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...mcpTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-signals server.`);
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
