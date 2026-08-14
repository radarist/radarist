/**
 * @file route.ts (API > companies > review-summary)
 * @description AI-043 — bounded batch review-status read for the review queue.
 *
 *   POST /api/companies/review-summary — for the authenticated caller, return the
 *   CURRENT review status of each requested company (not_reviewed / partial /
 *   blocked / stale / ready / none). One authenticated request derives every
 *   status server-side; the caller's events are read in BOUNDED, company-scoped
 *   chunked queries (never an owner-wide history scan), so the queue never issues
 *   an N+1 of per-company client requests and read cost is bounded by the request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getAuthenticatedUser } from '@/lib/auth-utils';
import { adminGetCompanyById } from '@/lib/companies-admin';
import {
  buildCompanyReviewProjection,
  classifyCompanyReviewStatus,
  type CompanyReviewStatus,
} from '@/lib/company-review';
import { listCompanyReviewEventsForCompanies } from '@/lib/company-review-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/companies/review-summary');

const RequestSchema = z.object({
  companyIds: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.errors }, { status: 400 });
    }

    // De-duplicate the requested ids and read the caller's events for JUST these
    // companies (bounded, chunked) — not the owner's entire review history.
    const ids = [...new Set(parsed.data.companyIds)];
    const eventsByCompany = await listCompanyReviewEventsForCompanies(auth.uid, ids);

    const summaries: Record<string, { status: CompanyReviewStatus; hasDraft: boolean }> = {};
    await Promise.all(
      ids.map(async (id) => {
        const company = await adminGetCompanyById(id);
        if (!company) {
          summaries[id] = { status: 'none', hasDraft: false };
          return;
        }
        const projection = buildCompanyReviewProjection(company);
        const status = classifyCompanyReviewStatus(projection, eventsByCompany.get(id) ?? []);
        summaries[id] = { status, hasDraft: projection.hasDraft };
      })
    );

    return NextResponse.json({ summaries });
  } catch (error) {
    log.error('Failed to build company review summaries', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to load review summaries' }, { status: 500 });
  }
}
