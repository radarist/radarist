/**
 * @file triage/assessment/__tests__/page.test.tsx
 * @description UX-053 — the Assessment inbox stays useful when a source fails.
 * One failed source must keep the other sources' rows on screen behind a
 * degraded banner (labels only, bounded retry); only a FULL outage with no
 * rows collapses to the error panel; a genuinely empty inbox stays the
 * actionable empty state. The hook mechanics live in useInbox.health.test.ts —
 * this suite pins the PAGE wiring.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxRow, InboxSourceHealth } from '@/hooks/inbox-rows';

// lucide-react ships ESM that Jest doesn't transform — proxy every icon to a
// span (same shim as agents/runs/__tests__/page.test.tsx).
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({ __esModule: true }, { get: (_t, prop: string) => makeIcon(String(prop)) });
});

const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
  usePathname: () => '/triage/assessment',
}));

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
  ErrorFallback: ({ title, reset }: { title?: string; reset?: () => void }) => (
    <div role="alert">
      {title ?? 'error'}
      {reset ? (
        <button type="button" onClick={reset}>
          Try again
        </button>
      ) : null}
    </div>
  ),
}));

const healthy: InboxSourceHealth = { discoveries: false, recommendations: false, verdicts: false };
const mockRetryFailed = jest.fn();

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'r1',
    kind: 'recommendation',
    name: 'AI agents report',
    entityType: 'report',
    effect: 'Produce an HTML report (runs on approve)',
    source: 'scout',
    confidence: 70,
    detail: '',
    tags: [],
    sourceUrl: '',
    whyRelevant: '',
    matchedTopics: [],
    createdAt: 1752900000000,
    ...over,
  };
}

const verdictRow = row({ id: 'v1', kind: 'verdict', name: 'TechX verdict', entityType: 'technology' });

type InboxReturn = {
  rows: InboxRow[];
  isLoading: boolean;
  sourceHealth: InboxSourceHealth;
  anySourceFailed: boolean;
  allSourcesFailed: boolean;
  retryFailed: () => void;
  retriesExhausted: boolean;
  busy: boolean;
  approve: jest.Mock;
  reject: jest.Mock;
  dismiss: jest.Mock;
};

function inboxReturn(over: Partial<InboxReturn> = {}): InboxReturn {
  return {
    rows: [row(), verdictRow],
    isLoading: false,
    sourceHealth: healthy,
    anySourceFailed: false,
    allSourcesFailed: false,
    retryFailed: mockRetryFailed,
    retriesExhausted: false,
    busy: false,
    approve: jest.fn(),
    reject: jest.fn(),
    dismiss: jest.fn(),
    ...over,
  };
}

const mockUseInbox = jest.fn<InboxReturn, []>(() => inboxReturn());
jest.mock('@/hooks/useInbox', () => ({
  useInbox: () => mockUseInbox(),
  useInboxArchive: () => ({ rows: [], isLoading: false, error: null, refetch: jest.fn() }),
}));

import AssessmentTriagePage from '../page';

beforeEach(() => {
  jest.clearAllMocks();
  mockUseInbox.mockImplementation(() => inboxReturn());
});

describe('Assessment inbox degradation (UX-053)', () => {
  it('fully available: rows render, no degraded banner, no error panel', () => {
    render(<AssessmentTriagePage />);
    expect(screen.getByText('AI agents report')).toBeInTheDocument();
    expect(screen.getByText('TechX verdict')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-degraded-banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('loading: keeps the skeleton, never the error or empty state', () => {
    mockUseInbox.mockImplementation(() => inboxReturn({ rows: [], isLoading: true }));
    render(<AssessmentTriagePage />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument();
  });

  it('genuinely empty (all sources healthy): actionable empty state, no banner', () => {
    mockUseInbox.mockImplementation(() => inboxReturn({ rows: [] }));
    render(<AssessmentTriagePage />);
    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-degraded-banner')).not.toBeInTheDocument();
  });

  it('one source down: last-good rows stay, the banner names ONLY the failed source class, retry wired', async () => {
    mockUseInbox.mockImplementation(() =>
      inboxReturn({
        rows: [row()],
        sourceHealth: { discoveries: true, recommendations: false, verdicts: false },
        anySourceFailed: true,
      })
    );
    render(<AssessmentTriagePage />);

    expect(screen.getByText('AI agents report')).toBeInTheDocument();
    const banner = screen.getByTestId('inbox-degraded-banner');
    expect(banner).toHaveTextContent('discoveries is temporarily unavailable');
    // Labels only — no backend internals in the UI.
    expect(banner.textContent).not.toMatch(/error|500|firestore/i);

    await userEvent.click(screen.getByTestId('inbox-degraded-retry'));
    expect(mockRetryFailed).toHaveBeenCalledTimes(1);
  });

  it('multiple sources down with remaining rows: banner joins the labels', () => {
    mockUseInbox.mockImplementation(() =>
      inboxReturn({
        rows: [verdictRow],
        sourceHealth: { discoveries: true, recommendations: true, verdicts: false },
        anySourceFailed: true,
      })
    );
    render(<AssessmentTriagePage />);
    expect(screen.getByTestId('inbox-degraded-banner')).toHaveTextContent(
      'discoveries and report recommendations are temporarily unavailable'
    );
    expect(screen.getByText('TechX verdict')).toBeInTheDocument();
  });

  it('full outage with zero rows: error panel with retry, not the empty state', async () => {
    mockUseInbox.mockImplementation(() =>
      inboxReturn({
        rows: [],
        sourceHealth: { discoveries: true, recommendations: true, verdicts: true },
        anySourceFailed: true,
        allSourcesFailed: true,
      })
    );
    render(<AssessmentTriagePage />);

    const panel = screen.getByRole('alert');
    expect(panel).toHaveTextContent('Failed to load the inbox');
    expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Try again'));
    expect(mockRetryFailed).toHaveBeenCalledTimes(1);
  });

  it('retry budget spent: the banner swaps Retry for honest guidance', () => {
    mockUseInbox.mockImplementation(() =>
      inboxReturn({
        rows: [row()],
        sourceHealth: { discoveries: false, recommendations: false, verdicts: true },
        anySourceFailed: true,
        retriesExhausted: true,
      })
    );
    render(<AssessmentTriagePage />);
    expect(screen.getByTestId('inbox-degraded-exhausted')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-degraded-retry')).not.toBeInTheDocument();
  });
});
