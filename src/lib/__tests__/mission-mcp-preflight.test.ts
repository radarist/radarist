/**
 * @jest-environment node
 */

import {
  preflightMissionMcp,
  resolvePreflightBaseUrl,
  formatMcpPreflightFailure,
  REQUIRED_INTERNAL_MCP_SERVERS,
  MCP_PREFLIGHT_FAILED_REASON,
  MCP_BASE_URL_MISSING_REASON,
  MCP_INTERNAL_KEY_MISSING_REASON,
} from '../mission-mcp-preflight';

const BASE = 'http://127.0.0.1:9022/api/mcp';

/** A healthy authorized tools/list response. */
function toolsListOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'x' }] } }),
  } as unknown as Response;
}

/** A JSON-RPC error at HTTP 200 (invalid/revoked key / permission denied). */
function jsonRpcErrorAt200(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } }),
  } as unknown as Response;
}

describe('resolvePreflightBaseUrl', () => {
  it('uses IMPULSE_MCP_BASE_URL and strips trailing slashes', () => {
    expect(resolvePreflightBaseUrl({ IMPULSE_MCP_BASE_URL: 'http://127.0.0.1:9022/api/mcp/' })).toBe(BASE);
  });

  it('returns undefined when unset or blank (no silent default)', () => {
    expect(resolvePreflightBaseUrl({})).toBeUndefined();
    expect(resolvePreflightBaseUrl({ IMPULSE_MCP_BASE_URL: '   ' })).toBeUndefined();
  });
});

describe('preflightMissionMcp', () => {
  const goodEnv = { IMPULSE_MCP_BASE_URL: BASE, IMPULSE_INTERNAL_KEY: 'internal-key' };

  it('fails loudly with mcp-base-url-missing when IMPULSE_MCP_BASE_URL is absent', async () => {
    const fetchImpl = jest.fn();
    const result = await preflightMissionMcp({
      env: { IMPULSE_INTERNAL_KEY: 'internal-key' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(MCP_BASE_URL_MISSING_REASON);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails loudly with mcp-internal-key-missing and NEVER falls back to IMPULSE_API_KEY', async () => {
    // A valid read-only IMPULSE_API_KEY must not satisfy the app/worker preflight:
    // it could make tools/list look healthy at dispatch then fail mission writes.
    const fetchImpl = jest.fn(async () => toolsListOk());
    const result = await preflightMissionMcp({
      env: { IMPULSE_MCP_BASE_URL: BASE, IMPULSE_API_KEY: 'read-only-external-key' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(MCP_INTERNAL_KEY_MISSING_REASON);
    // The probe must not even run without the exact internal key.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('probes every platform server with tools/list and the internal x-api-key, and passes when all authorized', async () => {
    const fetchImpl = jest.fn(async () => toolsListOk());
    const result = await preflightMissionMcp({ env: goodEnv, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.baseUrl).toBe(BASE);
    expect(result.checked).toEqual([...REQUIRED_INTERNAL_MCP_SERVERS]);
    expect(fetchImpl).toHaveBeenCalledTimes(REQUIRED_INTERNAL_MCP_SERVERS.length);
    // 11 canonical platform servers (6 domain + gemini x4 + super-graph).
    expect(REQUIRED_INTERNAL_MCP_SERVERS).toHaveLength(11);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('internal-key');
    expect(init.body).toContain('tools/list');
  });

  it('treats a JSON-RPC error at HTTP 200 as unhealthy (response.ok alone is insufficient)', async () => {
    const fetchImpl = jest.fn(async (url: string) => (url.endsWith('/reports') ? jsonRpcErrorAt200() : toolsListOk()));
    const result = await preflightMissionMcp({ env: goodEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(MCP_PREFLIGHT_FAILED_REASON);
    expect(result.unreachable).toEqual(['reports']);
  });

  it('treats a rejected fetch (connection refused) as unreachable and never throws', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await preflightMissionMcp({
      env: goodEnv,
      servers: ['entities', 'graph'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(MCP_PREFLIGHT_FAILED_REASON);
    expect(result.unreachable).toEqual(['entities', 'graph']);
  });

  it('tolerates a slow cold-start response that resolves within the timeout', async () => {
    // First-hit Next dynamic-route compilation is slow but succeeds. A response
    // that resolves after a delay (still < timeout) must be healthy, not a
    // false-fail.
    const fetchImpl = jest.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(toolsListOk()), 40)));
    const result = await preflightMissionMcp({
      env: goodEnv,
      servers: ['entities'],
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('formatMcpPreflightFailure returns a stable code + remediation and NEVER leaks the internal base URL', () => {
    const failedMsg = formatMcpPreflightFailure({
      ok: false,
      reason: MCP_PREFLIGHT_FAILED_REASON,
      baseUrl: BASE,
      checked: ['entities'],
      unreachable: ['entities'],
    });
    expect(failedMsg).toContain('mcp-preflight-failed');
    expect(failedMsg).not.toContain(BASE);
    expect(failedMsg).not.toMatch(/https?:\/\//);

    expect(
      formatMcpPreflightFailure({
        ok: false,
        reason: MCP_BASE_URL_MISSING_REASON,
        baseUrl: '',
        checked: [],
        unreachable: [],
      })
    ).toContain('mcp-base-url-missing');

    const keyMsg = formatMcpPreflightFailure({
      ok: false,
      reason: MCP_INTERNAL_KEY_MISSING_REASON,
      baseUrl: BASE,
      checked: [],
      unreachable: [],
    });
    expect(keyMsg).toContain('mcp-internal-key-missing');
    expect(keyMsg).not.toContain(BASE);
  });
});
