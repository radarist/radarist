/**
 * @file api/pipeline/trigger/route.ts
 * @description Pipeline trigger API endpoint
 *
 * Allows manual triggering of the daily pipeline.
 *
 * OBS-003 — this route is the head of the pipeline correlation path. It used to
 * mint a private `randomUUID()` request identity that nothing downstream could
 * join on, which is why a completed manual run had no durable
 * browser → event → job → graph correlation. It now joins the EXISTING contract
 * already used by the relation and triage routes: read-or-mint a strict
 * `corr_<UUIDv4>`, reject a malformed one rather than rewriting it, echo it on
 * every response, and place it on `event.data.correlationId` — the exact field
 * the job-run tracking middleware persists as a top-level queryable field.
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { unauthenticatedResponse } from '@/lib/auth-failure-response';
import { createLogger } from '@/lib/logger';
import { inngest } from '@/lib/inngest/client';
import { CORRELATION_ID_HEADER, correlationIdFromHeaders } from '@/lib/observability/correlation';

const log = createLogger('api/pipeline/trigger');

/** Every response on this route carries the identity it accepted or minted. */
function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  return response;
}

// ============================================================================
// HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  // Read the identity BEFORE any work, so even a rejected trigger is traceable.
  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    // A supplied-but-unparseable value is a caller error, never silently
    // replaced — a rewritten identity is worse than a refused one, because the
    // caller keeps a token that joins to nothing.
    return NextResponse.json({ error: 'Invalid correlation ID' }, { status: 400 });
  }

  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return unauthenticatedResponse(auth);
    }

    const triggeredAt = Date.now();

    // Send event to trigger pipeline
    await inngest.send({
      // Deterministic replay: Inngest de-duplicates on event id, so re-POSTing
      // an already-accepted identity cannot start a second pipeline run.
      id: correlationId,
      name: 'app/pipeline.trigger',
      data: {
        source: 'manual',
        triggeredAt,
        triggeredBy: 'api',
        correlationId,
        // Retained as an alias of the SAME value. Two identities for one request
        // is the defect this row closes; keeping the field name keeps existing
        // readers working without reintroducing a second identity.
        requestId: correlationId,
      },
    });

    return correlatedJson(correlationId, {
      success: true,
      message: 'Pipeline triggered successfully',
      triggeredAt,
      correlationId,
      requestId: correlationId,
    });
  } catch (error) {
    log.error('Failed to trigger pipeline', error instanceof Error ? error : undefined, { correlationId });
    return correlatedJson(correlationId, { error: 'Failed to trigger pipeline' }, { status: 500 });
  }
}
