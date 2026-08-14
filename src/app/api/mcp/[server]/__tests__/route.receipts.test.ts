/**
 * @file api/mcp/[server]/__tests__/route.receipts.test.ts
 * @description ARUN-022 C — the MCP route opens an operation-usage receipt scope
 * STRICTLY around a real, authorized tool invocation and flushes nested provider
 * spend under a SERVER-RESOLVED correlation.
 *
 * Pins:
 * - a spend-bearing tools/call flushes receipts under a server-resolved owner
 *   (`user:<uid>`, never caller-supplied), correctly classified;
 * - a standalone external call (no x-mission-id) flushes under an `mcp`
 *   correlation, scope `standalone`; a mission-bound call flushes under the
 *   mission, scope `additional-to-parent`;
 * - tools/list, a permission-denied call, and a spend-free call NEVER flush
 *   (zero-spend paths produce no paid receipt);
 * - a flush failure is non-fatal (the tool result is returned unchanged).
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

const mockCallTool = jest.fn();
const mockGetTools = jest.fn();
const mockDomainServer = { name: 'impulse-entities', version: '1.0.0', getTools: mockGetTools, callTool: mockCallTool };

jest.mock('@/lib/mcp/servers/entities-server', () => ({
  createEntitiesServer: jest.fn(() => ({ ...mockDomainServer, name: 'impulse-entities' })),
}));
jest.mock('@/lib/mcp/servers/graph-server', () => ({ createGraphServer: jest.fn(() => mockDomainServer) }));
jest.mock('@/lib/mcp/servers/signals-server', () => ({ createSignalsServer: jest.fn(() => mockDomainServer) }));
jest.mock('@/lib/mcp/servers/research-server', () => ({ createResearchServer: jest.fn(() => mockDomainServer) }));
jest.mock('@/lib/mcp/servers/radar-server', () => ({ createRadarServer: jest.fn(() => mockDomainServer) }));
jest.mock('@/lib/mcp/servers/reports-server', () => ({ createReportsServer: jest.fn(() => mockDomainServer) }));
jest.mock('@/lib/mcp/api-keys', () => ({ validateApiKey: jest.fn() }));
jest.mock('@/lib/missions', () => ({ getMissionById: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// Controllable instrument: withCapturedUsage runs the fn and returns whatever the
// current test staged as "nested captures"; flushCapturedUsage is a spy.
let stagedCaptures: unknown[] = [];
const mockFlush = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/operation-receipt-instrument', () => ({
  withCapturedUsage: async (fn: () => Promise<unknown>) => ({ result: await fn(), captured: stagedCaptures }),
  flushCapturedUsage: (...args: unknown[]) => mockFlush(...args),
}));

const { validateApiKey } = jest.requireMock('@/lib/mcp/api-keys');
const { getMissionById } = jest.requireMock('@/lib/missions');

import { POST } from '../route';

const VALID_API_KEY = {
  id: 'key-1',
  hashedKey: 'hashed',
  userId: 'user-1',
  name: 'Test Key',
  permissions: ['read', 'write', 'signals'],
  createdAt: Date.now(),
  expiresAt: null,
};

const READ_ONLY_KEY = { ...VALID_API_KEY, id: 'key-2', permissions: ['read'] };

function req(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/mcp/entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'tp_live_valid', ...headers },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ server: 'entities' }) };

beforeEach(() => {
  jest.clearAllMocks();
  stagedCaptures = [];
  validateApiKey.mockResolvedValue(VALID_API_KEY);
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
});

describe('MCP route — ARUN-022 receipt scope', () => {
  it('flushes a standalone external call under an mcp correlation with a server-resolved owner', async () => {
    stagedCaptures = [{ provider: 'gemini', operation: 'gemini.generate-content' }];
    const res = await POST(
      req({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'createCompany', arguments: {} } }),
      params
    );
    expect(res.status).toBe(200);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    const [correlation, captured, prefix, scope] = mockFlush.mock.calls[0];
    expect(correlation).toMatchObject({ parentType: 'mcp', owner: 'user:user-1' });
    expect(correlation.correlationId).toMatch(/^mcp-/);
    expect(prefix).toMatch(/^mcp-/);
    expect(captured).toHaveLength(1);
    expect(scope).toBe('standalone');
    // Owner is server-resolved, never from the caller body/headers.
    expect(correlation).not.toHaveProperty('missionId');
  });

  it('flushes a mission-bound call under the mission, classified additional-to-parent', async () => {
    getMissionById.mockResolvedValue({ userId: 'user-1', slots: [] });
    stagedCaptures = [{ provider: 'gemini', operation: 'gemini.grounded-generate' }];
    await POST(
      req(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'createCompany', arguments: {} } },
        { 'x-mission-id': 'mission-abc' }
      ),
      params
    );
    expect(mockFlush).toHaveBeenCalledTimes(1);
    const [correlation, , , scope] = mockFlush.mock.calls[0];
    expect(correlation).toEqual({
      parentType: 'mission',
      owner: 'user:user-1',
      correlationId: 'mission-mission-abc',
      missionId: 'mission-abc',
    });
    expect(scope).toBe('additional-to-parent');
  });

  it('does NOT classify spend under a nonexistent mission — an unverified x-mission-id records standalone', async () => {
    // The mission lookup fails to resolve (mission does not exist / not owned).
    getMissionById.mockResolvedValue(null);
    stagedCaptures = [{ provider: 'gemini', operation: 'gemini.generate-content' }];
    await POST(
      req(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'createCompany', arguments: {} } },
        { 'x-mission-id': 'mission-ghost' }
      ),
      params
    );
    expect(mockFlush).toHaveBeenCalledTimes(1);
    const [correlation, , , scope] = mockFlush.mock.calls[0];
    // Never attributed to the nonexistent parent — recorded standalone under the owner.
    expect(correlation.parentType).toBe('mcp');
    expect(correlation).not.toHaveProperty('missionId');
    expect(scope).toBe('standalone');
  });

  it('does NOT flush for tools/list (zero-spend)', async () => {
    mockGetTools.mockReturnValue([{ name: 'createCompany', description: 'x', inputSchema: { type: 'object' } }]);
    stagedCaptures = [{ provider: 'gemini', operation: 'x' }];
    await POST(req({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), params);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('does NOT flush for a permission-denied tools/call', async () => {
    validateApiKey.mockResolvedValue(READ_ONLY_KEY);
    stagedCaptures = [{ provider: 'gemini', operation: 'x' }];
    const res = await POST(
      // deleteEntity requires the 'delete' permission the read-only key lacks.
      req({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'deleteEntity', arguments: {} } }),
      params
    );
    const json = await res.json();
    expect(json.error).toBeDefined();
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('does NOT flush when the tool made no provider call (no captures)', async () => {
    stagedCaptures = [];
    await POST(
      req({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'createCompany', arguments: {} } }),
      params
    );
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('returns the tool result unchanged when the receipt flush fails (non-fatal)', async () => {
    stagedCaptures = [{ provider: 'gemini', operation: 'x' }];
    mockFlush.mockRejectedValueOnce(new Error('ledger down'));
    const res = await POST(
      req({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'createCompany', arguments: {} } }),
      params
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
  });
});
