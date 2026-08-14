/**
 * @jest-environment jsdom
 *
 * AI-043 — the inline source-review panel: renders reviewable areas, source
 * references, readiness + blockers, records a decision on the exact binding, and
 * gates promotion on an approved claim.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// lucide-react ships as ESM which Jest doesn't transform; stub every icon.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { buildCompanyReviewProjection, deriveCompanyReviewReadiness } from '@/lib/company-review';
import type { Company } from '@/lib/types';

const mockRecordMutate = jest.fn();
const mockPromoteMutate = jest.fn();
const mockRefetch = jest.fn();

const COMPANY = {
  id: 'c1',
  name: 'Acme',
  aiResearch: {
    lastResearched: 1_700_000_000_000,
    data: {
      citationsVerified: false,
      sourcingComplete: true,
      version: 7,
      receipts: {
        size: [{ url: 'https://reuters.com/acme', title: 'Reuters on Acme' }],
        website: [{ url: 'https://acme.example' }],
      },
      claimValues: { size: 'medium', website: 'https://acme.example' },
    },
  },
} as unknown as Company;

const projection = buildCompanyReviewProjection(COMPANY);
const readiness = deriveCompanyReviewReadiness(projection, []);

jest.mock('@/hooks/queries/useCompanyReview', () => ({
  __esModule: true,
  useCompanyReview: () => ({
    data: { projection, readiness, events: [] },
    isLoading: false,
    error: null,
    refetch: mockRefetch,
  }),
  useRecordReviewDecision: () => ({ mutate: mockRecordMutate }),
  usePromoteReviewClaims: () => ({
    mutate: mockPromoteMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
    data: undefined,
  }),
  StaleDraftError: class StaleDraftError extends Error {},
}));

import { CompanyReviewPanel } from '../CompanyReviewPanel';

beforeEach(() => jest.clearAllMocks());

describe('CompanyReviewPanel', () => {
  it('renders the reviewable areas, their values and safe source links', () => {
    render(<CompanyReviewPanel companyId="c1" />);
    expect(screen.getByText('Company size')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Reuters on Acme/i });
    expect(link).toHaveAttribute('href', 'https://reuters.com/acme');
  });

  it('shows the draft as review-incomplete before any decision', () => {
    render(<CompanyReviewPanel companyId="c1" />);
    expect(screen.getByText('Review incomplete')).toBeInTheDocument();
    expect(screen.getAllByText('Not reviewed').length).toBeGreaterThan(0);
  });

  it('records a decision bound to the exact area + draft digest', () => {
    render(<CompanyReviewPanel companyId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Company size' }));
    expect(mockRecordMutate).toHaveBeenCalledTimes(1);
    const [args] = mockRecordMutate.mock.calls[0];
    expect(args).toMatchObject({
      artifactKind: projection.artifactKind,
      artifactVersion: projection.artifactVersion,
      area: 'size',
      draftDigest: projection.draftDigest,
      decision: 'approved',
    });
  });

  it('disables promotion until the whole draft is ready (ready-only gate)', () => {
    render(<CompanyReviewPanel companyId="c1" />);
    // Structured draft → the promotion action is present but disabled while the
    // draft is not yet fully approved, matching the server ready-only gate.
    expect(screen.getByRole('button', { name: /Promote approved fields/i })).toBeDisabled();
  });
});
