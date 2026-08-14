/**
 * @jest-environment node
 */

/**
 * AI-051 (Gemini seam) — the same reservation rule as the Claude path, expressed
 * through the surface this SDK actually offers.
 *
 * `@google/generative-ai` fixes `toolConfig` when a chat session is created and
 * `sendMessage` takes no per-call override, so withholding tools for the
 * synthesis turn needs a session carrying the same history with mode `NONE`.
 * `StartChatParams.toolConfig` overrides the model-level value (`startChat` does
 * `Object.assign(modelDefaults, startChatParams)`), which is what makes this a
 * real withholding rather than a suggestion the model may ignore.
 *
 * The capability is probed, not assumed: an SDK without `getHistory()` cannot
 * host the turn, and the route then keeps its honest `tool_iterations_exhausted`
 * envelope instead of pretending a reservation happened.
 */

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-ai051-gemini' }),
}));

const mockSendMessage = jest.fn();
const mockSynthesisSendMessage = jest.fn();
const mockGetHistory = jest.fn().mockResolvedValue([{ role: 'user', parts: [{ text: 'prior' }] }]);
const mockStartChat = jest.fn();
const mockGetGenerativeModel = jest.fn().mockReturnValue({ startChat: mockStartChat });

jest.mock('@google/generative-ai', () => ({
  __esModule: true,
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: mockGetGenerativeModel })),
  FunctionCallingMode: { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' },
  SchemaType: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' },
}));

const mockExecuteTool = jest.fn();
jest.mock('@/lib/ai/tools', () => ({
  CORE_AI_TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));
jest.mock('@/lib/ai/mutation-tracking', () => ({
  extractMutatedTypes: jest.fn(() => new Set<string>()),
  getToolMutatedTypes: jest.fn(() => [] as string[]),
  normalizeToolName: jest.fn((name: string) => name),
}));
jest.mock('@/lib/ai/reliability', () => ({
  withRetry: jest.fn((fn: () => unknown) => fn()),
  getCircuitBreaker: jest.fn(() => ({ allowRequest: () => true, recordSuccess: () => {}, recordFailure: () => {} })),
  getRateLimiter: jest.fn(() => ({ waitForToken: () => Promise.resolve(true) })),
  trackCost: jest.fn(() => 0),
  calculateAnthropicUsageCost: jest.fn(() => ({ costUsd: 0, usage: {} })),
  trackAnthropicUsageCost: jest.fn(() => ({ costUsd: 0, usage: {} })),
  logAIOperation: jest.fn(),
  generateRequestId: jest.fn(() => 'req-ai051-gemini'),
  assertCostBudgetAvailable: jest.fn(),
  recordChatTurnCostEstimate: jest.fn(),
  CostBudgetError: class CostBudgetError extends Error {},
}));
jest.mock('@/lib/agent-runs', () => ({
  generateAgentRunId: () => 'run-ai051-gemini',
  createAgentRun: jest.fn().mockResolvedValue({ id: 'run-ai051-gemini' }),
  patchAgentRunAccounting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/operation-receipt-instrument', () => ({
  __esModule: true,
  flushCapturedUsage: jest.fn().mockResolvedValue({ receipts: [], complete: false, markerPersisted: false }),
}));
jest.mock('@/lib/graph/episodes', () => ({
  createEpisode: jest.fn().mockResolvedValue({ id: 'ep' }),
  completeEpisode: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/agent-events', () => ({ emitAgentEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/chat-preferences-admin', () => ({
  __esModule: true,
  buildWorkingStyleBlock: jest.fn().mockResolvedValue(''),
}));
jest.mock('@/lib/with-timeout', () => ({ withTimeout: (promise: Promise<unknown>) => promise }));

function functionCallResponse(name: string, args: Record<string, unknown>) {
  return {
    response: {
      text: () => '',
      functionCalls: () => [{ name, args }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, totalTokenCount: 1020 },
    },
  };
}

function textOnlyResponse(text: string) {
  return {
    response: {
      text: () => text,
      functionCalls: () => undefined,
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40, totalTokenCount: 540 },
    },
  };
}

const CONTEXT = { currentRoute: '/dashboard', currentPage: 'Dashboard' };

async function runTurn(message: string) {
  jest.resetModules();
  const { POST } = require('../route');
  const { NextRequest } = require('next/server');
  const req = new NextRequest('http://localhost:3000/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context: CONTEXT }),
  });
  return (await POST(req)).json();
}

describe('AI-051 — Gemini synthesis reservation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CHAT_ENABLED;
    process.env.GEMINI_API_KEY = 'test-key';
    mockExecuteTool.mockResolvedValue({ success: true, data: { gaps: 4 } });
    mockGetHistory.mockResolvedValue([{ role: 'user', parts: [{ text: 'prior' }] }]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('withholds tools on the reserved turn and returns the synthesized answer', async () => {
    // The main session always asks for the SAME tool, so the second batch is all
    // repeats — the duplicate-probe reservation, exactly as on the Claude path.
    mockSendMessage.mockResolvedValue(functionCallResponse('findDataGaps', {}));
    mockSynthesisSendMessage.mockResolvedValue(textOnlyResponse('findDataGaps returned 4 open gaps.'));
    mockStartChat.mockImplementation((params: Record<string, unknown>) =>
      params?.toolConfig
        ? { sendMessage: mockSynthesisSendMessage, sendMessageStream: jest.fn(), getHistory: mockGetHistory }
        : { sendMessage: mockSendMessage, sendMessageStream: jest.fn(), getHistory: mockGetHistory }
    );

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');

    expect(json.success).toBe(true);
    expect(json.message).toContain('findDataGaps returned 4 open gaps');
    expect(json.incomplete).toBeUndefined();
    // Executed once; the repeat was served from the earlier result.
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);

    // The synthesis session was created with mode NONE over the same history.
    const synthesisParams = mockStartChat.mock.calls.map(([p]) => p).filter((p) => p?.toolConfig);
    expect(synthesisParams).toHaveLength(1);
    expect(synthesisParams[0].toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(synthesisParams[0].history).toEqual([{ role: 'user', parts: [{ text: 'prior' }] }]);

    // The directive rides as a SYSTEM INSTRUCTION, and the original system
    // prompt is carried forward — `startChat` params REPLACE the model-level
    // values rather than merging into them.
    expect(synthesisParams[0].systemInstruction).toContain('ONLY the tool results already in this conversation');
    expect(synthesisParams[0].systemInstruction).toContain('never invent an id, number, date or name');

    // The message itself carries ONLY functionResponse parts. This SDK rejects
    // a message mixing `functionResponse` with any other part type — the live
    // acceptance failed on exactly that before the directive moved.
    const [sentParts] = mockSynthesisSendMessage.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(sentParts.length).toBeGreaterThan(0);
    expect(sentParts.every((part) => Object.keys(part).length === 1 && 'functionResponse' in part)).toBe(true);
  });

  it('keeps the honest incomplete envelope when the SDK cannot host a mode-NONE turn', async () => {
    // No `getHistory` — an older SDK or a stub. The reservation must not be
    // faked, and the turn must still terminate truthfully.
    mockSendMessage.mockResolvedValue(functionCallResponse('findDataGaps', {}));
    mockStartChat.mockReturnValue({ sendMessage: mockSendMessage, sendMessageStream: jest.fn() });

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');

    expect(json.success).toBe(false);
    expect(json.incomplete).toEqual(expect.objectContaining({ reason: 'tool_iterations_exhausted' }));
    expect(mockSynthesisSendMessage).not.toHaveBeenCalled();
    // Duplicate suppression still applies, so the budget is not burned on repeats.
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });
});
