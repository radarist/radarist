/**
 * @file /api/graph/status
 * @description Graph backend status endpoint (Task 0.14 — Provenance Signaling)
 *
 * Returns the current graph backend mode (neo4j | firestore-fallback | mock | unavailable)
 * so the UI can show a badge and Claude can caveat answers when degraded.
 *
 * Requires authentication. Returns:
 * - mode: current backend
 * - reason: why degraded (if not neo4j)
 * - maxHopsAvailable: pathfinding depth limit (6 for neo4j, 2 for fallback)
 * - healthy: overall health boolean
 * - latencyMs: last measured latency
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { getGraphMode } = await import('@/lib/graph/service-factory');
    const { getGraphServiceHealth } = await import('@/lib/graph/service-factory');

    // Mode resolution initializes (or joins initialization of) the shared
    // service. Read health only after that barrier so a cold request cannot
    // combine the chosen fallback mode with a synthetic pre-init health row.
    const modeInfo = await getGraphMode();
    const health = await getGraphServiceHealth();

    return NextResponse.json({
      mode: modeInfo.mode,
      reason: modeInfo.reason,
      maxHopsAvailable: modeInfo.maxHopsAvailable,
      healthy: health.healthy,
      latencyMs: health.latencyMs,
      backend: health.backend,
      checkedAt: new Date(health.checkedAt).toISOString(),
    });
  } catch (error) {
    return NextResponse.json({
      mode: 'unavailable',
      reason: error instanceof Error ? error.message : 'Failed to check graph status',
      maxHopsAvailable: 0,
      healthy: false,
    });
  }
}
