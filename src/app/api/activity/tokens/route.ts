/**
 * @file app/api/activity/tokens/route.ts
 * @description API route to get token usage summary for the authenticated user
 *
 * Returns today's token totals and a 7-day daily breakdown.
 * Used by the Activity page to render token usage charts.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getTokenUsageSummary } from '@/lib/agent-runs';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/activity/tokens');

/**
 * GET /api/activity/tokens
 *
 * Returns token usage summary for the authenticated user.
 *
 * Response:
 * ```json
 * {
 *   "today": { "input": 5000, "output": 3000, "total": 8000, "costUsd": 0.02 },
 *   "thisWeek": [
 *     { "date": "2026-02-17", "input": 1000, "output": 500, "total": 1500, "costUsd": 0.005 },
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
    const summary = await getTokenUsageSummary(auth.uid);
    return NextResponse.json(summary);
  } catch (error) {
    log.error(
      'Failed to get token usage summary',
      error instanceof Error ? error : new Error(String(error))
    );
    return NextResponse.json(
      { error: 'Failed to get token usage summary' },
      { status: 500 }
    );
  }
}
