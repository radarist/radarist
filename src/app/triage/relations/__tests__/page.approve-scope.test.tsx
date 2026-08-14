/**
 * @file triage/relations/__tests__/page.approve-scope.test.tsx
 * @description UX-037 — the Linker triage scope contract.
 *
 * The page must never write a proposal the operator cannot see. Before this
 * suite, `highConfidencePending` was derived from the UNFILTERED
 * `usePendingProposedRelations()` query while the visible list came from the
 * filtered `useProposedRelations()` query, so `Approve High` counted and
 * approved hidden proposals.
 *
 * Every test here asserts the same invariant from a different angle:
 *
 *   what the operator can see == what the page is authorized to mutate
 *
 * The two data hooks are deliberately given DIFFERENT arrays: the pending hook
 * returns rows that the active scope hides. If the page ever reads the pending
 * query again for a mutation set, these tests fail.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProposedRelation } from '@/lib/types';

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

// The triage queue is exercised for the proposals it is HANDED, not for its own
// keyboard behaviour (covered in components/linker/__tests__). Rendering the ids
// lets the scope assertions read the queue's contents.
jest.mock('@/components/linker/LinkerTriageQueue', () => ({
  __esModule: true,
  LinkerTriageQueue: ({ proposals }: { proposals: { id: string }[] }) => (
    <div data-testid="triage-queue" data-proposal-ids={proposals.map((p) => p.id).join(',')} />
  ),
}));

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

jest.mock('@/components/ui/tooltip', () => ({
  __esModule: true,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Radix Select has no keyboard-free jsdom affordance. Swap it for a native
// <select> so the facet controls are drivable; the page still owns the value
// and the onValueChange contract, which is what the scope depends on.
jest.mock('@/components/ui/select', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  return {
    __esModule: true,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) =>
      ReactModule.createElement(
        'select',
        { value, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value) },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{typeof children === 'string' ? children : value}</option>
    ),
  };
});

jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ children, className }: React.HTMLAttributes<HTMLDivElement>) => <div className={className}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

function makeProposal(overrides: Partial<ProposedRelation> & { id: string }): ProposedRelation {
  return {
    sourceType: 'company',
    sourceId: `company-${overrides.id}`,
    sourceSnapshot: { type: 'company', id: `company-${overrides.id}`, name: 'Acme Corp', snapshotAt: 1717200000000 },
    targetType: 'technology',
    targetId: `tech-${overrides.id}`,
    targetSnapshot: { type: 'technology', id: `tech-${overrides.id}`, name: 'Quantum SDK', snapshotAt: 1717200000000 },
    relationType: 'uses',
    confidence: 92,
    reasoning: 'Detected in docs',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: 1717200000000,
    updatedAt: 1717200000000,
    ...overrides,
  } as ProposedRelation;
}

/** Visible under the default scope and above the 75% threshold. */
const VISIBLE_HIGH = makeProposal({
  id: 'visible-high',
  confidence: 92,
  sourceSnapshot: { type: 'company', id: 'company-a', name: 'Northwind Freight', snapshotAt: 1717200000000 },
});

/**
 * Also high-confidence and also pending — but hidden by a "Northwind" search.
 * This is the exact row the old `Approve High` reached through the unfiltered
 * pending query.
 */
const HIDDEN_HIGH = makeProposal({
  id: 'hidden-high',
  confidence: 88,
  sourceSnapshot: { type: 'company', id: 'company-b', name: 'Southgate Metals', snapshotAt: 1717200000000 },
});

/** Visible but below the threshold: never part of Approve High. */
const VISIBLE_LOW = makeProposal({
  id: 'visible-low',
  confidence: 40,
  sourceSnapshot: { type: 'company', id: 'company-c', name: 'Northwind Rail', snapshotAt: 1717200000000 },
});

/** High confidence but already approved — outside the default pending status. */
const PROCESSED_HIGH = makeProposal({
  id: 'processed-high',
  confidence: 95,
  status: 'approved',
  sourceSnapshot: { type: 'company', id: 'company-d', name: 'Northwind Air', snapshotAt: 1717200000000 },
});

const ALL_PROPOSALS = [VISIBLE_HIGH, HIDDEN_HIGH, VISIBLE_LOW, PROCESSED_HIGH];
const PENDING_PROPOSALS = [VISIBLE_HIGH, HIDDEN_HIGH, VISIBLE_LOW];

let bulkApproveMutateAsync: jest.Mock;
let bulkRejectMutateAsync: jest.Mock;
let bulkDeleteMutateAsync: jest.Mock;

function mockMutation(mutateAsync: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
  return { mutateAsync, isPending: false };
}

function renderPage(viewMode: 'list' | 'triage' = 'list') {
  localStorage.setItem('radarist-linker-view-mode', viewMode);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LinkerTriagePage />
    </QueryClientProvider>
  );
}

/** [0] = status facet, [1] = discovery-source facet. */
function facetSelects(): HTMLSelectElement[] {
  return screen.getAllByRole('combobox') as HTMLSelectElement[];
}

function search(term: string): void {
  fireEvent.change(screen.getByPlaceholderText('Search entities...'), { target: { value: term } });
}

describe('LinkerTriagePage — Approve High is bounded by the visible scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    bulkApproveMutateAsync = jest.fn().mockResolvedValue({ approved: 0, failed: 0, failedIds: [] });
    bulkRejectMutateAsync = jest.fn().mockResolvedValue({ rejected: 0, failed: 0, failedIds: [] });
    bulkDeleteMutateAsync = jest.fn().mockResolvedValue({ deleted: 0, failed: 0 });

    (usePendingProposedRelations as jest.Mock).mockReturnValue({
      data: PENDING_PROPOSALS,
      isLoading: false,
      error: null,
    });
    (useProposedRelations as jest.Mock).mockReturnValue({ data: ALL_PROPOSALS, isLoading: false, error: null });
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
  // Count truth
  // ==========================================================================

  it('counts only the high-confidence proposals inside the active search', async () => {
    renderPage();
    // Unscoped: both pending high-confidence rows qualify.
    expect(await screen.findByText('Approve High (2)')).toBeInTheDocument();

    search('Northwind');

    // "Southgate Metals" is hidden, so it can no longer be counted.
    expect(await screen.findByText('Approve High (1)')).toBeInTheDocument();
  });

  it('drops the button entirely when the scope hides every high-confidence proposal', async () => {
    renderPage();
    await screen.findByText('Approve High (2)');

    search('Southgate');
    expect(await screen.findByText('Approve High (1)')).toBeInTheDocument();

    search('no-such-entity');
    await waitFor(() => {
      expect(screen.queryByText(/Approve High/)).not.toBeInTheDocument();
    });
  });

  it('excludes processed proposals unless the status facet admits them', async () => {
    renderPage();
    await screen.findByText('Approve High (2)');

    // Widen to every status: the approved 95% row is now visible, but it is not
    // pending, so it must still not be part of an approve set.
    fireEvent.change(facetSelects()[0], { target: { value: 'all' } });

    expect(await screen.findByText('Approve High (2)')).toBeInTheDocument();
  });

  it('respects the discovery-source facet', async () => {
    (useProposedRelations as jest.Mock).mockReturnValue({
      data: [VISIBLE_HIGH, makeProposal({ id: 'auto-high', confidence: 90, discoveredBy: 'auto-linker' })],
      isLoading: false,
      error: null,
    });
    renderPage();
    await screen.findByText('Approve High (2)');

    fireEvent.change(facetSelects()[1], { target: { value: 'auto-linker' } });

    expect(await screen.findByText('Approve High (1)')).toBeInTheDocument();
  });

  // ==========================================================================
  // Mutation truth
  // ==========================================================================

  it('approves only the visible high-confidence proposals', async () => {
    renderPage();
    await screen.findByText('Approve High (2)');

    search('Northwind');
    fireEvent.click(await screen.findByText('Approve High (1)'));
    fireEvent.click(await screen.findByText('Approve 1'));

    await waitFor(() => {
      expect(bulkApproveMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(bulkApproveMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ proposalIds: [VISIBLE_HIGH.id] }));
  });

  it('states the active scope in the confirmation so it cannot overstate its reach', async () => {
    renderPage();
    await screen.findByText('Approve High (2)');

    search('Northwind');
    fireEvent.click(await screen.findByText('Approve High (1)'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('matching "Northwind"');
  });

  // ==========================================================================
  // Selection truth
  // ==========================================================================

  it('drops selected proposals that a scope change hid', async () => {
    renderPage();
    await screen.findByText('Northwind Freight');

    fireEvent.click(screen.getByLabelText('Select Southgate Metals → Quantum SDK'));
    fireEvent.click(screen.getByLabelText('Select Northwind Freight → Quantum SDK'));
    expect(screen.getByText('2 proposals selected')).toBeInTheDocument();

    search('Northwind');

    // The Southgate row is gone from the scope, so it is gone from the selection.
    await waitFor(() => {
      expect(screen.getByText('1 proposal selected')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('bulk-approve'));
    fireEvent.click(await screen.findByText('Approve All'));

    await waitFor(() => {
      expect(bulkApproveMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ proposalIds: [VISIBLE_HIGH.id] }));
    });
  });

  // ==========================================================================
  // Retry truth
  // ==========================================================================

  it('keeps the failed proposals selected so the operator can retry', async () => {
    bulkApproveMutateAsync.mockResolvedValue({
      approved: 1,
      failed: 1,
      failedIds: [HIDDEN_HIGH.id],
      errors: [`${HIDDEN_HIGH.id}: boom`],
    });
    renderPage();
    await screen.findByText('Northwind Freight');

    fireEvent.click(screen.getByLabelText('Select Northwind Freight → Quantum SDK'));
    fireEvent.click(screen.getByLabelText('Select Southgate Metals → Quantum SDK'));
    fireEvent.click(screen.getByTestId('bulk-approve'));
    fireEvent.click(await screen.findByText('Approve All'));

    await waitFor(() => {
      expect(screen.getByText('1 proposal selected')).toBeInTheDocument();
    });
  });

  it('keeps the whole selection when the bulk mutation itself rejects', async () => {
    bulkApproveMutateAsync.mockRejectedValue(new Error('network down'));
    renderPage();
    await screen.findByText('Northwind Freight');

    fireEvent.click(screen.getByLabelText('Select Northwind Freight → Quantum SDK'));
    fireEvent.click(screen.getByTestId('bulk-approve'));
    fireEvent.click(await screen.findByText('Approve All'));

    await waitFor(() => {
      expect(bulkApproveMutateAsync).toHaveBeenCalled();
    });
    expect(screen.getByText('1 proposal selected')).toBeInTheDocument();
  });

  // ==========================================================================
  // Triage view reads the same scope
  // ==========================================================================

  it('hands the triage queue the same filtered scope the header advertises', async () => {
    renderPage('triage');
    const queue = await screen.findByTestId('triage-queue');
    expect(queue).toHaveAttribute('data-proposal-ids', [VISIBLE_HIGH.id, HIDDEN_HIGH.id, VISIBLE_LOW.id].join(','));

    search('Northwind');

    await waitFor(() => {
      expect(screen.getByTestId('triage-queue')).toHaveAttribute(
        'data-proposal-ids',
        [VISIBLE_HIGH.id, VISIBLE_LOW.id].join(',')
      );
    });
  });

  // ==========================================================================
  // The Show-processed switch is not a decoration
  // ==========================================================================

  it('makes Show processed widen the same scope the status facet controls', async () => {
    renderPage();
    await screen.findByText('Northwind Freight');
    expect(screen.queryByText('Northwind Air')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Show processed relations' }));

    expect(await screen.findByText('Northwind Air')).toBeInTheDocument();
    expect(facetSelects()[0]).toHaveValue('all');
  });
});
