import { createBudgetHooks } from '../../src/hooks/budget';
import type { BudgetState } from '../../src/hooks/budget';

/** Local cast helper for PostToolUse results */
type PostToolUseResult = {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function createPreToolUseInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'mcp__impulse-entities__createCompany',
    tool_input: { name: 'Acme Corp' },
    tool_use_id: 'tu-001',
    ...overrides,
  };
}

function createPostToolUseInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'PostToolUse' as const,
    tool_name: 'mcp__impulse-entities__createCompany',
    tool_input: { name: 'Acme Corp' },
    tool_response: { id: 'company-123', success: true },
    tool_use_id: 'tu-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Budget Hooks', () => {
  describe('createBudgetHooks', () => {
    it('should return budgetState and hooks for PreToolUse and PostToolUse', () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 5);

      expect(budgetState).toBeDefined();
      expect(budgetState.maxTokens).toBe(10000);
      expect(budgetState.maxToolCalls).toBe(5);
      expect(budgetState.tokensUsed).toBe(0);
      expect(budgetState.toolCallCount).toBe(0);

      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
    });

    it('should have exactly one hook callback per event', () => {
      const { hooks } = createBudgetHooks(10000, 5);

      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(hooks.PostToolUse[0].hooks).toHaveLength(1);
    });
  });

  describe('PreToolUse hook — tool call counting', () => {
    it('should increment toolCallCount on each PreToolUse call', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PreToolUse[0].hooks[0];
      const signal = createAbortSignal();

      expect(budgetState.toolCallCount).toBe(0);

      await hookFn(createPreToolUseInput(), 'tu-001', { signal });
      expect(budgetState.toolCallCount).toBe(1);

      await hookFn(createPreToolUseInput({ tool_use_id: 'tu-002' }), 'tu-002', { signal });
      expect(budgetState.toolCallCount).toBe(2);

      await hookFn(createPreToolUseInput({ tool_use_id: 'tu-003' }), 'tu-003', { signal });
      expect(budgetState.toolCallCount).toBe(3);
    });

    it('should allow tool calls within budget', async () => {
      const { hooks } = createBudgetHooks(10000, 5);
      const hookFn = hooks.PreToolUse[0].hooks[0];
      const signal = createAbortSignal();

      for (let i = 0; i < 5; i++) {
        const result = await hookFn(createPreToolUseInput({ tool_use_id: `tu-${i}` }), `tu-${i}`, { signal });
        expect(result).toEqual({ continue: true });
      }
    });

    it('should block tool calls when maxToolCalls exceeded', async () => {
      const { hooks } = createBudgetHooks(10000, 3);
      const hookFn = hooks.PreToolUse[0].hooks[0];
      const signal = createAbortSignal();

      // Use up all 3 calls
      for (let i = 0; i < 3; i++) {
        const result = await hookFn(createPreToolUseInput({ tool_use_id: `tu-${i}` }), `tu-${i}`, { signal });
        expect(result).toEqual({ continue: true });
      }

      // 4th call should be denied
      const denied = await hookFn(createPreToolUseInput({ tool_use_id: 'tu-blocked' }), 'tu-blocked', { signal });

      expect(denied).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('budget exceeded'),
        },
      });
    });

    it('should include call counts in deny reason', async () => {
      const { hooks } = createBudgetHooks(10000, 2);
      const hookFn = hooks.PreToolUse[0].hooks[0];
      const signal = createAbortSignal();

      // Use all 2 calls
      await hookFn(createPreToolUseInput({ tool_use_id: 'tu-1' }), 'tu-1', { signal });
      await hookFn(createPreToolUseInput({ tool_use_id: 'tu-2' }), 'tu-2', { signal });

      // 3rd call denied
      const denied = await hookFn(createPreToolUseInput({ tool_use_id: 'tu-3' }), 'tu-3', { signal });

      const reason = (denied as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput
        .permissionDecisionReason;
      expect(reason).toContain('3/2');
    });

    it('should keep denying after budget is exceeded', async () => {
      const { hooks } = createBudgetHooks(10000, 1);
      const hookFn = hooks.PreToolUse[0].hooks[0];
      const signal = createAbortSignal();

      // Use the single call
      await hookFn(createPreToolUseInput({ tool_use_id: 'tu-1' }), 'tu-1', { signal });

      // Next two calls should both be denied
      for (let i = 2; i <= 3; i++) {
        const result = await hookFn(createPreToolUseInput({ tool_use_id: `tu-${i}` }), `tu-${i}`, { signal });
        expect(result).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
      }
    });

    it('observes reaching the token reference without denying a tool call', async () => {
      const { budgetState, hooks } = createBudgetHooks(500, 5);
      budgetState.updateCost(0.1, 5, 0.8, 500);

      // The token budget is OBSERVATIONAL, not enforced (MISSION-007; the
      // profiles route reports `tokenBudgetEnforced: false`). Reaching it must
      // change the telemetry and nothing else.
      expect(budgetState.tokensUsed).toBe(500);
      await expect(
        hooks.PreToolUse[0].hooks[0](createPreToolUseInput(), 'tu-after-token-reference', {
          signal: createAbortSignal(),
        })
      ).resolves.toEqual({ continue: true });
    });
  });

  describe('PostToolUse hook — token tracking', () => {
    it('should extract tokens_used from tool_response', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      const input = createPostToolUseInput({
        tool_response: { id: 'company-1', tokens_used: 500 },
      });

      const result = (await hookFn(input, 'tu-001', { signal })) as PostToolUseResult;
      expect(result.continue).toBe(true);
      expect(budgetState.tokensUsed).toBe(500);
    });

    it('should accumulate tokens across multiple calls', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      await hookFn(createPostToolUseInput({ tool_response: { tokens_used: 200 }, tool_use_id: 'tu-1' }), 'tu-1', {
        signal,
      });
      await hookFn(createPostToolUseInput({ tool_response: { tokens_used: 300 }, tool_use_id: 'tu-2' }), 'tu-2', {
        signal,
      });

      expect(budgetState.tokensUsed).toBe(500);
    });

    it('should ignore responses without tokens_used field', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      await hookFn(createPostToolUseInput({ tool_response: { id: 'no-tokens' } }), 'tu-001', { signal });

      expect(budgetState.tokensUsed).toBe(0);
    });

    it('should ignore non-object responses', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      await hookFn(createPostToolUseInput({ tool_response: 'plain string response' }), 'tu-001', { signal });

      expect(budgetState.tokensUsed).toBe(0);
    });

    it('should ignore null responses', async () => {
      const { budgetState, hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      await hookFn(createPostToolUseInput({ tool_response: null }), 'tu-001', { signal });

      expect(budgetState.tokensUsed).toBe(0);
    });

    it('should always return { continue: true }', async () => {
      const { hooks } = createBudgetHooks(10000, 10);
      const hookFn = hooks.PostToolUse[0].hooks[0];
      const signal = createAbortSignal();

      const result = (await hookFn(createPostToolUseInput(), 'tu-001', { signal })) as {
        continue: true;
        hookSpecificOutput?: { hookEventName: 'PostToolUse'; additionalContext: string };
      };
      expect(result.continue).toBe(true);
    });
  });

  describe('BudgetState', () => {
    // These tests used to assert two predicates — isTokenReferenceReached() and
    // isToolCallLimitReached() — that had ZERO callers anywhere in the codebase
    // (AUDIT-011). They are deleted. Asserting a predicate nothing consults tells
    // you nothing about what the runtime does; worse, exporting `…Reached()` on a
    // public BudgetState implied an enforcement that does not exist.
    //
    // The tests below now pin the things that are actually TRUE at runtime: the
    // counters the supervisor reads as telemetry, and the ONE limit that really
    // denies.
    describe('counters and enforcement', () => {
      it('tracks the tool-call counter while within the limit', async () => {
        const { budgetState, hooks } = createBudgetHooks(10000, 5);
        const signal = createAbortSignal();

        await hooks.PreToolUse[0].hooks[0](createPreToolUseInput(), 'tu-001', { signal });

        expect(budgetState.toolCallCount).toBe(1);
        expect(budgetState.tokensUsed).toBe(0);
      });

      it('DENIES the tool call once maxToolCalls is reached — the only enforced limit', async () => {
        const { budgetState, hooks } = createBudgetHooks(10000, 2);
        const signal = createAbortSignal();

        await hooks.PreToolUse[0].hooks[0](createPreToolUseInput({ tool_use_id: 'tu-1' }), 'tu-1', { signal });
        await hooks.PreToolUse[0].hooks[0](createPreToolUseInput({ tool_use_id: 'tu-2' }), 'tu-2', { signal });
        expect(budgetState.toolCallCount).toBe(2);

        const denied = await hooks.PreToolUse[0].hooks[0](createPreToolUseInput({ tool_use_id: 'tu-3' }), 'tu-3', {
          signal,
        });
        expect(denied).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
      });

      it('accumulates tokensUsed as telemetry, and does NOT deny on it', async () => {
        const { budgetState, hooks } = createBudgetHooks(500, 100);
        const signal = createAbortSignal();

        await hooks.PostToolUse[0].hooks[0](createPostToolUseInput({ tool_response: { tokens_used: 500 } }), 'tu-001', {
          signal,
        });
        expect(budgetState.tokensUsed).toBe(500);

        // Blowing straight through the token reference must still allow the call.
        await expect(
          hooks.PreToolUse[0].hooks[0](createPreToolUseInput({ tool_use_id: 'tu-002' }), 'tu-002', { signal })
        ).resolves.toEqual({ continue: true });
      });
    });

    describe('reset', () => {
      it('should clear all counters', async () => {
        const { budgetState, hooks } = createBudgetHooks(10000, 10);
        const signal = createAbortSignal();

        // Accumulate some usage
        await hooks.PreToolUse[0].hooks[0](createPreToolUseInput(), 'tu-001', { signal });
        await hooks.PostToolUse[0].hooks[0](createPostToolUseInput({ tool_response: { tokens_used: 500 } }), 'tu-001', {
          signal,
        });

        expect(budgetState.toolCallCount).toBe(1);
        expect(budgetState.tokensUsed).toBe(500);

        budgetState.reset();

        expect(budgetState.toolCallCount).toBe(0);
        expect(budgetState.tokensUsed).toBe(0);
      });

      it('should allow tool calls again after reset', async () => {
        const { budgetState, hooks } = createBudgetHooks(10000, 1);
        const hookFn = hooks.PreToolUse[0].hooks[0];
        const signal = createAbortSignal();

        // Exhaust the budget
        await hookFn(createPreToolUseInput({ tool_use_id: 'tu-1' }), 'tu-1', { signal });
        expect(budgetState.toolCallCount).toBe(1);

        // Deny
        const denied = await hookFn(createPreToolUseInput({ tool_use_id: 'tu-2' }), 'tu-2', { signal });
        expect(denied).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');

        // Reset and try again
        budgetState.reset();
        const allowed = await hookFn(createPreToolUseInput({ tool_use_id: 'tu-3' }), 'tu-3', { signal });
        expect(allowed).toEqual({ continue: true });
      });

      it('should preserve maxTokens and maxToolCalls after reset', () => {
        const { budgetState } = createBudgetHooks(5000, 25);

        budgetState.reset();

        expect(budgetState.maxTokens).toBe(5000);
        expect(budgetState.maxToolCalls).toBe(25);
      });
    });
  });

  describe('PostToolUse additionalContext', () => {
    it('should return budget context string in additionalContext', async () => {
      const { hooks, budgetState } = createBudgetHooks(50000, 100);
      const postHook = hooks.PostToolUse[0].hooks[0];
      budgetState.updateCost(1.5, 5.0, 0.8);

      const result = (await postHook(
        { hook_event_name: 'PostToolUse', tool_name: 'test_tool', tool_input: {}, tool_response: {}, tool_use_id: '1' },
        '1',
        { signal: new AbortController().signal }
      )) as PostToolUseResult;

      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toContain('BUDGET');
      expect(result.hookSpecificOutput!.additionalContext).toContain('$1.50');
    });

    it('should escalate tone at warn threshold', async () => {
      const { hooks, budgetState } = createBudgetHooks(50000, 100);
      const postHook = hooks.PostToolUse[0].hooks[0];
      budgetState.updateCost(4.25, 5.0, 0.8);

      const result = (await postHook(
        { hook_event_name: 'PostToolUse', tool_name: 'test_tool', tool_input: {}, tool_response: {}, tool_use_id: '1' },
        '1',
        { signal: new AbortController().signal }
      )) as PostToolUseResult;

      expect(result.hookSpecificOutput!.additionalContext).toContain('WARNING');
      expect(result.hookSpecificOutput!.additionalContext).toContain('Wrap up');
    });

    it('renders unavailable spend without numeric arithmetic or a false $0 subtotal', async () => {
      const { hooks, budgetState } = createBudgetHooks(50000, 100);
      const postHook = hooks.PostToolUse[0].hooks[0];
      budgetState.updateCost(null, 5.0, 0.8, 900, 'model price unavailable');

      const result = (await postHook(
        { hook_event_name: 'PostToolUse', tool_name: 'test_tool', tool_input: {}, tool_response: {}, tool_use_id: '1' },
        '1',
        { signal: new AbortController().signal }
      )) as PostToolUseResult;

      expect(budgetState.estimatedCostUsd).toBeNull();
      expect(budgetState.costUnavailableReason).toBe('model price unavailable');
      expect(result.hookSpecificOutput!.additionalContext).toContain('cost unavailable / $5.00 cap');
      expect(result.hookSpecificOutput!.additionalContext).not.toContain('$0.00 spent');
      expect(result.hookSpecificOutput!.additionalContext).not.toContain('NaN');
    });

    it('should track MCP errors and include in context', async () => {
      const { hooks, budgetState } = createBudgetHooks(50000, 100);
      const postHook = hooks.PostToolUse[0].hooks[0];
      budgetState.updateCost(1.0, 5.0, 0.8);

      // Simulate 3 errors from arxiv
      for (let i = 0; i < 3; i++) {
        await postHook(
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'mcp__arxiv__search',
            tool_input: {},
            tool_response: { error: 'connection refused' },
            tool_use_id: String(i),
          },
          String(i),
          { signal: new AbortController().signal }
        );
      }

      const result = (await postHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__arxiv__search',
          tool_input: {},
          tool_response: { error: 'connection refused' },
          tool_use_id: '4',
        },
        '4',
        { signal: new AbortController().signal }
      )) as PostToolUseResult;

      expect(result.hookSpecificOutput!.additionalContext).toContain('MCP STATUS');
      expect(result.hookSpecificOutput!.additionalContext).toContain('arxiv');
    });
  });

  // AUDIT-003 — the cost cap must have exactly one source of truth.
  // `maxCostUsd` was seeded with a hardcoded `5.0` here: a fourth copy of the
  // mission cost cap, stale against the real default of $15, presented to the
  // agent as fact in its [BUDGET] preamble. The supervisor supplies the real cap
  // via updateCost() on the first usage event — until then we do not know it,
  // and inventing a number is worse than omitting one.
  describe('[BUDGET] preamble — never advertises a cap it was not given', () => {
    const callPostHook = async (hooks: ReturnType<typeof createBudgetHooks>['hooks']) => {
      const postHook = hooks.PostToolUse[0].hooks[0];
      return (await postHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: {},
          tool_response: { ok: true },
          tool_use_id: '1',
        },
        '1',
        { signal: new AbortController().signal }
      )) as PostToolUseResult;
    };

    it('omits the cap before the supervisor has reported one', async () => {
      const { hooks } = createBudgetHooks(50000, 100);

      const result = await callPostHook(hooks);
      const context = result.hookSpecificOutput!.additionalContext as string;

      expect(context).toContain('[BUDGET: $0.00 spent');
      // The specific regression: a fabricated "/ $5.00" against a $15 cap.
      expect(context).not.toContain('$5.00');
      expect(context).not.toMatch(/\/\s*\$/);
    });

    it('reports the real cap once the supervisor supplies it', async () => {
      const { hooks, budgetState } = createBudgetHooks(50000, 100);

      budgetState.updateCost(3.0, 15.0, 0.8);
      const result = await callPostHook(hooks);
      const context = result.hookSpecificOutput!.additionalContext as string;

      expect(context).toContain('$3.00 / $15.00');
    });
  });

  describe('BudgetState.updateCost', () => {
    it('should update cost tracking fields', () => {
      const { budgetState } = createBudgetHooks(50000, 100);
      expect(budgetState.estimatedCostUsd).toBe(0);

      budgetState.updateCost(2.5, 10.0, 0.9);

      expect(budgetState.estimatedCostUsd).toBe(2.5);
      expect(budgetState.maxCostUsd).toBe(10.0);
      expect(budgetState.warnThreshold).toBe(0.9);
    });

    it('sets the authoritative tokensUsed when the 4th arg is provided (MISSION-001)', () => {
      const { budgetState } = createBudgetHooks(50000, 100);
      expect(budgetState.tokensUsed).toBe(0);

      budgetState.updateCost(2.5, 10.0, 0.9, 4200);

      expect(budgetState.tokensUsed).toBe(4200);
    });

    it('leaves tokensUsed untouched when the 4th arg is omitted (back-compat)', () => {
      const { budgetState } = createBudgetHooks(50000, 100);
      budgetState.updateCost(1.0, 5.0, 0.8);
      expect(budgetState.tokensUsed).toBe(0);
    });
  });
});
