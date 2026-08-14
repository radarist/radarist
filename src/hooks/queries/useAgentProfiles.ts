/**
 * @file hooks/queries/useAgentProfiles.ts
 * @description TanStack Query hook for the live agent profiles + mission budget.
 *
 * Fetches /api/agents/profiles, which parses `agent/agents/<name>/config.yaml`
 * at request time (the same files the mission runtime loads) and reports the
 * live mission-control values from the mission runner. Consumed by the
 * settings Profiles tab, the Agent Config editor, and the Token Budget
 * dashboard so they display runtime truth instead of hardcoded snapshots.
 *
 * @created 2026-06-10
 */

import { useQuery } from '@tanstack/react-query';

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { agentKeys } from '@/lib/query-keys';

// ============================================================================
// TYPES (mirror of src/app/api/agents/profiles/route.ts response)
// ============================================================================

export interface AgentProfileSummary {
  /** Canonical agent name from config.yaml (e.g. 'defense-minister'). */
  name: string;
  description: string;
  /** Effective model — env override applied, matching the runtime resolution. */
  model: string;
  /** Where the effective model came from. */
  modelSource: 'config' | 'env';
  /** Lower of the global and profile token references; observational only. */
  maxTokens: number;
  /** Lower of the enforced global and profile tool-call caps. */
  maxToolCalls: number;
  internalMcpServers: string[];
  externalMcpServers: string[];
  maxTurns?: number;
  effort?: string;
}

export interface MissionBudgetInfo {
  /** Hard per-mission cost cap (USD) — the SDK aborts the mission above this. */
  maxCostUsd: number;
  maxCostSource: 'env' | 'default';
  /** Configured token reference used for telemetry; it does not stop execution. */
  tokenBudget: number;
  /** False until token-based cancellation is implemented. */
  tokenBudgetEnforced: false;
  /** Per-mission tool-call cap enforced by the mission budget hooks. */
  maxToolCalls: number;
}

export interface AgentProfilesResponse {
  profiles: AgentProfileSummary[];
  missionBudget: MissionBudgetInfo;
}

// ============================================================================
// FETCH + HOOK
// ============================================================================

async function fetchAgentProfiles(): Promise<AgentProfilesResponse> {
  const res = await fetchWithAuth('/api/agents/profiles');
  if (!res.ok) throw new Error(`Failed to fetch agent profiles: ${res.status}`);
  return res.json();
}

/**
 * useAgentProfiles
 *
 * Live agent profiles (models, budgets, MCP servers — parsed from the agent
 * config.yaml files at request time) plus the real per-mission budget caps.
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useAgentProfiles();
 * const profiles = data?.profiles ?? [];
 * ```
 */
export function useAgentProfiles() {
  return useQuery({
    queryKey: agentKeys.profiles(),
    queryFn: fetchAgentProfiles,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
