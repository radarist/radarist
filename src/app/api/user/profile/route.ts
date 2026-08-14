/**
 * @file app/api/user/profile/route.ts
 * @description UX-062 — expose the authenticated operator's owner profile so
 * the sidebar (and other identity surfaces) can bind to the canonical account
 * record instead of a seeded demo label.
 *
 * GET /api/user/profile — the `users/{uid}` owner-profile doc for the
 * AUTHENTICATED user only. A client-supplied uid is never accepted; the uid
 * always comes from the verified Firebase ID token (mirrors
 * /api/user/preferences). Returns `{ profile: null }` when no profile doc
 * exists yet (e.g. a fresh email signup that has not been seeded), so the
 * caller can fall back to the Firebase Auth email identity rather than a
 * stale demo label.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getOwnerProfile } from '@/lib/user-profile';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/user/profile');

/**
 * GET /api/user/profile — the authenticated user's owner profile.
 *
 * `profile` is null when no `users/{uid}` doc exists yet; callers fall back to
 * the Firebase Auth email identity in that case.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const profile = await getOwnerProfile(auth.uid);
    return NextResponse.json({ profile });
  } catch (error) {
    log.error('Failed to read owner profile', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
    });
    return NextResponse.json({ error: 'Failed to read profile' }, { status: 500 });
  }
}
