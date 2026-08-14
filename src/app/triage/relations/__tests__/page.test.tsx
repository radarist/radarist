/**
 * @file triage/relations/__tests__/page.test.tsx
 * @description Library-table-convention regression tests for the Linker page
 * (canonical at /triage/relations; /agents/linker is a legacy redirect stub).
 *
 * Pins the 2026-06-10 alignment with the canonical library-table pattern
 * (reference: CompaniesTable + library/shared/SortableHeader):
 *   - Source/Target/Relation/Confidence/Created headers use the shared
 *     plain-text SortableHeader, with `aria-sort` kept on the `<th>` and
 *     stable `linker-sort-*` test ids (sorting via the pure compareProposals).
 *   - Bulk selection surfaces the shared floating BulkActionToolbar
 *     (bottom of viewport) instead of the old page-local top action bar,
 *     while Approve / Reject / Delete keep flowing through the existing
 *     confirmation dialog into the same bulk mutations.
 *   - The pagination footer is the shared DataPagination.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProposedRelation } from '@/lib/types';
import { CONFIDENCE_EVIDENCE_GUIDE_URL } from '@/lib/public-documentation';

// SmartLayout pulls in firebase transitively via its sidebar links; stub the
// heavyweight layout modules to passthroughs so the test stays at unit scope.
jest.mock('@/components/layout/AppLayoutV2', () => ({
  __esModule: true,
  SmartLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/layout/PageShell', () => ({
  __esModule: true,
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  __esModule: true,
  useAuth: () => ({ user: { uid: 'user-1' } }),
}));

const mockToast = jest.fn(() => ({ id: 'toast-1', dismiss: jest.fn(), update: jest.fn() }));
jest.mock('@/hooks/use-toast', () => ({
  __esModule: true,
  useToast: () => ({ toast: mockToast }),
}));

// The triage queue is a heavy presentational child that is out of scope here
// (its A/R/D/arrow keyboard shortcuts have their own suite in
// components/linker/__tests__/linker-components.test.tsx).
jest.mock('@/components/linker/LinkerTriageQueue', () => ({
  __esModule: true,
  LinkerTriageQueue: () => <div data-testid="triage-queue" />,
}));

// All data access flows through the proposed-relations hooks; mocking the hook
// module severs the firebase/firestore import chain.
jest.mock('@/hooks/useProposedRelations', () => ({
  __esModule: true,
  usePendingProposedRelations: jest.fn(),
  useProposedRelations: jest.fn(),
  useBulkApproveProposedRelations: jest.fn(),
  useBulkRejectProposedRelations: jest.fn(),
  useBulkDeleteProposedRelations: jest.fn(),
  useApproveProposedRelation: jest.fn(),
  useRejectProposedRelation: jest.fn(),
  useDismissProposedRelation: jest.fn(),
  useRevertProposedRelation: jest.fn(),
  useRemoveApprovedRelation: jest.fn(),
}));

// Radix Tooltip requires a TooltipProvider ancestor (the app provides it in
// the root layout); passthrough keeps the unit render self-contained.
jest.mock('@/components/ui/tooltip', () => ({
  __esModule: true,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// BulkActionToolbar animates via framer-motion; flatten to plain divs.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ children, className }: React.HTMLAttributes<HTMLDivElement>) => <div className={className}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// lucide-react ships ESM that Jest's CJS transform can't load directly.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import LinkerTriagePage from '../page';
import {
  usePendingProposedRelations,
  useProposedRelations,
  useBulkApproveProposedRelations,
  useBulkRejectProposedRelations,
  useBulkDeleteProposedRelations,
  useApproveProposedRelation,
  useRejectProposedRelation,
  useDismissProposedRelation,
  useRevertProposedRelation,
  useRemoveApprovedRelation,
} from '@/hooks/useProposedRelations';

function makeProposal(overrides: Partial<ProposedRelation>): ProposedRelation {
  return {
    id: 'prop-0',
    sourceType: 'company',
    sourceId: 'company-1',
    sourceSnapshot: { type: 'company', id: 'company-1', name: 'Acme Corp', snapshotAt: 1717200000000 },
    targetType: 'technology',
    targetId: 'tech-1',
    targetSnapshot: { type: 'technology', id: 'tech-1', name: 'Quantum SDK', snapshotAt: 1717200000000 },
    relationType: 'uses',
    confidence: 80,
    reasoning: 'Detected in docs',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: 1717200000000,
    updatedAt: 1717200000000,
    ...overrides,
  };
}

const PROPOSALS: ProposedRelation[] = [
  makeProposal({
    id: 'prop-1',
    sourceSnapshot: { type: 'company', id: 'company-1', name: 'Acme Corp', snapshotAt: 1717200000000 },
    targetSnapshot: { type: 'technology', id: 'tech-1', name: 'Quantum SDK', snapshotAt: 1717200000000 },
    relationType: 'uses',
    confidence: 92,
    createdAt: 1717200000000,
  }),
  makeProposal({
    id: 'prop-2',
    sourceSnapshot: { type: 'company', id: 'company-2', name: 'Beta Labs', snapshotAt: 1717200000000 },
    targetSnapshot: { type: 'technology', id: 'tech-2', name: 'Agent Framework', snapshotAt: 1717200000000 },
    relationType: 'enables',
    confidence: 60,
    createdAt: 1717300000000,
  }),
];

const bulkApproveMutateAsync = jest.fn().mockResolvedValue(undefined);
const bulkRejectMutateAsync = jest.fn().mockResolvedValue(undefined);
const bulkDeleteMutateAsync = jest.fn().mockResolvedValue(undefined);

function mockMutation(mutateAsync: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
  return { mutateAsync, isPending: false };
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LinkerTriagePage />
    </QueryClientProvider>
  );
  // The page boots in triage mode, then flips to the saved list mode in an
  // effect; wait for the list view's table rows.
  await screen.findByText('Acme Corp');
}

describe('LinkerTriagePage — library-table conventions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    // List view is where the table + bulk selection live.
    localStorage.setItem('radarist-linker-view-mode', 'list');

    (usePendingProposedRelations as jest.Mock).mockReturnValue({ data: PROPOSALS, isLoading: false, error: null });
    (useProposedRelations as jest.Mock).mockReturnValue({ data: PROPOSALS, isLoading: false, error: null });
    (useBulkApproveProposedRelations as jest.Mock).mockReturnValue(mockMutation(bulkApproveMutateAsync));
    (useBulkRejectProposedRelations as jest.Mock).mockReturnValue(mockMutation(bulkRejectMutateAsync));
    (useBulkDeleteProposedRelations as jest.Mock).mockReturnValue(mockMutation(bulkDeleteMutateAsync));
    (useApproveProposedRelation as jest.Mock).mockReturnValue(mockMutation());
    (useRejectProposedRelation as jest.Mock).mockReturnValue(mockMutation());
    (useDismissProposedRelation as jest.Mock).mockReturnValue(mockMutation());
    (useRevertProposedRelation as jest.Mock).mockReturnValue(mockMutation());
    (useRemoveApprovedRelation as jest.Mock).mockReturnValue(mockMutation());
  });

  // ==========================================================================
  // Accessible control names
  // ==========================================================================

  it('names the view and processed-relation controls', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Switch to triage view' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show processed relations' })).toBeInTheDocument();

    const guideLink = screen.getByRole('link', {
      name: 'How confidence and evidence work (opens in a new tab)',
    });
    expect(guideLink).toHaveAttribute('href', CONFIDENCE_EVIDENCE_GUIDE_URL);
    expect(guideLink).toHaveAttribute('target', '_blank');
    expect(guideLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // ==========================================================================
  // (1) Shared SortableHeader pattern
  // ==========================================================================

  it('renders all five sortable columns as <th> with aria-sort and the shared header button', async () => {
    await renderPage();

    const expected: Array<[field: string, label: string]> = [
      ['source', 'Source'],
      ['target', 'Target'],
      ['relation', 'Relation'],
      ['confidence', 'Confidence'],
      ['createdAt', 'Created'],
    ];

    for (const [field, label] of expected) {
      const th = screen.getByTestId(`linker-sort-${field}`);
      expect(th.tagName).toBe('TH');
      expect(th).toHaveAttribute('aria-sort');
      // Shared SortableHeader renders a plain text <button>, not a ghost Button.
      const button = th.querySelector('button');
      expect(button).not.toBeNull();
      expect(button).toHaveTextContent(label);
    }

    // Default sort is Created descending (newest first); everything else inactive.
    expect(screen.getByTestId('linker-sort-createdAt')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByTestId('linker-sort-source')).toHaveAttribute('aria-sort', 'none');
  });

  it('text columns start asc and toggle to desc; numeric columns start desc', async () => {
    await renderPage();

    // Default order: createdAt desc → newest (Beta Labs) row first.
    let rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(rows[0]).toHaveTextContent('Beta Labs');

    const sourceButton = screen.getByTestId('linker-sort-source').querySelector('button');
    expect(sourceButton).not.toBeNull();

    // Source is a text column → first click sorts ascending.
    fireEvent.click(sourceButton!);
    expect(screen.getByTestId('linker-sort-source')).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByTestId('linker-sort-createdAt')).toHaveAttribute('aria-sort', 'none');
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Acme Corp');

    // Second click flips to descending.
    fireEvent.click(sourceButton!);
    expect(screen.getByTestId('linker-sort-source')).toHaveAttribute('aria-sort', 'descending');
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Beta Labs');

    // Confidence is numeric → first click sorts descending (highest first).
    const confidenceButton = screen.getByTestId('linker-sort-confidence').querySelector('button');
    fireEvent.click(confidenceButton!);
    expect(screen.getByTestId('linker-sort-confidence')).toHaveAttribute('aria-sort', 'descending');
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Acme Corp'); // 92% above 60%
  });

  // ==========================================================================
  // (2) Shared floating BulkActionToolbar
  // ==========================================================================

  it('shows the shared floating toolbar when rows are selected, with Approve/Reject/Delete', async () => {
    await renderPage();

    expect(screen.queryByText(/proposal(s)? selected/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select Acme Corp → Quantum SDK'));

    expect(screen.getByText('1 proposal selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-approve')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-reject')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument();
  });

  it('clears the selection (and hides the toolbar) via the toolbar X', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Acme Corp → Quantum SDK'));
    expect(screen.getByText('1 proposal selected')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText('1 proposal selected')).not.toBeInTheDocument();
  });

  it('bulk approve flows through the confirmation dialog into the bulk-approve mutation', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Acme Corp → Quantum SDK'));
    fireEvent.click(screen.getByTestId('bulk-approve'));

    // Same confirmation dialog as before the toolbar move.
    expect(await screen.findByText('Approve 1 Proposal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve All'));

    await waitFor(() => {
      expect(bulkApproveMutateAsync).toHaveBeenCalledWith({
        proposalIds: ['prop-1'],
        reviewedBy: 'user-1',
      });
    });
    // Selection is cleared after the bulk action completes.
    await waitFor(() => {
      expect(screen.queryByText('1 proposal selected')).not.toBeInTheDocument();
    });
  });

  it('bulk reject flows through the confirmation dialog into the bulk-reject mutation', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Beta Labs → Agent Framework'));
    fireEvent.click(screen.getByTestId('bulk-reject'));

    expect(await screen.findByText('Reject 1 Proposal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Reject All'));

    await waitFor(() => {
      expect(bulkRejectMutateAsync).toHaveBeenCalledWith({
        proposalIds: ['prop-2'],
        reviewedBy: 'user-1',
      });
    });
  });

  it('bulk delete flows through the confirmation dialog into the bulk-delete mutation', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Acme Corp → Quantum SDK'));
    fireEvent.click(screen.getByTestId('bulk-delete'));

    expect(await screen.findByText('Delete 1 Proposal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete All'));

    await waitFor(() => {
      expect(bulkDeleteMutateAsync).toHaveBeenCalledWith({ proposalIds: ['prop-1'] });
    });
  });

  // ==========================================================================
  // (3) Canonical DataPagination footer
  // ==========================================================================

  it('renders the shared DataPagination footer with the proposals item label', async () => {
    await renderPage();

    expect(screen.getByText('Rows per page')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2 proposals')).toBeInTheDocument();
  });

  // ==========================================================================
  // (4) Untouched surfaces stay wired
  // ==========================================================================

  it('keeps the Approve High button wired to the threshold dialog with interpolated count + threshold', async () => {
    await renderPage();

    // Only prop-1 (92%) clears the 75% threshold; prop-2 sits at 60%.
    fireEvent.click(screen.getByText('Approve High (1)'));

    expect(await screen.findByText('Approve 1 High-Confidence Proposals?')).toBeInTheDocument();
    // Copy interpolates the real HIGH_CONFIDENCE_THRESHOLD constant (75), not a
    // hardcoded 85 (the drift the design review flagged).
    expect(screen.getByText(/confidence ≥\s*75%/)).toBeInTheDocument();
  });
});
