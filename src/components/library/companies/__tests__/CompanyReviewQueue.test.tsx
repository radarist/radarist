/**
 * @jest-environment jsdom
 *
 * AI-043 — the truthful review queue facet: shows only genuinely-incomplete
 * drafts (a completed/ready or draft-less company leaves the queue), labels each
 * with its status, and links to the review panel.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockUseSummaries = jest.fn();
jest.mock('@/hooks/queries/useCompanyReview', () => ({
  __esModule: true,
  useCompanyReviewSummaries: (...args: unknown[]) => mockUseSummaries(...args),
}));

import { CompanyReviewQueue } from '../CompanyReviewQueue';
import type { Company } from '@/lib/types';

const draftA = {
  id: 'c1',
  name: 'Acme',
  aiResearch: { lastResearched: 1, data: { citationsVerified: false } },
} as unknown as Company;
const draftB = {
  id: 'c2',
  name: 'Beta',
  research: { lastResearched: 1, version: 1, executiveSummary: { overview: 'x', keyHighlights: [] } },
} as unknown as Company;
const noDraft = { id: 'c3', name: 'Gamma' } as unknown as Company;

beforeEach(() => jest.clearAllMocks());

const loaded = (data: Record<string, { status: string; hasDraft: boolean }>) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
});

describe('CompanyReviewQueue', () => {
  it('shows only incomplete drafts with their status; a ready draft leaves the queue', () => {
    mockUseSummaries.mockReturnValue(
      loaded({ c1: { status: 'not_reviewed', hasDraft: true }, c2: { status: 'ready', hasDraft: true } })
    );
    render(<CompanyReviewQueue companies={[draftA, draftB, noDraft]} onReview={jest.fn()} defaultOpen />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Not reviewed')).toBeInTheDocument();
    // c2 is ready → excluded; c3 has no draft → excluded.
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    expect(screen.getByText('1 awaiting review')).toBeInTheDocument();
  });

  it('links a company to its review panel', () => {
    mockUseSummaries.mockReturnValue(loaded({ c1: { status: 'partial', hasDraft: true } }));
    const onReview = jest.fn();
    render(<CompanyReviewQueue companies={[draftA]} onReview={onReview} defaultOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Review Acme' }));
    expect(onReview).toHaveBeenCalledWith(draftA);
  });

  it('renders nothing when every draft is ready or there is no draft', () => {
    mockUseSummaries.mockReturnValue(loaded({ c1: { status: 'ready', hasDraft: true } }));
    const { container } = render(<CompanyReviewQueue companies={[draftA, noDraft]} onReview={jest.fn()} defaultOpen />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a neutral "checking" state while statuses load — never labels drafts "awaiting review"', () => {
    mockUseSummaries.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() });
    render(<CompanyReviewQueue companies={[draftA, noDraft]} onReview={jest.fn()} defaultOpen />);
    expect(screen.getByText(/Checking review status/i)).toBeInTheDocument();
    // A draft is NOT presented as awaiting review before its status is known.
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting review/i)).not.toBeInTheDocument();
  });

  it('shows an explicit error with retry (not a false queue) when status loading fails', () => {
    const refetch = jest.fn();
    mockUseSummaries.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<CompanyReviewQueue companies={[draftA]} onReview={jest.fn()} defaultOpen />);
    expect(screen.getByText(/Review status unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
