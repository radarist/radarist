/**
 * @file app/api/agents/feedback/route.ts
 * @description API route for agent output feedback (thumbs up/down).
 *
 * Stores user ratings in the Firestore `agent-feedback` collection.
 * Future sweep REFLECT phases can query this to adjust strategy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/agents/feedback');

const feedbackSchema = z.object({
  missionId: z.string().min(1, 'missionId is required'),
  rating: z.enum(['positive', 'negative']),
  comment: z.string().max(1000).optional(),
});

/**
 * POST /api/agents/feedback
 *
 * Submit feedback for an agent mission output.
 *
 * Request body:
 * ```json
 * {
 *   "missionId": "abc123",
 *   "rating": "positive" | "negative",
 *   "comment": "optional text"
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();
    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { missionId, rating, comment } = parsed.data;

    const feedbackRef = db.collection('agent-feedback').doc();
    await feedbackRef.set({
      id: feedbackRef.id,
      missionId,
      rating,
      comment: comment ?? null,
      userId: auth.uid,
      createdAt: new Date().toISOString(),
    });

    log.info('Agent feedback recorded', { missionId, rating, userId: auth.uid });

    return NextResponse.json({ id: feedbackRef.id, success: true }, { status: 201 });
  } catch (error) {
    log.error('Error recording agent feedback', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to record feedback' }, { status: 500 });
  }
}
