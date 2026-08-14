/**
 * @file AgentConfigEditor.test.tsx
 * @description Unit tests for the AgentConfigEditor.
 *
 * Tests cover:
 * - Agent runtime table renders read-only LIVE data from /api/agents/profiles
 *   (models, budgets, defense-minister included, truthful total budget)
 * - Mission controls distinguish enforced caps from the token reference (no
 *   fictional daily-limit / alert-threshold inputs)
 * - Profiles fetch error surfaces a retry affordance
 * - Sweep panel hydrates from the persisted system-config sweep slice
 * - Save atomically persists the master policy, Linker gate, and Impulse cap
 * - Save is disabled until a persisted sweep field changes
 * - Save failure surfaces an error toast
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// Mocks
// ============================================================================

// JSDOM doesn't implement ResizeObserver — Radix Slider/Switch use it via
// @radix-ui/react-use-size. Same stub pattern as RadarVisualization.test.tsx.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

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

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
const mockToastInfo = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
    info: (...args: unknown[]) => mockToastInfo(...args),
  },
}));

const mockGetSystemConfig = jest.fn();
const mockUpdateBackgroundAutomationConfig = jest.fn();
const mockResetSignalSources = jest.fn();
jest.mock('@/lib/system-config', () => ({
  getSystemConfig: (...args: unknown[]) => mockGetSystemConfig(...args),
  updateBackgroundAutomationConfig: (...args: unknown[]) => mockUpdateBackgroundAutomationConfig(...args),
  resetSignalSourcesToSupportedDefaults: (...args: unknown[]) => mockResetSignalSources(...args),
}));

const mockUseAgentProfiles = jest.fn();
jest.mock('@/hooks/queries/useAgentProfiles', () => ({
  useAgentProfiles: (...args: unknown[]) => mockUseAgentProfiles(...args),
}));

import { AgentConfigEditor } from '../AgentConfigEditor';
import type { AgentProfilesResponse } from '@/hooks/queries/useAgentProfiles';

// ============================================================================
// Test utilities
// ============================================================================

function buildConfig(sweep?: { enabled: boolean; maxActionsPerSweep: number }) {
  return {
    id: 'global',
    agentMode: {
      mode: 'copilot',
      autoActionThreshold: 90,
      autoAddTechnologies: false,
      autoUpdateMaturity: false,
      autoLinkRelationships: false,
      autoImportSignals: false,
    },
    signalDetection: {
      enabled: false,
      minRelevanceScore: 70,
      sources: { patents: false, papers: true, news: true, funding: false, github: true, trends: true },
    },
    linkerAgent: {
      enabled: false,
    },
    notifications: { email: false, dashboard: true },
    ...(sweep ? { sweep } : {}),
    updatedAt: Date.now(),
  };
}

/** Live-shaped profiles response mirroring agent/agents/&#42;/config.yaml. */
function buildProfilesResponse(): AgentProfilesResponse {
  const profile = (
    name: string,
    model: string,
    maxTokens: number,
    maxToolCalls: number
  ): AgentProfilesResponse['profiles'][number] => ({
    name,
    description: `${name} description`,
    model,
    modelSource: 'config',
    maxTokens,
    maxToolCalls,
    internalMcpServers: ['impulse-signals'],
    externalMcpServers: ['exa'],
  });
  return {
    profiles: [
      profile('scout', 'claude-sonnet-4-6', 30000, 50),
      profile('evaluator', 'claude-sonnet-4-6', 25000, 25),
      profile('linker', 'claude-sonnet-4-6', 20000, 25),
      profile('curator', 'claude-haiku-4-5', 15000, 30),
      profile('strategist', 'claude-opus-4-8', 30000, 20),
      profile('creator', 'claude-opus-4-8', 50000, 50),
      profile('defense-minister', 'claude-haiku-4-5', 15000, 30),
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

function mockProfilesSuccess(data: AgentProfilesResponse = buildProfilesResponse()) {
  mockUseAgentProfiles.mockReturnValue({
    data,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  });
}

function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentConfigEditor />
    </QueryClientProvider>
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentConfigEditor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSystemConfig.mockResolvedValue(buildConfig({ enabled: true, maxActionsPerSweep: 10 }));
    mockUpdateBackgroundAutomationConfig.mockResolvedValue(undefined);
    mockResetSignalSources.mockResolvedValue(undefined);
    mockProfilesSuccess();
  });

  it('renders runtime-owned values and schedules without false edit controls', async () => {
    renderEditor();

    expect(await screen.findByText('Defense Minister')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByText(/server-controlled/i)).toBeInTheDocument();
    expect(screen.getByText(/DISCOVERY_SWEEP_CRON/)).toBeInTheDocument();
  });

  it('renders the live agent rows from the profiles API, including defense-minister', async () => {
    renderEditor();

    // All 7 agents, with the runtime's real budgets — not the stale snapshot.
    expect(await screen.findByText('Defense Minister')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    // Creator's effective token/tool limits are text, not editable inputs.
    const creatorRuntime = screen.getByRole('group', { name: /creator runtime configuration/i });
    expect(within(creatorRuntime).getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(within(creatorRuntime).getByText('Token reference')).toBeInTheDocument();
    expect(within(creatorRuntime).getByText('50k tokens')).toBeInTheDocument();
    expect(within(creatorRuntime).getByText('50 calls')).toBeInTheDocument();
    expect(screen.getByText('7 configured agents')).toBeInTheDocument();
    expect(screen.queryByText(/total budget/i)).not.toBeInTheDocument();
  });

  it('shows the real per-mission cost controls instead of fictional budget inputs', async () => {
    renderEditor();

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText(/per-mission cost cap/i)).toBeInTheDocument();
    expect(screen.getByText('Configured token reference')).toBeInTheDocument();
    expect(screen.getByText(/observed for telemetry only; this does not stop a mission/i)).toBeInTheDocument();

    // The fictional daily-limit / cost-alert inputs are gone.
    expect(screen.queryByLabelText(/daily token limit/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cost alert threshold/i)).not.toBeInTheDocument();
  });

  it('flags env-overridden values from the profiles API', async () => {
    const data = buildProfilesResponse();
    data.profiles[3] = { ...data.profiles[3], model: 'claude-sonnet-4-6', modelSource: 'env' };
    data.missionBudget = { ...data.missionBudget, maxCostUsd: 7.5, maxCostSource: 'env' };
    mockProfilesSuccess(data);

    renderEditor();

    expect(await screen.findByText('$7.50')).toBeInTheDocument();
    expect(screen.getByText('env override')).toBeInTheDocument();
    expect(screen.getByText('env')).toBeInTheDocument();
  });

  it('offers a retry when the live profiles cannot be loaded', async () => {
    const refetch = jest.fn();
    mockUseAgentProfiles.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    const user = userEvent.setup();

    renderEditor();

    expect(await screen.findByText(/could not load the live agent configs/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('disables the sweep controls while the persisted config is loading', async () => {
    // Never-resolving promise keeps the system-config query in loading state.
    mockGetSystemConfig.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    renderEditor();

    const sweepSwitch = screen.getByRole('switch', { name: /run background automation/i });
    expect(sweepSwitch).toBeDisabled();

    // The one genuinely persisted slider is disabled until hydration.
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(1);
    for (const slider of sliders) {
      expect(slider).toHaveAttribute('data-disabled');
    }

    // Interacting with the disabled switch can never seed a draft from the
    // fallback defaults — Save stays disabled.
    await user.click(sweepSwitch);
    expect(screen.getByRole('button', { name: /save automation settings/i })).toBeDisabled();
  });

  it('seeds the sweep draft from the resolved persisted config, not the fallback defaults', async () => {
    // Persisted maxActionsPerSweep is 5 — different from the default of 10.
    // A draft created after load must carry the persisted value, so Save
    // can never silently overwrite it with the default.
    mockGetSystemConfig.mockResolvedValue(buildConfig({ enabled: true, maxActionsPerSweep: 5 }));
    const user = userEvent.setup();

    renderEditor();

    const sweepSwitch = screen.getByRole('switch', { name: /run background automation/i });
    await waitFor(() => expect(sweepSwitch).toBeEnabled());
    await waitFor(() => expect(sweepSwitch).toHaveAttribute('aria-checked', 'true'));

    await user.click(sweepSwitch); // enabled: true → false seeds the draft

    await user.click(screen.getByRole('button', { name: /save automation settings/i }));

    await waitFor(() =>
      expect(mockUpdateBackgroundAutomationConfig).toHaveBeenCalledWith(
        {
          enabled: false,
          maxActionsPerSweep: 5, // persisted value, NOT the default 10
        },
        false
      )
    );
  });

  it('hydrates the sweep panel from the persisted config', async () => {
    mockGetSystemConfig.mockResolvedValue(buildConfig({ enabled: false, maxActionsPerSweep: 5 }));

    renderEditor();

    const sweepSwitch = screen.getByRole('switch', { name: /run background automation/i });
    await waitFor(() => expect(sweepSwitch).toHaveAttribute('aria-checked', 'false'));
    await waitFor(() => expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '5'));
  });

  it('fails closed when the persisted config predates the master policy', async () => {
    mockGetSystemConfig.mockResolvedValue(buildConfig());

    renderEditor();

    const automationSwitch = screen.getByRole('switch', { name: /run background automation/i });
    await waitFor(() => expect(automationSwitch).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('disables Save until a persisted sweep field changes', async () => {
    renderEditor();

    const saveButton = screen.getByRole('button', { name: /save automation settings/i });
    expect(saveButton).toBeDisabled();
  });

  it('can restore the safe defaults from a persisted enabled policy', async () => {
    const user = userEvent.setup();
    renderEditor();

    const resetButton = screen.getByRole('button', { name: /reset to defaults/i });
    await waitFor(() => expect(resetButton).toBeEnabled());
    await user.click(resetButton);

    expect(screen.getByRole('switch', { name: /run background automation/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /save automation settings/i })).toBeEnabled();
  });

  it('persists sweep fields on save and shows an honest toast', async () => {
    const user = userEvent.setup();
    renderEditor();

    const sweepSwitch = screen.getByRole('switch', { name: /run background automation/i });
    await waitFor(() => expect(sweepSwitch).toHaveAttribute('aria-checked', 'true'));

    await user.click(sweepSwitch); // enabled: true → false

    const saveButton = screen.getByRole('button', { name: /save automation settings/i });
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() =>
      expect(mockUpdateBackgroundAutomationConfig).toHaveBeenCalledWith(
        {
          enabled: false,
          maxActionsPerSweep: 10,
        },
        false
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Background automation settings saved',
      expect.objectContaining({ description: expect.stringMatching(/next scheduled run/i) })
    );
  });

  it('can enable the Linker capability on a fresh config', async () => {
    const user = userEvent.setup();
    renderEditor();

    const linkerSwitch = screen.getByRole('switch', { name: /relationship linker/i });
    await waitFor(() => expect(linkerSwitch).toBeEnabled());
    expect(linkerSwitch).toHaveAttribute('aria-checked', 'false');

    await user.click(linkerSwitch);
    await user.click(screen.getByRole('button', { name: /save automation settings/i }));

    await waitFor(() =>
      expect(mockUpdateBackgroundAutomationConfig).toHaveBeenCalledWith({ enabled: true, maxActionsPerSweep: 10 }, true)
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows an error toast when save fails', async () => {
    mockUpdateBackgroundAutomationConfig.mockRejectedValue(new Error('Firestore down'));
    const user = userEvent.setup();
    renderEditor();

    const sweepSwitch = screen.getByRole('switch', { name: /run background automation/i });
    await waitFor(() => expect(sweepSwitch).toHaveAttribute('aria-checked', 'true'));
    await user.click(sweepSwitch);

    await user.click(screen.getByRole('button', { name: /save automation settings/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to save background automation settings'));
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // ── SETTINGS-003: signal-source persisted-vs-effective panel + guarded reset ──

  it('shows each source persisted-vs-effective state with reasons for unavailable ones', async () => {
    // buildConfig persists trends:true (unavailable) and github:true (available).
    renderEditor();

    const githubRow = await screen.findByRole('group', { name: /github signal source/i });
    expect(within(githubRow).getByText('Saved: Enabled')).toBeInTheDocument();
    expect(within(githubRow).getByText('Effective: Active')).toBeInTheDocument();

    // Patents is off in the config but is intrinsically unavailable → reason shown.
    const patentsRow = screen.getByRole('group', { name: /patents signal source/i });
    expect(within(patentsRow).getByText('Unavailable')).toBeInTheDocument();
    expect(within(patentsRow).getByText(/retired/i)).toBeInTheDocument();

    // Trends is persisted enabled but unavailable — the honest effective state.
    const trendsRow = screen.getByRole('group', { name: /trends signal source/i });
    expect(within(trendsRow).getByText('Saved: Enabled')).toBeInTheDocument();
    expect(within(trendsRow).getByText('Unavailable')).toBeInTheDocument();
  });

  it('warns that an enabled-but-unavailable source will not surface under automation', async () => {
    renderEditor();
    // trends:true in buildConfig is enabled-but-unavailable → the guard warning shows.
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot produce signals/i);
  });

  it('does NOT warn when every enabled source is available', async () => {
    mockGetSystemConfig.mockResolvedValue({
      ...buildConfig({ enabled: true, maxActionsPerSweep: 10 }),
      signalDetection: {
        enabled: false,
        minRelevanceScore: 50,
        sources: { patents: false, papers: true, news: true, funding: false, github: true, trends: false },
      },
    });
    renderEditor();
    await screen.findByRole('group', { name: /github signal source/i });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('runs the guarded reset and refetches the source state', async () => {
    const user = userEvent.setup();
    renderEditor();

    const resetButton = await screen.findByRole('button', { name: /reset signal sources to supported defaults/i });
    await waitFor(() => expect(mockGetSystemConfig).toHaveBeenCalled());
    const callsBefore = mockGetSystemConfig.mock.calls.length;

    await user.click(resetButton);

    await waitFor(() => expect(mockResetSignalSources).toHaveBeenCalledTimes(1));
    // Reset refetches the persisted source map so the panel reflects the new state.
    await waitFor(() => expect(mockGetSystemConfig.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Signal sources reset to supported defaults',
      expect.objectContaining({ description: expect.stringMatching(/patents, funding, trends/i) })
    );
  });

  it('surfaces an error toast when the guarded reset fails', async () => {
    mockResetSignalSources.mockRejectedValue(new Error('Firestore down'));
    const user = userEvent.setup();
    renderEditor();

    const resetButton = await screen.findByRole('button', { name: /reset signal sources to supported defaults/i });
    await user.click(resetButton);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to reset signal sources'));
  });

  it('shows a retryable error instead of an indefinite skeleton when source state cannot load', async () => {
    mockGetSystemConfig.mockRejectedValue(new Error('Firestore unavailable'));
    const user = userEvent.setup();
    renderEditor();

    const error = await screen.findByRole('alert', { name: /signal sources unavailable/i });
    expect(within(error).getByText(/could not load signal source state/i)).toBeInTheDocument();
    const retry = within(error).getByRole('button', { name: /retry loading signal sources/i });
    const callsBeforeRetry = mockGetSystemConfig.mock.calls.length;

    await user.click(retry);

    await waitFor(() => expect(mockGetSystemConfig.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
    expect(screen.getByRole('button', { name: /reset signal sources to supported defaults/i })).toBeDisabled();
  });
});
