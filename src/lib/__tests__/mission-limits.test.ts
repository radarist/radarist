import {
  DEFAULT_MISSION_LIMITS,
  describeMissionEnvelopeMismatch,
  resolveAgentMissionCostEnvelope,
  resolveAgentMissionExecutionEnvelope,
  resolveEffectiveAgentMissionLimits,
  resolveMissionLimits,
} from '../mission-limits';

describe('resolveAgentMissionCostEnvelope', () => {
  it('accounts for every paid phase in the default authorization amount', () => {
    expect(resolveAgentMissionCostEnvelope({})).toEqual({
      orchestratorMaxCostUsd: 15,
      revisionMaxCostUsd: 12,
      preludeMaxCostUsd: 2,
      auxiliaryMaxCostUsd: 2,
      totalMaxCostUsd: 31,
    });
  });

  it('uses the same clamped revision and prelude configuration as execution', () => {
    expect(
      resolveAgentMissionCostEnvelope({
        MISSION_MAX_COST_USD: '20',
        REVISION_MAX_COST_USD: '50',
        PRELUDE_MAX_TOTAL_COST_USD: '3.25',
      })
    ).toEqual({
      orchestratorMaxCostUsd: 20,
      revisionMaxCostUsd: 20,
      preludeMaxCostUsd: 3.25,
      auxiliaryMaxCostUsd: 2,
      totalMaxCostUsd: 45.25,
    });
  });

  it('does not add a phantom cent when decimal components sum to an exact cent', () => {
    expect(
      resolveAgentMissionCostEnvelope({
        MISSION_MAX_COST_USD: '23',
      }).totalMaxCostUsd
    ).toBe(45.4);
  });

  it('rounds genuine sub-cent components upward in the authorized envelope', () => {
    expect(
      resolveAgentMissionCostEnvelope({
        MISSION_MAX_COST_USD: '10.001',
        REVISION_MAX_COST_USD: '1.001',
        PRELUDE_MAX_TOTAL_COST_USD: '1.001',
      }).totalMaxCostUsd
    ).toBe(14.03);
  });

  it.each(['-2', 'NaN', 'Infinity', 'invalid'])('falls back safely for an invalid prelude ceiling: %s', (value) => {
    expect(resolveAgentMissionCostEnvelope({ PRELUDE_MAX_TOTAL_COST_USD: value }).preludeMaxCostUsd).toBe(2);
  });

  it('honors an explicit zero revision allocation instead of restoring the default', () => {
    expect(
      resolveAgentMissionCostEnvelope({
        MISSION_MAX_COST_USD: '13',
        REVISION_MAX_COST_USD: '0',
      })
    ).toEqual({
      orchestratorMaxCostUsd: 13,
      revisionMaxCostUsd: 0,
      preludeMaxCostUsd: 2,
      auxiliaryMaxCostUsd: 2,
      totalMaxCostUsd: 17,
    });
  });

  it('honors an explicit zero prelude allocation instead of restoring the default', () => {
    expect(
      resolveAgentMissionCostEnvelope({
        MISSION_MAX_COST_USD: '13',
        REVISION_MAX_COST_USD: '0.01',
        PRELUDE_MAX_TOTAL_COST_USD: '0',
      })
    ).toEqual({
      orchestratorMaxCostUsd: 13,
      revisionMaxCostUsd: 0.01,
      preludeMaxCostUsd: 0,
      auxiliaryMaxCostUsd: 2,
      totalMaxCostUsd: 15.01,
    });
  });

  it.each(['-0.01', 'NaN', 'invalid'])(
    'still falls back for an invalid (non-zero) revision allocation: %s',
    (value) => {
      expect(
        resolveAgentMissionCostEnvelope({
          MISSION_MAX_COST_USD: '10',
          REVISION_MAX_COST_USD: value,
        }).revisionMaxCostUsd
      ).toBe(8);
    }
  );
});

describe('resolveAgentMissionExecutionEnvelope', () => {
  it('resolves the complete COORD-011 authorized allocation from the dispatch environment', () => {
    expect(
      resolveAgentMissionExecutionEnvelope(
        {
          MISSION_MAX_COST_USD: '13',
          REVISION_MAX_COST_USD: '0.01',
          PRELUDE_MAX_TOTAL_COST_USD: '2',
          MISSION_MAX_TOOL_CALLS: '120',
          MISSION_TIMEOUT_MINUTES: '90',
        },
        { requestedModel: 'claude-opus-5' }
      )
    ).toEqual({
      orchestratorMaxCostUsd: 13,
      revisionMaxCostUsd: 0.01,
      preludeMaxCostUsd: 2,
      auxiliaryMaxCostUsd: 2,
      totalMaxCostUsd: 17.01,
      maxToolCalls: 120,
      timeoutMinutes: 90,
      requestedModel: 'claude-opus-5',
    });
  });

  it('uses secure defaults for tool calls and timeout when the environment is silent', () => {
    const envelope = resolveAgentMissionExecutionEnvelope({});
    expect(envelope.maxToolCalls).toBe(100);
    expect(envelope.timeoutMinutes).toBe(45);
    expect(envelope.requestedModel).toBeUndefined();
    expect(envelope.authorizedFallbackModel).toBeUndefined();
  });

  it('clamps the timeout to the 120-minute platform ceiling', () => {
    expect(resolveAgentMissionExecutionEnvelope({ MISSION_TIMEOUT_MINUTES: '300' }).timeoutMinutes).toBe(120);
  });

  it.each(['0', '-5', 'NaN', 'ninety', ''])('falls back to the default timeout for an invalid value: %s', (value) => {
    expect(resolveAgentMissionExecutionEnvelope({ MISSION_TIMEOUT_MINUTES: value }).timeoutMinutes).toBe(45);
  });

  it('narrows the tool-call cap with a valid agent-profile budget instead of freezing the env default', () => {
    expect(resolveAgentMissionExecutionEnvelope({}, { profileMaxToolCalls: 20 }).maxToolCalls).toBe(20);
  });

  it('keeps the stricter environment tool-call cap when the profile is looser', () => {
    expect(
      resolveAgentMissionExecutionEnvelope({ MISSION_MAX_TOOL_CALLS: '40' }, { profileMaxToolCalls: 120 }).maxToolCalls
    ).toBe(40);
  });

  it('prefers a valid agent-profile timeout over the environment default', () => {
    expect(
      resolveAgentMissionExecutionEnvelope({ MISSION_TIMEOUT_MINUTES: '30' }, { profileTimeoutMinutes: 90 })
        .timeoutMinutes
    ).toBe(90);
  });

  it('clamps an oversized profile timeout to the platform ceiling', () => {
    expect(resolveAgentMissionExecutionEnvelope({}, { profileTimeoutMinutes: 300 }).timeoutMinutes).toBe(120);
  });

  it.each([0, -5, 1.5, 'ninety', Number.NaN])(
    'ignores an invalid profile timeout and tool-call budget: %p',
    (value) => {
      const envelope = resolveAgentMissionExecutionEnvelope(
        {},
        { profileTimeoutMinutes: value, profileMaxToolCalls: value }
      );
      expect(envelope.timeoutMinutes).toBe(45);
      expect(envelope.maxToolCalls).toBe(100);
    }
  );

  it('records an explicitly authorized fallback model when provided', () => {
    expect(
      resolveAgentMissionExecutionEnvelope(
        {},
        { requestedModel: 'claude-opus-5', authorizedFallbackModel: 'claude-sonnet-5' }
      ).authorizedFallbackModel
    ).toBe('claude-sonnet-5');
  });

  it('ignores blank model identifiers instead of persisting empty strings', () => {
    const envelope = resolveAgentMissionExecutionEnvelope({}, { requestedModel: '  ', authorizedFallbackModel: '' });
    expect(envelope.requestedModel).toBeUndefined();
    expect(envelope.authorizedFallbackModel).toBeUndefined();
  });
});

describe('describeMissionEnvelopeMismatch', () => {
  const confirmed = {
    orchestratorMaxCostUsd: 13,
    revisionMaxCostUsd: 0.01,
    preludeMaxCostUsd: 2,
    auxiliaryMaxCostUsd: 2,
    totalMaxCostUsd: 17.01,
    maxToolCalls: 120,
    timeoutMinutes: 90,
    requestedModel: 'claude-opus-5',
  };

  it('reports nothing for an identical effective envelope', () => {
    expect(describeMissionEnvelopeMismatch(confirmed, { ...confirmed })).toEqual([]);
  });

  it('names every differing component even when the totals agree', () => {
    const mismatches = describeMissionEnvelopeMismatch(confirmed, {
      ...confirmed,
      orchestratorMaxCostUsd: 11.01,
      revisionMaxCostUsd: 2,
      totalMaxCostUsd: 17.01,
    });
    expect(mismatches).toEqual([
      expect.stringContaining('orchestratorMaxCostUsd'),
      expect.stringContaining('revisionMaxCostUsd'),
    ]);
  });

  it('treats sub-cent float noise as equal', () => {
    expect(
      describeMissionEnvelopeMismatch(confirmed, {
        ...confirmed,
        totalMaxCostUsd: 17.009999999999998,
      })
    ).toEqual([]);
  });

  it('names tool-call, timeout, and model divergence', () => {
    const mismatches = describeMissionEnvelopeMismatch(confirmed, {
      ...confirmed,
      maxToolCalls: 100,
      timeoutMinutes: 45,
      requestedModel: 'claude-opus-4-8',
    });
    expect(mismatches).toEqual([
      expect.stringContaining('maxToolCalls'),
      expect.stringContaining('timeoutMinutes'),
      expect.stringContaining('requestedModel'),
    ]);
  });
});

describe('resolveMissionLimits', () => {
  it('uses secure defaults when mission limits are absent', () => {
    expect(resolveMissionLimits({})).toEqual({
      ...DEFAULT_MISSION_LIMITS,
      maxCostSource: 'default',
      invalidEnvironmentVariables: [],
    });
  });

  it('accepts valid legacy mission limits', () => {
    expect(
      resolveMissionLimits({
        MISSION_MAX_COST_USD: '7.50',
        MISSION_TOKEN_BUDGET: '80000',
        MISSION_MAX_TOOL_CALLS: '40',
      })
    ).toEqual({
      maxCostUsd: 7.5,
      maxCostSource: 'env',
      tokenBudget: 80_000,
      maxToolCalls: 40,
      warnThreshold: 0.8,
      invalidEnvironmentVariables: [],
    });
  });

  it('accepts the documented IMPULSE aliases', () => {
    expect(
      resolveMissionLimits({
        IMPULSE_MISSION_MAX_COST_USD: '9.25',
        IMPULSE_MISSION_TOKEN_BUDGET: '60000',
        IMPULSE_MISSION_MAX_TOOL_CALLS: '75',
      })
    ).toEqual({
      maxCostUsd: 9.25,
      maxCostSource: 'env',
      tokenBudget: 60_000,
      maxToolCalls: 75,
      warnThreshold: 0.8,
      invalidEnvironmentVariables: [],
    });
  });

  it.each([
    ['not-a-number', '-1', 'NaN'],
    ['Infinity', 'Infinity', 'Infinity'],
    ['-Infinity', '-Infinity', '-Infinity'],
    ['0', '0', '0'],
    ['-2.5', '-100', '-4'],
    ['', '', ''],
    ['7.5usd', '50000tokens', '100calls'],
  ])('rejects invalid legacy values (%s, %s, %s)', (maxCostUsd, tokenBudget, maxToolCalls) => {
    expect(
      resolveMissionLimits({
        MISSION_MAX_COST_USD: maxCostUsd,
        MISSION_TOKEN_BUDGET: tokenBudget,
        MISSION_MAX_TOOL_CALLS: maxToolCalls,
      })
    ).toEqual({
      ...DEFAULT_MISSION_LIMITS,
      maxCostSource: 'default',
      invalidEnvironmentVariables: ['MISSION_MAX_COST_USD', 'MISSION_TOKEN_BUDGET', 'MISSION_MAX_TOOL_CALLS'],
    });
  });

  it('rejects fractional and unsafe integer budgets', () => {
    const resolved = resolveMissionLimits({
      MISSION_TOKEN_BUDGET: '100.5',
      MISSION_MAX_TOOL_CALLS: String(Number.MAX_SAFE_INTEGER + 1),
    });

    expect(resolved.tokenBudget).toBe(DEFAULT_MISSION_LIMITS.tokenBudget);
    expect(resolved.maxToolCalls).toBe(DEFAULT_MISSION_LIMITS.maxToolCalls);
    expect(resolved.invalidEnvironmentVariables).toEqual(['MISSION_TOKEN_BUDGET', 'MISSION_MAX_TOOL_CALLS']);
  });

  it('keeps legacy-key precedence and does not mask an invalid primary with an alias', () => {
    expect(
      resolveMissionLimits({
        MISSION_MAX_COST_USD: '-1',
        IMPULSE_MISSION_MAX_COST_USD: '4',
        MISSION_TOKEN_BUDGET: '25000',
        IMPULSE_MISSION_TOKEN_BUDGET: '70000',
        MISSION_MAX_TOOL_CALLS: '25',
        IMPULSE_MISSION_MAX_TOOL_CALLS: '80',
      })
    ).toEqual({
      maxCostUsd: DEFAULT_MISSION_LIMITS.maxCostUsd,
      maxCostSource: 'default',
      tokenBudget: 25_000,
      maxToolCalls: 25,
      warnThreshold: 0.8,
      invalidEnvironmentVariables: ['MISSION_MAX_COST_USD'],
    });
  });

  it.each(['0', '-0.1', '1.01', 'NaN', 'Infinity', '80%'])(
    'rejects an invalid mission warning threshold: %s',
    (warnThreshold) => {
      const resolved = resolveMissionLimits({ MISSION_WARN_THRESHOLD: warnThreshold });

      expect(resolved.warnThreshold).toBe(DEFAULT_MISSION_LIMITS.warnThreshold);
      expect(resolved.invalidEnvironmentVariables).toEqual(['MISSION_WARN_THRESHOLD']);
    }
  );

  it('accepts warning thresholds in the (0, 1] interval and its alias', () => {
    expect(resolveMissionLimits({ MISSION_WARN_THRESHOLD: '0.25' }).warnThreshold).toBe(0.25);
    expect(resolveMissionLimits({ IMPULSE_MISSION_WARN_THRESHOLD: '1' }).warnThreshold).toBe(1);
  });
});

describe('resolveEffectiveAgentMissionLimits', () => {
  it('uses the lower profile values as active per-agent limits', () => {
    expect(
      resolveEffectiveAgentMissionLimits(
        { tokenBudget: 50_000, maxToolCalls: 100 },
        { max_tokens: 20_000, max_tool_calls: 30 }
      )
    ).toEqual({ tokenBudget: 20_000, maxToolCalls: 30 });
  });

  it('keeps stricter global limits', () => {
    expect(
      resolveEffectiveAgentMissionLimits(
        { tokenBudget: 50_000, maxToolCalls: 40 },
        { max_tokens: 100_000, max_tool_calls: 80 }
      )
    ).toEqual({ tokenBudget: 50_000, maxToolCalls: 40 });
  });

  it.each([
    undefined,
    {},
    { max_tokens: 0, max_tool_calls: -1 },
    { max_tokens: Infinity, max_tool_calls: 1.5 },
    { max_tokens: '20000', max_tool_calls: '30' },
  ])('falls back to global limits for an invalid or missing profile budget: %p', (profileBudget) => {
    expect(resolveEffectiveAgentMissionLimits({ tokenBudget: 50_000, maxToolCalls: 100 }, profileBudget)).toEqual({
      tokenBudget: 50_000,
      maxToolCalls: 100,
    });
  });

  it('validates profile fields independently', () => {
    expect(
      resolveEffectiveAgentMissionLimits(
        { tokenBudget: 50_000, maxToolCalls: 100 },
        { max_tokens: 'invalid', max_tool_calls: 25 }
      )
    ).toEqual({ tokenBudget: 50_000, maxToolCalls: 25 });
  });

  it('rejects invalid IMPULSE aliases with secure defaults', () => {
    const resolved = resolveMissionLimits({
      IMPULSE_MISSION_MAX_COST_USD: '-5',
      IMPULSE_MISSION_TOKEN_BUDGET: 'Infinity',
      IMPULSE_MISSION_MAX_TOOL_CALLS: '1.5',
    });

    expect(resolved).toEqual({
      ...DEFAULT_MISSION_LIMITS,
      maxCostSource: 'default',
      invalidEnvironmentVariables: [
        'IMPULSE_MISSION_MAX_COST_USD',
        'IMPULSE_MISSION_TOKEN_BUDGET',
        'IMPULSE_MISSION_MAX_TOOL_CALLS',
      ],
    });
  });
});
