/**
 * @file api/documents/deep-research/route.ts
 * @description API endpoint to start a Gemini Deep Research task.
 *
 * POST /api/documents/deep-research
 * - Creates a placeholder document (status: 'processing', type: 'deep-research')
 * - Sends Inngest event to start the background research job
 * - Returns the document ID immediately
 *
 * The research runs asynchronously (1-5+ minutes). The document appears in
 * the library immediately with a "processing" badge, then updates to
 * "processed" when complete.
 *
 * @author Radarist Team
 * @created 2026-02-27
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { DeepResearchDispatchError, dispatchDeepResearchDocument } from '@/lib/deep-research-document-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/deep-research');

/** Validation schema for the request body. */
const DeepResearchRequestSchema = z.object({
  query: z.string().min(3, 'Query must be at least 3 characters').max(2000, 'Query must be at most 2000 characters'),
  tags: z.array(z.string()).optional(),
});

/**
 * POST handler for starting deep research.
 *
 * Expected JSON body:
 * - query: string (3-2000 chars) — the research topic
 * - tags?: string[] — optional tags for the document
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // 2. Parse and validate body
    const body = await request.json();
    const validation = DeepResearchRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { query, tags } = validation.data;

    // 3+4. AI-021: one supported generated-document contract — truthful
    // `processing` state and a VERIFIED job dispatch. A rejected dispatch
    // marks the document failed and throws; this route must never report a
    // started research that will not run.
    const document = await dispatchDeepResearchDocument({ query, userId: auth.uid, tags });

    log.info('Created deep research document', {
      documentId: document.id,
      query: query.substring(0, 100),
    });

    // 5. Return immediately
    return NextResponse.json({
      success: true,
      documentId: document.id,
      status: 'processing',
      message: 'Deep research started. The document will appear in your library when complete (1-5 minutes).',
    });
  } catch (error) {
    if (error instanceof DeepResearchDispatchError) {
      log.error('Deep research dispatch failed', error, { documentId: error.documentId });
      return NextResponse.json(
        {
          error: error.message,
          documentId: error.documentId,
          status: 'failed',
        },
        { status: 502 }
      );
    }
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error starting deep research' }, { status: 500 });
  }
}
