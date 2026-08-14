/**
 * @file api/triage/assessments/route.ts
 * @description List proposed Assessments (the "Assessment" triage lane).
 * GET /api/triage/assessments?status=pending
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getProposedAssessments } from '@/lib/proposed-assessments-admin';
import type { ProposedAssessmentStatus } from '@/lib/schemas/proposed-assessment';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/triage/assessments');

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const status = request.nextUrl.searchParams.get('status') as ProposedAssessmentStatus | null;
    const assessments = await getProposedAssessments(status ? { status } : undefined);
    return NextResponse.json({ assessments });
  } catch (error) {
    log.error('list assessments failed', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list assessments' }, { status: 500 });
  }
}
