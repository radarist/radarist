/**
 * @file api/technologies/research/route.ts
 * @description API endpoint to trigger background research for a technology
 *
 * Supports two research types:
 * - Deep research (default): Basic AI research for quick insights
 * - Comprehensive research: Full 12-section AI research with Google Search grounding
 *
 * Sends an Inngest event to run research in the background, allowing
 * users to navigate away while the research completes.
 *
 * @author Radarist Team
 * @created 2026-01-12
 * @updated 2026-01-20 - Added comprehensive research support
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/technologies/research');
import { inngest } from '@/lib/inngest/client';
import { adminGetTechnologyById } from '@/lib/technology-admin';
import { claimResearchDispatch, releaseResearchPending } from '@/lib/technology-research-admin';

// ============================================================================
// TYPES
// ============================================================================

const triggerResearchRequestSchema = z.object({
  technologyId: z.string().trim().min(1).max(256),
  /** If true, triggers comprehensive 12-section research instead of basic deep research */
  comprehensive: z.boolean().optional().default(false),
});

// ============================================================================
// HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const parsed = triggerResearchRequestSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return NextResponse.json({ error: 'technologyId is required' }, { status: 400 });
    }
    const body = parsed.data;

    // Verify technology exists and get details if not provided
    const technology = await adminGetTechnologyById(body.technologyId);
    if (!technology) {
      return NextResponse.json({ error: `Technology ${body.technologyId} not found` }, { status: 404 });
    }

    // TEST-022: one shared dispatch contract (the tool path uses the same
    // decision). The old inline copy used a 10-minute stale window against a
    // 15-minute job budget, so a healthy run was re-triggerable before it
    // could finish.
    const startedAt = Date.now();
    const claim = await claimResearchDispatch(body.technologyId, startedAt);
    if (!claim.claimed) {
      if (claim.reason === 'not-found') {
        return NextResponse.json({ error: `Technology ${body.technologyId} not found` }, { status: 404 });
      }
      return NextResponse.json(
        {
          success: false,
          error: 'Research is already in progress',
          status: 'pending',
          startedAt: claim.startedAt,
        },
        { status: 409 }
      );
    }

    // Send event to trigger background research
    // Choose event based on whether comprehensive research is requested
    const eventName = body.comprehensive
      ? 'app/technology.comprehensive-research.requested'
      : 'app/technology.research.requested';

    try {
      await inngest.send({
        name: eventName,
        data: {
          technologyId: body.technologyId,
          technologyName: technology.name,
          technologyDescription: technology.description,
          category: technology.category,
          websiteUrl: technology.websiteUrl,
          triggeredAt: startedAt,
        },
      });
    } catch (dispatchError) {
      // TEST-022: pending is written BEFORE dispatch, so a dispatch failure
      // used to strand the technology at "Researching…" for the whole stale
      // window with no job that could ever clear it. Release it so the state
      // the operator sees matches the error they are handed, and so an
      // immediate retry is possible.
      await releaseResearchPending(body.technologyId, 'dispatch-failed', startedAt);
      throw dispatchError;
    }

    const researchType = body.comprehensive ? 'comprehensive' : 'deep';

    return NextResponse.json({
      success: true,
      message: `${researchType.charAt(0).toUpperCase() + researchType.slice(1)} research started in background`,
      technologyId: body.technologyId,
      technologyName: technology.name,
      status: 'pending',
      startedAt,
      researchType,
    });
  } catch (error) {
    log.error('Technology research trigger failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to trigger research' }, { status: 500 });
  }
}
