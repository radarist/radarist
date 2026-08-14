// ---------------------------------------------------------------------------
// Budget Hook — tracks token/tool-call consumption and enforces tool-call limits
// ---------------------------------------------------------------------------

/**
 * Tracks budget consumption state.
 */
export interface BudgetState {
  tokensUsed: number;
  toolCallCount: number;
  maxTokens: number;
  maxToolCalls: number;
  /** Current estimated cost — null once any provider component is unpriceable. */
  estimatedCostUsd: number | null;
  /** Why the running total is unavailable. Set only while estimatedCostUsd is null. */
  costUnavailableReason?: string;
  /** Max cost for this mission */
  maxCostUsd: number;
  /** Warn threshold (0-1) */
  warnThreshold: number;
  /** Per-MCP-server error counts */
  mcpErrorCounts: Record<string, number>;
  reset(): void;
  /**
   * Called by the orchestrator loop after each assistant turn with the real
   * running spend. `tokensUsed`, when provided, is the authoritative cumulative
   * token count (parent + subagent turns from the SDK usage stream) and
   * overrides the PostToolUse hook's counter — which only ever sees the rare
   * `tokens_used` tool-response field, so without this it stays ~0 and every
   * live/timeout telemetry read under-reports.
   */
  updateCost(
    costUsd: number | null,
    maxCostUsd: number,
    warnThreshold: number,
    tokensUsed?: number,
    costUnavailableReason?: string
  ): void;
}

// NOTE: no PreToolUseInput shape here — the PreToolUse hook below is a pure
// tool-call counter and deliberately ignores its `_input` (unlike the
// PostToolUse hook, which casts to PostToolUseInput to read tool_response).
/**
 * Hook input shape for PostToolUse events.
 */
interface PostToolUseInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
}

type HookOptions = { signal: AbortSignal };

type PreToolUseHookFn = (
  input: unknown,
  toolUseId: string | undefined,
  options: HookOptions
) => Promise<PreToolUseResult>;

interface PostToolUseHookOutput {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

type PostToolUseHookFn = (
  input: unknown,
  toolUseId: string | undefined,
  options: HookOptions
) => Promise<PostToolUseHookOutput>;

interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

type PreToolUseResult = { continue: true } | PreToolUseDeny;

interface HookCallbackMatcher {
  hooks: Array<PreToolUseHookFn | PostToolUseHookFn>;
}

/**
 * Creates budget hooks that observe token usage and deny tool execution when
 * the tool-call cap is exceeded. The token threshold is not an execution cap.
 *
 * @param maxTokens - Token reference used for telemetry/exhaustion reporting only
 * @param maxToolCalls - Maximum number of tool calls before denying
 */
export function createBudgetHooks(
  maxTokens: number,
  maxToolCalls: number
): {
  budgetState: BudgetState;
  hooks: Record<string, HookCallbackMatcher[]>;
} {
  let tokensUsed = 0;
  let toolCallCount = 0;
  let estimatedCostUsd: number | null = 0;
  let costUnavailableReason: string | undefined;
  // Unknown until the supervisor's first updateCost() lands (AUDIT-003). This
  // was a hardcoded 5.0 — a FOURTH copy of the mission cost cap, stale against
  // the real default of $15, which the agent would have been shown as fact.
  // Don't guess the number: say nothing until the real one arrives.
  let maxCostUsd = 0;
  let warnThreshold = 0.8;
  const mcpErrorCounts: Record<string, number> = {};

  const budgetState: BudgetState = {
    get tokensUsed() {
      return tokensUsed;
    },
    get toolCallCount() {
      return toolCallCount;
    },
    maxTokens,
    maxToolCalls,
    get estimatedCostUsd() {
      return estimatedCostUsd;
    },
    get costUnavailableReason() {
      return costUnavailableReason;
    },
    get maxCostUsd() {
      return maxCostUsd;
    },
    get warnThreshold() {
      return warnThreshold;
    },
    get mcpErrorCounts() {
      return { ...mcpErrorCounts };
    },
    // NOTE: there were two predicates here — isTokenReferenceReached() and
    // isToolCallLimitReached() — with zero callers anywhere. Neither was ever
    // wired: the token budget is observational (see MISSION-007, and
    // `tokenBudgetEnforced: false` on the profiles route), and the tool-call
    // limit is enforced inline in the PreToolUse hook below. Exporting
    // `…Reached()` predicates on a public BudgetState implied an enforcement
    // that does not exist. Deleted rather than left as decoration (AUDIT-011).
    reset(): void {
      tokensUsed = 0;
      toolCallCount = 0;
    },
    updateCost(cost: number | null, max: number, warn: number, tokens?: number, unavailableReason?: string): void {
      estimatedCostUsd = cost;
      costUnavailableReason = cost === null ? unavailableReason ?? 'accounting unavailable' : undefined;
      maxCostUsd = max;
      warnThreshold = warn;
      if (typeof tokens === 'number') tokensUsed = tokens;
    },
  };

  const preToolUseHook: PreToolUseHookFn = async (
    _input: unknown,
    _toolUseId: string | undefined
  ): Promise<PreToolUseResult> => {
    toolCallCount++;

    if (toolCallCount > maxToolCalls) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Tool call budget exceeded (${toolCallCount}/${maxToolCalls} calls used)`,
        },
      };
    }

    return { continue: true };
  };

  const postToolUseHook: PostToolUseHookFn = async (
    input: unknown,
    _toolUseId: string | undefined
  ): Promise<PostToolUseHookOutput> => {
    // Extract token usage from tool_response if available.
    // The shape of tool_response varies; we do a best-effort check.
    const hookInput = input as PostToolUseInput;
    const response = hookInput.tool_response;

    if (response !== null && typeof response === 'object') {
      const resp = response as Record<string, unknown>;
      if (typeof resp['tokens_used'] === 'number') {
        tokensUsed += resp['tokens_used'];
      }
    }

    // Track MCP errors
    const toolName = hookInput.tool_name ?? '';
    const serverMatch = toolName.match(/^mcp__([^_]+)__/);
    if (serverMatch) {
      const serverName = serverMatch[1];
      const respStr = JSON.stringify(response).toLowerCase();
      if (respStr.includes('error') || respStr.includes('denied') || respStr.includes('failed')) {
        mcpErrorCounts[serverName] = (mcpErrorCounts[serverName] ?? 0) + 1;
      }
    }

    // Build additionalContext string
    const capKnown = maxCostUsd > 0;

    let context: string;
    if (estimatedCostUsd === null) {
      // A partial numeric subtotal would look authoritative and could cause the
      // agent to keep spending against a fictional remainder. Keep the real cap
      // visible, but do not perform arithmetic or call toFixed on the null total.
      context = capKnown
        ? `[BUDGET: cost unavailable / $${maxCostUsd.toFixed(2)} cap · ${toolCallCount} tool calls]`
        : `[BUDGET: cost unavailable · ${toolCallCount} tool calls]`;
    } else {
      const spent = estimatedCostUsd;
      const remaining = capKnown ? Math.round((1 - spent / maxCostUsd) * 100) : 100;
      const isWarning = capKnown && spent / maxCostUsd >= warnThreshold;
      if (isWarning) {
        context = `[BUDGET WARNING: $${spent.toFixed(2)} / $${maxCostUsd.toFixed(2)} — ${Math.round((spent / maxCostUsd) * 100)}% spent. Wrap up now.]`;
      } else if (capKnown) {
        context = `[BUDGET: $${spent.toFixed(2)} / $${maxCostUsd.toFixed(2)} spent · ${toolCallCount} tool calls · ${remaining}% remaining]`;
      } else {
        // Before the first usage event the supervisor has not told us the cap.
        // Report what we know and omit what we don't, rather than inventing it.
        context = `[BUDGET: $${spent.toFixed(2)} spent · ${toolCallCount} tool calls]`;
      }
    }

    // Append MCP errors
    const mcpWarnThreshold = 3;
    const failingServers = Object.entries(mcpErrorCounts)
      .filter(([, count]) => count >= mcpWarnThreshold)
      .map(([name, count]) => `${name} failing (${count} errors)`);
    if (failingServers.length > 0) {
      context += `\n[MCP STATUS: ${failingServers.join(', ')}. Treat as unavailable — use alternatives.]`;
    }

    return {
      continue: true as const,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse' as const,
        additionalContext: context,
      },
    };
  };

  return {
    budgetState,
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
      PostToolUse: [{ hooks: [postToolUseHook] }],
    },
  };
}
