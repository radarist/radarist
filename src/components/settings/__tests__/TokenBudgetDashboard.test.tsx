/**
 * @file TokenBudgetDashboard.test.tsx
 * @description Unit tests for the honest token-usage dashboard.
 *
 * Tests cover:
 * - Today's usage shows absolute numbers — no fictional "% of budget" gauge
 * - The fake "Save Budget Settings" button and fictional daily-limit /
 *   alert-threshold inputs are gone
 * - Enforced caps and the observational token reference from
 *   /api/agents/profiles are displayed honestly
 * - Weekly bars are labeled as scaled to the week's own highest day
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// ============================================================================
// Mocks
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default. Mock
// every icon with a simple <svg> stub.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop;
        return IconComponent;
      },
    }
  );
});

const mockUseTokenUsage = jest.fn();
const mockUseTokensByAgent = jest.fn();
jest.mock('@/hooks/useAgentActivity', () => ({
  useTokenUsage: (...args: unknown[]) => mockUseTokenUsage(...args),
  useTokensByAgent: (...args: unknown[]) => mockUseTokensByAgent(...args),
}));

const mockUseAgentProfiles = jest.fn();
jest.mock('@/hooks/queries/useAgentProfiles', () => ({
  useAgentProfiles: (...args: unknown[]) => mockUseAgentProfiles(...args),
}));

import { TokenBudgetDashboard } from '../TokenBudgetDashboard';
import type { AgentProfilesResponse } from '@/hooks/queries/useAgentProfiles';
import type { TokenUsageDay } from '@/hooks/useAgentActivity';

// ============================================================================
// Fixtures
// ============================================================================

function buildTokenUsage() {
  return {
    today: { date: '2026-06-10', input: 5000, output: 3000, total: 8000, costUsd: 0.42 },
    thisWeek: [
      { date: '2026-06-08', input: 1000, output: 500, total: 1500, costUsd: 0.05 },
      { date: '2026-06-09', input: 9000, output: 3000, total: 12000, costUsd: 0.6 },
      { date: '2026-06-10', input: 5000, output: 3000, total: 8000, costUsd: 0.42 },
    ],
  };
}

function buildMissionBudget(): AgentProfilesResponse['missionBudget'] {
  return {
    maxCostUsd: 15.0,
    maxCostSource: 'default',
    tokenBudget: 50000,
    tokenBudgetEnforced: false,
    maxToolCalls: 100,
  };
}

function mockAll({
  missionBudget = buildMissionBudget(),
}: {
  missionBudget?: AgentProfilesResponse['missionBudget'];
} = {}) {
  mockUseTokenUsage.mockReturnValue({ data: buildTokenUsage(), isLoading: false });
  mockUseTokensByAgent.mockReturnValue({
    data: [
      {
        agentName: 'strategist',
        model: 'claude-opus-4-8',
        totalInput: 10000,
        totalOutput: 5000,
        totalTokens: 15000,
        totalCost: 2.77,
        runCount: 2,
      },
    ],
    isLoading: false,
  });
  mockUseAgentProfiles.mockReturnValue({
    data: { profiles: [], missionBudget },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('TokenBudgetDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAll();
  });

  it('shows absolute usage numbers without a fictional "% used" gauge', () => {
    render(<TokenBudgetDashboard />);

    expect(screen.getByText('8k tokens')).toBeInTheDocument();
    // Part of a total can be an in-flight reservation, which is not money
    // already spent, so the label must say "tracked".
    expect(
      screen.getAllByText('$0.42 today').length + screen.getAllByText('$0.42 tracked today').length
    ).toBeGreaterThan(0);
    // The old gauge divided today's tokens by an arbitrary 50k constant.
    expect(screen.queryByText(/% used/i)).not.toBeInTheDocument();
  });

  it('removes the fake save button and fictional budget inputs', () => {
    render(<TokenBudgetDashboard />);

    expect(screen.queryByRole('button', { name: /save budget settings/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/daily token limit/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cost alert threshold/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/above 80% budget/i)).not.toBeInTheDocument();
  });

  it('shows the real per-mission cost cap and its env var', () => {
    render(<TokenBudgetDashboard />);

    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText(/per-mission cost cap/i)).toBeInTheDocument();
    expect(screen.getByText('MISSION_MAX_COST_USD')).toBeInTheDocument();
    expect(screen.getByText(/configured token reference/i)).toBeInTheDocument();
    expect(screen.getByText(/observed for telemetry only; this does not stop a mission/i)).toBeInTheDocument();
    expect(screen.getByText('100 tool calls')).toBeInTheDocument();
  });

  it('flags an env-overridden cost cap', () => {
    mockAll({
      missionBudget: {
        maxCostUsd: 7.5,
        maxCostSource: 'env',
        tokenBudget: 50000,
        tokenBudgetEnforced: false,
        maxToolCalls: 100,
      },
    });

    render(<TokenBudgetDashboard />);

    expect(screen.getByText('$7.50')).toBeInTheDocument();
    expect(screen.getByText('env override')).toBeInTheDocument();
  });

  it('labels the weekly bars as scaled to the week itself', () => {
    render(<TokenBudgetDashboard />);

    expect(screen.getByText(/scaled relative to the week.s highest day/i)).toBeInTheDocument();
  });

  it('renders the per-agent breakdown from real data', () => {
    render(<TokenBudgetDashboard />);

    expect(screen.getByText('strategist')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(screen.getByText(/\$2\.77 \/ 2 runs/)).toBeInTheDocument();
  });

  it('labels per-agent settled, estimated, and unavailable cost instead of blending them', () => {
    mockUseTokensByAgent.mockReturnValue({
      data: [
        {
          agentName: 'strategist',
          model: 'claude-opus-4-8',
          totalInput: 10000,
          totalOutput: 5000,
          totalTokens: 15000,
          totalCost: 2.75,
          settledCost: 1.25,
          estimatedCost: 1.5,
          unavailableCostRuns: 1,
          runCount: 3,
        },
      ],
      isLoading: false,
    });

    render(<TokenBudgetDashboard />);

    const cost = screen.getByTestId('agent-cost-strategist');
    expect(cost).toHaveTextContent('Settled $1.25');
    expect(cost).toHaveTextContent('Estimated $1.50');
    expect(cost).toHaveTextContent('1 unavailable');
    expect(cost).toHaveTextContent('3 runs');
  });
});

// ============================================================================
// Accounting scope labels
// ============================================================================

describe('TokenBudgetDashboard accounting scope', () => {
  function usageWith(overrides: Partial<TokenUsageDay>) {
    const base = buildTokenUsage();
    return {
      ...base,
      today: {
        ...base.today,
        settledCostUsd: base.today.costUsd,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
        unavailableCostRuns: 0,
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAll();
  });

  it('labels the headline total as a tracked app estimate, not invoice spend', () => {
    mockUseTokenUsage.mockReturnValue({ data: usageWith({}), isLoading: false });
    render(<TokenBudgetDashboard />);
    expect(screen.getByTestId('usage-accounting-label')).toHaveTextContent(/tracked app estimate/i);
  });

  it('defines what the token counts include so the number is interpretable', () => {
    mockUseTokenUsage.mockReturnValue({ data: usageWith({}), isLoading: false });
    render(<TokenBudgetDashboard />);
    const scope = screen.getByTestId('usage-accounting-scope');
    expect(scope).toHaveTextContent(/cached/i);
    expect(scope).toHaveTextContent(/tool/i);
    expect(scope).toHaveTextContent(/not a provider invoice/i);
  });

  it('shows settled and reserved separately — a reservation is not money already spent', () => {
    mockUseTokenUsage.mockReturnValue({
      data: usageWith({ costUsd: 5.25, settledCostUsd: 1.25, reservedCostUsd: 4.0 }),
      isLoading: false,
    });
    render(<TokenBudgetDashboard />);

    expect(screen.getByTestId('usage-settled')).toHaveTextContent('$1.25');
    expect(screen.getByTestId('usage-reserved')).toHaveTextContent('$4.00');
    expect(screen.getByTestId('usage-reserved')).toHaveTextContent(/reserved/i);
  });

  it('labels canonical receipt-derived chat costs as estimates, never settled invoice spend', () => {
    mockUseTokenUsage.mockReturnValue({
      data: usageWith({ costUsd: 0.75, settledCostUsd: 0, estimatedCostUsd: 0.75 }),
      isLoading: false,
    });
    render(<TokenBudgetDashboard />);

    expect(screen.getByTestId('usage-estimated')).toHaveTextContent('$0.75');
    expect(screen.getByTestId('usage-settled')).toHaveTextContent('$0.00');
  });

  it('omits the reserved figure entirely when nothing is in flight', () => {
    mockUseTokenUsage.mockReturnValue({ data: usageWith({ reservedCostUsd: 0 }), isLoading: false });
    render(<TokenBudgetDashboard />);
    expect(screen.queryByTestId('usage-reserved')).toBeNull();
  });

  it('reports runs whose cost is unavailable instead of folding them in as $0', () => {
    mockUseTokenUsage.mockReturnValue({ data: usageWith({ unavailableCostRuns: 3 }), isLoading: false });
    render(<TokenBudgetDashboard />);

    const unavailable = screen.getByTestId('usage-unavailable');
    expect(unavailable).toHaveTextContent('3');
    expect(unavailable).toHaveTextContent(/without cost data/i);
  });

  it('never renders an unknown cost as $0.00 — the headline reads as unavailable', () => {
    const base = buildTokenUsage();
    mockUseTokenUsage.mockReturnValue({
      data: {
        ...base,
        today: {
          ...base.today,
          costUsd: 0,
          settledCostUsd: 0,
          reservedCostUsd: 0,
          unavailableCostRuns: 2,
        },
      },
      isLoading: false,
    });
    render(<TokenBudgetDashboard />);

    expect(screen.getByTestId('usage-today-cost')).toHaveTextContent('—');
    expect(screen.getByTestId('usage-today-cost')).not.toHaveTextContent('$0.00');
  });

  it('renders a genuine zero as $0.00 when nothing was tracked at all', () => {
    const base = buildTokenUsage();
    mockUseTokenUsage.mockReturnValue({
      data: {
        ...base,
        today: {
          ...base.today,
          input: 0,
          output: 0,
          total: 0,
          costUsd: 0,
          settledCostUsd: 0,
          reservedCostUsd: 0,
          unavailableCostRuns: 0,
        },
      },
      isLoading: false,
    });
    render(<TokenBudgetDashboard />);
    expect(screen.getByTestId('usage-today-cost')).toHaveTextContent('$0.00');
  });

  it('links the accounting limitation so the reader can see what is not covered', () => {
    mockUseTokenUsage.mockReturnValue({ data: usageWith({}), isLoading: false });
    render(<TokenBudgetDashboard />);
    expect(screen.getByTestId('usage-limitation-link')).toHaveAttribute(
      'href',
      'https://github.com/radarist/radarist/blob/main/docs/LIMITATIONS.md#ai-usage-accounting'
    );
  });

  it('tolerates a legacy payload without the split fields', () => {
    mockUseTokenUsage.mockReturnValue({ data: buildTokenUsage(), isLoading: false });
    expect(() => render(<TokenBudgetDashboard />)).not.toThrow();
    expect(screen.getByTestId('usage-accounting-label')).toBeInTheDocument();
  });
});
