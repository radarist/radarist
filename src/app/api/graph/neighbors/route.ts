/**
 * @file api/graph/neighbors/route.ts
 * @description Server-side neighbor lookup for the browser graph panels.
 *
 * P5-D — Graph panel revival. The in-browser graph service is never
 * initialized (the Neo4j driver is server-only), so RelationsTab /
 * ContextualGraph / EntityRelationshipPanel fetch neighbors through this
 * route via `@/lib/graph/client-safe` instead of calling dead code.
 *
 * H10 honest degradation: GraphUnavailableError → 503 with a `degraded`
 * flag so the client can surface the degradation instead of treating a
 * fabricated empty result as real data.
 *
 * @author Radarist Team
 * @created 2026-07-03
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { GraphUnavailableError } from '@/lib/graph/errors';
import { getNeighbors } from '@/lib/graph';

const log = createLogger('api/graph/neighbors');

const MAX_DEPTH = 2;
const MAX_LIMIT = 50;

const querySchema = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(MAX_LIMIT),
});

/**
 * GET /api/graph/neighbors
 *
 * Query parameters:
 * - nodeId: entity ID to expand (required)
 * - depth: traversal depth, 1..2 (default: 1)
 * - limit: max neighbors, 1..50 (default: 50)
 */
export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { nodeId, depth, limit } = parsed.data;
    const neighbors = await getNeighbors(nodeId, { depth, limit });

    return NextResponse.json({ success: true, nodeId, depth, limit, neighbors });
  } catch (error) {
    if (error instanceof GraphUnavailableError) {
      return NextResponse.json(
        {
          success: false,
          degraded: true,
          error: 'Graph backend unavailable',
          message: error.message,
          backend: error.backend,
        },
        { status: 503 }
      );
    }

    log.error('Failed to fetch graph neighbors', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Failed to fetch graph neighbors' }, { status: 500 });
  }
}
