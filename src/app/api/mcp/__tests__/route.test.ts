/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock MCP server module
jest.mock('@/lib/mcp/server', () => ({
  handleMcpRequest: jest.fn(),
  getServerInfo: jest.fn(),
  healthCheck: jest.fn(),
}));

const { handleMcpRequest, getServerInfo, healthCheck } = jest.requireMock('@/lib/mcp/server');

import { OPTIONS, GET, POST } from '../route';

// ============================================================================
// OPTIONS /api/mcp (CORS preflight)
// ============================================================================

describe('OPTIONS /api/mcp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 with CORS headers', async () => {
    const res = await OPTIONS();

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, x-api-key');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });
});

// ============================================================================
// GET /api/mcp (Health check / Server info)
// ============================================================================

describe('GET /api/mcp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns server info and health check on success', async () => {
    getServerInfo.mockReturnValue({
      name: 'radarist-mcp',
      version: '1.0.0',
    });
    healthCheck.mockReturnValue({
      status: 'healthy',
      uptime: 12345,
    });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.name).toBe('radarist-mcp');
    expect(json.version).toBe('1.0.0');
    expect(json.status).toBe('healthy');
    expect(json.uptime).toBe(12345);
    expect(getServerInfo).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it('includes CORS headers in response', async () => {
    getServerInfo.mockReturnValue({ name: 'MCP' });
    healthCheck.mockReturnValue({ status: 'healthy' });

    const res = await GET();

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, x-api-key');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('returns 500 on error', async () => {
    getServerInfo.mockImplementation(() => {
      throw new Error('Server info failed');
    });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.status).toBe('error');
    expect(json.error).toBe('Server info failed');
  });
});

// ============================================================================
// POST /api/mcp (JSON-RPC requests)
// ============================================================================

describe('POST /api/mcp', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards request body and auth header to handleMcpRequest', async () => {
    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };
    handleMcpRequest.mockResolvedValue({
      response: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
      status: 200,
    });

    const req = new NextRequest('http://localhost:3000/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-api-key',
      },
      body: JSON.stringify(requestBody),
    });

    await POST(req);

    expect(handleMcpRequest).toHaveBeenCalledWith({
      authHeader: 'Bearer my-api-key',
      body: requestBody,
    });
  });

  it('returns JSON-RPC response from handleMcpRequest', async () => {
    const mcpResponse = {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'listSignals' }] },
    };
    handleMcpRequest.mockResolvedValue({
      response: mcpResponse,
      status: 200,
    });

    const req = new NextRequest('http://localhost:3000/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(mcpResponse);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns -32700 parse error for invalid JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}', // placeholder body; we override json() below
    });
    // Override json() to throw a SyntaxError in the same realm
    // (NextRequest.json() from a different VM context may not pass instanceof)
    jest.spyOn(req, 'json').mockRejectedValue(new SyntaxError('Unexpected token'));

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBeNull();
    expect(json.error.code).toBe(-32700);
    expect(json.error.message).toBe('Parse error: Invalid JSON');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('returns -32603 internal error on unexpected error', async () => {
    handleMcpRequest.mockRejectedValue(new Error('Unexpected handler failure'));

    const req = new NextRequest('http://localhost:3000/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBeNull();
    expect(json.error.code).toBe(-32603);
    expect(json.error.message).toBe('Internal error');
    // Task 0.7: In test (NODE_ENV=test), error is sanitized to generic message
    expect(json.error.data).toBe('Internal server error');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
