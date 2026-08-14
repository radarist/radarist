/**
 * @file hooks/useAgentActivity.ts
 * @description TanStack Query hooks for the Activity page
 *
 * Fetches agent log entries and token usage data from the Activity API.
 *
 * Reads are gated on Firebase auth-state restoration via `useAuth()` — the
 * same pattern as `useProposedEntities`/`useInbox` (P-A4): without the gate,
 * the queries fire on mount before `onAuthStateChanged` restores the session,
 * `fetchWithAuth` ships with no Authorization header, and `/api/activity/*`
 * 401s (the /agents/runs console noise this guards against). Each hook
 * returns `isLoading: query.isPending` so consumers keep their skeleton up
 * while the auth gate holds instead of flashing an empty state (a disabled
 * query has `isLoading === false` but `isPending === true`).
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type { AgentRunUsageProvenance } from '@/lib/agent-run-usage';
import type {
  AgentRunKind,
  AgentRunProvider,
  AgentRunSweepStats,
  AgentRunToolSummaryEntry,
} from '@/lib/schemas/agent-run';

// ============================================================================
// TYPES
// ============================================================================

export type AgentLogEntryStatus = 'success' | 'failure' | 'skipped';

export interface AgentLogEntry {
  id: string;
  agentName: string;
  action: string;
  status: AgentLogEntryStatus;
  /** Explicit server classification; absent only on unnormalized legacy fixtures. */
  kind?: AgentRunKind;
  /** Interactive Assistant provider. Only meaningful for chat runs. */
  provider?: AgentRunProvider;
  /** Exact model reported by the provider. */
  model?: string;
  sweepId?: string;
  /** OBS-004: durable honest counters persisted on sweep summary runs. */
  sweepStats?: AgentRunSweepStats;
  /** Mission that produced this run — used to link the run to its published report. */
  missionId?: string;
  /** Absent when no usage was persisted for the run (legacy docs, terminal
   * missions whose usage never finalized) — renderers show "—", never a
   * fabricated 0 (ARUN-020). Server-recorded AgentRuns always carry it. */
  tokenUsage?: { input: number; output: number };
  /**
   * ARUN-020: how much of `tokenUsage` the provider actually reported. Absent on
   * legacy rows. `unreported` means the stored counters are a required-field
   * placeholder, not a measurement, and every surface must render "—".
   */
  tokenUsageProvenance?: AgentRunUsageProvenance;
  /** Estimated cost in USD. AI-029: genuinely absent when the run's model had
   * no rate-card entry — such a run is unknown-cost, not free, and ARUN-027
   * counts it as unavailable rather than summing it as 0. */
  costUsd?: number;
  /**
   * Receipt-derived chat costs are estimates; absent on historical settled
   * AgentRuns. `mixed` is used only by the client-side build Mission adapter
   * when its canonical BUILD-035 snapshot contains both authority buckets.
   */
  costState?: 'estimated' | 'settled' | 'mixed' | 'reserved' | 'maximum-exposure';
  /**
   * ARUN-027 — WHY no cost is stated. The two reasons are materially different
   * and must never collapse into one word: `unknown-pricing` means the spend is
   * recorded but the canonical rate card could not price it, while
   * `accounting-incomplete` means the ledger provably LOST receipts, so real
   * spend exists that nothing can account for. Only meaningful when `costUsd`
   * is absent.
   */
  costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
  duration: number;
  /** ARUN-008: duration is unknowable (infrastructure-failure fallback row). */
  durationUnknown?: boolean;
  errors?: string[];
  /**
   * ARUN-029: the run's stable machine-readable terminal failure code, mirroring
   * `Mission.failureCode`. Absent on successful runs and on failures with no
   * derivable code — in which case the surface must say a reason is unavailable
   * rather than invent one.
   */
  failureCode?: 'mcp-preflight-failed' | 'mcp-base-url-missing' | 'mcp-internal-key-missing';
  /** Bounded, redacted chat tool history (name/outcome/timing only). */
  toolSummary?: AgentRunToolSummaryEntry[];
  toolSummaryTruncated?: boolean;
  createdAt: string;
  /** True when this run's result was recovered from a mid-run checkpoint (Tier 1). */
  partial?: boolean;
  /** AI-042: why the run is partial. Absent on rows written before the field. */
  partialReason?: 'checkpoint-recovery' | 'tool-failures';
  /** Turn number of the last checkpoint before partial recovery. */
  partialCheckpointTurn?: number;
  /** Trail of Skill(...) invocations captured during the mission (Tier 2). */
  skillInvocations?: Array<{
    skill: string;
    args?: string;
    firedAt: string;
    turn?: number;
  }>;
  /** Deterministic quality verdict from Layer 1 evaluator. */
  qualityReport?: {
    evaluatedAt: string;
    overallScore: number;
    verdict: 'PASS' | 'REVISE' | 'FAIL';
    checks: Array<{
      name: string;
      pass: boolean;
      critical: boolean;
      detail: string;
    }>;
  };
  /**
   * REPORT-018 — the ONE governing verdict, composed from L1 and L2.
   *
   * Present only for missions evaluated after the composition step shipped; the
   * two raw receipts stay authoritative for their own layers.
   */
  qualityVerdict?: {
    verdict: 'PASS' | 'REVISE' | 'FAIL';
    ceiling: 'PASS' | 'REVISE' | 'FAIL';
    decidedBy: 'deterministic' | 'judge' | 'ceiling';
    criticalFailures: string[];
    disagreement?: { kind: 'judge-more-favourable' | 'judge-more-critical'; detail: string };
  };
  /** Layer 2 LLM-as-judge verdict. Runs after Layer 1; best-effort. */
  qualityJudgement?: {
    evaluatedAt: string;
    judgeModel: string;
    overallScore: number;
    verdict: 'PASS' | 'REVISE' | 'FAIL';
    dimensions: Array<{
      name: string;
      score: number;
      rationale: string;
    }>;
    costUsd?: number;
    note?: string;
  };
  /** Workspace files salvaged on timeout (Tier 3 Task 6). */
  attachments?: Array<{
    filename: string;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    content?: string;
    savedAt: string;
    salvaged?: boolean;
  }>;
  /** Mission chain membership (Superpower #2). */
  chainId?: string;
  chainStep?: number;
  chainTotalSteps?: number;
}

export interface TokenUsageDay {
  date: string;
  input: number;
  output: number;
  total: number;
  /** ARUN-027: the tracked app estimate — settled + reserved, excluding runs
   * with no cost data. Optional because legacy payloads predate the split. */
  costUsd?: number;
  /** Cost of runs that reached a terminal state with a recorded cost. */
  settledCostUsd?: number;
  /** Static-rate-card estimates, distinct from provider settlements/invoices. */
  estimatedCostUsd?: number;
  /** Accrued spend of in-flight builds — not final, and not money spent. */
  reservedCostUsd?: number;
  /** Runs carrying no cost measurement; counted, never summed as $0. */
  unavailableCostRuns?: number;
  /**
   * ARUN-020: runs whose TOKEN count is unknowable (no counters, or a provider
   * that reported none); counted, never summed as 0 tokens.
   */
  unavailableTokenRuns?: number;
}

export interface TokenUsageSummary {
  today: TokenUsageDay;
  thisWeek: TokenUsageDay[];
}

export interface AgentTokenBreakdown {
  agentName: string;
  model: string;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  totalCost: number;
  /** Optional on legacy API payloads; current server responses always include the split. */
  settledCost?: number;
  estimatedCost?: number;
  unavailableCostRuns?: number;
  /** ARUN-020: runs whose TOKEN count could not be proven; counted, never summed. */
  unavailableTokenRuns?: number;
  runCount: number;
}

interface AgentLogResponse {
  entries: AgentLogEntry[];
  degradedKinds: AgentRunKind[];
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

export const activityKeys = {
  all: ['activity'] as const,
  /**
   * UX-046: every activity key embeds the account uid so a user switch can
   * never serve another account's cached runs or token totals.
   * `AccountCacheBoundary` additionally purges the cache on auth transitions.
   */
  forUser: (uid: string) => [...activityKeys.all, uid] as const,
  log: (uid: string) => [...activityKeys.forUser(uid), 'log'] as const,
  tokens: (uid: string) => [...activityKeys.forUser(uid), 'tokens'] as const,
  tokensByAgent: (uid: string) => [...activityKeys.forUser(uid), 'tokens-by-agent'] as const,
  tokensByPeriod: (uid: string, period: string) => [...activityKeys.tokens(uid), period] as const,
};

/**
 * UX-046 visible-tab freshness contract for the activity surfaces. The
 * intervals are bounded (no tight polling), pause automatically while the
 * tab is hidden (refetchIntervalInBackground defaults to false), and focus
 * return refetches once stale. Runs refresh faster than token totals
 * because completed runs are the thing the operator is actively watching.
 */
const RUNS_REFRESH_INTERVAL_MS = 60 * 1000;
const TOKENS_REFRESH_INTERVAL_MS = 120 * 1000;

// ============================================================================
// FETCH FUNCTIONS
// ============================================================================

/**
 * Fetch agent log entries from the Activity API.
 */
async function fetchAgentLog(): Promise<AgentLogResponse> {
  const res = await fetchWithAuth('/api/activity/log');
  if (!res.ok) throw new Error(`Failed to fetch agent log: ${res.status}`);
  const data: unknown = await res.json();
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const knownKinds = new Set<AgentRunKind>(['chat', 'mission', 'sweep']);
  const degradedKinds = Array.isArray(raw.degradedKinds)
    ? raw.degradedKinds.filter((kind): kind is AgentRunKind => knownKinds.has(kind as AgentRunKind))
    : [];
  return {
    entries: Array.isArray(raw.entries) ? (raw.entries as AgentLogEntry[]) : [],
    degradedKinds: [...new Set(degradedKinds)],
  };
}

/**
 * Fetch token usage summary from the Activity API.
 */
async function fetchTokenUsage(): Promise<TokenUsageSummary> {
  const res = await fetchWithAuth('/api/activity/tokens');
  if (!res.ok) throw new Error(`Failed to fetch token usage: ${res.status}`);
  return res.json();
}

/**
 * Fetch per-agent token usage breakdown from the Activity API.
 */
async function fetchTokensByAgent(): Promise<AgentTokenBreakdown[]> {
  const res = await fetchWithAuth('/api/activity/tokens-by-agent');
  if (!res.ok) throw new Error(`Failed to fetch tokens by agent: ${res.status}`);
  const data = await res.json();
  return data.agents ?? [];
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * useAgentLog
 *
 * TanStack Query hook for fetching the full list of agent log entries.
 * Returns entries sorted by creation date (most recent first).
 *
 * @example
 * ```tsx
 * const { data: entries, isLoading, error } = useAgentLog()
 * ```
 */
export function useAgentLog() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: activityKeys.log(user?.uid ?? 'anonymous'),
    queryFn: fetchAgentLog,
    enabled: !loading && !!user,
    staleTime: 30 * 1000,
    refetchInterval: RUNS_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  // isPending, not isLoading — keep the skeleton up while the auth gate holds.
  return {
    ...query,
    data: query.data?.entries,
    degradedKinds: query.data?.degradedKinds ?? [],
    isLoading: query.isPending,
  };
}

/**
 * useTokenUsage
 *
 * TanStack Query hook for fetching token usage summary (today + this week).
 *
 * @example
 * ```tsx
 * const { data: tokenUsage, isLoading, error } = useTokenUsage()
 * ```
 */
export function useTokenUsage() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: activityKeys.tokens(user?.uid ?? 'anonymous'),
    queryFn: fetchTokenUsage,
    enabled: !loading && !!user,
    staleTime: 60 * 1000,
    refetchInterval: TOKENS_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  // isPending, not isLoading — keep the skeleton up while the auth gate holds.
  return { ...query, isLoading: query.isPending };
}

/**
 * useTokensByAgent
 *
 * TanStack Query hook for fetching per-agent token usage breakdown (past 7 days).
 *
 * @example
 * ```tsx
 * const { data: agents, isLoading } = useTokensByAgent()
 * ```
 */
export function useTokensByAgent() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: activityKeys.tokensByAgent(user?.uid ?? 'anonymous'),
    queryFn: fetchTokensByAgent,
    enabled: !loading && !!user,
    staleTime: 60 * 1000,
    refetchInterval: TOKENS_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  // isPending, not isLoading — keep the skeleton up while the auth gate holds.
  return { ...query, isLoading: query.isPending };
}
