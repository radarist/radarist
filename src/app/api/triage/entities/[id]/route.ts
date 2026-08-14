/**
 * @file api/triage/entities/[id]/route.ts
 * @description Resolve a proposed Entity.
 * POST /api/triage/entities/[id] { action: 'approve'|'reject'|'dismiss', feedbackReason? }
 * Approve mints the real entity (via the factory) and records the discovery feedback.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { approveProposedEntity, rejectProposedEntity, dismissProposedEntity } from '@/lib/proposed-entities-admin';
import { createLogger } from '@/lib/logger';
import { dismissReasonSchema } from '@/lib/schemas/dismiss-reason';

const log = createLogger('api/triage/entities/[id]');

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const { action, feedbackReason } = body as { action?: string; feedbackReason?: string };

    const reason = dismissReasonSchema.optional().safeParse(feedbackReason);
    const validatedReason = reason.success ? reason.data : undefined;
    if (feedbackReason !== undefined && !reason.success) {
      log.warn('dropped unrecognized feedbackReason', { id, feedbackReason });
    }

    let entity;
    let feedbackAction: 'approved' | 'rejected' | 'dismissed' | null = null;
    if (action === 'approve') {
      entity = await approveProposedEntity(id, auth.uid);
      feedbackAction = 'approved';
    } else if (action === 'reject') {
      entity = await rejectProposedEntity(id, auth.uid, validatedReason);
      feedbackAction = 'rejected';
    } else if (action === 'dismiss') {
      entity = await dismissProposedEntity(id, auth.uid);
      feedbackAction = 'dismissed';
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Best-effort discovery feedback — approving/rejecting a net-new entity feeds the
    // interest loop. On approve the appliedEntityId is a real entity (resolves to its
    // tags); on reject it falls back to the entityType. NEVER allowed to break the 200.
    if (feedbackAction && entity) {
      try {
        const { recordProposalFeedback } = await import('@/lib/discovery/discovery-feedback');
        await recordProposalFeedback(
          auth.uid,
          id,
          'entity',
          entity.appliedEntityId ?? id,
          entity.entityType,
          feedbackAction,
          validatedReason
        );
      } catch (feedbackError) {
        log.warn('entity feedback wire failed (ignored)', {
          id,
          error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
        });
      }
    }

    return NextResponse.json({ entity });
  } catch (error) {
    log.error('resolve proposed entity failed', error instanceof Error ? error : new Error(String(error)), { id });
    return NextResponse.json({ error: 'Failed to resolve proposed entity' }, { status: 500 });
  }
}
