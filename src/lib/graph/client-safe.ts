/**
 * @file graph/client-safe.ts
 * @description Browser-side graph access over the /api/graph/* routes.
 *
 * "use client" components must import graph utilities from this module
 * instead of the main barrel (@/lib/graph), which re-exports server-only
 * symbols like Neo4jGraphService and getDriver.
 *
 * P5-D — Graph panel revival: this module previously re-exported the
 * server-side traversal functions and `isGraphServiceInitialized`, which is
 * permanently false in the browser (the Neo4j driver never initializes
 * there) — so every consumer's graph insight panel was dead code. It now
 * calls the server routes via fetchWithAuth:
 *   - checkGraphAvailability → GET /api/graph/status
 *   - getNeighbors           → GET /api/graph/neighbors
 *   - explainGraphConnection → GET /api/graph/path
 *
 * The routes inherit H10 honest degradation (503 + degraded flag when the
 * graph backend is unavailable); the fetchers throw on non-OK responses so
 * callers surface the degradation instead of rendering fabricated data.
 */

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type { GraphNode } from './interface';
import type { ConnectionExplanation } from './traversal';

const log = createLogger('graph/client-safe');

// Types (type-only re-exports — erased at compile time, no server code loads)
export type { GraphNode } from './interface';
export type { ConnectionExplanation as GraphConnectionExplanation } from './traversal';

/** Options the neighbors route accepts (depth 1..2, limit 1..50). */
export interface ClientNeighborOptions {
  depth?: number;
  limit?: number;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string } | null;
    return body?.message || body?.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Whether the graph backend can serve queries right now.
 * Never throws — availability probes must not break the UI.
 */
export async function checkGraphAvailability(): Promise<boolean> {
  try {
    const response = await fetchWithAuth('/api/graph/status');
    if (!response.ok) return false;
    const status = (await response.json()) as { healthy?: boolean; mode?: string };
    return status.healthy === true && status.mode !== 'unavailable';
  } catch (error) {
    log.warn('Graph availability check failed', { error: String(error) });
    return false;
  }
}

/**
 * Get the neighbors of an entity via GET /api/graph/neighbors.
 *
 * @throws Error on non-OK responses (including 503 graph-degraded)
 */
export async function getNeighbors(entityId: string, options: ClientNeighborOptions = {}): Promise<GraphNode[]> {
  const params = new URLSearchParams({ nodeId: entityId });
  if (options.depth !== undefined) params.set('depth', String(options.depth));
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  const response = await fetchWithAuth(`/api/graph/neighbors?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Failed to fetch graph neighbors (${response.status})`));
  }

  const data = (await response.json()) as { neighbors?: GraphNode[] };
  return data.neighbors ?? [];
}

/**
 * Explain the connection between two entities via GET /api/graph/path.
 *
 * @throws Error on non-OK responses (including 503 graph-degraded)
 */
export async function explainGraphConnection(fromId: string, toId: string): Promise<ConnectionExplanation> {
  const params = new URLSearchParams({ from: fromId, to: toId });

  const response = await fetchWithAuth(`/api/graph/path?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Failed to explain graph connection (${response.status})`));
  }

  const data = (await response.json()) as { result: ConnectionExplanation };
  return data.result;
}
