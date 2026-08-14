/**
 * @file AgentProfilesViewer.test.tsx
 * @description Unit tests for the live-data Profiles tab.
 *
 * Tests cover:
 * - Cards render models, budgets, and MCP servers from /api/agents/profiles
 * - defense-minister is included
 * - env-overridden models are flagged
 * - Loading shows skeletons (no stale data flash), errors offer retry
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const mockUseAgentProfiles = jest.fn();
jest.mock('@/hooks/queries/useAgentProfiles', () => ({
  useAgentProfiles: (...args: unknown[]) => mockUseAgentProfiles(...args),
}));

import { AgentProfilesViewer } from '../AgentProfilesViewer';
import type { AgentProfilesResponse } from '@/hooks/queries/useAgentProfiles';

// ============================================================================
// Fixtures (mirror agent/agents/&#42;/config.yaml ground truth)
// ============================================================================

function buildProfilesResponse(): AgentProfilesResponse {
  return {
    profiles: [
      {
        name: 'scout',
        description: 'Discovers new signals',
        model: 'claude-sonnet-4-6',
        modelSource: 'config',
        maxTokens: 30000,
        maxToolCalls: 50,
        internalMcpServers: ['impulse-signals'],
        externalMcpServers: ['gemini-grounding', 'exa', 'firecrawl', 'playwright'],
      },
      {
        name: 'curator',
        description: 'Maintains data quality',
        model: 'claude-haiku-4-5',
        modelSource: 'config',
        maxTokens: 15000,
        maxToolCalls: 30,
        internalMcpServers: ['impulse-signals'],
        externalMcpServers: ['gemini-grounding', 'exa'],
      },
      {
        name: 'creator',
        description: 'Generates professional HTML reports',
        model: 'claude-opus-4-8',
        modelSource: 'config',
        maxTokens: 50000,
        maxToolCalls: 50,
        internalMcpServers: ['impulse-reports', 'impulse-research'],
        externalMcpServers: ['super-graph', 'gemini-image'],
      },
      {
        name: 'defense-minister',
        description: 'Data quality verifier',
        model: 'claude-haiku-4-5',
        modelSource: 'env',
        maxTokens: 15000,
        maxToolCalls: 30,
        internalMcpServers: ['impulse-entities', 'impulse-graph'],
        externalMcpServers: ['gemini-grounding'],
      },
    ],
    missionBudget: {
      maxCostUsd: 15.0,
      maxCostSource: 'default',
      tokenBudget: 50000,
      tokenBudgetEnforced: false,
      maxToolCalls: 100,
    },
  };
}

function mockSuccess(data: AgentProfilesResponse = buildProfilesResponse()) {
  mockUseAgentProfiles.mockReturnValue({
    data,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentProfilesViewer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSuccess();
  });

  it('renders a card per live profile, including defense-minister', () => {
    render(<AgentProfilesViewer />);

    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Curator')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByText('Defense Minister')).toBeInTheDocument();
  });

  it('shows the live models from config.yaml (not the stale snapshot)', () => {
    render(<AgentProfilesViewer />);

    // Audit bugs: curator was shown as 'gemini-2.5-flash', creator as 'claude-opus-4-6'.
    expect(screen.getAllByText('claude-haiku-4-5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(screen.queryByText('gemini-2.5-flash')).not.toBeInTheDocument();
    expect(screen.queryByText('claude-opus-4-6')).not.toBeInTheDocument();
  });

  it('labels the effective runtime limits and shows MCP servers', () => {
    render(<AgentProfilesViewer />);

    expect(screen.getByText('Effective: 50k token reference / 50 tool calls')).toBeInTheDocument();
    expect(screen.getByText('super-graph')).toBeInTheDocument();
    expect(screen.getByText('impulse-reports')).toBeInTheDocument();
  });

  it('flags env-overridden models', () => {
    render(<AgentProfilesViewer />);

    expect(screen.getByText('env override')).toBeInTheDocument();
  });

  it('shows skeletons while loading instead of stale data', () => {
    mockUseAgentProfiles.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });

    render(<AgentProfilesViewer />);

    expect(screen.queryByText('Scout')).not.toBeInTheDocument();
    expect(screen.queryByText(/claude-/)).not.toBeInTheDocument();
  });

  it('offers a retry when the profiles cannot be loaded', async () => {
    const refetch = jest.fn();
    mockUseAgentProfiles.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    const user = userEvent.setup();

    render(<AgentProfilesViewer />);

    expect(screen.getByText(/could not load agent profiles/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
