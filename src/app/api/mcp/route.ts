/**
 * @file /api/mcp
 * @description MCP (Model Context Protocol) Server API Endpoint
 *
 * This endpoint implements the MCP protocol for external AI assistants
 * (Claude Desktop, ChatGPT, etc.) to interact with Radarist.
 *
 * The endpoint:
 * 1. Receives JSON-RPC 2.0 requests
 * 2. Authenticates via API key in Authorization header
 * 3. Routes to MCP method handlers
 * 4. Returns JSON-RPC 2.0 responses
 *
 * Authentication:
 *   Authorization: Bearer <api_key>
 *
 * Example requests:
 *   POST /api/mcp
 *   { "jsonrpc": "2.0", "id": 1, "method": "initialize" }
 *
 *   POST /api/mcp
 *   { "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
 *
 *   POST /api/mcp
 *   { "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "listSignals", "arguments": {} } }
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/mcp');

// ============================================================================
// CORS Headers for MCP
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  'Access-Control-Max-Age': '86400',
};

// ============================================================================
// OPTIONS Handler (CORS preflight)
// ============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ============================================================================
// GET Handler (Health check / Server info)
// ============================================================================

/**
 * GET /api/mcp
 *
 * Returns MCP server health and info.
 * Does not require authentication.
 */
export async function GET() {
  try {
    const { getServerInfo, healthCheck } = await import('@/lib/mcp/server');
    const info = getServerInfo();
    const health = healthCheck();

    return NextResponse.json(
      {
        ...info,
        ...health,
      },
      {
        status: 200,
        headers: CORS_HEADERS,
      }
    );
  } catch (error) {
    log.error('Health check failed', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
}

// ============================================================================
// POST Handler (JSON-RPC requests)
// ============================================================================

/**
 * POST /api/mcp
 *
 * Main MCP endpoint for JSON-RPC requests.
 * Requires API key for protected methods.
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json();

    // Get the API key: Authorization Bearer is canonical; x-api-key is
    // accepted for parity with the domain dispatcher (/api/mcp/[server]) —
    // previously a key sent only via x-api-key passed initialize (no auth
    // needed) but failed tools/list, a confusing half-authenticated state.
    const xApiKey = request.headers.get('x-api-key');
    const authHeader = request.headers.get('Authorization') ?? (xApiKey ? `Bearer ${xApiKey}` : null);

    // Dynamic import to defer loading ~3764 transitive modules (AI tools,
    // graph, Firebase) until an actual request arrives.
    const { handleMcpRequest } = await import('@/lib/mcp/server');

    // Handle the MCP request
    const result = await handleMcpRequest({
      authHeader,
      body,
    });

    return NextResponse.json(result.response, {
      status: result.status,
      headers: CORS_HEADERS,
    });
  } catch (error) {
    log.error('Request handling failed', error instanceof Error ? error : undefined);

    // JSON parse error
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error: Invalid JSON',
          },
        },
        {
          status: 400,
          headers: CORS_HEADERS,
        }
      );
    }

    // Generic error
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
          // Task 0.7: Sanitize errors — only show details in development
          data:
            process.env.NODE_ENV === 'development'
              ? error instanceof Error
                ? error.message
                : 'Unknown error'
              : 'Internal server error',
        },
      },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
}
