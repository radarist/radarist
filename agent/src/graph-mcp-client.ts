/**
 * @file graph-mcp-client.ts
 * @description ARUN-011: real graph access for the standalone
 * `impulse-agent sweep` command.
 *
 * The production CLI used to inject `executeCypher: async () => []` and
 * `persistResults: async () => {}` while the help text advertised a working
 * sweep — every cycle "ran" against an empty graph and persisted nothing.
 * This client wires both deps to the app's `graph` MCP server
 * (`${IMPULSE_MCP_BASE_URL}/graph`, JSON-RPC `tools/call`):
 *
 * - `executeCypher` → the bounded read-only Cypher tool (record/payload/time
 *   caps and procedure policy enforced app-side).
 * - `persistResults` → one `recordAgentObservation` per insight and per
 *   curiosity gap, mirroring the in-app sweep's REFLECT mapping. The
 *   AgentRun row itself has no MCP write surface — that is logged honestly
 *   instead of silently dropped (run history for standalone sweeps remains
 *   an in-app-sweep feature).
 */

import type { ReflectResult } from './sweep/reflect.js';

export interface GraphMcpClientOptions {
  /** e.g. http://localhost:9002/api/mcp */
  baseUrl: string;
  /** MCP API key with write scope (x-api-key). */
  apiKey?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

interface McpTextResult {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

export interface GraphMcpClient {
  executeCypher: (query: string) => Promise<Array<Record<string, unknown>>>;
  persistResults: (result: ReflectResult) => Promise<void>;
}

export function createGraphMcpClient(options: GraphMcpClientOptions): GraphMcpClient {
  const { baseUrl, apiKey, fetchFn = fetch, log = () => {} } = options;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/graph`;
  let rpcId = 0;

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      // SEC-013: the internal MCP key must not follow a redirect to another
      // origin. A redirected endpoint is an error, not a destination.
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`graph MCP ${name} failed: HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as McpTextResult;
    if (envelope.error) {
      throw new Error(`graph MCP ${name} failed: ${envelope.error.message ?? 'unknown RPC error'}`);
    }
    const text = envelope.result?.content?.[0]?.text ?? '{}';
    // The dispatcher wraps tool fields under `data`:
    // `{success: boolean, data?: <tool payload>, error?: string}`.
    const payload = JSON.parse(text) as { success?: boolean; data?: Record<string, unknown>; error?: string };
    if (envelope.result?.isError || payload.error || payload.success === false) {
      throw new Error(`graph MCP ${name} failed: ${payload.error ?? 'tool error'}`);
    }
    return payload.data ?? {};
  }

  return {
    async executeCypher(query: string): Promise<Array<Record<string, unknown>>> {
      // The bounded Cypher tool returns its rows as `results`.
      const data = await callTool('executeCypher', { cypher: query });
      const results = data['results'];
      return Array.isArray(results) ? (results as Array<Record<string, unknown>>) : [];
    },

    async persistResults(result: ReflectResult): Promise<void> {
      // Mirrors the in-app sweep's REFLECT mapping (impulse-sweep-cycle):
      // insights → 'pattern' observations, curiosity gaps → 'discovery'.
      // Best-effort per item — one bad entity must not sink the batch.
      let persisted = 0;
      let failed = 0;
      for (const insight of result.insights) {
        try {
          await callTool('recordAgentObservation', {
            observationType: 'pattern',
            title: `Sweep insight: ${insight.entityName}`,
            summary: insight.summary,
            confidence: Math.round(insight.confidenceScore * 100),
            entityId: insight.entityId,
            // Schema field is `agentType` — the old `agentName` key was
            // silently stripped by Zod, losing provenance (AUDIT-015).
            agentType: insight.agentName || 'sweep-cli',
          });
          persisted++;
        } catch (err) {
          failed++;
          log(`[sweep] observation persist failed for insight ${insight.entityId}: ${String(err)}`);
        }
      }
      for (const gap of result.curiosityGaps) {
        try {
          await callTool('recordAgentObservation', {
            observationType: 'discovery',
            title: `Sweep gap: ${gap.entityName}`,
            summary: `Sweep flagged ${gap.entityName} (${gap.entityType}): ${gap.failureReason}`,
            confidence: 80,
            entityId: gap.entityId,
            agentType: 'sweep-cli',
          });
          persisted++;
        } catch (err) {
          failed++;
          log(`[sweep] observation persist failed for gap ${gap.entityId}: ${String(err)}`);
        }
      }
      // Honest gap: standalone sweeps have no MCP surface for AgentRun rows.
      log(
        `[sweep] persisted ${persisted} observation(s), ${failed} failed; run-history row for sweep '${result.agentRun.sweepId}' is recorded only by the in-app sweep`
      );
    },
  };
}
