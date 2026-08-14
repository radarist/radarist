/**
 * @file mcp/servers/reports-server.ts
 * @description Impulse Reports Domain MCP Server
 *
 * Wraps existing document, assertions, and linker triage tools
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
import { DOCUMENT_TOOLS, DOCUMENT_WRITE_TOOLS } from '@/lib/ai/tools/document-tools';
import { ASSERTIONS_TOOLS } from '@/lib/ai/tools/assertions-tools';
import { LINKER_TOOLS } from '@/lib/ai/tools/linker-tools';
import { REPORT_TOOLS } from '@/lib/ai/tools/report-tools';
import { MISSION_TOOLS } from '@/lib/ai/tools/mission-tools';
import { VISUALIZATION_TOOLS } from '@/lib/ai/tools/visualization-tools';
import { executeTool } from '@/lib/ai/tools';
import { convertGeminiToolToMcpTool } from '../schema-converter';
import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/reports-server');

// ============================================================================
// Factory
// ============================================================================

/**
 * Collect all Gemini FunctionDeclarations that belong to the reports domain.
 */
function collectReportsToolDeclarations(): FunctionDeclaration[] {
  // Bug I: drop generateInfographic from the reports MCP bundling. It is a
  // functional duplicate of mcp__gemini-image__generate_image (both call
  // generateInfographic() in image-client.ts; both return a non-persistent
  // Firebase Storage URL under /infographics/). Exposing both can make the
  // agent flip-flop between equivalent paths. Keeping
  // only generateVisualization here (which is genuinely different — it
  // persists to the visualizations Firestore collection for the browseable
  // /visualizations page). The chat path (CORE_AI_TOOLS) keeps both
  // declarations unchanged.
  const visualizationToolsForReports = VISUALIZATION_TOOLS.filter((t) => t.name !== 'generateInfographic');

  const allDeclarations = [
    ...DOCUMENT_TOOLS,
    ...DOCUMENT_WRITE_TOOLS,
    ...ASSERTIONS_TOOLS,
    ...LINKER_TOOLS,
    ...REPORT_TOOLS,
    ...MISSION_TOOLS,
    ...visualizationToolsForReports,
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
 * Create the impulse-reports domain MCP server.
 *
 * This factory collects reports-related tool declarations, converts them
 * to MCP format, and returns a server object that can list and call tools.
 *
 * @returns A DomainMcpServer instance for reports operations
 */
export function createReportsServer(): DomainMcpServer {
  const declarations = collectReportsToolDeclarations();
  const mcpTools = declarations.map(convertGeminiToolToMcpTool);
  const toolNameSet = new Set(mcpTools.map((t) => t.name));

  log.info('Reports MCP server created', { toolCount: mcpTools.length });

  return {
    name: 'impulse-reports',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [...mcpTools];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      if (!toolNameSet.has(name)) {
        throw new Error(`Unknown tool: ${name}. This tool is not registered on the impulse-reports server.`);
      }

      try {
        const result = await executeTool(
          { name, args },
          {
            userId: context?.userId ?? 'anonymous',
            missionId: context?.missionId,
            slots: context?.slots,
            designBrief: context?.designBrief,
            evidenceBundle: context?.evidenceBundle,
            evidenceProvenance: context?.evidenceProvenance,
          }
        );

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
