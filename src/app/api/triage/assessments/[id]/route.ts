/**
 * @file api/triage/assessments/[id]/route.ts
 * @description Resolve a proposed Assessment.
 * POST /api/triage/assessments/[id] { action: 'approve'|'reject'|'dismiss', radarId?, quadrantId?, feedbackReason? }
 * Approve applies the system-of-record change (radar placement + TRL-if-unset).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  approveProposedAssessment,
  rejectProposedAssessment,
  dismissProposedAssessment,
  isProposedAssessmentRadarAuthorizationError,
} from '@/lib/proposed-assessments-admin';
import { createLogger } from '@/lib/logger';
import { dismissReasonSchema } from '@/lib/schemas/dismiss-reason';

const log = createLogger('api/triage/assessments/[id]');

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const { action, radarId, quadrantId, feedbackReason } = body as {
      action?: string;
      radarId?: string;
      quadrantId?: string;
      feedbackReason?: string;
    };

    // Validate the reason against the closed reason-code enum (P1a-T6). An
    // unrecognized reason is dropped so it can't poison the reason-coded learning
    // semantics (only the literal 'correct' flips a reject to acted) — but the drop
    // is LOGGED so a typo'd reason silently inverting a learning signal is debuggable.
    const reason = dismissReasonSchema.optional().safeParse(feedbackReason);
    const validatedReason = reason.success ? reason.data : undefined;
    if (feedbackReason !== undefined && !reason.success) {
      log.warn('dropped unrecognized feedbackReason', { id, feedbackReason });
    }

    let assessment;
    let feedbackAction: 'approved' | 'rejected' | 'dismissed' | null = null;
    if (action === 'approve') {
      assessment = await approveProposedAssessment(id, auth.uid, { radarId, quadrantId });
      feedbackAction = 'approved';
    } else if (action === 'reject') {
      assessment = await rejectProposedAssessment(id, auth.uid, validatedReason);
      feedbackAction = 'rejected';
    } else if (action === 'dismiss') {
      assessment = await dismissProposedAssessment(id, auth.uid);
      feedbackAction = 'dismissed';
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Best-effort discovery feedback. The learning-store write is NEVER allowed
    // to turn a successful triage into a 500 (BLAST-#1), so it is dynamic-imported
    // (server-only module) and wrapped in its own try/catch.
    if (feedbackAction && assessment?.technologyId) {
      try {
        const { recordProposalFeedback } = await import('@/lib/discovery/discovery-feedback');
        await recordProposalFeedback(
          auth.uid,
          id,
          'assessment',
          assessment.technologyId,
          'technology',
          feedbackAction,
          validatedReason
        );
      } catch (feedbackError) {
        log.warn('assessment feedback wire failed (ignored)', {
          id,
          error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
        });
      }
    }

    return NextResponse.json({ assessment });
  } catch (error) {
    if (isProposedAssessmentRadarAuthorizationError(error)) {
      return NextResponse.json(
        { error: 'You do not have permission to modify this radar.' },
        { status: 403 }
      );
    }
    log.error('resolve assessment failed', error instanceof Error ? error : new Error(String(error)), { id });
    return NextResponse.json({ error: 'Failed to resolve assessment' }, { status: 500 });
  }
}
