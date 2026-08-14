/**
 * @file mcp/servers/research-server.ts
 * @description Impulse Research Domain MCP Server
 *
 * Wraps existing web research and page research tools
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
import { WEB_RESEARCH_TOOLS } from '@/lib/ai/tools/web-research';
import { PAGE_RESEARCH_TOOLS } from '@/lib/ai/tools/page-research';
import { DEEP_RESEARCH_TOOLS } from '@/lib/ai/tools/deep-research-tools';
import { PRIMARY_SOURCE_TOOLS } from '@/lib/ai/tools/primary-source-tools';
import { CAPABILITY_TOOLS } from '@/lib/ai/tools/capability-tools';
import { executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/research-server');

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the research domain.
 */
function collectResearchToolDeclarations(): FunctionDeclaration[] {
  const allDeclarations = [
    ...WEB_RESEARCH_TOOLS,
    ...PAGE_RESEARCH_TOOLS,
    ...DEEP_RESEARCH_TOOLS,
    ...PRIMARY_SOURCE_TOOLS,
    ...CAPABILITY_TOOLS,
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
 * Create the impulse-research domain MCP server.
 *
 * This factory collects research-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for research operations
 */
export function createResearchServer(): DomainMcpServer {
  const declarations = collectResearchToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  log.info('Research MCP server created', { toolCount: mcpTools.length });

  return {
    name: 'impulse-research',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...mcpTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-research server.`);
      }

      try {
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
