/**
 * ARUN-011 / AUDIT-015: the standalone sweep's graph client. Locks the
 * JSON-RPC contract against the app's `graph` MCP server using the
 * LIVE-CAPTURED dispatcher shapes (2026-07-12, dev :9003) — the payload text
 * is `{success, data: {results: [...]}}`, NOT the fabricated top-level
 * `records` the original fixtures invented. Also pins per-item best-effort
 * observation persistence with the schema's `agentType` provenance field.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createGraphMcpClient } from '../src/graph-mcp-client.js';
import type { ReflectResult } from '../src/sweep/reflect.js';

function mcpOk(payload: unknown) {
  return {
    ok: true,
    json: async () => ({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
  } as unknown as Response;
}

const REFLECT: ReflectResult = {
  agentRun: {
    sweepId: 'sweep-1',
    startedAt: 't0',
    completedAt: 't1',
    totalCostUsd: 0,
    totalTokens: { input: 0, output: 0 },
    taskCount: 1,
    successCount: 1,
    failureCount: 0,
    observations: [],
  },
  insights: [
    {
      entityId: 'tech-1',
      entityType: 'technology',
      entityName: 'GraphRAG',
      agentName: 'scout',
      summary: 'Momentum accelerating across 3 sources.',
      confidence: 'high',
      confidenceScore: 0.9,
      relatedEntities: ['tech-1'],
      actionable: true,
    } as ReflectResult['insights'][number],
  ],
  curiosityGaps: [
    {
      entityId: 'tech-2',
      entityType: 'technology',
      entityName: 'MoE Routers',
      type: 'stale_entity',
      failureReason: 'no recent sources found',
      retryCount: 1,
      timestamp: 't0',
    } as ReflectResult['curiosityGaps'][number],
  ],
};

describe('createGraphMcpClient', () => {
  it('executeCypher posts a tools/call to <base>/graph with x-api-key and parses rows from data.results (live shape)', async () => {
    // Live-captured success shape: {"success":true,"data":{"results":[…],"resultCount":…,…}}
    const fetchFn = jest.fn(async () =>
      mcpOk({ success: true, data: { results: [{ name: 'GraphRAG' }], resultCount: 1, truncated: false } })
    ) as unknown as typeof fetch;
    const client = createGraphMcpClient({ baseUrl: 'http://app/api/mcp/', apiKey: 'k-1', fetchFn });

    const records = await client.executeCypher('MATCH (t:Technology) RETURN t.name LIMIT 5');

    expect(records).toEqual([{ name: 'GraphRAG' }]);
    const [url, init] = (fetchFn as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://app/api/mcp/graph'); // trailing slash normalized
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k-1');
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({
      name: 'executeCypher',
      arguments: { cypher: 'MATCH (t:Technology) RETURN t.name LIMIT 5' },
    });
  });

  it('executeCypher throws on tool errors instead of returning fake empty results', async () => {
    // Live-captured error shape: isError:true + {"success":false,"error":"…"}
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'write blocked' }) }],
        },
      }),
    })) as unknown as typeof fetch;
    const client = createGraphMcpClient({ baseUrl: 'http://app/api/mcp', fetchFn });

    await expect(client.executeCypher('CREATE (n)')).rejects.toThrow('write blocked');
  });

  it('executeCypher returns [] ONLY for a genuinely empty result set — the old fabricated top-level `records` shape is dead', async () => {
    // Regression for AUDIT-015: a response in the pre-fix imagined shape
    // (top-level `records`, no success/data envelope) must NOT silently
    // yield rows; and an honest empty result set parses as [].
    const empty = jest.fn(async () =>
      mcpOk({ success: true, data: { results: [], resultCount: 0 } })
    ) as unknown as typeof fetch;
    const clientEmpty = createGraphMcpClient({ baseUrl: 'http://app/api/mcp', fetchFn: empty });
    await expect(clientEmpty.executeCypher('MATCH (n:Nothing) RETURN n')).resolves.toEqual([]);

    const fabricated = jest.fn(async () => mcpOk({ records: [{ name: 'ghost' }] })) as unknown as typeof fetch;
    const clientFab = createGraphMcpClient({ baseUrl: 'http://app/api/mcp', fetchFn: fabricated });
    await expect(clientFab.executeCypher('MATCH (n) RETURN n')).resolves.toEqual([]);
  });

  it('persistResults records one observation per insight (pattern) and per gap (discovery)', async () => {
    const fetchFn = jest.fn(async () =>
      mcpOk({ success: true, data: { observationId: 'obs-1' } })
    ) as unknown as typeof fetch;
    const client = createGraphMcpClient({ baseUrl: 'http://app/api/mcp', apiKey: 'k', fetchFn });

    await client.persistResults(REFLECT);

    const calls = (fetchFn as jest.Mock).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(calls).toHaveLength(2);
    expect(calls[0].params.name).toBe('recordAgentObservation');
    expect(calls[0].params.arguments).toMatchObject({
      observationType: 'pattern',
      entityId: 'tech-1',
      confidence: 90, // 0.9 → 0-100 scale
      // AUDIT-015: the schema's provenance field is `agentType` — the old
      // `agentName` key was silently stripped by Zod and provenance lost.
      agentType: 'scout',
    });
    expect(calls[0].params.arguments.agentName).toBeUndefined();
    expect(calls[1].params.arguments).toMatchObject({
      observationType: 'discovery',
      entityId: 'tech-2',
      agentType: 'sweep-cli',
    });
  });

  it('persistResults is best-effort per item — one failing observation does not sink the batch', async () => {
    let call = 0;
    const fetchFn = jest.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 500 } as unknown as Response;
      return mcpOk({ success: true, data: { observationId: 'obs-2' } });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const client = createGraphMcpClient({ baseUrl: 'http://app/api/mcp', fetchFn, log: (m) => logs.push(m) });

    await client.persistResults(REFLECT); // must not throw

    expect((fetchFn as jest.Mock).mock.calls).toHaveLength(2); // gap still attempted
    expect(logs.some((l) => l.includes('persist failed'))).toBe(true);
    // The unrecordable AgentRun row is logged honestly, never silently dropped.
    expect(logs.some((l) => l.includes('recorded only by the in-app sweep'))).toBe(true);
  });
});
