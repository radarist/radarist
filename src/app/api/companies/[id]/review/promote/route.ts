/**
 * @file route.ts (API > companies > [id] > review > promote)
 * @description AI-043 — the SEPARATE, EXPLICIT promotion action.
 *
 *   POST /api/companies/[id]/review/promote — copy the reviewed value of every
 *   structured claim area that has a CURRENT approved decision (for the
 *   authenticated owner) into the canonical Company fields.
 *
 * This is the ONLY path that promotes a reviewed value onto the Company. Research
 * writes drafts; recording a review decision never mutates the Company; promotion
 * is this deliberate, owner-scoped, authenticated action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import {
  CompanyReviewCompanyNotFoundError,
  CompanyReviewNotPromotableError,
  CompanyReviewNotReadyError,
  promoteApprovedCompanyReviewClaims,
} from '@/lib/company-review-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/companies/review/promote');

/**
 * Authorization: promoting a reviewed draft onto the canonical Company fields is a
 * Company mutation, and it reuses the SAME authority the rest of the app uses to
 * mutate a Company (`updateCompany` — authentication; Companies are shared
 * workspace entities with no per-record owner/editor role in this prototype, see
 * docs/LIMITATIONS.md). The auth check runs BEFORE the id is used, so an
 * unauthenticated caller gets 401 and learns nothing about whether the company
 * exists. Promotion additionally applies only the CALLER'S OWN owner-scoped
 * approvals, so it can never promote another reviewer's private decisions.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;
    const result = await promoteApprovedCompanyReviewClaims(id, auth.uid);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CompanyReviewCompanyNotFoundError) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    if (error instanceof CompanyReviewNotReadyError) {
      return NextResponse.json({ error: 'not_ready', message: error.message }, { status: 409 });
    }
    if (error instanceof CompanyReviewNotPromotableError) {
      return NextResponse.json({ error: 'not_promotable', message: error.message }, { status: 409 });
    }
    log.error('Failed to promote approved company review claims', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to promote review claims' }, { status: 500 });
  }
}
