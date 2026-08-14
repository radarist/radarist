import {
  MAX_CHAT_TOOL_DURATION_MS,
  MAX_CHAT_TOOL_NAME_LENGTH,
  MAX_CHAT_TOOL_SUMMARY_ENTRIES,
  summarizeChatToolCalls,
} from '../chat-tool-summary';

describe('summarizeChatToolCalls', () => {
  it('accepts Gemini trace and Claude executor result shapes', () => {
    expect(
      summarizeChatToolCalls([
        { name: 'searchEntities', success: true, durationMs: 17 },
        { name: 'createRelation', result: { success: false }, duration: 31 },
      ])
    ).toEqual({
      toolSummary: [
        { name: 'searchEntities', status: 'success', durationMs: 17 },
        { name: 'createRelation', status: 'failure', durationMs: 31 },
      ],
      toolSummaryTruncated: false,
    });
  });

  it('copies no arguments, results, prompts, document content, or confirmation phrases', () => {
    const summary = summarizeChatToolCalls([
      {
        name: 'dispatchBuildMission',
        args: { confirmationPhrase: 'CONFIRM SPEND $50 secret-session-token', prompt: 'private prompt' },
        result: {
          success: true,
          data: { documentContent: 'private document body', apiKey: 'secret-api-key' },
        },
        prompt: 'another private prompt',
        durationMs: 25,
      },
    ]);

    expect(summary.toolSummary).toEqual([
      { name: 'dispatchBuildMission', status: 'success', durationMs: 25 },
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('CONFIRM SPEND');
    expect(serialized).not.toContain('secret-session-token');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('private document body');
    expect(serialized).not.toContain('secret-api-key');
  });

  it('hard-caps entries, names, and durations', () => {
    const longName = `tool${'x'.repeat(MAX_CHAT_TOOL_NAME_LENGTH + 20)}`;
    const calls = Array.from({ length: MAX_CHAT_TOOL_SUMMARY_ENTRIES + 3 }, (_, index) => ({
      name: index === 0 ? longName : `tool_${index}`,
      success: true,
      durationMs: MAX_CHAT_TOOL_DURATION_MS + 10_000,
    }));

    const summary = summarizeChatToolCalls(calls);

    expect(summary.toolSummary).toHaveLength(MAX_CHAT_TOOL_SUMMARY_ENTRIES);
    expect(summary.toolSummaryTruncated).toBe(true);
    expect(summary.toolSummary[0].name).toHaveLength(MAX_CHAT_TOOL_NAME_LENGTH);
    expect(summary.toolSummary.every((entry) => entry.durationMs === MAX_CHAT_TOOL_DURATION_MS)).toBe(true);
  });

  it('drops malformed or unsafe entries and omits unknowable durations', () => {
    expect(
      summarizeChatToolCalls([
        null,
        { name: 'CONFIRM SPEND $31 secret', success: true },
        { name: 'missingStatus' },
        { name: 'negativeDuration', status: 'success', durationMs: -1 },
        { name: 'nanDuration', status: 'failure', durationMs: Number.NaN },
      ])
    ).toEqual({
      toolSummary: [
        { name: 'negativeDuration', status: 'success' },
        { name: 'nanDuration', status: 'failure' },
      ],
      toolSummaryTruncated: false,
    });
  });

  it('returns an empty summary for non-array input', () => {
    expect(summarizeChatToolCalls({ name: 'searchEntities', success: true })).toEqual({
      toolSummary: [],
      toolSummaryTruncated: false,
    });
  });
});
