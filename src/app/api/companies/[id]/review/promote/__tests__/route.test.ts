/**
 * @jest-environment node
 *
 * AI-043 — the explicit promotion endpoint: auth-first, owner-resolved, maps a
 * missing company to 404.
 */

const mockGetAuthenticatedUser = jest.fn();
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

const mockPromote = jest.fn();
jest.mock('@/lib/company-review-admin', () => {
  class CompanyReviewCompanyNotFoundError extends Error {
    constructor(id: string) {
      super(id);
      this.name = 'CompanyReviewCompanyNotFoundError';
    }
  }
  class CompanyReviewNotReadyError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CompanyReviewNotReadyError';
    }
  }
  return {
    __esModule: true,
    CompanyReviewCompanyNotFoundError,
    CompanyReviewNotReadyError,
    promoteApprovedCompanyReviewClaims: (...args: unknown[]) => mockPromote(...args),
  };
});

import { POST } from '../route';
import { CompanyReviewCompanyNotFoundError, CompanyReviewNotReadyError } from '@/lib/company-review-admin';

function req() {
  return {} as unknown as import('next/server').NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'alice' });
});

describe('POST /api/companies/[id]/review/promote', () => {
  it('rejects an unauthenticated request', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    expect((await POST(req(), ctx)).status).toBe(401);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('promotes as the authenticated owner and returns the promoted fields', async () => {
    mockPromote.mockResolvedValue({ promoted: ['size', 'website'] });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(mockPromote).toHaveBeenCalledWith('c1', 'alice');
    expect((await res.json()).promoted).toEqual(['size', 'website']);
  });

  it('maps a missing company to 404', async () => {
    mockPromote.mockRejectedValue(new CompanyReviewCompanyNotFoundError('c1'));
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it('maps a not-ready draft to a stable 409', async () => {
    mockPromote.mockRejectedValue(new CompanyReviewNotReadyError('not ready'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_ready');
  });
});
