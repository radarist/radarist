/**
 * @file app/api/missions/[id]/iterate/route.ts
 * @description Iterate on a finished build mission — the artifact is never
 * finished. Appends the new instructions to the brief, refreshes the QA
 * slate, raises the budget envelope, and re-dispatches the supervisor,
 * which resumes the SAME sandbox volume (git history, memory, and
 * methodology artifacts intact).
 *
 * POST /api/missions/:id/iterate
 *   { instructions: string, additionalBudgetUsd?: number }
 *
 * BUILD-019: the actual contract lives in `@/lib/build-mission-iterate`,
 * shared with the `iterateBuildArtifact` AI tool so the chat/MCP path and
 * this route can never drift.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { iterateBuildMission, type IterateFailureCode } from '@/lib/build-mission-iterate';

const log = createLogger('api-mission-iterate');

const iterateSchema = z.object({
  instructions: z.string().min(1).max(10_000),
  additionalBudgetUsd: z.number().positive().max(500).default(10),
});

// Exported so the Resume route (`../resume/route.ts`) reuses the SAME
// HTTP-status contract instead of forking a divergent copy — both routes map
// the shared `IterateFailureCode` union from `@/lib/build-mission-iterate`.
export const FAILURE_STATUS: Record<IterateFailureCode, number> = {
  'not-found': 404,
  forbidden: 403,
  'not-build': 400,
  running: 409,
  'no-sandbox': 409,
  // AUDIT-017 — the workspace existed and was reclaimed by the GC. 410 (not 409)
  // so a client can tell "gone forever, start a new mission" apart from "retry
  // later".
  'sandbox-reclaimed': 410,
  // AUDIT-016 — the mission hit the cumulative build ceiling. No retry, no
  // top-up will help.
  'budget-exhausted': 409,
  'brief-too-long': 400,
  'operation-in-progress': 409,
  'not-limitless': 400,
  'not-failed': 409,
  published: 409,
  'invalid-recovery': 400,
  'confirmation-required': 428,
  'dispatch-failed': 503,
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const { id } = await params;

  try {
    const body = await request.json();
    const validation = iterateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }
    const { instructions, additionalBudgetUsd } = validation.data;

    const result = await iterateBuildMission({ missionId: id, userId: auth.uid, instructions, additionalBudgetUsd });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: FAILURE_STATUS[result.code] });
    }
    return NextResponse.json({ ok: true, iteration: result.iteration });
  } catch (error) {
    log.error('Failed to iterate mission', error instanceof Error ? error : new Error(String(error)), {
      missionId: id,
    });
    return NextResponse.json({ error: 'Failed to iterate mission' }, { status: 500 });
  }
}
