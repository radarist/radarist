/**
 * @file helpers/anthropic-mock.ts
 * @description Shared mock helper for @anthropic-ai/sdk (Task 0.8)
 *
 * Mirrors the pattern of existing helpers (firestore-mock.ts, entity-factory-mock.ts).
 * Used by any test that needs to mock Claude API calls.
 *
 * Usage:
 * ```typescript
 * import { createAnthropicMock } from './helpers/anthropic-mock';
 * const { mock, mockCreate } = createAnthropicMock();
 * jest.mock('@anthropic-ai/sdk', () => ({ default: jest.fn(() => mock) }));
 * ```
 */

export interface AnthropicMockConfig {
  defaultResponse?: string;
  defaultModel?: string;
  defaultTokens?: { input: number; output: number };
}

/**
 * Creates a mock Anthropic SDK client with configurable defaults.
 */
export function createAnthropicMock(config?: AnthropicMockConfig) {
  const defaultResponse = config?.defaultResponse ?? 'Mocked Claude response';
  const defaultModel = config?.defaultModel ?? 'claude-sonnet-4-6';
  const defaultTokens = config?.defaultTokens ?? { input: 100, output: 50 };

  const mockCreate = jest.fn().mockResolvedValue({
    id: 'msg_mock_001',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: defaultResponse }],
    model: defaultModel,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: defaultTokens.input,
      output_tokens: defaultTokens.output,
    },
  });

  const mock = {
    messages: {
      create: mockCreate,
    },
  };

  return {
    /** The mock Anthropic client instance */
    mock,
    /** Direct reference to messages.create mock for assertions */
    mockCreate,
    /** Helper to configure a specific response for the next call */
    mockNextResponse: (text: string, extras?: Record<string, unknown>) => {
      mockCreate.mockResolvedValueOnce({
        id: `msg_mock_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: defaultModel,
        stop_reason: 'end_turn',
        usage: {
          input_tokens: defaultTokens.input,
          output_tokens: defaultTokens.output,
        },
        ...extras,
      });
    },
    /** Helper to configure an error for the next call */
    mockNextError: (error: Error | string) => {
      mockCreate.mockRejectedValueOnce(error instanceof Error ? error : new Error(error));
    },
    /** Helper to configure a tool-use response */
    mockNextToolUse: (toolName: string, toolInput: Record<string, unknown>) => {
      mockCreate.mockResolvedValueOnce({
        id: `msg_mock_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_mock_${Date.now()}`, name: toolName, input: toolInput }],
        model: defaultModel,
        stop_reason: 'tool_use',
        usage: {
          input_tokens: defaultTokens.input,
          output_tokens: defaultTokens.output,
        },
      });
    },
  };
}
