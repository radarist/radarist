/**
 * @jest-environment node
 *
 * AI-043 — the batch review-summary endpoint: auth-first, one owner-scoped events
 * read, per-company status classification, de-duplicated ids.
 */

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

const mockGetCompanyById = jest.fn();
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanyById: (...args: unknown[]) => mockGetCompanyById(...args),
}));

const mockOwnerEvents = jest.fn();
jest.mock('@/lib/company-review-admin', () => ({
  __esModule: true,
  listCompanyReviewEventsForCompanies: (...args: unknown[]) => mockOwnerEvents(...args),
}));

import { POST } from '../route';
import type { Company } from '@/lib/types';

function draftCompany(id: string): Company {
  return {
    id,
    aiResearch: {
      lastResearched: 1,
      data: {
        citationsVerified: false,
        sourcingComplete: true,
        version: 7,
        receipts: { size: [{ url: 'https://reuters.com/a' }] },
        claimValues: { size: 'medium' },
      },
    },
  } as unknown as Company;
}

function req(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'alice' });
  mockOwnerEvents.mockResolvedValue(new Map());
});

describe('POST /api/companies/review-summary', () => {
  it('rejects an unauthenticated request', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    expect((await POST(req({ companyIds: ['c1'] }))).status).toBe(401);
  });

  it('rejects an invalid body', async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it('classifies each company and reads events for JUST the requested (de-duplicated) ids', async () => {
    mockGetCompanyById.mockImplementation(async (id: string) => (id === 'c9' ? null : draftCompany(id)));
    const res = await POST(req({ companyIds: ['c1', 'c1', 'c9'] }));
    expect(res.status).toBe(200);
    const { summaries } = await res.json();
    // A draft with no decisions → not_reviewed; a missing company → none.
    expect(summaries.c1.status).toBe('not_reviewed');
    expect(summaries.c9.status).toBe('none');
    // Events are read once, scoped to the DE-DUPLICATED requested ids (bounded), not
    // the owner's entire history.
    expect(mockOwnerEvents).toHaveBeenCalledTimes(1);
    expect(mockOwnerEvents).toHaveBeenCalledWith('alice', ['c1', 'c9']);
  });
});
