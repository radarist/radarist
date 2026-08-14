/**
 * @file app/api/activity/defense-verifications/route.ts
 * @description API route for the Background Verifications activity facet.
 *
 * Returns a bounded, paginated list of Defense Minister verification JobRuns
 * (`verify-entity` / `verify-edge`), correlated with their accounting receipts,
 * markers, settlements, and graph results. The route is read-only and never
 * exposes raw input/output, prompts, provider payloads, or stack traces.
 *
 * Authentication is the first operation; unauthorized requests are rejected
 * before any read. Defense verification runs are system-principal
 * (`user:system`) because the producer functions record receipts under that
 * principal. The route hard-codes that principal for accounting joins so a
 * caller can never substitute another tenant's owner.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { listDefenseVerifications } from '@/lib/activity/defense-verification-join';
import {
  listDefenseVerificationsQuerySchema,
  type DefenseVerificationListPage,
} from '@/lib/activity/defense-verification-types';

const log = createLogger('api/activity/defense-verifications');

const DEFENSE_VERIFICATION_ACCOUNTING_OWNER = 'user:system';

/**
 * GET /api/activity/defense-verifications
 *
 * Query params (all optional):
 * - `kind`: 'entity' | 'edge'
 * - `status`: 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled'
 * - `cursor`: opaque pagination cursor
 * - `limit`: 1..100, default 25
 *
 * Response:
 * ```json
 * {
 *   "verifications": [DefenseVerificationRow],
 *   "nextCursor": string | null
 * }
 * ```
 */
export async function GET(request: NextRequest): Promise<NextResponse<DefenseVerificationListPage | { error: string }>> {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let params: { kind?: 'entity' | 'edge'; status?: 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled'; cursor?: string; limit: number };
  try {
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    params = listDefenseVerificationsQuerySchema.parse(searchParams);
  } catch (error) {
    log.warn('Invalid defense-verifications query params', {
      error: error instanceof Error ? error.message : String(error),
      search: request.nextUrl.search,
    });
    return NextResponse.json({ error: 'Invalid query parameters' }, { status: 400 });
  }

  try {
    const page = await listDefenseVerifications({
      accountingOwner: DEFENSE_VERIFICATION_ACCOUNTING_OWNER,
      kind: params.kind,
      status: params.status,
      cursor: params.cursor,
      limit: params.limit,
    });
    return NextResponse.json(page);
  } catch (error) {
    log.error(
      'Failed to list defense verifications',
      error instanceof Error ? error : new Error(String(error)),
      { uid: auth.uid }
    );
    return NextResponse.json(
      { error: 'Failed to list defense verifications' },
      { status: 500 }
    );
  }
}
