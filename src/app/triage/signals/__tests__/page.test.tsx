/**
 * @file triage/signals/__tests__/page.test.tsx
 * @description Library-table-convention regression tests for the Signals page
 * (/triage/signals (canonical; /agents/signals redirects here)).
 *
 * Pins the 2026-06-10 alignment with the canonical library-table pattern
 * (reference: CompaniesTable + library/shared/SortableHeader):
 *   - Column headers use the shared plain-text SortableHeader, with
 *     `aria-sort` kept on the `<th>` and stable `signals-sort-*` test ids.
 *   - Bulk selection surfaces the shared floating BulkActionToolbar
 *     (bottom of viewport) instead of the old page-local top action bar,
 *     while Approve / Reject / Delete keep flowing through the existing
 *     confirmation dialog into the same handlers.
 *   - The pagination footer is the shared DataPagination.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { Signal } from '@/lib/types';
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

// Typed payload so the UX-074 cases can read `mockToast.mock.calls[n][0]` — an
// untyped `jest.fn(() => ...)` infers a zero-length args tuple, which tsc rejects
// at the index access. Existing `toHaveBeenCalledWith` assertions are unaffected.
type ToastPayload = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: 'default' | 'destructive';
  action?: React.ReactElement<{ onClick: () => void }>;
};
const mockToast = jest.fn((_props: ToastPayload) => ({ id: 'toast-1', dismiss: jest.fn(), update: jest.fn() }));
jest.mock('@/hooks/use-toast', () => ({
  __esModule: true,
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/hooks/useDataRefresh', () => ({
  __esModule: true,
  useDataRefresh: jest.fn(),
}));

jest.mock('@/lib/signals-client', () => ({
  __esModule: true,
  getSignals: jest.fn(),
}));
jest.mock('@/lib/signals/feedback', () => ({
  __esModule: true,
  submitSignalFeedback: jest.fn(),
}));
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));

// Heavy presentational children that are out of scope here.
jest.mock('@/components/signals/SignalTriageQueue', () => ({
  __esModule: true,
  SignalTriageQueue: () => <div data-testid="triage-queue" />,
}));
jest.mock('@/components/signals/TrustScoreBadge', () => ({
  __esModule: true,
  TrustScoreBadge: () => <span data-testid="trust-badge" />,
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

import SignalsPage, { QUICK_FEEDBACK_UNDO_WINDOW_MS } from '../page';
import { getSignals } from '@/lib/signals-client';
import { submitSignalFeedback } from '@/lib/signals/feedback';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

// Radix Select (Status / Source / Group By) touches pointer-capture / scroll APIs jsdom
// doesn't implement.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.hasPointerCapture = jest.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = jest.fn();
  Element.prototype.releasePointerCapture = jest.fn();
  // shadcn's SelectContent defaults to position="popper" → Radix Popper →
  // floating-ui, which needs ResizeObserver. Only the UX-074 status-filter case
  // actually opens a Select; the stub is inert for every other test.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    id: 'sig-0',
    type: 'news',
    title: 'Untitled signal',
    slug: 'untitled-signal',
    description: 'A signal description',
    source: 'news',
    url: 'https://example.com/article',
    date: 1717200000000,
    relevanceScore: 80,
    alignmentScore: 70,
    alignedStrategies: [],
    linkedEntities: {},
    status: 'Detected',
    sentiment: 'neutral',
    aiSummary: 'AI summary of the signal.',
    detectedAt: 1717200000000,
    ...overrides,
  };
}

const SIGNALS: Signal[] = [
  makeSignal({
    id: 'sig-1',
    title: 'Quantum chip launch',
    slug: 'quantum-chip-launch',
    description: 'Vendor ships a new quantum chip',
    source: 'news',
    detectedAt: 1717200000000,
  }),
  makeSignal({
    id: 'sig-2',
    title: 'Agentic AI funding round',
    slug: 'agentic-ai-funding-round',
    description: 'Series B for agent infrastructure',
    source: 'funding',
    status: 'Validated',
    detectedAt: 1717300000000,
  }),
];

async function renderPage() {
  render(<SignalsPage />);
  // Wait for the async loadSignals effect to land rows in the table.
  await screen.findByText('Quantum chip launch');
}

describe('SignalsPage — library-table conventions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    (getSignals as jest.Mock).mockResolvedValue(SIGNALS);
    (submitSignalFeedback as jest.Mock).mockResolvedValue({ success: true });
    (fetchWithAuth as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: 1, failed: [] }),
    });
  });

  // ==========================================================================
  // Accessible control names
  // ==========================================================================

  it('names the view, archive, and per-signal action controls', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Switch to triage view' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show archived signals' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open actions for Quantum chip launch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open actions for Agentic AI funding round' })).toBeInTheDocument();

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
      ['title', 'Title'],
      ['source', 'Source'],
      ['status', 'Status'],
      ['trust', 'Trust'],
      ['date', 'Detected'],
    ];

    for (const [field, label] of expected) {
      const th = screen.getByTestId(`signals-sort-${field}`);
      expect(th.tagName).toBe('TH');
      expect(th).toHaveAttribute('aria-sort');
      // Shared SortableHeader renders a plain text <button>, not a ghost Button.
      const button = th.querySelector('button');
      expect(button).not.toBeNull();
      expect(button).toHaveTextContent(label);
    }

    // Default sort is Detected (date) descending; everything else inactive.
    expect(screen.getByTestId('signals-sort-date')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByTestId('signals-sort-title')).toHaveAttribute('aria-sort', 'none');
  });

  it('preserves the sort behavior: new column starts desc, second click flips to asc', async () => {
    await renderPage();

    const titleButton = screen.getByTestId('signals-sort-title').querySelector('button');
    expect(titleButton).not.toBeNull();

    fireEvent.click(titleButton!);
    expect(screen.getByTestId('signals-sort-title')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByTestId('signals-sort-date')).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(titleButton!);
    expect(screen.getByTestId('signals-sort-title')).toHaveAttribute('aria-sort', 'ascending');
  });

  // ==========================================================================
  // (2) Shared floating BulkActionToolbar
  // ==========================================================================

  it('shows the shared floating toolbar when rows are selected, with Approve/Reject/Delete', async () => {
    await renderPage();

    expect(screen.queryByText(/signal(s)? selected/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));

    expect(screen.getByText('1 signal selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-approve')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-reject')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-archive')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-delete')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument();
  });

  it('clears the selection (and hides the toolbar) via the toolbar X', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    expect(screen.getByText('1 signal selected')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText('1 signal selected')).not.toBeInTheDocument();
  });

  it('bulk approve flows through the confirmation dialog into submitSignalFeedback', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    fireEvent.click(screen.getByTestId('bulk-approve'));

    // Same confirmation dialog as before the toolbar move.
    expect(await screen.findByText('Approve 1 Signal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve All'));

    await waitFor(() => {
      expect(submitSignalFeedback).toHaveBeenCalledWith('sig-1', 'up', undefined, true, 'user-1', true);
    });
    // Selection is cleared after the bulk action completes.
    await waitFor(() => {
      expect(screen.queryByText('1 signal selected')).not.toBeInTheDocument();
    });
  });

  it('bulk reject submits a down vote through the same handler', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Agentic AI funding round'));
    fireEvent.click(screen.getByTestId('bulk-reject'));

    expect(await screen.findByText('Reject 1 Signal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Reject All'));

    await waitFor(() => {
      expect(submitSignalFeedback).toHaveBeenCalledWith('sig-2', 'down', undefined, true, 'user-1', true);
    });
  });

  it('bulk delete confirms and posts to the bulk-delete API', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    fireEvent.click(screen.getByTestId('bulk-delete'));

    expect(await screen.findByText('Delete 1 Signal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete All'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/signals/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['sig-1'] }),
      });
      expect(screen.queryByText('1 signal selected')).not.toBeInTheDocument();
    });
  });

  it('retains only failed signal IDs after a partial bulk delete', async () => {
    (fetchWithAuth as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, deleted: 1, failed: ['sig-2'] }),
    });
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    fireEvent.click(screen.getByLabelText('Select Agentic AI funding round'));
    fireEvent.click(screen.getByTestId('bulk-delete'));
    fireEvent.click(await screen.findByText('Delete All'));

    await waitFor(() => {
      expect(screen.getByText('1 signal selected')).toBeInTheDocument();
      expect(screen.getByLabelText('Select Agentic AI funding round')).toBeChecked();
      expect(screen.getByLabelText('Select Quantum chip launch')).not.toBeChecked();
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Signals Partially Deleted', variant: 'destructive' })
    );
  });

  it.each([
    {
      success: false,
      deleted: 1,
      failed: ['unknown'],
    },
    {
      success: true,
      deleted: 0,
      failed: [],
    },
  ])('retains the full signal selection for an invalid acknowledgement %#', async (body) => {
    (fetchWithAuth as jest.Mock).mockResolvedValue({ ok: true, json: async () => body });
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    fireEvent.click(screen.getByLabelText('Select Agentic AI funding round'));
    fireEvent.click(screen.getByTestId('bulk-delete'));
    fireEvent.click(await screen.findByText('Delete All'));

    await waitFor(() => {
      expect(screen.getByText('2 signals selected')).toBeInTheDocument();
      expect(screen.getByLabelText('Select Quantum chip launch')).toBeChecked();
      expect(screen.getByLabelText('Select Agentic AI funding round')).toBeChecked();
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bulk Delete Failed', variant: 'destructive' })
    );
  });

  it('bulk archive confirms and posts to the archive API (DISC-010)', async () => {
    (fetchWithAuth as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, changed: 1, failed: [] }),
    });
    await renderPage();

    fireEvent.click(screen.getByLabelText('Select Quantum chip launch'));
    fireEvent.click(screen.getByTestId('bulk-archive'));

    expect(await screen.findByText('Archive 1 Signal?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Archive All'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/signals/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['sig-1'], action: 'archive' }),
      });
    });
  });

  // ==========================================================================
  // (3) Canonical DataPagination footer
  // ==========================================================================

  it('renders the shared DataPagination footer with the signals item label', async () => {
    await renderPage();

    expect(screen.getByText('Rows per page')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2 signals')).toBeInTheDocument();
  });

  // ==========================================================================
  // (4) Task 14 (P-B10, spec D4): slimmed header — Company facet + "For you"
  // sort dropdown removed; approval actions are ✓/✗ icon buttons, not thumbs.
  // ==========================================================================

  it('does not render the Company facet or the sort dropdown', async () => {
    await renderPage();

    expect(screen.queryByText('All Companies')).not.toBeInTheDocument();
    expect(screen.queryByText('Default sort')).not.toBeInTheDocument();
    expect(screen.queryByText('For you')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icon-Sparkles')).not.toBeInTheDocument();
  });

  it('renders ✓/✗ (Check/X) approval icon buttons instead of thumbs, matching LinkerProposalsTable', async () => {
    await renderPage();

    // Neither signal has been voted on yet, so every row shows the pending approve/reject pair.
    expect(screen.queryAllByTestId('icon-ThumbsUp')).toHaveLength(0);
    expect(screen.queryAllByTestId('icon-ThumbsDown')).toHaveLength(0);
    expect(screen.getAllByTitle('Approve (one-click)').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Reject (one-click)').length).toBeGreaterThan(0);

    const approveButton = screen.getAllByTitle('Approve (one-click)')[0];
    expect(approveButton.querySelector('[data-testid="icon-Check"]')).not.toBeNull();
    expect(approveButton.className).toContain('text-emerald-600');

    const rejectButton = screen.getAllByTitle('Reject (one-click)')[0];
    expect(rejectButton.querySelector('[data-testid="icon-X"]')).not.toBeNull();
    expect(rejectButton.className).toContain('text-destructive');
  });

  // ==========================================================================
  // (5) UX-074: a COMMITTED one-click approve/reject must reach the row's status
  // badge, the result count, and status-filter membership without a reload. The
  // server write is deferred behind the F71 undo window, so every status
  // assertion here is anchored to the COMMIT, never to the click.
  // ==========================================================================

  describe('UX-074 — one-click approve reflects the committed write', () => {
    // The commit timer is deliberately NOT cancelled on unmount (an approval the
    // operator already saw confirmed must still reach the server), so a pending
    // timer would otherwise fire into the NEXT test and call submitSignalFeedback
    // with a stale signal id. jest.clearAllMocks() calls mockClear, which does NOT
    // drain a mockResolvedValueOnce queue, so that pollution would be silent —
    // hence clearAllTimers here, and mockResolvedValue (never ...Once) below.
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    const rowFor = (title: string) => screen.getByText(title).closest('tr') as HTMLElement;

    // Fires the deferred commit AND drains what it triggers:
    //   setTimeout -> submitSignalFeedback (async) -> setSignals -> filter effect
    //   -> setFilteredSignals -> re-render.
    // `await act(async () => ...)` is what flushes those microtasks; a synchronous
    // act() returns before the await inside commit() resolves, so every assertion
    // after it would read a pre-commit DOM.
    const runCommitWindow = async () => {
      await act(async () => {
        jest.advanceTimersByTime(QUICK_FEEDBACK_UNDO_WINDOW_MS);
      });
    };

    it('holds the status badge at Validated until the deferred write commits, then flips it', async () => {
      await renderPage();
      // Install fake timers only AFTER the initial load settles — switching timer
      // modes while a findBy*/waitFor is in flight makes DOM Testing Library throw.
      jest.useFakeTimers();

      expect(within(rowFor('Agentic AI funding round')).getByText('Validated')).toBeInTheDocument();

      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Approve (one-click)'));

      // t=0 — the action column freezes (immediate confirmation + the re-click
      // guard), but nothing is written yet, so status must NOT move.
      const clicked = rowFor('Agentic AI funding round');
      expect(within(clicked).getByTitle('Approved')).toBeInTheDocument();
      expect(within(clicked).getByText('Validated')).toBeInTheDocument();
      expect(submitSignalFeedback).not.toHaveBeenCalled();

      // t = window - 1ms — still inside the undo window, still nothing written.
      act(() => {
        jest.advanceTimersByTime(QUICK_FEEDBACK_UNDO_WINDOW_MS - 1);
      });
      expect(submitSignalFeedback).not.toHaveBeenCalled();
      expect(within(rowFor('Agentic AI funding round')).getByText('Validated')).toBeInTheDocument();

      // t = window — the write goes out and the badge follows the SERVER.
      await act(async () => {
        jest.advanceTimersByTime(1);
      });

      expect(submitSignalFeedback).toHaveBeenCalledTimes(1);
      expect(submitSignalFeedback).toHaveBeenCalledWith('sig-2', 'up', undefined, true, 'user-1', true);
      const committed = rowFor('Agentic AI funding round');
      expect(within(committed).getByText('Approved')).toBeInTheDocument();
      expect(within(committed).queryByText('Validated')).not.toBeInTheDocument();
    });

    it('advances a rejected signal to Rejected, not Approved', async () => {
      await renderPage();
      jest.useFakeTimers();

      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Reject (one-click)'));
      await runCommitWindow();

      expect(submitSignalFeedback).toHaveBeenCalledWith('sig-2', 'down', undefined, true, 'user-1', true);
      const committed = rowFor('Agentic AI funding round');
      expect(within(committed).getByText('Rejected')).toBeInTheDocument();
      expect(within(committed).queryByText('Approved')).not.toBeInTheDocument();
    });

    it('drops the row out of a Validated-filtered view and moves the result count on commit', async () => {
      // Local fixture only — the shared SIGNALS array is pinned by the existing
      // pagination test ("1–2 of 2 signals"), so it must not gain a third row.
      (getSignals as jest.Mock).mockResolvedValue([
        ...SIGNALS,
        makeSignal({
          id: 'sig-3',
          title: 'Robotics grant awarded',
          slug: 'robotics-grant-awarded',
          description: 'A national lab funds a robotics programme',
          source: 'news',
          status: 'Validated',
          detectedAt: 1717100000000,
        }),
      ]);
      await renderPage();

      // Drive the REAL Radix Select. Its internal pointerType ref defaults to
      // 'touch', so trigger and item both act on `click` under jsdom — fireEvent
      // suffices. userEvent is avoided deliberately: it hangs under fake timers
      // without an advanceTimers callback.
      // Anchor on the trigger's rendered value rather than its accessible name:
      // the trigger's icon spans contribute to the computed name, so a name query
      // is brittle here. The status trigger is the only node reading
      // "All Statuses".
      fireEvent.click(screen.getByText('All Statuses').closest('button') as HTMLElement);
      fireEvent.click(await screen.findByRole('option', { name: 'Validated' }));

      expect(screen.getByText('1–2 of 2 signals')).toBeInTheDocument();

      jest.useFakeTimers();
      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Approve (one-click)'));

      // Deliberate: neither the count nor membership moves on the click alone.
      expect(screen.getByText('1–2 of 2 signals')).toBeInTheDocument();
      expect(screen.getByText('Agentic AI funding round')).toBeInTheDocument();

      await runCommitWindow();

      // The approved signal has left the Validated set and the count followed it.
      expect(screen.queryByText('Agentic AI funding round')).not.toBeInTheDocument();
      expect(screen.getByText('Robotics grant awarded')).toBeInTheDocument();
      expect(screen.getByText('1–1 of 1 signals')).toBeInTheDocument();
    });

    it('leaves the status untouched, restores the controls, and toasts destructively when the write fails', async () => {
      // AUDIT-005 shape: submitSignalFeedback resolves {success:false}; it never
      // throws. mockResolvedValue, NOT ...Once — clearAllMocks does not drain a
      // Once queue, so a leaked queue entry would poison a later test silently.
      (submitSignalFeedback as jest.Mock).mockResolvedValue({ success: false, error: 'firestore unavailable' });
      await renderPage();
      jest.useFakeTimers();

      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Approve (one-click)'));
      await runCommitWindow();

      // Assert the handler ran BEFORE the DOM: if this passes and the DOM
      // assertions below fail, the fault is a flush/render problem, not a
      // "the catch block never ran" problem.
      expect(submitSignalFeedback).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));

      const row = rowFor('Agentic AI funding round');
      // Status never advanced, so there is nothing to roll back — it still equals
      // what the server holds. ("Restores" would be the wrong assertion here.)
      expect(within(row).getByText('Validated')).toBeInTheDocument();
      expect(within(row).queryByText('Approved')).not.toBeInTheDocument();
      // The frozen indicator reverts, so the row is actionable again.
      expect(within(row).queryByTitle('Approved')).not.toBeInTheDocument();
      expect(within(row).getByTitle('Approve (one-click)')).toBeInTheDocument();
      expect(within(row).getByTitle('Reject (one-click)')).toBeInTheDocument();
    });

    it('cancels the write entirely when Undo lands inside the window, and never moves the status', async () => {
      await renderPage();
      jest.useFakeTimers();

      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Approve (one-click)'));
      expect(within(rowFor('Agentic AI funding round')).getByTitle('Approved')).toBeInTheDocument();

      // The Undo button lives in the toast payload's `action` element. This page
      // does not render <Toaster/> (the root layout does) and useToast is mocked,
      // so the element is never mounted — invoke its handler, which is exactly
      // what clicking it does.
      const undoAction = mockToast.mock.calls
        .map(([payload]) => payload)
        .find((p) => p.title === 'Signal Approved')?.action;
      expect(undoAction).toBeDefined();
      act(() => {
        undoAction!.props.onClick();
      });

      // Even after the full window elapses the deferred write never fires (F71)...
      await runCommitWindow();
      expect(submitSignalFeedback).not.toHaveBeenCalled();

      // ...and the row is back exactly where it started.
      const reverted = rowFor('Agentic AI funding round');
      expect(within(reverted).getByText('Validated')).toBeInTheDocument();
      expect(within(reverted).queryByText('Approved')).not.toBeInTheDocument();
      expect(within(reverted).getByTitle('Approve (one-click)')).toBeInTheDocument();
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Undone' }));
    });

    it('retires the Undo affordance before writing, so it can never contradict the flipped badge', async () => {
      // Radix pauses a toast's dismiss timer on hover, so the Undo button can
      // outlive the commit timer. commit() dismisses it first; without that, a
      // post-commit Undo would revert only `feedback` while the row still read
      // "Approved" off the patched status.
      await renderPage();
      jest.useFakeTimers();

      fireEvent.click(within(rowFor('Agentic AI funding round')).getByTitle('Approve (one-click)'));

      // Read the handle the component actually received, rather than overriding
      // the factory: jest.clearAllMocks() clears calls but NOT a mockReturnValue,
      // so an override here would leak into every later test in the file.
      const undoToastIndex = mockToast.mock.calls.findIndex(([payload]) => payload.title === 'Signal Approved');
      expect(undoToastIndex).toBeGreaterThanOrEqual(0);
      const { dismiss } = mockToast.mock.results[undoToastIndex].value;
      expect(dismiss).not.toHaveBeenCalled();

      await runCommitWindow();

      expect(dismiss).toHaveBeenCalled();
      expect(within(rowFor('Agentic AI funding round')).getByText('Approved')).toBeInTheDocument();
    });
  });
});
