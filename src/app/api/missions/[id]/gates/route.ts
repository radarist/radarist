/**
 * @file app/api/missions/[id]/gates/route.ts
 * @description Resolve a build-mission human gate (budget top-up, stall,
 * final approval). The supervisor parks at step.waitForEvent on
 * `app/build-mission.gate.resolved`; this route records the decision on the
 * mission doc and emits that event.
 *
 * POST /api/missions/:id/gates
 *   { gate: 'budget'|'stall'|'final', decision: 'approve'|'deny',
 *     topUpUsd?: number, note?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { isSystemPrincipal } from '@/lib/system-principals';
import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { appendBuildGate, getMissionById } from '@/lib/missions';

const log = createLogger('api-mission-gates');

const gateResolutionSchema = z.object({
  gate: z.enum(['budget', 'stall', 'final']),
  decision: z.enum(['approve', 'deny']),
  topUpUsd: z.number().positive().max(500).optional(),
  note: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const { id } = await params;

  try {
    const body = await request.json();
    const validation = gateResolutionSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }
    const { gate, decision, topUpUsd, note } = validation.data;
    if (gate === 'budget' && decision === 'approve' && !topUpUsd) {
      return NextResponse.json({ error: 'Approving a budget gate requires topUpUsd' }, { status: 400 });
    }

    const mission = await getMissionById(id);
    if (!mission) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    // ARUN-005: in local single-user mode the signed-in user may operate on
    // system-dispatched missions too (visible rows must not carry dead 403
    // buttons; a system build paused on a human gate must be resolvable).
    // Missions of another HUMAN user stay forbidden.
    if (mission.userId !== auth.uid && !isSystemPrincipal(mission.userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (mission.kind !== 'build') {
      return NextResponse.json({ error: 'Gates only apply to build missions' }, { status: 400 });
    }

    await appendBuildGate(id, {
      gate,
      requestedAt: new Date().toISOString(), // resolution record; the request record was appended by the supervisor
      resolvedAt: new Date().toISOString(),
      decision,
      ...(topUpUsd ? { topUpUsd } : {}),
      ...(note ? { note } : {}),
    });
    await inngest.send({
      name: 'app/build-mission.gate.resolved',
      data: {
        missionId: id,
        gate,
        decision,
        ...(topUpUsd ? { topUpUsd } : {}),
        ...(note ? { note } : {}),
        resolvedBy: auth.uid,
      },
    });

    log.info('Build-mission gate resolved', { missionId: id, gate, decision, topUpUsd });
    return NextResponse.json({ ok: true, gate, decision });
  } catch (error) {
    log.error('Failed to resolve gate', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    return NextResponse.json({ error: 'Failed to resolve gate' }, { status: 500 });
  }
}
