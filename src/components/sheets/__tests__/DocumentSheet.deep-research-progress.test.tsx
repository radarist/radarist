/**
 * @file components/sheets/__tests__/DocumentSheet.deep-research-progress.test.tsx
 * @description PRODUCT-003 — the owner-visible surface for a deep-research
 * run. A visible run spent about nine minutes showing nothing but
 * "Processing"; this panel is where the provider's own status and steps become
 * visible. It must show provider facts only: no progress bar, no percentage,
 * no ETA, and no invented stage name for a step the provider never typed.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { useMutation, useQuery } from '@tanstack/react-query';

let mockActiveTabIndex = 0;

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/document-service', () => ({
  getDocumentById: jest.fn(),
  deleteDocument: jest.fn(),
  retryDocumentProcessing: jest.fn(),
}));
jest.mock('@/lib/document-chunk-service', () => ({ getChunksForDocument: jest.fn() }));
jest.mock('@/lib/entity-document-link-service', () => ({
  getLinksForDocument: jest.fn(),
  deleteEntityDocumentLink: jest.fn(),
}));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/components/knowledge/LinkEntityForm', () => ({ LinkEntityForm: () => null }));
jest.mock('@/hooks/useTrackEntityView', () => ({ useTrackEntityView: jest.fn() }));
jest.mock('@/components/impulse/VerificationBadge', () => ({ VerificationBadge: () => null }));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../EntitySheetShell', () => ({
  EntitySheetShell: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
jest.mock('../EntitySheetTabs', () => ({
  EntitySheetTabs: ({ tabs }: { tabs: Array<{ content: React.ReactNode }> }) => <>{tabs[mockActiveTabIndex]?.content}</>,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { DocumentSheet } from '../DocumentSheet';

const mockUseQuery = jest.mocked(useQuery);
const mockUseMutation = jest.mocked(useMutation);

function renderWithProgress(progress: unknown) {
  mockUseQuery.mockReturnValue({
    data: {
      id: 'doc-dr-1',
      title: 'Deep research draft',
      type: 'markdown',
      storageUrl: '',
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      uploadedBy: 'test-user',
      deepResearchInteractionId: 'interaction-abc',
      ...(progress === undefined ? {} : { deepResearchProgress: progress }),
    },
    isLoading: false,
    error: null,
  } as never);
  mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false } as never);
  render(<DocumentSheet documentId="doc-dr-1" open onOpenChange={jest.fn()} />);
}

const runningProgress = {
  interactionId: 'interaction-abc',
  providerStatus: 'in_progress',
  stepCount: 3,
  steps: [{ index: 0, type: 'plan' }, { index: 1, type: 'web_search' }, { index: 2 }],
  progressUnavailable: false,
  observedAt: '2026-07-30T10:00:00.000Z',
  observations: 3,
  observationsWithoutNewStep: 0,
  stalled: false,
  poll: { iteration: 3, max: 60, intervalSeconds: 15 },
  resumable: true,
};

describe('DocumentSheet — deep research progress (PRODUCT-003)', () => {
  beforeEach(() => {
    mockActiveTabIndex = 0;
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
  });

  it('renders nothing when the document is not a deep-research run', () => {
    renderWithProgress(undefined);
    expect(screen.queryByTestId('deep-research-progress')).not.toBeInTheDocument();
  });

  it('shows the provider status and its own step types, with no percentage or ETA', () => {
    renderWithProgress(runningProgress);

    expect(screen.getByTestId('deep-research-progress-headline')).toHaveTextContent('3 provider steps reported');
    expect(screen.getByTestId('deep-research-progress-detail')).toHaveTextContent('in_progress');
    const steps = screen.getByTestId('deep-research-progress-steps');
    expect(steps).toHaveTextContent('1. plan');
    expect(steps).toHaveTextContent('2. web_search');
    // A step the provider never typed says so rather than getting a made-up name.
    expect(steps).toHaveTextContent('3. step type not reported');
    expect(screen.getByTestId('deep-research-progress').textContent).not.toMatch(/%|\bETA\b/i);
  });

  it('labels the poll budget as our own measurement, not provider progress', () => {
    renderWithProgress(runningProgress);
    expect(screen.getByTestId('deep-research-progress-detail')).toHaveTextContent('3 of 60 checks (15s apart)');
  });

  it('says progress detail is unavailable when the provider reports no steps', () => {
    renderWithProgress({
      ...runningProgress,
      stepCount: undefined,
      steps: [],
      progressUnavailable: true,
      observationsWithoutNewStep: 0,
    });

    expect(screen.getByTestId('deep-research-progress-headline')).toHaveTextContent('Progress detail unavailable');
    expect(screen.queryByTestId('deep-research-progress-steps')).not.toBeInTheDocument();
  });

  it('shows a stall without claiming to know its cause', () => {
    renderWithProgress({ ...runningProgress, stalled: true, observationsWithoutNewStep: 8 });
    expect(screen.getByTestId('deep-research-progress-headline')).toHaveTextContent('No new provider step recently');
  });

  it('distinguishes our exhausted poll budget from a cancelled run and offers the resume handle', () => {
    renderWithProgress({
      ...runningProgress,
      poll: { iteration: 60, max: 60, intervalSeconds: 15 },
      terminal: { state: 'timed-out', reason: 'Stopped polling after 60 checks' },
      resumable: true,
    });

    expect(screen.getByTestId('deep-research-progress-headline')).toHaveTextContent('outlasted our poll budget');
    expect(screen.getByTestId('deep-research-progress-detail')).toHaveTextContent('may still be running');
    expect(screen.getByTestId('deep-research-progress-resumable')).toHaveTextContent('was not cancelled');
  });

  it('reports a provider failure with the provider’s own reason and no resume offer', () => {
    renderWithProgress({
      ...runningProgress,
      providerStatus: 'cancelled',
      terminal: { state: 'failed', reason: 'Deep research ended with provider status "cancelled"' },
      resumable: false,
    });

    expect(screen.getByTestId('deep-research-progress-headline')).toHaveTextContent('Research failed');
    expect(screen.getByTestId('deep-research-progress-detail')).toHaveTextContent('cancelled');
    expect(screen.queryByTestId('deep-research-progress-resumable')).not.toBeInTheDocument();
  });
});
