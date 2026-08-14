/**
 * @file api/graph/path/route.ts
 * @description Server-side connection explanation for the browser graph panels.
 *
 * P5-D — Graph panel revival. Finds the shortest path between two entities
 * and explains it in natural language (traversal.explainConnection). Used
 * by the "Find Path" / "Explain connection" affordances in RelationsTab,
 * ContextualGraph and EntityRelationshipPanel via `@/lib/graph/client-safe`.
 *
 * H10 honest degradation: GraphUnavailableError → 503 with a `degraded`
 * flag so the client can surface the degradation.
 *
 * @author Radarist Team
 * @created 2026-07-03
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { GraphUnavailableError } from '@/lib/graph/errors';
import { explainGraphConnection } from '@/lib/graph';

const log = createLogger('api/graph/path');

const querySchema = z.object({
  from: z.string().min(1, 'from is required'),
  to: z.string().min(1, 'to is required'),
});

/**
 * GET /api/graph/path
 *
 * Query parameters:
 * - from: source entity ID (required)
 * - to: target entity ID (required)
 *
 * Returns `{ success: true, result: ConnectionExplanation }`.
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

    const { from, to } = parsed.data;
    const result = await explainGraphConnection(from, to);

    return NextResponse.json({ success: true, result });
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

    log.error('Failed to explain graph connection', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Failed to explain graph connection' }, { status: 500 });
  }
}
