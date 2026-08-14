/**
 * @file page.test.tsx
 * @description Pins the report-detail load-failure and deletion contracts:
 *
 *   UX-016 — deleting a report requires an explicit confirmation, disables the
 *   confirm button while the delete is in flight (no double-submit), and stays
 *   on the page when the API rejects.
 *   UX-017 — a genuine 404 renders "Report not found"; any other failure
 *   (network / 401 / 429 / 5xx) renders "Report unavailable" with a Retry that
 *   re-runs the query.
 *   REPORT-007 — optional brand CSS never gates the static preview or print
 *   document, so a stalled asset cannot leave a blank report surface.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// lucide-react is ESM; stub every icon as a null-rendering component.
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'report-001' }),
  useRouter: () => ({ push: mockRouterPush }),
}));

// Break the Firebase init chain so requireActual of the
// hook module below only pulls in the pure ReportFetchError class.
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, loading: false }),
}));

// Layout is stubbed to plain divs so these tests isolate report-page behavior.
jest.mock('@/components/layout/AppLayoutV2', () => ({
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const mockRefetch = jest.fn();
let reportState: { data: unknown; isLoading: boolean; error: unknown };
const mockDeleteMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
let deleteIsPending = false;

jest.mock('@/hooks/useReports', () => {
  const actual = jest.requireActual('@/hooks/useReports');
  return {
    ...actual,
    useReport: () => ({ ...reportState, refetch: mockRefetch }),
    useUpdateReport: () => ({ mutateAsync: mockUpdateMutateAsync }),
    useDeleteReport: () => ({ mutateAsync: mockDeleteMutateAsync, isPending: deleteIsPending }),
    // DISC-014 hooks — stubbed so they don't reach the (stubbed) react-query.
    useReportVersion: () => ({ data: undefined }),
    useRestoreReportVersion: () => ({ mutateAsync: jest.fn() }),
  };
});
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
// The history sheet has its own test + its own data hooks — stub it here so the
// page test stays focused on the page's load/error/delete states.
jest.mock('@/components/reports/ReportHistorySheet', () => ({ ReportHistorySheet: () => null }));

import ReportDetailPage from '../page';
import { ReportFetchError } from '@/hooks/useReports';
import { toast } from 'sonner';

const MOCK_REPORT = {
  id: 'report-001',
  title: 'Quantum Radar Landscape',
  html: '<p>body</p>',
  createdAt: new Date('2026-01-01').toISOString(),
  createdBy: 'agent',
  agentType: 'creator',
  entityIds: [],
  metadata: { description: '', dataSnapshotAt: new Date('2026-01-01').toISOString() },
  shared: false,
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
  // SEC-003: the static preview + print frames fetch the brand stylesheet
  // (loadReportBrandCss). jsdom has no fetch — stub a benign miss so the frame
  // builders run without the theme CSS.
  (global as unknown as { fetch: unknown }).fetch = jest.fn(() =>
    Promise.resolve({ ok: false, text: async () => '' })
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  (global.fetch as jest.Mock).mockImplementation(() =>
    Promise.resolve({ ok: false, text: async () => '' })
  );
  deleteIsPending = false;
  reportState = { data: MOCK_REPORT, isLoading: false, error: null };
});

// ---------------------------------------------------------------------------
// REPORT-007 — optional brand CSS must not gate report availability
// ---------------------------------------------------------------------------

describe('report preview availability (REPORT-007)', () => {
  it('renders sanitized report HTML while the optional brand stylesheet is still pending', async () => {
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));

    render(<ReportDetailPage />);

    const preview = await screen.findByTitle('Report preview');
    await waitFor(() => expect(preview).toHaveAttribute('srcdoc', expect.stringContaining('<p>body</p>')));
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// UX-017 — unavailable vs not found
// ---------------------------------------------------------------------------

describe('report-detail load failures (UX-017)', () => {
  it('renders "not found" for a genuine 404', () => {
    reportState = { data: undefined, isLoading: false, error: new ReportFetchError('nope', 404) };
    render(<ReportDetailPage />);
    expect(screen.getByText('Report not found')).toBeInTheDocument();
    expect(screen.queryByText('Report unavailable')).not.toBeInTheDocument();
  });

  it.each([
    ['network failure (no status)', new ReportFetchError('network', undefined)],
    ['401 unauthorized', new ReportFetchError('unauth', 401)],
    ['429 rate limited', new ReportFetchError('rate', 429)],
    ['503 server error', new ReportFetchError('boom', 503)],
  ])('renders "unavailable" with Retry for %s', (_label, error) => {
    reportState = { data: undefined, isLoading: false, error };
    render(<ReportDetailPage />);
    expect(screen.getByText('Report unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Report not found')).not.toBeInTheDocument();
  });

  it('Retry re-runs the query', () => {
    reportState = { data: undefined, isLoading: false, error: new ReportFetchError('boom', 503) };
    render(<ReportDetailPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// UX-016 — deletion confirmation
// ---------------------------------------------------------------------------

describe('report deletion confirmation (UX-016)', () => {
  function openDeleteDialog() {
    render(<ReportDetailPage />);
    fireEvent.click(screen.getByTestId('report-delete'));
  }

  it('does not delete without confirmation — the trigger only opens the dialog', () => {
    openDeleteDialog();
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
    // The confirm dialog is now present.
    expect(screen.getByText(/This action cannot be undone/i)).toBeInTheDocument();
  });

  it('deletes and navigates away on confirm success', async () => {
    mockDeleteMutateAsync.mockResolvedValueOnce(undefined);
    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockDeleteMutateAsync).toHaveBeenCalledWith('report-001'));
    expect(mockRouterPush).toHaveBeenCalledWith('/reports');
    expect(toast.success).toHaveBeenCalledWith('Report deleted');
  });

  it('cancel closes the dialog without deleting', () => {
    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });

  it('stays on the page when the delete API rejects', async () => {
    mockDeleteMutateAsync.mockRejectedValueOnce(new Error('500'));
    openDeleteDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to delete report'));
    expect(mockRouterPush).not.toHaveBeenCalled();
    // Report content is still on screen.
    expect(screen.getByText('Quantum Radar Landscape')).toBeInTheDocument();
  });

  it('disables the confirm button while a delete is pending (no double-submit)', () => {
    deleteIsPending = true;
    openDeleteDialog();
    const confirm = screen.getByRole('button', { name: 'Deleting…' });
    expect(confirm).toBeDisabled();
  });

  it('disables confirm after the first click so a second click cannot resubmit', () => {
    // Model TanStack: the first mutateAsync flips isPending synchronously and
    // the mutation stays in-flight (never resolves) for the test.
    mockDeleteMutateAsync.mockImplementation(() => {
      deleteIsPending = true;
      return new Promise(() => {});
    });
    const { rerender } = render(<ReportDetailPage />);
    fireEvent.click(screen.getByTestId('report-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // React commits the pending state → the confirm is now disabled.
    rerender(<ReportDetailPage />);
    const pendingConfirm = screen.getByRole('button', { name: 'Deleting…' });
    expect(pendingConfirm).toBeDisabled();
    fireEvent.click(pendingConfirm); // disabled → no-op
    expect(mockDeleteMutateAsync).toHaveBeenCalledTimes(1);
  });
});


// ---------------------------------------------------------------------------
// REPORT-002 — owner-visible needs-review draft with repair path
// ---------------------------------------------------------------------------

describe('needs-review draft banner (REPORT-002)', () => {
  const DRAFT_REPORT = {
    ...MOCK_REPORT,
    reviewStatus: 'needs-review',
    qualityGate: {
      verdict: 'REVISE',
      evaluatedAt: new Date('2026-07-01').toISOString(),
      failingChecks: [
        { name: 'creator-brand-compliance', detail: '3 brand violation(s): no-variable-shadowing', critical: false },
        { name: 'citations-present', detail: 'only 1 citation markers — prompt expected ≥3', critical: false },
      ],
      repair: 'Fix the issues with an edit, restore an earlier passing version, or approve the draft as-is.',
    },
  };

  it('shows the banner with the exact failed checks and the repair path', () => {
    reportState = { data: DRAFT_REPORT, isLoading: false, error: null };
    render(<ReportDetailPage />);

    expect(screen.getByTestId('needs-review-banner')).toBeInTheDocument();
    expect(screen.getByText(/draft pending your review/i)).toBeInTheDocument();
    const checks = screen.getByTestId('failed-checks');
    expect(checks).toHaveTextContent('creator-brand-compliance');
    expect(checks).toHaveTextContent('citations-present');
    expect(screen.getByText(/approve the draft as-is/i)).toBeInTheDocument();
  });

  it('Approve & publish performs the explicit owner approval', () => {
    reportState = { data: DRAFT_REPORT, isLoading: false, error: null };
    mockUpdateMutateAsync.mockResolvedValue({});
    render(<ReportDetailPage />);

    fireEvent.click(screen.getByTestId('approve-report'));

    expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
      id: 'report-001',
      updates: { reviewStatus: 'published' },
    });
  });

  it('disables Share for an unshared draft and never calls the update', () => {
    reportState = { data: DRAFT_REPORT, isLoading: false, error: null };
    render(<ReportDetailPage />);

    const shareButton = screen.getByRole('button', { name: /^Share$/ });
    expect(shareButton).toBeDisabled();
    fireEvent.click(shareButton);
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it('renders no banner for a published report', () => {
    reportState = { data: MOCK_REPORT, isLoading: false, error: null };
    render(<ReportDetailPage />);
    expect(screen.queryByTestId('needs-review-banner')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Share$/ })).toBeEnabled();
  });
});
