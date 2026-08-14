/**
 * @file api/triage/relations/[id]/route.ts
 * @description Resolve a proposed Relation via the admin twin. The twin
 * (`proposed-relations-admin.ts`) owns discovery-feedback recording — this
 * route only forwards the authenticated user's id as `feedbackUserId` so a
 * successful triage decision folds into that user's InterestProfile learning
 * store. No double-record: the route never calls `recordProposalFeedback`
 * itself.
 *
 * POST /api/triage/relations/[id] { action: 'approve'|'reject'|'dismiss', feedbackReason? }
 *
 * ProposedRelation has no owner field — like assessments it is a global authed
 * triage object, so the enforceable boundary is auth-at-top (401). Admin SDK only.
 *
 * B3 — confidence recalibration: AFTER a successful triage decision, gated on
 * `getDiscoveryConfig().feedbackEnabled`, an approve/reject DISPATCHES
 * `app/relation.feedback.requested` so the graph edge's (and its backing
 * Assertion's) `effectiveConfidence` nudge is applied durably by the
 * `apply-relation-feedback` Inngest function, not inline in the request
 * (LIVE-1: the Neo4j edge/Assertion for a freshly-approved relation are
 * created asynchronously by the sync job, so an inline call here could race
 * that sync and silently match 0 rows — the Inngest function retries until
 * the sync catches up). Own try/catch — a dispatch failure must never turn a
 * successful triage decision (already a 200) into a 500. Reject only
 * dispatches when the proposal has a materialized `relationId` (pre-approval
 * rejects have none — no-op, logged at debug), and passes
 * `expectMaterialized: false` since a reject's relationId does not guarantee
 * the 75-gate cleared the edge/Assertion into existence.
 *
 * C4 — per-asserter outcome recording (Increment 2, last learning-loop
 * writer): every approve/reject also records an outcome onto the asserting
 * agent's `:AsserterReliability` node via `recordAsserterOutcome`. The
 * WRITE is gated on the SAME `feedbackEnabled` flag as B3 — it's learning
 * data, always safe to accrue. Whether that accrued history is later
 * CONSUMED to shift the materialization gate is a separate, independent
 * flag (`ASSERTER_RELIABILITY_ENABLED`, resolved in
 * `relation-assertion-sync.ts`) — outcomes can build up while gate
 * consumption stays off. Every `ProposedRelation` carries a required
 * `discoveredBy` (linker-agent/auto-linker/ai-assistant — there is no
 * human-curated proposal shape), so this route only ever scores AI-suggested
 * proposals; the `discoveredBy` presence check below is defense-in-depth,
 * not a real branch. Own try/catch, mirroring B3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  approveProposedRelationWithOutcome,
  rejectProposedRelationWithOutcome,
  dismissProposedRelation,
} from '@/lib/proposed-relations-admin';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';
import { inngest } from '@/lib/inngest/client';
import { recordAsserterOutcome } from '@/lib/graph/asserter-reliability';
import { agentNameForDiscoverySource } from '@/lib/types/relations';
import { createLogger } from '@/lib/logger';
import {
  correlationIdFromHeaders,
  withCorrelationIdHeader,
} from '@/lib/observability/correlation';

const log = createLogger('api/triage/relations/[id]');

const triageRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'dismiss']),
    feedbackReason: z.string().max(1000).optional(),
  })
  .strict();

function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  return withCorrelationIdHeader(NextResponse.json(body, init), correlationId);
}

/**
 * Best-effort confidence-recalibration DISPATCH for a resolved triage
 * decision. Never throws — a dispatch failure is logged and swallowed so it
 * can never convert a successful triage response into a 500. The actual
 * `applyConfidenceFeedback` write happens durably in the
 * `apply-relation-feedback` Inngest function (LIVE-1) so it can retry past
 * the relation-sync latency race instead of racing it inline.
 *
 * `expectMaterialized` is `true` only for approve — an approve is the event
 * that triggers `app/relation.sync.requested` in the first place, so the
 * edge/Assertion is expected to exist (or land within the retry window). A
 * reject's `relationId` only proves the proposal previously materialized a
 * Firestore Relation doc, not that the 75-gate cleared it into a Neo4j
 * edge/Assertion — so reject passes `false` and a 0/0 match is a legitimate,
 * non-retried no-op.
 */
async function recalibrateConfidence(
  id: string,
  action: 'approve' | 'reject',
  relationId: string | undefined,
  correlationId: string
): Promise<void> {
  if (!getDiscoveryConfig().feedbackEnabled) return;

  if (!relationId) {
    log.debug('confidence recalibration skipped — proposal has no materialized relationId', { id, action });
    return;
  }

  try {
    await inngest.send({
      name: 'app/relation.feedback.requested',
      data: {
        correlationId,
        relationId,
        direction: action === 'approve' ? 'up' : 'down',
        expectMaterialized: action === 'approve',
      },
    });
  } catch (dispatchError) {
    log.warn('confidence recalibration dispatch failed (non-fatal)', {
      id,
      action,
      relationId,
      error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
    });
  }
}

/**
 * Best-effort per-asserter outcome recording for a resolved triage decision
 * (C4). Gated on the same `feedbackEnabled` flag as `recalibrateConfidence`
 * — never throws, a recording failure is logged and swallowed so it can
 * never convert a successful triage response into a 500.
 */
async function recordProposalOutcome(
  id: string,
  action: 'approve' | 'reject',
  discoveredBy: string | undefined
): Promise<void> {
  if (!getDiscoveryConfig().feedbackEnabled) return;

  if (!discoveredBy) {
    log.debug('asserter outcome recording skipped — proposal has no discoveredBy', { id, action });
    return;
  }

  const assertedBy = `agent:${agentNameForDiscoverySource(discoveredBy)}`;
  try {
    await recordAsserterOutcome(assertedBy, action === 'approve' ? 'approved' : 'rejected');
  } catch (outcomeError) {
    log.warn('asserter outcome recording failed (non-fatal)', {
      id,
      action,
      assertedBy,
      error: outcomeError instanceof Error ? outcomeError.message : String(outcomeError),
    });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    return NextResponse.json({ error: 'Invalid correlation ID' }, { status: 400 });
  }

  const { id } = await params;
  try {
    const parsedBody = triageRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsedBody.success) {
      return correlatedJson(correlationId, { error: 'Invalid request body' }, { status: 400 });
    }
    const { action, feedbackReason } = parsedBody.data;

    let relation;
    if (action === 'approve') {
      const result = await approveProposedRelationWithOutcome(id, auth.uid, {
        feedbackUserId: auth.uid,
        correlationId,
      });
      relation = result.proposal;
      if (result.transitioned) {
        await recalibrateConfidence(id, 'approve', relation.relationId, correlationId);
        await recordProposalOutcome(id, 'approve', relation.discoveredBy);
      }
    } else if (action === 'reject') {
      const result = await rejectProposedRelationWithOutcome(id, auth.uid, feedbackReason, {
        feedbackUserId: auth.uid,
        correlationId,
      });
      relation = result.proposal;
      if (result.transitioned) {
        await recalibrateConfidence(id, 'reject', relation.relationId, correlationId);
        await recordProposalOutcome(id, 'reject', relation.discoveredBy);
      }
    } else if (action === 'dismiss') {
      relation = await dismissProposedRelation(id, auth.uid, {
        feedbackUserId: auth.uid,
        correlationId,
      });
    }

    return correlatedJson(correlationId, { relation });
  } catch (error) {
    log.error('resolve relation failed', error instanceof Error ? error : new Error(String(error)), { id });
    return correlatedJson(correlationId, { error: 'Failed to resolve relation' }, { status: 500 });
  }
}
