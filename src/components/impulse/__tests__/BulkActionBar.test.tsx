/**
 * @file BulkActionBar.test.tsx
 * @description Tests the render gate, dialog flow, and Undo snackbar on
 * bulk dismiss success. Since the 2026-06-10 library-table alignment the
 * component wraps the shared floating `BulkActionToolbar` — the count and
 * clear-X come from the toolbar, the Dismiss CTA rides `additionalActions`.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

// BulkActionToolbar animates via framer-motion; flatten to plain divs.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ children, className }: React.HTMLAttributes<HTMLDivElement>) => <div className={className}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockBulkMutate = jest.fn();
jest.mock('@/hooks/queries/useBulkDismissInsights', () => ({
  __esModule: true,
  useBulkDismissInsights: () => ({
    mutate: (vars: unknown, opts: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      mockBulkMutate(vars, opts);
      // Fire onSuccess synchronously so the toast scheduling happens
      // in the same tick as the mutate call.
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
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

// `useBriefing` types are reached transitively via BriefingInsight import;
// stub firebase + AuthProvider as we did in the other test files.
jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

import { BulkActionBar } from '../BulkActionBar';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(id: string): BriefingInsight {
  return {
    id,
    type: 'discovery',
    title: id.toUpperCase(),
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.5,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
  };
}

describe('BulkActionBar', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders nothing when no insights are selected', () => {
    const { container } = render(<BulkActionBar selectedInsights={[]} onClearSelection={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the toolbar count + Dismiss CTA + clear-X when ≥1 selected', () => {
    render(<BulkActionBar selectedInsights={[makeInsight('a'), makeInsight('b')]} onClearSelection={() => {}} />);
    expect(screen.getByText('2 insights selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-action-bar-dismiss')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument();
  });

  it('pluralises the count word for a single selection', () => {
    render(<BulkActionBar selectedInsights={[makeInsight('a')]} onClearSelection={() => {}} />);
    expect(screen.getByText('1 insight selected')).toBeInTheDocument();
  });

  it('the toolbar X calls onClearSelection', () => {
    const onClear = jest.fn();
    render(<BulkActionBar selectedInsights={[makeInsight('a')]} onClearSelection={onClear} />);
    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('clicking Dismiss opens the dialog (does NOT immediately mutate)', () => {
    render(<BulkActionBar selectedInsights={[makeInsight('a'), makeInsight('b')]} onClearSelection={() => {}} />);
    fireEvent.click(screen.getByTestId('bulk-action-bar-dismiss'));
    expect(screen.getByTestId('bulk-dismiss-dialog')).toBeInTheDocument();
    expect(mockBulkMutate).not.toHaveBeenCalled();
  });

  it('confirm fires the bulk mutation with dismiss=true + the selected IDs', () => {
    const onClear = jest.fn();
    render(<BulkActionBar selectedInsights={[makeInsight('a'), makeInsight('b')]} onClearSelection={onClear} />);
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-action-bar-dismiss'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-dismiss-confirm'));
    });
    expect(mockBulkMutate).toHaveBeenCalledWith({ dismiss: true, insightIds: ['a', 'b'] }, expect.any(Object));
    // Successful confirm clears the selection.
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('shows the Undo toast on success', () => {
    render(<BulkActionBar selectedInsights={[makeInsight('a'), makeInsight('b')]} onClearSelection={() => {}} />);
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-action-bar-dismiss'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-dismiss-confirm'));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      '2 insights marked as read',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
  });

  it('Undo action restores the batch via dismiss=false with the carried snapshots', () => {
    const insights = [makeInsight('a'), makeInsight('b')];
    render(<BulkActionBar selectedInsights={insights} onClearSelection={() => {}} />);
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-action-bar-dismiss'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('bulk-dismiss-confirm'));
    });
    const undo = mockToastSuccess.mock.calls[0][1] as { action: { onClick: () => void } };
    act(() => {
      undo.action.onClick();
    });
    // The most recent mutate call should carry the full insight objects.
    const lastCall = mockBulkMutate.mock.calls[mockBulkMutate.mock.calls.length - 1][0];
    expect(lastCall.dismiss).toBe(false);
    expect(lastCall.insights.map((i: BriefingInsight) => i.id)).toEqual(['a', 'b']);
  });
});
