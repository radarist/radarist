/**
 * @file mcp/server.ts
 * @description MCP Server Core - Handles JSON-RPC protocol for MCP
 *
 * This module provides the core MCP server implementation that:
 * 1. Handles JSON-RPC 2.0 requests
 * 2. Authenticates via API keys
 * 3. Maps MCP methods to platform functionality
 * 4. Executes AI tools via the existing executeTool function
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import { validateApiKey } from './api-keys';
import { convertGeminiToolsToMcpTools } from './schema-converter';
import { canExecuteTool, getToolPermissions, isMissionBoundTool, missionBoundToolGuidance } from './permissions';
import {
  handlePromptResourceMethod,
  isPromptResourceMethod,
  PROMPT_RESOURCE_CAPABILITIES,
} from './prompt-resource-methods';
import { externalToolFailureToMcp, externalToolResultToMcp } from './external-tool-result';

import { wrapFactAsserting } from './grounding-wrap';
import { CORE_AI_TOOLS, executeTool } from '@/lib/ai/tools';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  McpInitializeResult,
  McpTool,
  McpToolCallParams,
  McpToolCallResult,
  McpContext,
  ApiKey,
} from './types';
import { JSON_RPC_ERROR_CODES } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp/server');

// ============================================================================
// Constants
// ============================================================================

const MCP_PROTOCOL_VERSION = '2024-11-05';

const SERVER_INFO = {
  name: 'radarist-mcp',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {
    listChanged: false, // We don't support dynamic tool changes yet
  },
  // Resources and prompts are advertised only because this gateway actually
  // serves them (L3 Memory-as-resources / L2 Skills-as-prompts). The capability
  // block and the real handlers ship from the same module, so a transport can
  // never advertise a surface that answers `Method not found`.
  ...PROMPT_RESOURCE_CAPABILITIES,
};

// ============================================================================
// Response Builders
// ============================================================================

/**
 * Create a successful JSON-RPC response
 */
function createResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Create an error JSON-RPC response
 */
function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

// ============================================================================
// MCP Method Handlers
// ============================================================================

/**
 * Handle 'initialize' method
 * Returns server capabilities and protocol version
 */
function handleInitialize(): McpInitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
  };
}

/**
 * Handle 'tools/list' method
 * Returns all available tools based on user permissions
 */
function handleToolsList(apiKey: ApiKey): { tools: McpTool[] } {
  // Use CORE_AI_TOOLS instead of ALL_AI_TOOLS
  // External AI assistants like ChatGPT work better with fewer, well-curated tools
  // This matches the curated set used by our internal Gemini AI Chat
  const allMcpTools = convertGeminiToolsToMcpTools(CORE_AI_TOOLS);

  // Filter tools based on permissions. Mission-bound tools (draftReport,
  // publishReport) are hidden entirely: this endpoint has no mission-binding
  // mechanism (no x-mission-id header), so advertising them is a guaranteed
  // dead end — external clients reach reports via startMission instead.
  const accessibleTools = allMcpTools.filter(
    (tool) => !isMissionBoundTool(tool.name) && canExecuteTool(apiKey.permissions, tool.name)
  );

  log.info('tools/list', { accessible: accessibleTools.length, total: allMcpTools.length, userId: apiKey.userId });

  return { tools: accessibleTools };
}

/**
 * Handle 'tools/call' method
 * Executes a tool and returns the result
 */
async function handleToolsCall(params: McpToolCallParams, apiKey: ApiKey): Promise<McpToolCallResult> {
  const { name, arguments: args } = params;

  if (!name) {
    throw {
      code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      message: 'Tool name is required',
    };
  }

  // Check permission for this tool
  if (!canExecuteTool(apiKey.permissions, name)) {
    const required = getToolPermissions(name);
    log.warn('Permission denied for tool', { name, required, permissions: apiKey.permissions });
    throw {
      code: JSON_RPC_ERROR_CODES.FORBIDDEN,
      message: `Permission denied for tool: ${name}. Required permissions: ${required.join(', ')}`,
    };
  }

  // Mission-bound tools can never succeed on this endpoint (no mission
  // context exists here) — return a self-remediating error instead of the
  // opaque "missionId not bound" the executor would produce.
  if (isMissionBoundTool(name)) {
    log.info('Mission-bound tool called without mission context', { name, userId: apiKey.userId });
    return {
      content: [
        {
          type: 'text',
          text: missionBoundToolGuidance(name),
        },
      ],
      isError: true,
    };
  }

  log.info('Executing tool', { name, userId: apiKey.userId });

  try {
    // Execute using the existing tool executor, attributing the call to the
    // API key's owner. This is the same context shape the in-app chat route
    // builds from Firebase auth (`{ userId: auth.uid }`) — without it, tools
    // that dispatch async work (startMission, createResearchDocument) or
    // scope data per-user (listReports, …) reject with
    // 'requires an authenticated user context'.
    const result = await executeTool(
      {
        name,
        args: args || {},
      },
      { userId: apiKey.userId }
    );

    // SEC-010 — tool results carrying externally-authored text (scraped pages,
    // search snippets, upstream abstracts) get the same untrusted-data envelope
    // this server already applies to resource and prompt bodies. Without it the
    // `## Presentation Guidance` preamble below would sit directly beside raw
    // external prose in the host's context. First-party platform results pass
    // through by identity, so their formatting is byte-identical.
    const externalResult = externalToolResultToMcp(name, result);
    if (externalResult) return externalResult;

    // Convert to MCP format with rich formatting
    if (result.success) {
      const formattedResponse = formatToolResponse(name, result.data, args || {});
      return {
        content: [
          {
            type: 'text',
            text: formattedResponse,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: result.error || 'Tool execution failed',
          },
        ],
        isError: true,
      };
    }
  } catch (error) {
    log.error('Tool execution error', error instanceof Error ? error : undefined, { name });
    const externalFailure = externalToolFailureToMcp(name, error);
    if (externalFailure) return externalFailure;
    throw {
      code: JSON_RPC_ERROR_CODES.TOOL_EXECUTION_ERROR,
      message: error instanceof Error ? error.message : 'Tool execution failed',
    };
  }
}

// ============================================================================
// Response Formatting
// ============================================================================

/**
 * Format tool responses with rich context to help AI assistants present data nicely.
 * Adds formatting hints, summaries, and structured presentation guidance.
 */
function formatToolResponse(toolName: string, data: unknown, args: Record<string, unknown>): string {
  // Get formatting hints based on tool and data
  const formattingHint = getFormattingHint(toolName, data, args);

  // Build the response with context
  const response: string[] = [];

  // Add formatting guidance
  if (formattingHint) {
    response.push(`## Presentation Guidance\n${formattingHint}\n`);
  }

  // Add summary for list results
  const summary = generateResultSummary(toolName, data);
  if (summary) {
    response.push(`## Summary\n${summary}\n`);
  }

  // Add the actual data
  response.push(`## Data\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);

  return response.join('\n');
}

/**
 * Generate formatting hints based on the tool and result type
 */
function getFormattingHint(toolName: string, data: unknown, args: Record<string, unknown>): string | null {
  // Entity list tools
  if (toolName === 'listEntities' || toolName === 'searchEntities') {
    const entityType = args.entityType as string;
    return `Present this as a **formatted table** with columns appropriate for ${entityType}:
- For technologies: Name, Description, Category, Tags, Status
- For companies: Name, Type, Industry, Status, Website
- For strategies: Name, Description, Status, Priority
- For prototypes: Name, Description, Status, Phase
- For useCases: Name, Description, Status
- For orgUnits: Name, Description, Type
- For initiatives: Name, Description, Status, Priority
- For painPoints: Name, Description, Severity, Status

Include a count at the top (e.g., "Found X ${entityType}(s)").`;
  }

  // Radar tools
  if (toolName === 'listRadars') {
    return `Present this as a **formatted table** with columns: Name, Description, Ring System, Technology Count.
Add a summary line at the top with total radar count.`;
  }

  if (toolName === 'getRadarDetails') {
    return `Present the radar details with:
1. **Radar Info**: Name, description, ring system, quadrants
2. **Technologies Table**: Name, Quadrant, Ring, Status, TRL, Description (truncated)
3. **Statistics**: Total technologies, count per quadrant, count per ring

Use markdown tables for best readability.`;
  }

  // Signal tools
  if (toolName === 'listSignals') {
    return `Present signals as a **formatted table** with columns: Title, Type, Status, Source, Date, Relevance Score.
Group by status if showing multiple statuses. Include count summary at top.`;
  }

  // Entity details
  if (toolName === 'getEntityDetails') {
    return `Present the entity details in a well-formatted way:
- Show the name prominently
- List key fields with labels
- Format dates nicely
- Show relationships if present`;
  }

  // Graph/relationship tools
  if (toolName === 'getRelatedEntities' || toolName === 'queryGraph' || toolName === 'getGraphNeighbors') {
    return `Present relationships as:
1. A summary of connections found
2. A list or table showing: Related Entity, Type, Relationship Type
3. Group by relationship type if many results`;
  }

  // Knowledge search
  if (toolName === 'searchKnowledgeGraph') {
    return `Present knowledge search results with:
1. Summary of what was found
2. Entities found (as a list with brief descriptions)
3. Relevant document excerpts (if any)
4. Key concepts mentioned`;
  }

  return null;
}

/**
 * Generate a summary of the results for quick understanding
 */
function generateResultSummary(toolName: string, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;

  const dataObj = data as Record<string, unknown>;

  // Handle arrays (list results)
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return 'No results found.';
    }
    return `Found ${data.length} result(s).`;
  }

  // Handle objects with results array
  if (dataObj.results && Array.isArray(dataObj.results)) {
    const results = dataObj.results as unknown[];
    if (results.length === 0) {
      return 'No results found.';
    }
    return `Found ${results.length} result(s).`;
  }

  // Handle objects with items array
  if (dataObj.items && Array.isArray(dataObj.items)) {
    const items = dataObj.items as unknown[];
    if (items.length === 0) {
      return 'No items found.';
    }
    return `Found ${items.length} item(s).`;
  }

  // Handle radar details
  if (dataObj.radar && dataObj.technologies) {
    const techs = dataObj.technologies as unknown[];
    return `Radar "${(dataObj.radar as Record<string, unknown>).name}" has ${techs.length} technologies.`;
  }

  // Handle entity details
  if (dataObj.name && dataObj.id) {
    return `Details for "${dataObj.name}" (ID: ${dataObj.id})`;
  }

  return null;
}

// ============================================================================
// Request Processing
// ============================================================================

/**
 * Parse and validate a JSON-RPC request
 */
function parseRequest(body: unknown): JsonRpcRequest {
  if (!body || typeof body !== 'object') {
    throw {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: 'Invalid JSON-RPC request body',
    };
  }

  const req = body as Record<string, unknown>;

  if (req.jsonrpc !== '2.0') {
    throw {
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Invalid JSON-RPC version, expected 2.0',
    };
  }

  if (typeof req.method !== 'string') {
    throw {
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Method must be a string',
    };
  }

  return {
    jsonrpc: '2.0',
    id: (req.id as string | number | null) ?? null,
    method: req.method as string,
    params: (req.params as Record<string, unknown>) || {},
  };
}

/**
 * Extract API key from authorization header
 */
function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  // Support both "Bearer <key>" and raw key
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return authHeader;
}

// ============================================================================
// Main Handler
// ============================================================================

export interface McpHandlerOptions {
  authHeader: string | null;
  body: unknown;
}

export interface McpHandlerResult {
  response: JsonRpcResponse;
  status: number;
}

/**
 * Main MCP request handler
 *
 * This is the entry point for all MCP requests. It:
 * 1. Validates the JSON-RPC request
 * 2. Authenticates via API key
 * 3. Routes to the appropriate method handler
 * 4. Returns a JSON-RPC response
 *
 * @param options - Request options including auth header and body
 * @returns Response object with JSON-RPC response and HTTP status
 */
export async function handleMcpRequest(options: McpHandlerOptions): Promise<McpHandlerResult> {
  const { authHeader, body } = options;

  let request: JsonRpcRequest;

  // Parse request
  try {
    request = parseRequest(body);
  } catch (error) {
    const err = error as { code: number; message: string };
    return {
      response: createErrorResponse(null, err.code, err.message),
      status: 400,
    };
  }

  // Methods that don't require authentication
  const publicMethods = ['initialize', 'initialized', 'ping'];

  if (publicMethods.includes(request.method)) {
    return handlePublicMethod(request);
  }

  // Authenticate for protected methods
  const apiKeyString = extractApiKey(authHeader);

  if (!apiKeyString) {
    return {
      response: createErrorResponse(
        request.id,
        JSON_RPC_ERROR_CODES.UNAUTHORIZED,
        'API key required. Provide via Authorization header.'
      ),
      status: 401,
    };
  }

  const apiKey = await validateApiKey(apiKeyString);

  if (!apiKey) {
    return {
      response: createErrorResponse(request.id, JSON_RPC_ERROR_CODES.UNAUTHORIZED, 'Invalid or expired API key'),
      status: 401,
    };
  }

  // Build context
  const context: McpContext = { apiKey };

  // Route to method handler
  return handleProtectedMethod(request, context);
}

/**
 * Handle public methods (no auth required)
 */
function handlePublicMethod(request: JsonRpcRequest): McpHandlerResult {
  switch (request.method) {
    case 'initialize':
      return {
        response: createResponse(request.id, handleInitialize()),
        status: 200,
      };

    case 'initialized':
      // Notification - no response needed, but we'll acknowledge
      return {
        response: createResponse(request.id, {}),
        status: 200,
      };

    case 'ping':
      return {
        response: createResponse(request.id, { pong: true }),
        status: 200,
      };

    default:
      return {
        response: createErrorResponse(
          request.id,
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown public method: ${request.method}`
        ),
        status: 404,
      };
  }
}

/**
 * Handle protected methods (auth required)
 */
async function handleProtectedMethod(request: JsonRpcRequest, context: McpContext): Promise<McpHandlerResult> {
  const { apiKey } = context;

  try {
    // `prompts/*` and `resources/*` are served from the one shared
    // implementation (SKILL-042), so this gateway and the per-domain
    // dispatcher cannot drift on permissions, budget, or the
    // no-existence-leak rule. The HTTP statuses are the ones this gateway
    // has always returned for each condition.
    if (isPromptResourceMethod(request.method)) {
      const outcome = await handlePromptResourceMethod(request.method, request.params, apiKey);
      return outcome.ok
        ? { response: createResponse(request.id, outcome.result), status: 200 }
        : {
            response: createErrorResponse(request.id, outcome.code, outcome.message),
            status: outcome.httpStatus,
          };
    }

    switch (request.method) {
      case 'tools/list':
        return {
          response: createResponse(request.id, handleToolsList(apiKey)),
          status: 200,
        };

      case 'tools/call': {
        const params = (request.params ?? {}) as unknown as McpToolCallParams;
        const result = await handleToolsCall(params, apiKey);
        // Soft, fail-open grounding label for allow-listed fact-asserting tools.
        // Wired on the MCP transport ONLY (the in-app chat path is untouched).
        // Non-allow-listed tools pass through byte-identical (same reference).
        const grounded = await wrapFactAsserting(params.name, result);
        return {
          response: createResponse(request.id, grounded),
          status: 200,
        };
      }

      default:
        return {
          response: createErrorResponse(
            request.id,
            JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Unknown method: ${request.method}`
          ),
          status: 404,
        };
    }
  } catch (error) {
    // Handle thrown JSON-RPC errors
    if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
      const rpcError = error as { code: number; message: string };
      const status = rpcError.code === JSON_RPC_ERROR_CODES.FORBIDDEN ? 403 : 500;
      return {
        response: createErrorResponse(request.id, rpcError.code, rpcError.message),
        status,
      };
    }

    // Generic error
    log.error('Unexpected error', error instanceof Error ? error : undefined);
    return {
      response: createErrorResponse(request.id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal server error'),
      status: 500,
    };
  }
}

// ============================================================================
// Utility Exports
// ============================================================================

/**
 * Get server info for debugging/monitoring
 */
export function getServerInfo() {
  return {
    ...SERVER_INFO,
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: SERVER_CAPABILITIES,
    toolCount: CORE_AI_TOOLS.length, // Curated tools exposed to external AI assistants
  };
}

/**
 * Health check for the MCP server
 */
export function healthCheck() {
  return {
    status: 'healthy',
    server: SERVER_INFO,
    timestamp: new Date().toISOString(),
  };
}
