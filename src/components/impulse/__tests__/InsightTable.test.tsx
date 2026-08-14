/**
 * @file InsightTable.test.tsx
 * @description Tests for the table primitive: sort, select-all,
 * empty-state, and the URL-state plumbing for sort persistence.
 *
 * Row interaction (click-through, like, dismiss) is covered by
 * InsightTableRow.test.tsx — this file uses a stubbed row so the focus
 * stays on sort + selection plumbing.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Reactive URL-state mock — the table now uses `useUrlParams`, which
// reads everything off a single `URLSearchParams` snapshot and writes
// many keys at once. The mock mirrors that contract: one shared store
// + a `useState` tick that triggers re-renders on update.
jest.mock('@/hooks/useUrlState', () => {
  const ReactMod = require('react');
  const urlStore = new Map<string, string | undefined>();
  return {
    __esModule: true,
    __urlStore: urlStore,
    useUrlParams: () => {
      // Each `useUrlParams` consumer keeps its own state so a write
      // here triggers the component's re-render — matches production
      // semantics where `useSearchParams` change re-renders subscribers.
      const [, setVersion] = ReactMod.useState(0);
      const params = new URLSearchParams();
      for (const [k, v] of urlStore.entries()) {
        if (v !== undefined && v !== null) params.set(k, v);
      }
      const setParams = (next: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === undefined || v === '') urlStore.delete(k);
          else if (Array.isArray(v)) {
            if (v.length === 0) urlStore.delete(k);
            else urlStore.set(k, v.join(','));
          } else urlStore.set(k, String(v));
        }
        setVersion((n: number) => n + 1);
      };
      const setParam = (key: string, value: unknown) => setParams({ [key]: value });
      const clearAll = () => {
        urlStore.clear();
        setVersion((n: number) => n + 1);
      };
      return { params, setParams, setParam, clearAll };
    },
    // Other helpers stay null-shaped — InsightTable only consumes
    // `useUrlParams` now. Keep these so consumers in other files that
    // share the same mock file don't blow up at import time.
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

// Surface the mock's store for assertions.
const urlStore = (jest.requireMock('@/hooks/useUrlState') as { __urlStore: Map<string, string | undefined> })
  .__urlStore;

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

// Stub the row entirely — InsightTableRow is exercised by its own tests.
// Here we just need a deterministic body so we can assert sort order.
jest.mock('../InsightTableRow', () => ({
  __esModule: true,
  InsightTableRow: ({
    insight,
    selected,
    onSelectedChange,
  }: {
    insight: { id: string; title: string };
    selected: boolean;
    onSelectedChange: (next: boolean) => void;
  }) => (
    <tr data-testid={`row-${insight.id}`} data-selected={selected}>
      <td>
        <button data-testid={`select-${insight.id}`} onClick={() => onSelectedChange(!selected)}>
          select
        </button>
      </td>
      <td>{insight.title}</td>
    </tr>
  ),
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

import { InsightTable, StandaloneInsightTable } from '../InsightTable';
import type { BriefingInsight } from '@/hooks/useBriefing';

/**
 * Click the sort control for a column. The `insights-sort-*` test id sits
 * on the `<th>` (its `aria-sort` home); the clickable control is the shared
 * SortableHeader's plain-text <button> inside it.
 */
function clickSort(field: string) {
  const th = screen.getByTestId(`insights-sort-${field}`);
  const button = within(th).getByRole('button');
  fireEvent.click(button);
}

function makeInsight(overrides: Partial<BriefingInsight> & { id: string; title: string }): BriefingInsight {
  return {
    type: 'discovery',
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

const ROWS: BriefingInsight[] = [
  makeInsight({ id: 'b', title: 'B title', createdAt: '2026-05-13T03:00:00.000Z', confidenceScore: 0.4 }),
  makeInsight({ id: 'a', title: 'A title', createdAt: '2026-05-13T01:00:00.000Z', confidenceScore: 0.9 }),
  makeInsight({ id: 'c', title: 'C title', createdAt: '2026-05-13T02:00:00.000Z', confidenceScore: 0.6 }),
];

describe('InsightTable', () => {
  beforeEach(() => {
    urlStore.clear();
  });

  it('renders an empty state when no insights are present', () => {
    render(<StandaloneInsightTable insights={[]} />);
    expect(screen.getByTestId('insight-table-empty')).toBeInTheDocument();
  });

  it('sorts by createdAt desc by default (matches the server order)', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    const rows = screen.getAllByTestId(/^row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['row-b', 'row-c', 'row-a']);
  });

  it('flips direction when clicking the active sort header again', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    // Click "Detected" once (active header) → flips desc → asc.
    clickSort('createdAt');
    const rowsAsc = screen.getAllByTestId(/^row-/);
    expect(rowsAsc.map((r) => r.getAttribute('data-testid'))).toEqual(['row-a', 'row-c', 'row-b']);
  });

  it('switches sort column to title asc on first click of a different header', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    clickSort('title');
    const rows = screen.getAllByTestId(/^row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('sorts numerically on confidenceScore, starting desc (numeric-column convention)', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    clickSort('confidenceScore');
    const rows = screen.getAllByTestId(/^row-/);
    // First click on a numeric column starts descending: 0.9 > 0.6 > 0.4.
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['row-a', 'row-c', 'row-b']);
    clickSort('confidenceScore');
    const rowsAsc = screen.getAllByTestId(/^row-/);
    expect(rowsAsc.map((r) => r.getAttribute('data-testid'))).toEqual(['row-b', 'row-c', 'row-a']);
  });

  it('persists sort to the URL via useUrlState', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    clickSort('title');
    expect(urlStore.get('sort')).toBe('title:asc');
    clickSort('title');
    expect(urlStore.get('sort')).toBe('title:desc');
  });

  it('resets the page param in the same write when the sort changes', () => {
    urlStore.set('page', '2');
    render(<StandaloneInsightTable insights={ROWS} />);
    clickSort('title');
    expect(urlStore.get('sort')).toBe('title:asc');
    expect(urlStore.get('page')).toBeUndefined();
  });

  it('select-all toggles every visible row', () => {
    const onChange = jest.fn();
    render(<InsightTable insights={ROWS} selectedIds={new Set()} onSelectedIdsChange={onChange} />);
    fireEvent.click(screen.getByTestId('insight-table-select-all'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(Array.from(next).sort()).toEqual(['a', 'b', 'c']);
  });

  it('select-all clears selections that match the visible rows but preserves others', () => {
    const onChange = jest.fn();
    // 'a','b','c' visible + 'x' selected from a filtered-out row.
    const existing = new Set(['a', 'b', 'c', 'x']);
    render(<InsightTable insights={ROWS} selectedIds={existing} onSelectedIdsChange={onChange} />);
    // All visible rows are selected → click clears only those, keeps 'x'.
    fireEvent.click(screen.getByTestId('insight-table-select-all'));
    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(Array.from(next)).toEqual(['x']);
  });

  it('renders sortable headers as <th> with aria-sort on the active column', () => {
    render(<StandaloneInsightTable insights={ROWS} />);
    const activeHeader = screen.getByTestId('insights-sort-createdAt');
    expect(activeHeader.tagName).toBe('TH');
    expect(activeHeader).toHaveAttribute('aria-sort', 'descending');
    const inactiveHeader = screen.getByTestId('insights-sort-title');
    expect(inactiveHeader.tagName).toBe('TH');
    expect(inactiveHeader).toHaveAttribute('aria-sort', 'none');
    // Shared SortableHeader renders a plain text <button>, not a ghost pill.
    expect(within(activeHeader).getByRole('button')).toHaveTextContent('Detected');
  });

  it('exposes the table container with a stable test id', () => {
    const { container } = render(<StandaloneInsightTable insights={ROWS} />);
    const tableContainer = within(container).getByTestId('insight-table');
    expect(tableContainer).toBeInTheDocument();
  });
});
