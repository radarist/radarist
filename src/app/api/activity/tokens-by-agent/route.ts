/**
 * @file app/api/activity/tokens-by-agent/route.ts
 * @description API route for per-agent token usage breakdown
 *
 * Returns token usage grouped by agent name over the past 7 days.
 * Used by the Token Budget dashboard to show per-agent cost drivers.
 *
 * @author Radarist Team
 * @created 2026-02-26
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getTokenUsageByAgent } from '@/lib/agent-runs';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/activity/tokens-by-agent');

/**
 * GET /api/activity/tokens-by-agent
 *
 * Returns per-agent token usage breakdown for the authenticated user.
 *
 * Response:
 * ```json
 * {
 *   "agents": [
 *     { "agentName": "Scout", "model": "claude-sonnet-4-6", "totalInput": 5000, "totalOutput": 3000, "totalTokens": 8000, "totalCost": 0.02, "runCount": 3 },
 *     ...
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
    const agents = await getTokenUsageByAgent(auth.uid);
    return NextResponse.json({ agents });
  } catch (error) {
    log.error('Failed to get token usage by agent', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get token usage by agent' }, { status: 500 });
  }
}
