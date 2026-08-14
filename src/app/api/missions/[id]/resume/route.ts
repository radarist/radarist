/**
 * @file app/api/missions/[id]/resume/route.ts
 * @description Resume a failed unfinished Limitless build on the SAME retained
 * workspace. Turn authority and spend authority are explicit and independent;
 * positive USD top-ups require an exact, session-bound, two-request handshake.
 *
 * POST /api/missions/:id/resume
 *
 * Task 3b: the actual contract lives in `@/lib/build-mission-iterate`
 * (`resumeBuildMission`, Task 3a) — this route is thin wiring so the shared
 * precondition/budget gate (`validateRedispatch`) can never drift between the
 * iterate and resume paths. Reuses the iterate route's `FAILURE_STATUS` map
 * rather than defining a divergent copy of the HTTP-status contract.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  CONFIRMATION_TTL_MS,
  PAID_ACTION_SESSION_COOKIE,
  confirmPaidAction,
  normalizePaidActionSessionId,
  paidActionFingerprint,
} from '@/lib/ai/destructive-confirmation';
import { createLogger } from '@/lib/logger';
import { resumeBuildMission } from '@/lib/build-mission-iterate';
import { FAILURE_STATUS } from '../iterate/route';

const log = createLogger('api-mission-resume');

const resumeSchema = z
  .object({
    additionalTurns: z.number().int().min(1).max(160).default(40),
    additionalBudgetUsd: z.number().min(0).max(150).default(0),
    confirmationText: z.string().max(500).optional(),
  })
  .strict();

function sessionFor(request: NextRequest): string {
  return normalizePaidActionSessionId(request.cookies.get(PAID_ACTION_SESSION_COOKIE)?.value) ?? randomUUID();
}

function withSessionCookie<T extends NextResponse>(response: T, sessionId: string): T {
  response.cookies.set({
    name: PAID_ACTION_SESSION_COOKIE,
    value: sessionId,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/missions',
    maxAge: Math.ceil(CONFIRMATION_TTL_MS / 1000) + 60,
  });
  return response;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  const { id } = await params;

  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = resumeSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { additionalTurns, additionalBudgetUsd, confirmationText } = parsed.data;
    const actionFingerprint = paidActionFingerprint('resumeBuildMission', {
      missionId: id,
      additionalTurns,
      additionalBudgetUsd,
    });
    const confirmationFingerprint = actionFingerprint.split(':')[1];
    let confirmedBy: string | undefined;

    if (additionalBudgetUsd > 0) {
      const sessionId = sessionFor(request);
      const gate = confirmPaidAction({
        fingerprint: actionFingerprint,
        summary: `add ${additionalTurns} build turns and up to $${additionalBudgetUsd.toFixed(2)} of authority`,
        amountUsd: additionalBudgetUsd,
        principal: 'human',
        userId: auth.uid,
        requestId: randomUUID(),
        confirmationText,
        sessionId,
      });
      if (!gate.ok) {
        return withSessionCookie(
          NextResponse.json({ error: gate.error, ...gate.data }, { status: 428 }),
          sessionId
        );
      }
      confirmedBy = auth.uid;
    }

    const result = await resumeBuildMission({
      missionId: id,
      userId: auth.uid,
      additionalTurns,
      additionalBudgetUsd,
      confirmedBy,
      ...(additionalBudgetUsd > 0 ? { confirmationFingerprint } : {}),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: FAILURE_STATUS[result.code] });
    }
    return NextResponse.json(result);
  } catch (error) {
    log.error('Failed to resume mission', error instanceof Error ? error : new Error(String(error)), {
      missionId: id,
    });
    return NextResponse.json({ error: 'Failed to resume mission' }, { status: 500 });
  }
}
