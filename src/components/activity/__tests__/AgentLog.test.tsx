/**
 * @file AgentLog.test.tsx
 * @description Component rendering tests for AgentLog
 *
 * Tests run→report linking on Activity history cards:
 * - entry with a missionId matching a published report shows a "View report"
 *   link pointing at /reports/{reportId}
 * - entry without a missionId (or with a missionId that has no report)
 *   renders no link
 * - reports query still loading / empty renders no link
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import type { AgentLogEntry } from '@/hooks/useAgentActivity';
import type { Report } from '@/lib/schemas/report';

// Mock lucide-react with a Proxy so any icon import works
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

// Mock next/link as a passthrough anchor
jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = 'NextLink';
  return { __esModule: true, default: MockLink };
});

// Mock the reports query hook — AgentLog resolves missionId → report from it
const mockUseReports = jest.fn();
jest.mock('@/hooks/useReports', () => ({
  useReports: () => mockUseReports(),
}));

// Mock auth — AgentLog passes the authenticated uid as the defensive owner
// scope for canonical report resolution (REPORT-002).
const OWNER_UID = 'owner-1';
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: OWNER_UID } }),
}));

// Mock the router — the empty state navigates to the Agent Config settings tab
const mockRouterPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

import { AgentLog } from '../AgentLog';

// ============================================================================
// FIXTURES
// ============================================================================

function makeEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    id: 'run-001',
    agentName: 'Creator',
    action: 'Generated landscape report',
    status: 'success',
    tokenUsage: { input: 1200, output: 800 },
    duration: 4500,
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-abc',
    title: 'Quantum Landscape 2026',
    html: '<html><body>report</body></html>',
    createdAt: '2026-06-01T10:05:00.000Z',
    createdBy: 'agent',
    agentType: 'creator',
    missionId: 'mission-123',
    // Catalog reports are owner-scoped — carry the authenticated owner so the
    // canonical selector links them (an ownerless report is refused).
    ownerId: OWNER_UID,
    entityIds: [],
    metadata: {
      description: 'Landscape report',
      dataSnapshotAt: '2026-06-01T10:00:00.000Z',
    },
    shared: false,
    ...overrides,
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('AgentLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseReports.mockReturnValue({ data: [] });
  });

  it('renders a View report link when an entry has a missionId with a matching report', () => {
    mockUseReports.mockReturnValue({ data: [makeReport()] });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    const link = screen.getByTestId(`view-report-link-${entry.id}`);
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('View report');
    expect(link).toHaveAttribute('href', '/reports/report-abc');
  });

  it('renders no link when the entry has no missionId', () => {
    mockUseReports.mockReturnValue({ data: [makeReport()] });
    const entry = makeEntry();

    render(<AgentLog entries={[entry]} />);

    expect(screen.getByTestId(`agent-log-entry-${entry.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`view-report-link-${entry.id}`)).not.toBeInTheDocument();
    expect(screen.queryByText('View report')).not.toBeInTheDocument();
  });

  it('renders no link when no report matches the missionId', () => {
    mockUseReports.mockReturnValue({ data: [makeReport({ missionId: 'mission-other' })] });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    expect(screen.queryByTestId(`view-report-link-${entry.id}`)).not.toBeInTheDocument();
  });

  it('renders no link while the reports query has no data yet', () => {
    mockUseReports.mockReturnValue({ data: undefined });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    expect(screen.getByTestId(`agent-log-entry-${entry.id}`)).toBeInTheDocument();
    expect(screen.queryByText('View report')).not.toBeInTheDocument();
  });

  it('labels each cost authority explicitly', () => {
    render(
      <AgentLog
        entries={[
          makeEntry({ id: 'estimated', costUsd: 0.125, costState: 'estimated' }),
          makeEntry({ id: 'settled', costUsd: 0.25, costState: 'settled' }),
          makeEntry({ id: 'mixed', costUsd: 0.375, costState: 'mixed' }),
          makeEntry({ id: 'reserved', costUsd: 1.5, costState: 'reserved' }),
          makeEntry({
            id: 'maximum',
            costUsd: 2.5,
            costState: 'maximum-exposure',
          }),
          makeEntry({ id: 'unavailable', costUsd: undefined }),
        ]}
      />
    );

    expect(screen.getByTestId('agent-log-cost-estimated')).toHaveTextContent('$0.13 est.');
    expect(screen.getByTestId('agent-log-cost-settled')).toHaveTextContent('$0.25 settled');
    expect(screen.getByTestId('agent-log-cost-mixed')).toHaveTextContent('$0.38 settled + est.');
    expect(screen.getByTestId('agent-log-cost-reserved')).toHaveTextContent('$1.50 reserved');
    expect(screen.getByTestId('agent-log-cost-maximum')).toHaveTextContent('$2.50 maximum exposure');
    expect(screen.getByTestId('agent-log-cost-unavailable')).toHaveTextContent('Unavailable');
  });

  it('ARUN-027: an amount with no recorded authority is never labelled settled', () => {
    // A pre-AI-029 AgentRun persisted `costUsd` with no `costState`. Calling it
    // "settled" asserts a provider confirmation that never happened.
    render(<AgentLog entries={[makeEntry({ id: 'legacy', costUsd: 0.25, costState: undefined })]} />);

    const cell = screen.getByTestId('agent-log-cost-legacy');
    expect(cell).toHaveTextContent('$0.25');
    expect(cell).not.toHaveTextContent('settled');
    expect(cell).not.toHaveTextContent('est.');
  });

  it('ARUN-027: an unpriceable model reads differently from a ledger that lost receipts', () => {
    render(
      <AgentLog
        entries={[
          makeEntry({ id: 'unpriced', costUsd: undefined, costUnavailableReason: 'unknown-pricing' }),
          makeEntry({
            id: 'incomplete',
            costUsd: undefined,
            costUnavailableReason: 'accounting-incomplete',
          }),
        ]}
      />
    );

    // A rate-card gap: the spend is recorded, its price is unknown.
    expect(screen.getByTestId('agent-log-cost-unpriced')).toHaveTextContent('Unpriced');
    // A durable accounting loss: real spend exists that nothing can account for.
    expect(screen.getByTestId('agent-log-cost-incomplete')).toHaveTextContent('Incomplete');
  });

  it('empty state explains automation and links to the Agent Config tab', () => {
    render(<AgentLog entries={[]} />);

    expect(screen.getByText('No agent activity yet')).toBeInTheDocument();
    expect(screen.getByText(/working automation controls in Agent Config/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Go to Agent Config/ }));
    expect(mockRouterPush).toHaveBeenCalledWith('/settings?tab=agent-config');
  });

  it('links chain-grouped entries to their respective reports', () => {
    mockUseReports.mockReturnValue({
      data: [makeReport({ id: 'report-step2', missionId: 'mission-step2' })],
    });
    const step1 = makeEntry({
      id: 'run-c1',
      missionId: 'mission-step1',
      chainId: 'chain-1',
      chainStep: 1,
      chainTotalSteps: 2,
    });
    const step2 = makeEntry({
      id: 'run-c2',
      missionId: 'mission-step2',
      chainId: 'chain-1',
      chainStep: 2,
      chainTotalSteps: 2,
    });

    render(<AgentLog entries={[step2, step1]} />);

    expect(screen.getByTestId('chain-group-chain-1')).toBeInTheDocument();
    expect(screen.queryByTestId('view-report-link-run-c1')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-report-link-run-c2')).toHaveAttribute('href', '/reports/report-step2');
  });

  // REPORT-002 — Activity must not link a run to an ownerless, foreign, or
  // arbitrary same-mission report; a multi-report mission resolves to one
  // deterministic canonical report.
  it('renders no link for an ownerless legacy report (defense-in-depth)', () => {
    mockUseReports.mockReturnValue({ data: [makeReport({ ownerId: undefined })] });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    expect(screen.queryByTestId(`view-report-link-${entry.id}`)).not.toBeInTheDocument();
  });

  it('renders no link for a foreign report even if it leaked into the list', () => {
    mockUseReports.mockReturnValue({ data: [makeReport({ ownerId: 'someone-else' })] });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    expect(screen.queryByTestId(`view-report-link-${entry.id}`)).not.toBeInTheDocument();
  });

  it('links a multi-report mission to the deterministic canonical report (newest, id tiebreaker)', () => {
    const tied = '2026-06-05T10:00:00.000Z';
    mockUseReports.mockReturnValue({
      data: [
        makeReport({ id: 'report-old', createdAt: '2026-06-01T10:00:00.000Z' }),
        makeReport({ id: 'report-y', createdAt: tied }),
        makeReport({ id: 'report-x', createdAt: tied }),
      ],
    });
    const entry = makeEntry({ missionId: 'mission-123' });

    render(<AgentLog entries={[entry]} />);

    // Newest wins; on the tie the lower id (report-x) is chosen deterministically.
    expect(screen.getByTestId(`view-report-link-${entry.id}`)).toHaveAttribute('href', '/reports/report-x');
  });
});
