/**
 * @file app/api/digests/route.ts
 * @description API routes for daily digests.
 *
 * GET /api/digests?unread=true — List unread digests
 * POST /api/digests — Mark digest as read { digestId, action: 'markRead' }
 *                    — Mark all digests read { action: 'markAllRead' }
 *
 * @phase Impulse v1.0 — Phase 4: Intelligence Layer
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getUnreadDigests, markDigestRead, markAllDigestsRead } from '@/lib/digests';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/digests');

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const digests = await getUnreadDigests(auth.uid);
    return NextResponse.json({ digests });
  } catch (error) {
    log.error('Failed to list digests', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list digests' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { digestId, action } = body;

    if (action === 'markAllRead') {
      const count = await markAllDigestsRead(auth.uid);
      log.info('All digests marked as read', { count, uid: auth.uid });
      return NextResponse.json({ success: true, count });
    }

    if (!digestId || action !== 'markRead') {
      return NextResponse.json({ error: 'digestId and action: "markRead" required' }, { status: 400 });
    }

    await markDigestRead(digestId);
    log.info('Digest marked as read', { digestId, uid: auth.uid });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Failed to update digest', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to update digest' }, { status: 500 });
  }
}
