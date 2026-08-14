import { createAgentRunSchema, inferAgentRunKind, inferAgentRunProvider } from '../agent-run';
import {
  MAX_CHAT_TOOL_DURATION_MS,
  MAX_CHAT_TOOL_NAME_LENGTH,
  MAX_CHAT_TOOL_SUMMARY_ENTRIES,
} from '@/lib/chat-tool-summary';

const base = {
  userId: 'user-1',
  agentName: 'chat',
  action: 'Research quantum sensing',
  status: 'success' as const,
  tokenUsage: { input: 120, output: 40 },
  costUsd: 0.01,
  duration: 500,
};

describe('AgentRun chat persistence contract', () => {
  it('accepts explicit symmetric chat provider/model/tool fields', () => {
    const parsed = createAgentRunSchema.parse({
      ...base,
      kind: 'chat',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
      toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 12 }],
      toolSummaryTruncated: false,
    });

    expect(parsed).toMatchObject({
      kind: 'chat',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
      toolSummary: [{ name: 'searchEntities', status: 'success', durationMs: 12 }],
    });
  });

  it('rejects privacy-bearing fields inside a strict tool summary entry', () => {
    expect(() =>
      createAgentRunSchema.parse({
        ...base,
        toolSummary: [
          {
            name: 'dispatchBuildMission',
            status: 'success',
            durationMs: 10,
            args: { confirmationPhrase: 'CONFIRM SPEND $50 secret' },
            result: { documentContent: 'private' },
          },
        ],
      })
    ).toThrow();
  });

  it('rejects free-text tool names at the persistence boundary', () => {
    expect(
      createAgentRunSchema.safeParse({
        ...base,
        toolSummary: [{ name: 'searchEntities CONFIRM SPEND $50', status: 'success' }],
      }).success
    ).toBe(false);
  });

  it('hard-caps summary entries, strings, durations, and model names', () => {
    const validEntry = { name: 'webSearch', status: 'success' as const, durationMs: 10 };
    expect(
      createAgentRunSchema.safeParse({
        ...base,
        toolSummary: Array.from({ length: MAX_CHAT_TOOL_SUMMARY_ENTRIES + 1 }, () => validEntry),
      }).success
    ).toBe(false);
    expect(
      createAgentRunSchema.safeParse({
        ...base,
        toolSummary: [{ ...validEntry, name: 'x'.repeat(MAX_CHAT_TOOL_NAME_LENGTH + 1) }],
      }).success
    ).toBe(false);
    expect(
      createAgentRunSchema.safeParse({
        ...base,
        toolSummary: [{ ...validEntry, durationMs: MAX_CHAT_TOOL_DURATION_MS + 1 }],
      }).success
    ).toBe(false);
    expect(createAgentRunSchema.safeParse({ ...base, model: 'x'.repeat(201) }).success).toBe(false);
  });

  it('binds cost authority fields so contradictory accounting states cannot persist', () => {
    expect(createAgentRunSchema.safeParse({ ...base, costState: 'estimated' }).success).toBe(true);
    expect(
      createAgentRunSchema.safeParse({
        ...base,
        costState: 'estimated',
        costUnavailableReason: 'accounting-incomplete',
      }).success
    ).toBe(false);
    const { costUsd: _costUsd, ...withoutCost } = base;
    expect(createAgentRunSchema.safeParse({ ...withoutCost, costState: 'estimated' }).success).toBe(false);
    expect(
      createAgentRunSchema.safeParse({
        ...withoutCost,
        costUnavailableReason: 'unknown-pricing',
      }).success
    ).toBe(true);
  });
});

describe('AgentRun historical classification', () => {
  it('honors explicit persisted classifications', () => {
    expect(inferAgentRunKind({ kind: 'sweep', agentName: 'chat' })).toBe('sweep');
    expect(inferAgentRunProvider({ kind: 'chat', provider: 'gemini', model: 'claude-opus-4-8' })).toBe('gemini');
  });

  it('infers a legacy Claude chat only from an exact unowned chat row', () => {
    const legacy = { agentName: 'chat', model: 'claude-opus-4-8' };
    expect(inferAgentRunKind(legacy)).toBe('chat');
    expect(inferAgentRunProvider(legacy)).toBe('claude');
  });

  it('does not relabel missions, sweeps, or chat-like agent names', () => {
    expect(inferAgentRunKind({ agentName: 'chat', missionId: 'mission-1', model: 'claude-opus-4-8' })).toBe('mission');
    expect(
      inferAgentRunProvider({ agentName: 'chat', missionId: 'mission-1', model: 'claude-opus-4-8' })
    ).toBeUndefined();
    expect(inferAgentRunKind({ agentName: 'chat-helper', model: 'claude-opus-4-8' })).toBe('mission');
    expect(inferAgentRunKind({ agentName: 'scout', sweepId: 'sweep-1', model: 'gemini-3.5-pro' })).toBe('sweep');
    expect(inferAgentRunProvider({ agentName: 'scout', sweepId: 'sweep-1', model: 'gemini-3.5-pro' })).toBeUndefined();
  });
});

describe('AgentRun nullable nested mission-cost mirrors', () => {
  it('accepts nullable prelude and revision costs with canonical reasons', () => {
    const parsed = createAgentRunSchema.parse({
      ...base,
      costUsd: undefined,
      costUnavailableReason: 'accounting-incomplete',
      skillPrelude: [
        {
          skill: 'jtbd-framing',
          block: '<jtbd>result</jtbd>',
          costUsd: null,
          costUnavailableReason: 'unknown-pricing',
          durationMs: 100,
          firedAt: new Date().toISOString(),
          success: true,
        },
      ],
      revisionAttempts: [
        {
          attempt: 1,
          triggeredByVerdict: 'REVISE',
          failingChecks: ['evidence'],
          feedback: 'Add citations',
          costUsd: null,
          costUnavailableReason: 'accounting-incomplete',
          skillInvocations: [
            {
              skill: 'cite-ieee',
              firedAt: '2026-04-29T00:04:59.000Z',
              turn: 1,
            },
          ],
          durationMs: 250,
          revisedAt: new Date().toISOString(),
        },
      ],
    });

    expect(parsed.skillPrelude?.[0]?.costUsd).toBeNull();
    expect(parsed.revisionAttempts?.[0]?.costUnavailableReason).toBe('accounting-incomplete');
    expect(parsed.revisionAttempts?.[0]?.skillInvocations?.[0]?.skill).toBe('cite-ieee');
  });
});

describe('OBS-004 — sweepStats durable counters', () => {
  const stats = {
    gapsFound: 2,
    missionsSpawned: 1,
    usersProcessed: 1,
    observationsWritten: 3,
    watchedInsights: 0,
    narrativeInsights: 2,
    insightsTotal: 2,
    insightsStatus: 'ok' as const,
  };

  it('accepts and RETAINS sweepStats through parse (a stripped field is a lost counter)', () => {
    const parsed = createAgentRunSchema.parse({ ...base, agentName: 'sweep-cycle', sweepStats: stats });
    expect(parsed.sweepStats).toEqual(stats);
  });

  it('accepts the four honest insightsStatus outcomes and rejects anything else', () => {
    for (const insightsStatus of ['ok', 'quiet', 'failed', 'not-run'] as const) {
      expect(() => createAgentRunSchema.parse({ ...base, sweepStats: { ...stats, insightsStatus } })).not.toThrow();
    }
    expect(() => createAgentRunSchema.parse({ ...base, sweepStats: { ...stats, insightsStatus: 'zero' } })).toThrow();
  });

  it('rejects negative or fractional counters', () => {
    expect(() => createAgentRunSchema.parse({ ...base, sweepStats: { ...stats, narrativeInsights: -1 } })).toThrow();
    expect(() => createAgentRunSchema.parse({ ...base, sweepStats: { ...stats, insightsTotal: 1.5 } })).toThrow();
  });
});
