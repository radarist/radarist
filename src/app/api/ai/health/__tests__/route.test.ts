/**
 * @jest-environment node
 */

/**
 * AI-033 — the /api/ai/health POST live-check exposes a DISTINCT OpenRouter
 * chat-provider probe, separate from (and never conflated with) the first-party
 * Claude mission-readiness probe. The distinct probe only runs when the opt-in
 * transport is fully configured and never gates overall health.
 */

const mockGenerateContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  generateContent: (...a: unknown[]) => mockGenerateContent(...a),
}));

const mockMessagesCreate = jest.fn();
const mockAnthropicCtor = jest.fn().mockImplementation(() => ({
  messages: { create: mockMessagesCreate },
}));
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: mockAnthropicCtor }));

// The POST live-check dynamically imports the MCP route to verify it loads.
jest.mock('@/app/api/mcp/[server]/route', () => ({ POST: jest.fn() }));

jest.mock('@/lib/ai/reliability', () => ({
  getAIHealthStatus: jest.fn(() => ({ status: 'healthy', timestamp: 0, components: {} })),
  getLogStats: jest.fn(() => ({
    total: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    avgDurationMs: 0,
    totalCostUsd: 0,
  })),
}));

describe('/api/ai/health POST — OpenRouter chat-provider probe (AI-033)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Live check is dev-only; enable it and clear any leaked OpenRouter config.
    process.env = { ...originalEnv, NODE_ENV: 'development' };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.CLAUDE_CHAT_MODEL;
    delete process.env.CLAUDE_CHAT_ENABLED;
    mockGenerateContent.mockResolvedValue('OK');
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'OK' }], model: 'claude-haiku-4-5' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function callPOST() {
    const { POST } = require('../route');
    return POST();
  }

  it('reports the chat provider as not configured, preserving the first-party Claude probe', async () => {
    const res = await callPOST();
    const json = await res.json();
    expect(json.liveCheck.chatProvider.configured).toBe(false);
    expect(json.liveCheck.chatProvider.effective).toBe(false);
    // The separate first-party mission-readiness Claude probe is still present.
    expect(json.liveCheck.claude).toBeDefined();
  });

  it('does not probe a configured OpenRouter transport while Claude chat is disabled', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';

    const res = await callPOST();
    const json = await res.json();

    expect(json.liveCheck.chatProvider).toMatchObject({
      configured: true,
      effective: false,
      reason: 'claude-chat-disabled',
      model: 'anthropic/claude-sonnet-4.5',
    });
    // The only Anthropic construction is the distinct first-party mission
    // readiness probe. No paid OpenRouter request is made.
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor).toHaveBeenCalledWith();
  });

  it('probes OpenRouter with bearer auth and reports the served model when configured', async () => {
    process.env.CLAUDE_CHAT_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      model: 'anthropic/claude-sonnet-4.5',
    });

    const res = await callPOST();
    const json = await res.json();

    expect(json.liveCheck.chatProvider.configured).toBe(true);
    expect(json.liveCheck.chatProvider.effective).toBe(true);
    expect(json.liveCheck.chatProvider.success).toBe(true);
    expect(json.liveCheck.chatProvider.servedModel).toBe('anthropic/claude-sonnet-4.5');
    // Still distinct from the first-party probe.
    expect(json.liveCheck.claude).toBeDefined();
    // Built for OpenRouter: bearer token, no second x-api-key header.
    expect(mockAnthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://openrouter.ai/api',
        authToken: 'sk-or-test',
        apiKey: null,
      })
    );
  });
});

describe('/api/ai/health GET — chat transport signal (AI-033)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CHAT_ENABLED;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.CLAUDE_CHAT_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function callGET() {
    const { GET } = require('../route');
    return GET();
  }

  it('reports gemini when the Claude chat path is disabled', async () => {
    const res = await callGET();
    const json = await res.json();
    expect(json.chatTransport.claudeChatEnabled).toBe(false);
    expect(json.chatTransport.provider).toBe('gemini');
    expect(json.chatTransport.openRouter).toMatchObject({
      configured: false,
      effective: false,
      enabled: false,
    });
  });

  it('reports OpenRouter as configured but ineffective when Claude chat is disabled', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';

    const res = await callGET();
    const json = await res.json();

    expect(json.chatTransport.provider).toBe('gemini');
    expect(json.chatTransport.openRouter).toMatchObject({
      configured: true,
      effective: false,
      enabled: false,
      reason: 'claude-chat-disabled',
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(JSON.stringify(json)).not.toContain('sk-or-secret');
  });

  it('reports first-party anthropic + reason when Claude is on but OpenRouter is unconfigured', async () => {
    process.env.CLAUDE_CHAT_ENABLED = 'true';
    const res = await callGET();
    const json = await res.json();
    expect(json.chatTransport.provider).toBe('anthropic');
    expect(json.chatTransport.openRouter).toEqual({
      configured: false,
      effective: false,
      enabled: false,
      reason: 'no-key',
    });
  });

  it('reports openrouter (baseURL + model, never the key) when fully configured', async () => {
    process.env.CLAUDE_CHAT_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    const res = await callGET();
    const json = await res.json();
    expect(json.chatTransport.provider).toBe('openrouter');
    expect(json.chatTransport.openRouter.configured).toBe(true);
    expect(json.chatTransport.openRouter.effective).toBe(true);
    expect(json.chatTransport.openRouter.enabled).toBe(true);
    expect(json.chatTransport.openRouter.model).toBe('anthropic/claude-sonnet-4.5');
    expect(json.chatTransport.openRouter.baseURL).toBe('https://openrouter.ai/api');
    // The key must never appear anywhere in the health payload.
    expect(JSON.stringify(json)).not.toContain('sk-or-secret');
  });

  it('surfaces the misconfiguration reason when a key is set but the model is not anthropic/*', async () => {
    process.env.CLAUDE_CHAT_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    process.env.CLAUDE_CHAT_MODEL = 'claude-sonnet-4-6';
    const res = await callGET();
    const json = await res.json();
    expect(json.chatTransport.provider).toBe('anthropic');
    expect(json.chatTransport.openRouter.reason).toBe('model-not-explicit-anthropic');
  });
});
