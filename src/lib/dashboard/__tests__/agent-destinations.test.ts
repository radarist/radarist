/**
 * @file agent-destinations.test.ts
 * @description Locks the agent → in-app surface mapping used by both
 * NeedsAttentionPanel and AgentFeedPanel. Routing churn here would
 * silently dead-end dashboard cards otherwise.
 */

import { getAgentDestination, getAgentRunDestination } from '../agent-destinations';

describe('getAgentDestination', () => {
  it('routes LinkerAgent activities to the Linker triage queue', () => {
    // LinkerAgent activities surface "Suggested N actions" rows — the
    // user expects to land where they can approve / reject those
    // proposals, not on the generic /agents/runs list.
    expect(getAgentDestination('LinkerAgent')).toBe('/triage/relations');
  });

  it('routes ScoutAgent activities to the signals queue', () => {
    expect(getAgentDestination('ScoutAgent')).toBe('/triage/signals');
  });

  it('routes Monitor/Innovation agents to the insights feed', () => {
    expect(getAgentDestination('MonitorAgent')).toBe('/triage/insights');
    expect(getAgentDestination('InnovationAgent')).toBe('/triage/insights');
  });

  it('falls back to /agents/runs for agents without a dedicated surface', () => {
    expect(getAgentDestination('EvaluationAgent')).toBe('/agents/runs');
    expect(getAgentDestination('PortfolioAgent')).toBe('/agents/runs');
    expect(getAgentDestination('PrototypeAgent')).toBe('/agents/runs');
  });

  it('falls back to /agents/runs for unknown / undefined agents', () => {
    // Defensive default — a future agent type or a malformed activity
    // doc shouldn't produce a broken link from the dashboard.
    expect(getAgentDestination(undefined)).toBe('/agents/runs');
    expect(getAgentDestination('UnknownAgent')).toBe('/agents/runs');
  });
});

describe('getAgentRunDestination (UX-019)', () => {
  it('routes to the exact run detail page for a given run id', () => {
    // The feed and failed-run attention cards must open the RUN the user
    // clicked — its action, status, and error — not a generic per-agent list.
    expect(getAgentRunDestination('run-abc')).toBe('/agents/runs/run-abc');
  });

  it('routes by run id regardless of agent — so an unknown agent still opens its run', () => {
    // This is the whole point of the UX-019 change: `getAgentDestination`
    // collapses unmapped/unknown agents to the generic list, but the run
    // detail page is accurate for every agent type because it keys on the id.
    expect(getAgentRunDestination('run-from-unknown-agent')).toBe('/agents/runs/run-from-unknown-agent');
  });

  it('encodes ids that contain URL-significant characters', () => {
    expect(getAgentRunDestination('run/with space')).toBe('/agents/runs/run%2Fwith%20space');
  });

  it('falls back to the run history list when the id is missing or blank', () => {
    // Never dead-end on a malformed activity with no usable id.
    expect(getAgentRunDestination(undefined)).toBe('/agents/runs');
    expect(getAgentRunDestination('')).toBe('/agents/runs');
    expect(getAgentRunDestination('   ')).toBe('/agents/runs');
  });
});
