/**
 * @file api/triage/artifacts/[id]/route.ts
 * @description Resolve an artifact recommendation.
 * POST /api/triage/artifacts/[id] { action: 'approve'|'reject'|'dismiss', feedbackReason? }
 * APPROVE is the execute-on-approve gate: it flips the proposal to approved+generating
 * and DISPATCHES the generation job. Reject/dismiss never generate. All actions feed the
 * discovery feedback loop ("more/fewer of these").
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  approveProposedArtifact,
  rejectProposedArtifact,
  dismissProposedArtifact,
  ProposedArtifactNotFoundError,
} from '@/lib/proposed-artifacts-admin';
import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { dismissReasonSchema } from '@/lib/schemas/dismiss-reason';

const log = createLogger('api/triage/artifacts/[id]');

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

    let artifact;
    let feedbackAction: 'approved' | 'rejected' | 'dismissed' | null = null;
    if (action === 'approve') {
      const { artifact: approved, transitioned } = await approveProposedArtifact(id, auth.uid);
      artifact = approved;
      feedbackAction = 'approved';
      // Execute-on-approve: dispatch the generation job ONLY when this call
      // performed the pending→approved transition. An idempotent re-approve
      // must not fire a second event — that duplicated deep-research documents
      // and raced the report slot upsert. Best-effort — the approval is
      // already committed; a dispatch failure leaves the row 'generating' and is logged.
      if (transitioned) {
        try {
          await inngest.send({
            name: 'app/artifact.generation.requested',
            data: { proposedArtifactId: id, userId: auth.uid },
          });
        } catch (dispatchError) {
          log.error(
            'artifact generation dispatch failed',
            dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError)),
            { id }
          );
        }
      }
    } else if (action === 'reject') {
      artifact = await rejectProposedArtifact(id, auth.uid, validatedReason);
      feedbackAction = 'rejected';
    } else if (action === 'dismiss') {
      artifact = await dismissProposedArtifact(id, auth.uid);
      feedbackAction = 'dismissed';
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Best-effort discovery feedback — recommendations steer like every other proposal.
    if (feedbackAction && artifact) {
      try {
        const { recordProposalFeedback } = await import('@/lib/discovery/discovery-feedback');
        const entityId = artifact.scope?.entityIds?.[0];
        // When the artifact is scoped to a real entity, let the feedback resolve that
        // entity's tags. Otherwise (a query-only report/infographic), derive a tag-space
        // topic from the SUBJECT so the vote isn't stranded on the synthetic 'document' key.
        let topicOverride: string | undefined;
        if (!entityId) {
          const { deriveTopicFromTags, meaningfulTags } = await import('@/lib/discovery/candidate-topic');
          const words = (artifact.scope?.query ?? artifact.title ?? '').split(/\s+/);
          topicOverride = deriveTopicFromTags(meaningfulTags(words), 'artifact');
        }
        await recordProposalFeedback(
          auth.uid,
          id,
          'artifact',
          entityId ?? id,
          artifact.scope?.entityType ?? 'document',
          feedbackAction,
          validatedReason,
          topicOverride
        );
      } catch (feedbackError) {
        log.warn('artifact feedback wire failed (ignored)', {
          id,
          error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
        });
      }
    }

    return NextResponse.json({ artifact });
  } catch (error) {
    // SEC-011: absent, foreign, and ownerless legacy proposals all surface as
    // this ONE identical 404 — the response must never reveal whether the id
    // exists for someone else.
    if (error instanceof ProposedArtifactNotFoundError) {
      return NextResponse.json({ error: 'Proposed artifact not found' }, { status: 404 });
    }
    log.error('resolve proposed artifact failed', error instanceof Error ? error : new Error(String(error)), { id });
    return NextResponse.json({ error: 'Failed to resolve proposed artifact' }, { status: 500 });
  }
}
