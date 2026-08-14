/**
 * @file triage/insights/__tests__/page.table-conventions.test.tsx
 * @description Library-table-convention regression tests for the Insights
 * page (/triage/insights, list view).
 *
 * Pins the 2026-06-10 alignment with the canonical library-table pattern
 * (reference: CompaniesTable + library/shared/SortableHeader):
 *   - Title/Type/Agent/Confidence/Detected headers use the shared
 *     plain-text SortableHeader, with `aria-sort` kept on the `<th>` and
 *     stable `insights-sort-*` test ids (sorting via the pure
 *     compareInsights in components/impulse/insight-sort).
 *   - Bulk selection surfaces the shared floating BulkActionToolbar
 *     (bottom of viewport) instead of the old page-local top action bar,
 *     while Dismiss keeps flowing through the existing BulkDismissDialog
 *     into the same useBulkDismissInsights mutation (with Undo toast).
 *   - The pagination footer is the shared DataPagination.
 *   - Per-row like engagement (preference signal) stays wired.
 *
 * The H5 mount regression lives in ./page.test.tsx — this file covers the
 * table-convention surface only.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

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
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  __esModule: true,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  __esModule: true,
  useAuth: () => ({ user: { uid: 'user-1' }, loading: false }),
}));

// The briefing query is the data source; two insights with distinct values
// per sortable column so header clicks have observable effects.
const mockUseBriefing = jest.fn();
jest.mock('@/hooks/useBriefing', () => ({
  __esModule: true,
  useBriefing: () => mockUseBriefing(),
  briefingKeys: { all: ['briefing'], insights: () => ['briefing', 'insights'] },
}));

// Engagement mutations — the like path writes preference signals; pin that
// the row button still reaches the hook after the alignment.
const mockLikeMutate = jest.fn();
jest.mock('@/hooks/queries/useLikeInsight', () => ({
  __esModule: true,
  useLikeInsight: () => ({ mutate: mockLikeMutate }),
}));
jest.mock('@/hooks/queries/useDismissInsight', () => ({
  __esModule: true,
  useDismissInsight: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/hooks/queries/useUndismissInsight', () => ({
  __esModule: true,
  useUndismissInsight: () => ({ mutate: jest.fn() }),
}));

// Bulk dismiss — fire onSuccess synchronously so the confirm click, the
// selection clear, and the Undo toast all land in the same tick.
const mockBulkMutate = jest.fn();
jest.mock('@/hooks/queries/useBulkDismissInsights', () => ({
  __esModule: true,
  useBulkDismissInsights: () => ({
    mutate: (vars: unknown, opts?: { onSuccess?: () => void }) => {
      mockBulkMutate(vars, opts);
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
}));

// Keyboard shortcuts have their own suite; no-op here.
jest.mock('@/hooks/useBriefingKeyboardShortcuts', () => ({
  __esModule: true,
  useBriefingKeyboardShortcuts: () => ({ focusedId: null, setFocusedId: () => {} }),
}));

// Deterministic list view (the grid/card view is out of scope here).
jest.mock('@/stores/briefing-ui-store', () => ({
  __esModule: true,
  useBriefingUIStore: (selector: (s: { viewMode: 'table' | 'card' }) => unknown) => selector({ viewMode: 'table' }),
}));

// Reactive URL-state mock — sort/page persistence flows through
// `useUrlParams`; mirror the production contract (one shared store, one
// snapshot per write, re-render on update).
jest.mock('@/hooks/useUrlState', () => {
  const ReactMod = require('react');
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    useUrlParams: () => {
      const [, setVersion] = ReactMod.useState(0);
      const params = new URLSearchParams();
      for (const [k, v] of store.entries()) params.set(k, v);
      const setParams = (next: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === undefined || v === '') store.delete(k);
          else if (Array.isArray(v)) {
            if (v.length === 0) store.delete(k);
            else store.set(k, v.join(','));
          } else store.set(k, String(v));
        }
        setVersion((n: number) => n + 1);
      };
      const setParam = (key: string, value: unknown) => setParams({ [key]: value });
      const clearAll = () => {
        store.clear();
        setVersion((n: number) => n + 1);
      };
      return { params, setParams, setParam, clearAll };
    },
    useUrlState: () => ({ value: undefined, setValue: () => {}, clear: () => {} }),
    useUrlArrayState: () => ({
      values: [],
      setValues: () => {},
      add: () => {},
      remove: () => {},
      toggle: () => {},
      has: () => false,
      clear: () => {},
    }),
  };
});
const urlMocks = jest.requireMock('@/hooks/useUrlState') as { __store: Map<string, string> };

jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/triage/insights',
  useSearchParams: () => new URLSearchParams(),
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

import InsightsPage from '../page';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(overrides: Partial<BriefingInsight> & { id: string }): BriefingInsight {
  return {
    type: 'discovery',
    title: overrides.id.toUpperCase(),
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.5,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    ...overrides,
  };
}

const INSIGHTS: BriefingInsight[] = [
  makeInsight({
    id: 'in-1',
    title: 'Quantum cluster forming',
    type: 'pattern',
    agentName: 'scout',
    confidenceScore: 0.9,
    createdAt: '2026-05-13T03:00:00.000Z',
  }),
  makeInsight({
    id: 'in-2',
    title: 'Agentic stack connection',
    type: 'connection',
    agentName: 'linker',
    confidenceScore: 0.4,
    createdAt: '2026-05-13T01:00:00.000Z',
  }),
];

function renderPage() {
  render(<InsightsPage />);
}

/** Click a column's sort control (the button inside the `<th>`). */
function clickSort(field: string) {
  fireEvent.click(within(screen.getByTestId(`insights-sort-${field}`)).getByRole('button'));
}

describe('InsightsPage — library-table conventions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    urlMocks.__store.clear();
    mockUseBriefing.mockReturnValue({
      data: { insights: INSIGHTS, tokenUsage: { used: 0, budget: 100_000 } },
      isPending: false,
    });
  });

  // ==========================================================================
  // (1) Shared SortableHeader pattern
  // ==========================================================================

  it('renders all five sortable columns as <th> with aria-sort and the shared header button', () => {
    renderPage();

    const expected: Array<[field: string, label: string]> = [
      ['title', 'Title'],
      ['type', 'Type'],
      ['agentName', 'Agent'],
      ['confidenceScore', 'Confidence'],
      ['createdAt', 'Detected'],
    ];

    for (const [field, label] of expected) {
      const th = screen.getByTestId(`insights-sort-${field}`);
      expect(th.tagName).toBe('TH');
      expect(th).toHaveAttribute('aria-sort');
      // Shared SortableHeader renders a plain text <button>, not a ghost pill.
      const button = within(th).getByRole('button');
      expect(button).toHaveTextContent(label);
    }

    // Default sort is Detected (createdAt) descending; everything else inactive.
    expect(screen.getByTestId('insights-sort-createdAt')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByTestId('insights-sort-title')).toHaveAttribute('aria-sort', 'none');
  });

  it('preserves the sort behavior: text column starts asc, second click flips to desc', () => {
    renderPage();

    clickSort('title');
    expect(screen.getByTestId('insights-sort-title')).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByTestId('insights-sort-createdAt')).toHaveAttribute('aria-sort', 'none');

    clickSort('title');
    expect(screen.getByTestId('insights-sort-title')).toHaveAttribute('aria-sort', 'descending');
  });

  it('numeric column (Confidence) starts desc and reorders the rows', () => {
    renderPage();

    clickSort('confidenceScore');
    expect(screen.getByTestId('insights-sort-confidenceScore')).toHaveAttribute('aria-sort', 'descending');

    const rows = screen.getAllByTestId(/^insight-row-/);
    // 0.9 (in-1) before 0.4 (in-2).
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['insight-row-in-1', 'insight-row-in-2']);
  });

  // ==========================================================================
  // (2) Shared floating BulkActionToolbar
  // ==========================================================================

  it('shows the shared floating toolbar when rows are selected, with the Dismiss CTA', () => {
    renderPage();

    expect(screen.queryByText(/insight(s)? selected/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('insight-select-in-1'));

    expect(screen.getByText('1 insight selected')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-action-bar-dismiss')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument();
  });

  it('clears the selection (and hides the toolbar) via the toolbar X', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('insight-select-in-1'));
    expect(screen.getByText('1 insight selected')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText('1 insight selected')).not.toBeInTheDocument();
  });

  it('bulk dismiss flows through the BulkDismissDialog into useBulkDismissInsights with an Undo toast', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('insight-select-in-1'));
    fireEvent.click(screen.getByTestId('insight-select-in-2'));
    expect(screen.getByText('2 insights selected')).toBeInTheDocument();

    // The Dismiss CTA opens the same Q3 confirmation dialog as before the
    // toolbar move — no mutation until confirm.
    fireEvent.click(screen.getByTestId('bulk-action-bar-dismiss'));
    expect(screen.getByTestId('bulk-dismiss-dialog')).toBeInTheDocument();
    expect(mockBulkMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('bulk-dismiss-confirm'));
    expect(mockBulkMutate).toHaveBeenCalledWith({ dismiss: true, insightIds: ['in-1', 'in-2'] }, expect.any(Object));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      '2 insights marked as read',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );

    // Selection is cleared after the bulk action completes.
    expect(screen.queryByText('2 insights selected')).not.toBeInTheDocument();
  });

  // ==========================================================================
  // (3) Canonical DataPagination footer
  // ==========================================================================

  it('renders the shared DataPagination footer with the insights item label', () => {
    renderPage();

    expect(screen.getByText('Rows per page')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2 insights')).toBeInTheDocument();
  });

  // ==========================================================================
  // (4) Engagement wiring preserved
  // ==========================================================================

  it('keeps the per-row like button wired to useLikeInsight (preference signal)', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('insight-like-in-1'));
    expect(mockLikeMutate).toHaveBeenCalledWith({ insightId: 'in-1', liked: true });
  });
});
