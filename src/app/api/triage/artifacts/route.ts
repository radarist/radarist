/**
 * @file api/triage/artifacts/route.ts
 * @description List artifact RECOMMENDATIONS — the "produce a report / research doc /
 * infographic" proposals that land in the Assessments inbox. `status=pending` is the
 * inbox; any other status is the Archive.
 * GET /api/triage/artifacts?status=pending
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getProposedArtifacts } from '@/lib/proposed-artifacts-admin';
import type { ProposedArtifactStatus } from '@/lib/schemas/proposed-artifact';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/triage/artifacts');

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const status = (request.nextUrl.searchParams.get('status') as ProposedArtifactStatus | null) ?? 'pending';
    // SEC-011: list only the authenticated caller's recommendations.
    const artifacts = await getProposedArtifacts(auth.uid, { status });
    return NextResponse.json({ artifacts });
  } catch (error) {
    log.error('list proposed artifacts failed', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list proposed artifacts' }, { status: 500 });
  }
}
