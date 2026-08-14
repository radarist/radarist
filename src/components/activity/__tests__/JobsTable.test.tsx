/**
 * @file components/activity/__tests__/JobsTable.test.tsx
 * @description UX-068 component regressions for the Activity → Jobs table.
 *
 * Covers what the panel it replaces could not do — accessible ascending /
 * descending sort, search, rows-per-page, multi-page navigation and result
 * range — plus the semantics it must NOT lose: server-side kind/status filters,
 * lineage fields (target, endpoints, verifier pipeline version separate from
 * provider model, graph result), and the honest settled / estimated /
 * incomplete / unavailable cost vocabulary.
 *
 * @jest-environment jsdom
 */

// Radix Select needs pointer APIs jsdom lacks; the trigger/value semantics
// under test are the `aria-label` + current value, so stub it to inert markup
// that still reports the selected value and forwards a change.
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  // `React` comes from an untyped `require`, so the context type is applied at
  // the read site rather than as a type argument.
  const ValueContext = React.createContext({});
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
    }) => <ValueContext.Provider value={{ value, onValueChange }}>{children}</ValueContext.Provider>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(ValueContext) as { value?: string; onValueChange?: (v: string) => void };
      return (
        <button
          type="button"
          role="option"
          aria-selected={ctx.value === value}
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    SelectTrigger: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      'aria-label'?: string;
      'data-testid'?: string;
    }) => {
      const ctx = React.useContext(ValueContext) as { value?: string; onValueChange?: (v: string) => void };
      return (
        <div role="combobox" aria-label={props['aria-label']} data-testid={props['data-testid']} data-value={ctx.value}>
          {children}
        </div>
      );
    },
    SelectValue: () => null,
  };
});

// lucide-react is ESM; stub icons as inert spans.
jest.mock('lucide-react', () => {
  const React = require('react');
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) =>
      React.createElement('span', { 'data-testid': `icon-${name}`, className: props.className });
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_t: never, prop: string) => makeIcon(prop) });
});

import * as React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobsTable, type JobsTableProps } from '../JobsTable';
import type { DefenseVerificationRow } from '@/lib/activity/defense-verification-types';

const BASE_STARTED_AT = Date.parse('2026-05-08T08:00:00.000Z');

function makeJob(overrides: Partial<DefenseVerificationRow> = {}): DefenseVerificationRow {
  return {
    id: 'inngest-run-1',
    kind: 'entity',
    status: 'completed',
    attempts: 1,
    startedAt: BASE_STARTED_AT,
    completedAt: BASE_STARTED_AT + 10_000,
    durationMs: 10_000,
    targetKind: 'entity',
    targetId: 'entity-1',
    resultId: 'vr-1',
    resultStatus: 'verified',
    resultScore: 0.85,
    providers: ['gemini'],
    models: ['gemini-3.5-flash'],
    verifierModel: 'defense-minister-smart-v1',
    cost: { state: 'settled', amountMicros: 1_000_000, currency: 'USD', display: '$1.00 USD settled' },
    ...overrides,
  };
}

/** `count` jobs with deterministic, distinguishable ids and start times. */
function makeJobs(count: number): DefenseVerificationRow[] {
  return Array.from({ length: count }, (_, i) =>
    makeJob({
      id: `inngest-run-${i + 1}`,
      targetId: `entity-${String(i + 1).padStart(2, '0')}`,
      // Descending start time, so index 0 is the newest.
      startedAt: BASE_STARTED_AT - i * 60_000,
      durationMs: (i + 1) * 1000,
    })
  );
}

function renderTable(overrides: Partial<JobsTableProps> = {}) {
  const props: JobsTableProps = {
    jobs: [makeJob()],
    filters: {},
    onFiltersChange: jest.fn(),
    isLoading: false,
    error: null,
    onRetry: jest.fn(),
    hasMore: false,
    onLoadMore: jest.fn(),
    isLoadingMore: false,
    ...overrides,
  };
  return { props, ...render(<JobsTable {...props} />) };
}

/** Data rows in current visual order (the header row lives in <thead>). */
function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-testid')?.startsWith('job-row-'));
}

describe('JobsTable — states', () => {
  it('keeps the card header stable while loading and shows a table skeleton', () => {
    renderTable({ isLoading: true, jobs: [] });

    expect(screen.getByRole('heading', { name: 'Jobs', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('jobs-table-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders an error state with a working Retry', async () => {
    const onRetry = jest.fn();
    renderTable({ jobs: [], error: new Error('network down'), onRetry });

    // The header survives the failure, so the page does not blank out.
    expect(screen.getByRole('heading', { name: 'Jobs', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('jobs-table-unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/background verifications unavailable/i);

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an actionable empty state when nothing has run yet', () => {
    const onRetry = jest.fn();
    renderTable({ jobs: [], onRetry });

    expect(screen.getByText(/no background verification jobs yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('distinguishes "no matches" from "nothing has run", and Clear filters resets both', async () => {
    const onFiltersChange = jest.fn();
    renderTable({ jobs: makeJobs(3), filters: { kind: 'entity' }, onFiltersChange });

    await userEvent.type(screen.getByTestId('jobs-search-input'), 'no-such-target');
    expect(screen.getByText(/no matching jobs/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(onFiltersChange).toHaveBeenCalledWith({});
    expect(screen.getByTestId('jobs-search-input')).toHaveValue('');
  });
});

describe('JobsTable — lineage and cost scope', () => {
  it('reports the verifier pipeline version separately from the provider model', () => {
    renderTable();

    const row = screen.getByTestId('job-row-inngest-run-1');
    expect(within(row).getByText('gemini')).toBeInTheDocument();
    expect(within(row).getByText('gemini-3.5-flash')).toBeInTheDocument();
    expect(within(row).getByText('defense-minister-smart-v1')).toBeInTheDocument();
  });

  it('renders edge endpoints and the graph result for an edge verification', () => {
    renderTable({
      jobs: [
        makeJob({
          id: 'inngest-edge-1',
          kind: 'edge',
          targetKind: 'edge',
          targetId: 'relation-1',
          targetSubIds: { sourceEntityId: 'src-1', targetEntityId: 'tgt-1' },
          resultId: 'vr-edge-1',
          resultStatus: 'disputed',
          resultScore: 0.3,
        }),
      ],
    });

    const row = screen.getByTestId('job-row-inngest-edge-1');
    expect(within(row).getByText('relation-1')).toBeInTheDocument();
    expect(within(row).getByText('src-1 → tgt-1')).toBeInTheDocument();
    expect(within(row).getByText('vr-edge-1')).toBeInTheDocument();
    expect(within(row).getByText(/disputed/)).toBeInTheDocument();
  });

  it.each([
    ['settled', '$0.05 USD settled', undefined],
    ['estimated', '$0.02 USD est.', undefined],
    ['incomplete', '$0.02 USD (incomplete)', 'incomplete-accounting'],
    ['unavailable', '—', 'orphan-target'],
  ] as const)('renders the %s cost scope verbatim from the ledger', (state, display, partialReason) => {
    renderTable({
      jobs: [
        makeJob({
          id: `inngest-${state}`,
          cost: { state, display },
          partialReason,
        }),
      ],
    });

    const row = screen.getByTestId(`job-row-inngest-${state}`);
    expect(within(row).getByTestId('cost-cell')).toHaveTextContent(display);
  });

  it('never fabricates a zero — an unknown cost stays an em dash', () => {
    renderTable({ jobs: [makeJob({ cost: { state: 'unavailable', display: '—' } })] });

    const costCell = screen.getByTestId('cost-cell');
    expect(costCell).toHaveTextContent('—');
    expect(costCell).not.toHaveTextContent('$0');
  });

  it('renders an unknowable duration as an em dash, not 0ms', () => {
    renderTable({ jobs: [makeJob({ status: 'running', completedAt: undefined, durationMs: undefined })] });

    const row = screen.getByTestId('job-row-inngest-run-1');
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('0ms');
  });
});

describe('JobsTable — filters', () => {
  it('exposes the route-backed kind and status filters', () => {
    renderTable({ filters: { kind: 'edge', status: 'failed' } });

    expect(screen.getByRole('combobox', { name: 'Filter by kind' })).toHaveAttribute('data-value', 'edge');
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveAttribute('data-value', 'failed');
  });

  it('lifts a kind change to the caller so the server query re-runs', async () => {
    const onFiltersChange = jest.fn();
    renderTable({ onFiltersChange });

    await userEvent.click(screen.getByRole('option', { name: 'Edge' }));
    expect(onFiltersChange).toHaveBeenCalledWith({ kind: 'edge' });
  });

  it('lifts a status change to the caller so the server query re-runs', async () => {
    const onFiltersChange = jest.fn();
    renderTable({ onFiltersChange });

    await userEvent.click(screen.getByRole('option', { name: 'Failed' }));
    expect(onFiltersChange).toHaveBeenCalledWith({ status: 'failed' });
  });

  it('offers only the kinds and statuses the route query schema accepts', () => {
    renderTable();

    // Scoped to the card header — the pagination footer has a rows-per-page
    // select of its own, and its options are not filter values.
    const header = screen.getByTestId('jobs-table').firstElementChild as HTMLElement;
    const optionNames = within(header)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(optionNames).toEqual([
      'All kinds',
      'Entity',
      'Edge',
      'All statuses',
      'Running',
      'Retrying',
      'Completed',
      'Failed',
      'Cancelled',
    ]);
    // `interrupted` is a real row status but the route's Zod enum rejects it as
    // a filter value, so offering it would produce a guaranteed 400.
    expect(optionNames).not.toContain('Interrupted');
  });

  it('searches across target, endpoints, providers, models and verifier', async () => {
    renderTable({
      jobs: [
        makeJob({ id: 'a', targetId: 'alpha-entity' }),
        makeJob({ id: 'b', targetId: 'beta-entity', providers: ['anthropic'], models: ['claude-opus-5'] }),
      ],
    });

    await userEvent.type(screen.getByTestId('jobs-search-input'), 'claude-opus');

    expect(screen.queryByTestId('job-row-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('job-row-b')).toBeInTheDocument();
  });

  it('states the visible count against the total actually held', async () => {
    renderTable({ jobs: makeJobs(5) });

    await userEvent.type(screen.getByTestId('jobs-search-input'), 'entity-01');
    expect(screen.getByTestId('jobs-filter-summary')).toHaveTextContent('Showing 1 of 5 jobs');
  });

  it('qualifies that count as "loaded" while rows remain beyond the window', async () => {
    renderTable({ jobs: makeJobs(5), hasMore: true });

    await userEvent.type(screen.getByTestId('jobs-search-input'), 'entity-01');
    expect(screen.getByTestId('jobs-filter-summary')).toHaveTextContent('Showing 1 of 5 loaded jobs');
  });
});

describe('JobsTable — sort', () => {
  it('defaults to newest first and exposes descending sort state on Started', () => {
    renderTable({ jobs: makeJobs(3) });

    expect(screen.getByTestId('jobs-sort-started')).toHaveAttribute('aria-sort', 'descending');
    expect(bodyRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'job-row-inngest-run-1',
      'job-row-inngest-run-2',
      'job-row-inngest-run-3',
    ]);
  });

  it('toggles Started between descending and ascending, and reorders the rows', async () => {
    renderTable({ jobs: makeJobs(3) });

    await userEvent.click(within(screen.getByTestId('jobs-sort-started')).getByRole('button'));

    expect(screen.getByTestId('jobs-sort-started')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'job-row-inngest-run-3',
      'job-row-inngest-run-2',
      'job-row-inngest-run-1',
    ]);
  });

  it('moves the sort to a new column and leaves the previous one unsorted', async () => {
    renderTable({ jobs: makeJobs(3) });

    await userEvent.click(within(screen.getByTestId('jobs-sort-target')).getByRole('button'));

    expect(screen.getByTestId('jobs-sort-target')).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByTestId('jobs-sort-started')).toHaveAttribute('aria-sort', 'none');
    expect(bodyRows()[0]).toHaveAttribute('data-testid', 'job-row-inngest-run-3');
  });

  it('sorts duration numerically and puts an unknown duration lowest', async () => {
    renderTable({
      jobs: [
        makeJob({ id: 'slow', targetId: 't-slow', durationMs: 90_000 }),
        makeJob({ id: 'unknown', targetId: 't-unknown', durationMs: undefined }),
        makeJob({ id: 'fast', targetId: 't-fast', durationMs: 500 }),
      ],
    });

    await userEvent.click(within(screen.getByTestId('jobs-sort-duration')).getByRole('button'));

    expect(bodyRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'job-row-slow',
      'job-row-fast',
      'job-row-unknown',
    ]);
  });

  it('never orders one currency against another by raw amount', async () => {
    renderTable({
      jobs: [
        makeJob({
          id: 'usd-small',
          cost: { state: 'settled', currency: 'USD', amountMicros: 1, display: '$0.01 USD settled' },
        }),
        makeJob({
          id: 'cad-large',
          cost: { state: 'settled', currency: 'CAD', amountMicros: 9_000_000, display: '$9.00 CAD settled' },
        }),
      ],
    });

    await userEvent.click(within(screen.getByTestId('jobs-sort-cost')).getByRole('button'));

    // Descending by currency first: USD before CAD, despite CAD's larger integer.
    expect(bodyRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'job-row-usd-small',
      'job-row-cad-large',
    ]);
  });
});

describe('JobsTable — pagination', () => {
  it('paginates at 10 rows per page and reports the result range', async () => {
    renderTable({ jobs: makeJobs(25) });

    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText('1–10 of 25 jobs')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('11–20 of 25 jobs')).toBeInTheDocument();
    expect(bodyRows()[0]).toHaveAttribute('data-testid', 'job-row-inngest-run-11');
  });

  it('walks first / previous / next / last across multiple pages', async () => {
    renderTable({ jobs: makeJobs(25) });

    await userEvent.click(screen.getByRole('button', { name: /last page/i }));
    expect(screen.getByText('21–25 of 25 jobs')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(5);

    await userEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(screen.getByText('11–20 of 25 jobs')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /first page/i }));
    expect(screen.getByText('1–10 of 25 jobs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /first page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
  });

  it('changes rows per page and snaps back to page 1', async () => {
    renderTable({ jobs: makeJobs(25) });

    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('11–20 of 25 jobs')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('option', { name: '20' }));

    expect(bodyRows()).toHaveLength(20);
    expect(screen.getByText('1–20 of 25 jobs')).toBeInTheDocument();
  });

  it('returns to page 1 when a search narrows the set past the current offset', async () => {
    renderTable({ jobs: makeJobs(25) });

    await userEvent.click(screen.getByRole('button', { name: /last page/i }));
    expect(screen.getByText('21–25 of 25 jobs')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('jobs-search-input'), 'entity-0');

    expect(screen.getByText('1–9 of 9 jobs')).toBeInTheDocument();
  });
});

describe('JobsTable — bounded window honesty', () => {
  it('says plainly that more jobs exist beyond the loaded window', () => {
    renderTable({ jobs: makeJobs(12), hasMore: true });

    expect(screen.getByTestId('jobs-window-notice')).toHaveTextContent(/more jobs exist beyond this window/i);
    // The footer counts what is loaded, never a total it cannot see.
    expect(screen.getByText('1–10 of 12 loaded jobs')).toBeInTheDocument();
  });

  it('loads the next window on demand and disables the control while loading', async () => {
    const onLoadMore = jest.fn();
    const { rerender } = renderTable({ jobs: makeJobs(12), hasMore: true, onLoadMore });

    await userEvent.click(screen.getByTestId('jobs-load-more'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(
      <JobsTable
        jobs={makeJobs(12)}
        filters={{}}
        onFiltersChange={jest.fn()}
        isLoading={false}
        error={null}
        onRetry={jest.fn()}
        hasMore
        onLoadMore={onLoadMore}
        isLoadingMore
      />
    );
    expect(screen.getByTestId('jobs-load-more')).toBeDisabled();
    expect(screen.getByTestId('jobs-load-more')).toHaveTextContent('Loading…');
  });

  it('drops the window caveat once the whole ledger is loaded', () => {
    renderTable({ jobs: makeJobs(12), hasMore: false });

    expect(screen.queryByTestId('jobs-window-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-load-more')).not.toBeInTheDocument();
    expect(screen.getByText('1–10 of 12 jobs')).toBeInTheDocument();
  });
});

describe('JobsTable — shell parity with Agent Runs', () => {
  it('exposes every visible column as an accessible sortable header', () => {
    renderTable({ jobs: makeJobs(2) });

    const fields = ['target', 'kind', 'status', 'provider', 'verifier', 'result', 'cost', 'duration', 'started'];
    for (const field of fields) {
      const head = screen.getByTestId(`jobs-sort-${field}`);
      expect(head).toHaveAttribute('aria-sort');
      expect(within(head).getByRole('button')).toBeInTheDocument();
    }
  });

  it('scrolls the table inside its own bounded container rather than the page', () => {
    renderTable({ jobs: makeJobs(2) });

    const table = screen.getByRole('table', { name: 'Background verification jobs' });
    expect(table.parentElement).toHaveClass('overflow-auto');
  });
});
