/**
 * @file agents/jobs/__tests__/page.test.tsx
 * @description UX-068 page regression — `/agents/jobs` mounts the Jobs table as
 * the page's only experience and threads the server-side kind/status filters
 * back into the bounded verification query.
 *
 * @jest-environment jsdom
 */

// ---------------------------------------------------------------------------
// Layout chrome — passthrough mocks. SmartLayout pulls the sidebar (and through
// it firebase-admin), so stub it down to a div for unit-scope mounting.
// ---------------------------------------------------------------------------
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
  ErrorFallback: ({ title }: { title?: string }) => <div role="alert">{title ?? 'error'}</div>,
}));

const mockUseDefenseVerificationJobs = jest.fn();
jest.mock('@/hooks/useDefenseVerifications', () => ({
  __esModule: true,
  useDefenseVerificationJobs: (filters: unknown) => mockUseDefenseVerificationJobs(filters),
}));

// The Jobs table renders Radix Select triggers; jsdom lacks the pointer APIs.
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  const Ctx = React.createContext({});
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
    }) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(Ctx) as { value?: string; onValueChange?: (v: string) => void };
      return (
        <button type="button" role="option" aria-selected={false} onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    SelectTrigger: ({ children, ...props }: { children: React.ReactNode; 'aria-label'?: string }) => (
      <div role="combobox" aria-label={props['aria-label']}>
        {children}
      </div>
    ),
    SelectValue: () => null,
  };
});

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
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DefenseVerificationRow } from '@/lib/activity/defense-verification-types';
import AgentJobsPage from '../page';

const JOB: DefenseVerificationRow = {
  id: 'inngest-run-1',
  kind: 'entity',
  status: 'completed',
  attempts: 1,
  startedAt: Date.parse('2026-05-08T08:00:00.000Z'),
  completedAt: Date.parse('2026-05-08T08:00:10.000Z'),
  durationMs: 10_000,
  targetKind: 'entity',
  targetId: 'entity-1',
  resultId: 'vr-1',
  resultStatus: 'verified',
  resultScore: 0.9,
  providers: ['gemini'],
  models: ['gemini-3.5-flash'],
  verifierModel: 'defense-minister-smart-v1',
  cost: { state: 'settled', amountMicros: 50_000, currency: 'USD', display: '$0.05 USD settled' },
};

function hookResult(overrides: Record<string, unknown> = {}) {
  return {
    jobs: [JOB],
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    hasMore: false,
    loadMore: jest.fn(),
    isLoadingMore: false,
    ...overrides,
  };
}

describe('AgentJobsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseDefenseVerificationJobs.mockReturnValue(hookResult());
  });

  it('mounts and renders the Jobs table', () => {
    render(<AgentJobsPage />);

    expect(screen.getByTestId('layout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Jobs', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('job-row-inngest-run-1')).toBeInTheDocument();
  });

  it('holds only the Jobs experience — no Agent Runs table', () => {
    render(<AgentJobsPage />);

    expect(screen.queryByRole('heading', { name: /agent runs/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('starts with no server-side filter applied', () => {
    render(<AgentJobsPage />);

    expect(mockUseDefenseVerificationJobs).toHaveBeenCalledWith({});
  });

  it('threads a kind selection back into the bounded verification query', async () => {
    render(<AgentJobsPage />);

    await userEvent.click(screen.getByRole('option', { name: 'Edge' }));

    expect(mockUseDefenseVerificationJobs).toHaveBeenLastCalledWith({ kind: 'edge' });
  });

  it('threads a status selection back into the bounded verification query', async () => {
    render(<AgentJobsPage />);

    await userEvent.click(screen.getByRole('option', { name: 'Running' }));

    expect(mockUseDefenseVerificationJobs).toHaveBeenLastCalledWith({ status: 'running' });
  });

  it('surfaces the hook error as a retryable unavailable state', async () => {
    const refetch = jest.fn();
    mockUseDefenseVerificationJobs.mockReturnValue(hookResult({ jobs: [], error: new Error('boom'), refetch }));

    render(<AgentJobsPage />);

    expect(screen.getByTestId('jobs-table-unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces the loading state as a table skeleton', () => {
    mockUseDefenseVerificationJobs.mockReturnValue(hookResult({ jobs: [], isLoading: true }));

    render(<AgentJobsPage />);

    expect(screen.getByTestId('jobs-table-skeleton')).toBeInTheDocument();
  });
});
