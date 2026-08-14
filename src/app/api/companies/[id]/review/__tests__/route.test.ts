/**
 * @jest-environment node
 *
 * AI-043 — the authenticated review API. Auth-first, owner-scoped, and it maps
 * the repository's atomic stale/conflict/not-found refusals to HTTP. The pure
 * projection is real; auth, the company read, and the ledger repository are mocked.
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

const mockRecord = jest.fn();
const mockList = jest.fn();
jest.mock('@/lib/company-review-admin', () => {
  class CompanyReviewConflictError extends Error {
    existing: { id: string };
    constructor(existing: { id: string }) {
      super('conflict');
      this.name = 'CompanyReviewConflictError';
      this.existing = existing;
    }
  }
  class CompanyReviewStaleDraftError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CompanyReviewStaleDraftError';
    }
  }
  class CompanyReviewCompanyNotFoundError extends Error {
    constructor(id: string) {
      super(id);
      this.name = 'CompanyReviewCompanyNotFoundError';
    }
  }
  return {
    __esModule: true,
    CompanyReviewConflictError,
    CompanyReviewStaleDraftError,
    CompanyReviewCompanyNotFoundError,
    recordCompanyReviewDecision: (...args: unknown[]) => mockRecord(...args),
    listCompanyReviewEvents: (...args: unknown[]) => mockList(...args),
  };
});

import { GET, POST } from '../route';
import { buildCompanyReviewProjection } from '@/lib/company-review';
import {
  CompanyReviewConflictError,
  CompanyReviewStaleDraftError,
  CompanyReviewCompanyNotFoundError,
} from '@/lib/company-review-admin';
import type { Company } from '@/lib/types';

const COMPANY = {
  id: 'c1',
  aiResearch: {
    lastResearched: 1,
    data: {
      citationsVerified: false,
      sourcingComplete: true,
      version: 7,
      receipts: { size: [{ url: 'https://reuters.com/a' }], website: [{ url: 'https://acme.example' }] },
      claimValues: { size: 'medium', website: 'https://acme.example' },
    },
  },
} as unknown as Company;

const projection = buildCompanyReviewProjection(COMPANY);
const sizeArea = projection.areas.find((a) => a.key === 'size')!;

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'c1',
    artifactKind: 'structured',
    artifactVersion: projection.artifactVersion,
    area: 'size',
    areaDigest: sizeArea.areaDigest,
    draftDigest: projection.draftDigest,
    sourceIds: sizeArea.sourceIds,
    decision: 'approved',
    idempotencyKey: 'key-00000001',
    ...overrides,
  };
}

function req(body?: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}

const ctx = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'alice' });
  mockGetCompanyById.mockResolvedValue(COMPANY);
  mockList.mockResolvedValue([]);
});

describe('GET /api/companies/[id]/review', () => {
  it('rejects an unauthenticated request', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    expect((await GET(req(), ctx)).status).toBe(401);
    expect(mockGetCompanyById).not.toHaveBeenCalled();
  });

  it('returns 404 for an absent company', async () => {
    mockGetCompanyById.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it('returns projection, readiness and caller-owned events', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.projection.areas.map((a: { key: string }) => a.key)).toEqual(['size', 'website']);
    expect(json.projection.artifactKind).toBe('structured');
    expect(mockList).toHaveBeenCalledWith('c1', 'alice');
  });
});

describe('POST /api/companies/[id]/review', () => {
  it('rejects an unauthenticated request before parsing the body', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    expect((await POST(req(validBody()), ctx)).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (missing artifactKind)', async () => {
    const res = await POST(req({ ...validBody(), artifactKind: undefined }), ctx);
    expect(res.status).toBe(400);
  });

  it('rejects a companyId that does not match the route', async () => {
    expect((await POST(req(validBody({ companyId: 'other' })), ctx)).status).toBe(400);
  });

  it('records a valid decision with server-resolved owner and reviewer', async () => {
    mockRecord.mockResolvedValue({ event: { id: 'rev-1', area: 'size', decision: 'approved' }, outcome: 'recorded' });
    const res = await POST(req(validBody()), ctx);
    expect(res.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'c1', artifactKind: 'structured', area: 'size' }),
      { ownerId: 'alice', reviewerId: 'alice' }
    );
    expect((await res.json()).readiness).toBeDefined();
  });

  it('maps a stale-draft refusal to 409', async () => {
    mockRecord.mockRejectedValue(new CompanyReviewStaleDraftError('stale'));
    const res = await POST(req(validBody()), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_draft');
  });

  it('maps a decision conflict to 409', async () => {
    mockRecord.mockRejectedValue(new CompanyReviewConflictError({ id: 'rev-1' } as never));
    const res = await POST(req(validBody()), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('decision_conflict');
  });

  it('maps a missing company to 404', async () => {
    mockRecord.mockRejectedValue(new CompanyReviewCompanyNotFoundError('c1'));
    expect((await POST(req(validBody()), ctx)).status).toBe(404);
  });
});
