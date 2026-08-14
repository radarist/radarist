/**
 * @file app/api/activity/log/route.ts
 * @description API route to list agent run logs for the authenticated user
 *
 * Returns a bounded union of the newest global window and per-kind floors
 * (at most 250 deduplicated rows), ordered by creation date descending. Used
 * by the Activity page to display the agent run history.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { listAgentRunsWithDiagnostics } from '@/lib/agent-runs';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/activity/log');

/**
 * GET /api/activity/log
 *
 * Returns agent run entries for the authenticated user.
 *
 * Response:
 * ```json
 * {
 *   "entries": [
 *     {
 *       "id": "run-123",
 *       "agentName": "Scout",
 *       "action": "Discovered 3 new signals",
 *       "status": "success",
 *       "tokenUsage": { "input": 1200, "output": 800 },
 *       "costUsd": 0.004,
 *       "duration": 3200,
 *       "createdAt": "2026-02-23T10:00:00.000Z"
 *     }
 *   ]
 * }
 * ```
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { runs, degradedKinds } = await listAgentRunsWithDiagnostics(auth.uid);
    return NextResponse.json({ entries: runs, degradedKinds });
  } catch (error) {
    log.error(
      'Failed to list agent runs',
      error instanceof Error ? error : new Error(String(error))
    );
    return NextResponse.json(
      { error: 'Failed to list agent runs' },
      { status: 500 }
    );
  }
}
