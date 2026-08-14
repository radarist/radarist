/**
 * @file route.ts (API > companies > [id] > review)
 * @description AI-043 — the authenticated, same-origin surface for the human
 * source-review workflow over a company research draft.
 *
 *   GET  /api/companies/[id]/review — the review projection (areas, digests,
 *        hard blockers), the caller's own recorded decisions, and the DERIVED
 *        readiness. Readiness is never stored.
 *   POST /api/companies/[id]/review — record ONE human review decision. The
 *        server resolves owner/reviewer/timestamp from the session (a client can
 *        never choose them) and refuses a decision made against a stale draft —
 *        the current draft is re-derived inside the write transaction.
 *
 * Auth is the first operation. Owner/reviewer are the authenticated uid; the
 * ledger read is owner-scoped, so one user never sees another's decisions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { adminGetCompanyById } from '@/lib/companies-admin';
import {
  buildCompanyReviewProjection,
  deriveCompanyReviewReadiness,
  type CompanyReviewEvent,
} from '@/lib/company-review';
import {
  CompanyReviewConflictError,
  CompanyReviewCompanyNotFoundError,
  CompanyReviewStaleDraftError,
  listCompanyReviewEvents,
  recordCompanyReviewDecision,
} from '@/lib/company-review-admin';
import { companyReviewDecisionInputSchema } from '@/lib/schemas/company-review';
import { createLogger } from '@/lib/logger';
import type { Company } from '@/lib/types';

const log = createLogger('api/companies/review');

/** The wire shape the UI and Assistant consume. Readiness is derived, not stored. */
function buildReviewState(company: Pick<Company, 'id' | 'research' | 'aiResearch'>, events: CompanyReviewEvent[]) {
  const projection = buildCompanyReviewProjection(company);
  const readiness = deriveCompanyReviewReadiness(projection, events);
  return { projection, readiness, events };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;
    const company = await adminGetCompanyById(id);
    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const events = await listCompanyReviewEvents(id, auth.uid);
    return NextResponse.json(buildReviewState(company, events));
  } catch (error) {
    log.error('Failed to load company review state', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to load review state' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = companyReviewDecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.errors }, { status: 400 });
    }
    const input = parsed.data;
    if (input.companyId !== id) {
      return NextResponse.json({ error: 'companyId does not match the route' }, { status: 400 });
    }

    // The repository re-derives the current draft inside the write transaction and
    // refuses a stale decision atomically.
    const { event, outcome } = await recordCompanyReviewDecision(input, {
      ownerId: auth.uid,
      reviewerId: auth.uid,
    });

    const company = await adminGetCompanyById(id);
    const events = await listCompanyReviewEvents(id, auth.uid);
    const readiness = company ? deriveCompanyReviewReadiness(buildCompanyReviewProjection(company), events) : undefined;
    return NextResponse.json({ event, outcome, readiness }, { status: outcome === 'recorded' ? 201 : 200 });
  } catch (error) {
    if (error instanceof CompanyReviewCompanyNotFoundError) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    if (error instanceof CompanyReviewStaleDraftError) {
      return NextResponse.json({ error: 'stale_draft', message: error.message }, { status: 409 });
    }
    if (error instanceof CompanyReviewConflictError) {
      return NextResponse.json(
        { error: 'decision_conflict', message: error.message, existing: { id: error.existing.id } },
        { status: 409 }
      );
    }
    log.error('Failed to record company review decision', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to record review decision' }, { status: 500 });
  }
}
