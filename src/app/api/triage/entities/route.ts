/**
 * @file api/triage/entities/route.ts
 * @description List proposed Entities (the net-new entity triage lane — where
 * technologies discovered by the net-new scout land for review).
 * GET /api/triage/entities?status=pending
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getProposedEntities } from '@/lib/proposed-entities-admin';
import type { ProposedEntityStatus } from '@/lib/schemas/proposed-entity';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/triage/entities');

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const status = (request.nextUrl.searchParams.get('status') as ProposedEntityStatus | null) ?? 'pending';
    const entities = await getProposedEntities({ status });
    return NextResponse.json({ entities });
  } catch (error) {
    log.error('list proposed entities failed', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list proposed entities' }, { status: 500 });
  }
}
