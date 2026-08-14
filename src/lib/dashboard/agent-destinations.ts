/**
 * @file lib/dashboard/agent-destinations.ts
 * @description Maps an `AgentType` to the in-app surface a user should
 * land on when they click a dashboard card produced by that agent.
 *
 * Both `NeedsAttentionPanel` and `AgentFeedPanel` used to dead-end:
 * NeedsAttention sent every `agent-pending` item to `/agents/runs` (a
 * generic list page) and AgentFeedPanel hardcoded every card to
 * `/triage/signals`. A LinkerAgent card going to Signals is plainly
 * misdirection — the actual proposals live in the Linker queue.
 *
 * This helper centralises the agent → surface mapping so both panels
 * stay in sync and adding a new agent type only requires editing one
 * place.
 */

import type { AgentType } from '@/lib/types';

const AGENT_DESTINATION: Record<AgentType, string> = {
  // Linker proposals live in the relations triage queue — that's where
  // the user can approve / reject the 200+ suggested actions.
  LinkerAgent: '/triage/relations',
  // Scout produces signals; the signals triage page is the canonical
  // review surface.
  ScoutAgent: '/triage/signals',
  // The "Insights" feed is where Monitor / Innovation surface their
  // proactive findings.
  MonitorAgent: '/triage/insights',
  InnovationAgent: '/triage/insights',
  // The remaining agents don't have a dedicated triage surface yet — the
  // run history is the most accurate destination so the user can at
  // least see what was done.
  EvaluationAgent: '/agents/runs',
  PortfolioAgent: '/agents/runs',
  PrototypeAgent: '/agents/runs',
};

/**
 * Returns the canonical in-app URL the user should be sent to when they
 * click a card produced by the given agent. Falls back to `/agents/runs`
 * for any future agent types not yet mapped here so dashboard clicks
 * never dead-end.
 */
export function getAgentDestination(agent: AgentType | string | undefined): string {
  if (!agent) return '/agents/runs';
  return AGENT_DESTINATION[agent as AgentType] ?? '/agents/runs';
}

/**
 * Returns the run-detail URL for one specific agent run so a dashboard card
 * opens the EXACT run the user clicked — not a generic per-agent triage list.
 *
 * This is the correct primary target for the "what happened" agent feed and for
 * failed-run attention items: the run detail page (`/agents/runs/[id]`) shows
 * that single run's action, status, and error regardless of agent type, so it
 * stays accurate even when the agent name is unknown (where `getAgentDestination`
 * would silently collapse to the generic list). Falls back to the run history
 * list when the id is missing so a click never dead-ends.
 */
export function getAgentRunDestination(runId: string | undefined): string {
  const id = runId?.trim();
  return id ? `/agents/runs/${encodeURIComponent(id)}` : '/agents/runs';
}
