/**
 * @file InsightDetailView.test.tsx
 * @description Tests the detail page client component.
 *
 * Pins:
 *   1. Shows the skeleton while the detail query is pending.
 *   2. Shows the "not found" state on null data (deep-link to deleted).
 *   3. Renders title + summary + WhyAmISeeingThis when data lands.
 *   4. Fires `useTrackInsightView` exactly once per mount.
 *   5. Like button toggles via `useLikeInsight` with the inverse flag.
 *   6. Dismiss button fires `useDismissInsight`, shows Undo toast,
 *      navigates back to /triage/insights, and the Undo action restores
 *      the snapshot via `useUndismissInsight`.
 *   7. Back button navigates to /triage/insights (renamed from /briefing
 *      on 2026-05-13).
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockUseDetail = jest.fn();
jest.mock('@/hooks/queries/useInsightDetail', () => ({
  __esModule: true,
  useInsightDetail: (...args: unknown[]) => mockUseDetail(...args),
}));

// Task 20 (P-D4) — the detail view now also pulls the full briefing list to
// derive "Related insights" client-side. Default to an empty list; tests
// that care about the related-insights wiring override this per-case.
const mockUseBriefing = jest.fn();
jest.mock('@/hooks/useBriefing', () => {
  // Defined inside the factory so the component's `instanceof
  // BriefingRequestError` check (unavailable-state branch) matches.
  class BriefingRequestError extends Error {
    constructor(
      public status: number,
      public kind: string,
      message: string
    ) {
      super(message);
      this.name = 'BriefingRequestError';
    }
  }
  return {
    __esModule: true,
    useBriefing: (...args: unknown[]) => mockUseBriefing(...args),
    BriefingRequestError,
  };
});
const { BriefingRequestError: MockBriefingRequestError } = jest.requireMock('@/hooks/useBriefing') as {
  BriefingRequestError: new (status: number, kind: string, message: string) => Error;
};

const mockLikeMutate = jest.fn();
jest.mock('@/hooks/queries/useLikeInsight', () => ({
  __esModule: true,
  useLikeInsight: () => ({ mutate: mockLikeMutate }),
}));

const mockDismissMutate = jest.fn();
const mockUndismissMutate = jest.fn();
jest.mock('@/hooks/queries/useDismissInsight', () => ({
  __esModule: true,
  useDismissInsight: () => ({
    mutate: (vars: unknown, opts: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      mockDismissMutate(vars, opts);
      opts?.onSuccess?.();
    },
  }),
}));
jest.mock('@/hooks/queries/useUndismissInsight', () => ({
  __esModule: true,
  useUndismissInsight: () => ({ mutate: mockUndismissMutate }),
}));

const mockTrackViewMutate = jest.fn();
jest.mock('@/hooks/queries/useTrackInsightView', () => ({
  __esModule: true,
  useTrackInsightView: () => ({ mutate: mockTrackViewMutate }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('sonner', () => ({
  __esModule: true,
  toast: {
    success: (msg: string, opts: unknown) => mockToastSuccess(msg, opts),
    error: (msg: string, opts: unknown) => mockToastError(msg, opts),
  },
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

// Stub the breadcrumb so its internal logic doesn't muddy these tests
// — WhyAmISeeingThis has its own dedicated suite.
jest.mock('../WhyAmISeeingThis', () => ({
  __esModule: true,
  WhyAmISeeingThis: ({ insight }: { insight: { id: string }; entityNamesById: Map<string, string> }) => (
    <div data-testid="why-stub">why-{insight.id}</div>
  ),
}));

import { InsightDetailView } from '../InsightDetailView';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
  return {
    id: 'pi-1',
    type: 'connection',
    title: 'Quantum link',
    summary: 'Path goes through VENDOR → USES.',
    agentName: 'scout',
    confidenceScore: 0.8,
    relatedEntities: [{ id: 'comp-ibm', name: 'IBM', type: 'company' }],
    observedEntityId: 'comp-ibm',
    exploredEntityId: 'tech-quantum',
    actionable: true,
    actionUrl: '/library/companies?sheet=comp-ibm',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    relationshipTypes: ['VENDOR', 'USES'],
    pathLength: 2,
    exploredAt: '2026-05-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('InsightDetailView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseDetail.mockReturnValue({ data: makeInsight(), isPending: false, isError: false });
    mockUseBriefing.mockReturnValue({ data: { insights: [], tokenUsage: { used: 0, budget: 0 } } });
  });

  it('shows the skeleton while the detail query is pending', () => {
    mockUseDetail.mockReturnValueOnce({ data: undefined, isPending: true, isError: false });
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.getByTestId('detail-skeleton')).toBeInTheDocument();
    expect(mockTrackViewMutate).not.toHaveBeenCalled();
  });

  it('shows the "not found" state when the data is null (deleted deep-link)', () => {
    mockUseDetail.mockReturnValueOnce({ data: null, isPending: false, isError: false });
    render(<InsightDetailView insightId="missing" />);
    expect(screen.getByTestId('detail-empty')).toBeInTheDocument();
    expect(screen.getByText(/Insight not found/)).toBeInTheDocument();
    // The stale-link state is NOT the outage state.
    expect(screen.queryByTestId('detail-unavailable')).toBeNull();
  });

  it('shows the UNAVAILABLE state (not "not found") on a graph outage — UX-018', () => {
    const refetch = jest.fn();
    mockUseDetail.mockReturnValueOnce({
      data: undefined,
      isPending: false,
      isError: true,
      error: new MockBriefingRequestError(503, 'unavailable', 'Graph backend unavailable'),
      refetch,
    });
    render(<InsightDetailView insightId="pi-1" />);

    // Distinct from the stale-link "Insight not found" copy.
    expect(screen.getByTestId('detail-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-empty')).toBeNull();
    expect(screen.getByText('This insight is temporarily unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Insight not found/)).toBeNull();

    // Retry re-runs the query; the view tracker must not fire on an error.
    fireEvent.click(screen.getByTestId('detail-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mockTrackViewMutate).not.toHaveBeenCalled();
  });

  it('uses rate-limit copy on the detail page when the failure kind is rate-limited', () => {
    mockUseDetail.mockReturnValueOnce({
      data: undefined,
      isPending: false,
      isError: true,
      error: new MockBriefingRequestError(429, 'rate-limited', 'Too many requests'),
      refetch: jest.fn(),
    });
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.getByText('Too many requests')).toBeInTheDocument();
  });

  it('renders the title + summary + breadcrumb when data lands', () => {
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.getByText('Quantum link')).toBeInTheDocument();
    expect(screen.getByText(/Path goes through VENDOR/)).toBeInTheDocument();
    expect(screen.getByTestId('why-stub')).toHaveTextContent('why-pi-1');
  });

  it('fires the view tracker exactly once per mount', () => {
    render(<InsightDetailView insightId="pi-1" />);
    expect(mockTrackViewMutate).toHaveBeenCalledTimes(1);
    expect(mockTrackViewMutate).toHaveBeenCalledWith({ insightId: 'pi-1' });
  });

  it('does not re-fire the view tracker on re-render with the same id', () => {
    const { rerender } = render(<InsightDetailView insightId="pi-1" />);
    rerender(<InsightDetailView insightId="pi-1" />);
    expect(mockTrackViewMutate).toHaveBeenCalledTimes(1);
  });

  it('fires the view tracker again when the insightId prop changes', () => {
    const { rerender } = render(<InsightDetailView insightId="pi-1" />);
    mockUseDetail.mockReturnValue({ data: makeInsight({ id: 'pi-2', title: 'B' }), isPending: false, isError: false });
    rerender(<InsightDetailView insightId="pi-2" />);
    expect(mockTrackViewMutate).toHaveBeenCalledTimes(2);
    expect(mockTrackViewMutate).toHaveBeenNthCalledWith(2, { insightId: 'pi-2' });
  });

  it('like toggles via useLikeInsight with the inverse flag', () => {
    render(<InsightDetailView insightId="pi-1" />);
    fireEvent.click(screen.getByTestId('detail-like'));
    expect(mockLikeMutate).toHaveBeenCalledWith({ insightId: 'pi-1', liked: true });
  });

  it('unlike fires liked=false when the insight is already liked', () => {
    mockUseDetail.mockReturnValue({ data: makeInsight({ liked: true }), isPending: false, isError: false });
    render(<InsightDetailView insightId="pi-1" />);
    fireEvent.click(screen.getByTestId('detail-like'));
    expect(mockLikeMutate).toHaveBeenCalledWith({ insightId: 'pi-1', liked: false });
  });

  it('dismiss fires useDismissInsight, shows undo toast, and navigates back', () => {
    render(<InsightDetailView insightId="pi-1" />);
    act(() => {
      fireEvent.click(screen.getByTestId('detail-dismiss'));
    });
    expect(mockDismissMutate).toHaveBeenCalledWith({ insightId: 'pi-1' }, expect.any(Object));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Insight dismissed',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
    expect(mockPush).toHaveBeenCalledWith('/triage/insights');
  });

  it('toast Undo action calls useUndismissInsight with the captured snapshot', () => {
    render(<InsightDetailView insightId="pi-1" />);
    act(() => {
      fireEvent.click(screen.getByTestId('detail-dismiss'));
    });
    const opts = mockToastSuccess.mock.calls[0][1] as { action: { onClick: () => void } };
    act(() => {
      opts.action.onClick();
    });
    expect(mockUndismissMutate).toHaveBeenCalledTimes(1);
    expect(mockUndismissMutate.mock.calls[0][0].insight.id).toBe('pi-1');
  });

  it('humanizes the agent slug in both the byline and the Agent detail row (CONV-ENUM)', () => {
    mockUseDetail.mockReturnValue({
      data: makeInsight({ agentName: 'narrative-synthesizer' }),
      isPending: false,
      isError: false,
    });
    render(<InsightDetailView insightId="pi-1" />);
    // Byline: "by {agentName}" renders as one text node inside its span.
    expect(screen.getByText('by Narrative Synthesizer')).toBeInTheDocument();
    // DetailRow "Agent" value renders the humanized label on its own.
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Narrative Synthesizer')).toBeInTheDocument();
  });

  it('back link (from the shared DetailPageShell) points to /triage/insights', () => {
    // Task 20 (P-D4) — the loaded view now renders through DetailPageShell,
    // which renders the back control as a declarative <Link> (not a Button
    // wired to router.push), so we assert on the href rather than a mocked
    // push call — see DetailPageShell.test.tsx for the canonical pattern.
    render(<InsightDetailView insightId="pi-1" />);
    const backLink = screen.getByRole('link', { name: /back to insights/i });
    expect(backLink).toHaveAttribute('href', '/triage/insights');
  });

  it('the "not found" state still renders its own Link-based back control with the legacy testid', () => {
    mockUseDetail.mockReturnValueOnce({ data: null, isPending: false, isError: false });
    render(<InsightDetailView insightId="missing" />);
    expect(screen.getByTestId('detail-back')).toHaveAttribute('href', '/triage/insights');
  });

  // ==========================================================================
  // Task 20 (P-D4) — additive aside/main-column cards
  // ==========================================================================

  it('renders the Linked Entities card in the aside when the insight has related entities', () => {
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.getByTestId('linked-entities-card')).toBeInTheDocument();
    expect(screen.getByText('IBM')).toBeInTheDocument();
  });

  it('omits the Linked Entities card when the insight has no related entities', () => {
    mockUseDetail.mockReturnValue({
      data: makeInsight({ relatedEntities: [] }),
      isPending: false,
      isError: false,
    });
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.queryByTestId('linked-entities-card')).not.toBeInTheDocument();
  });

  it('renders the Related insights card with same-type / shared-entity insights from useBriefing', () => {
    mockUseBriefing.mockReturnValue({
      data: {
        insights: [
          makeInsight({ id: 'pi-1' }), // current insight — excluded
          makeInsight({ id: 'pi-2', title: 'Another connection', type: 'connection' }), // same type — included
          makeInsight({ id: 'pi-3', title: 'Unrelated pattern', type: 'pattern', relatedEntities: [] }), // excluded
        ],
        tokenUsage: { used: 0, budget: 0 },
      },
    });
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.getByTestId('related-insights-card')).toBeInTheDocument();
    expect(screen.getByTestId('related-insight-pi-2')).toBeInTheDocument();
    expect(screen.queryByTestId('related-insight-pi-3')).not.toBeInTheDocument();
  });

  it('omits the Related insights card when nothing else matches', () => {
    mockUseBriefing.mockReturnValue({
      data: { insights: [makeInsight({ id: 'pi-1' })], tokenUsage: { used: 0, budget: 0 } },
    });
    render(<InsightDetailView insightId="pi-1" />);
    expect(screen.queryByTestId('related-insights-card')).not.toBeInTheDocument();
  });
});
