/**
 * @jest-environment node
 */

/**
 * AI-033 — fail-closed gating for the opt-in OpenRouter chat transport.
 *
 * Every gate below must hold or the transport is disabled and the caller keeps
 * first-party Anthropic / Gemini behavior. These tests pin the security
 * contract: a server-only key, an approved HTTPS origin, and an explicit
 * `anthropic/*` (Claude-only) model.
 */
import {
  isApprovedOpenRouterOrigin,
  resolveOpenRouterChatTransport,
  DEFAULT_OPENROUTER_BASE_URL,
} from '../openrouter-transport';

describe('isApprovedOpenRouterOrigin', () => {
  it('accepts the default https openrouter.ai origin', () => {
    expect(isApprovedOpenRouterOrigin('https://openrouter.ai/api')).toBe(true);
  });

  it('rejects a non-https origin (never send a server key over plaintext)', () => {
    expect(isApprovedOpenRouterOrigin('http://openrouter.ai/api')).toBe(false);
  });

  it('rejects an unapproved host even over https', () => {
    expect(isApprovedOpenRouterOrigin('https://evil.example.com/api')).toBe(false);
  });

  it('rejects a lookalike host that merely contains the approved host', () => {
    expect(isApprovedOpenRouterOrigin('https://openrouter.ai.evil.com/api')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isApprovedOpenRouterOrigin('not a url')).toBe(false);
  });
});

describe('resolveOpenRouterChatTransport', () => {
  const ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'CLAUDE_CHAT_MODEL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is disabled (no-key) when the key is absent', () => {
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    expect(resolveOpenRouterChatTransport()).toEqual({ enabled: false, reason: 'no-key' });
  });

  it('treats a setup-scaffold placeholder key as absent', () => {
    process.env.OPENROUTER_API_KEY = 'your-openrouter-key';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    expect(resolveOpenRouterChatTransport()).toEqual({ enabled: false, reason: 'no-key' });
  });

  it('is disabled when the model is not an explicit anthropic/* slug', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    process.env.CLAUDE_CHAT_MODEL = 'claude-sonnet-4-6';
    expect(resolveOpenRouterChatTransport()).toEqual({
      enabled: false,
      reason: 'model-not-explicit-anthropic',
    });
  });

  it('never defaults a model — an unset model disables the transport', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    expect(resolveOpenRouterChatTransport()).toEqual({
      enabled: false,
      reason: 'model-not-explicit-anthropic',
    });
  });

  it('refuses a non-Claude model slug (Claude-only transport)', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    process.env.CLAUDE_CHAT_MODEL = 'openai/gpt-4o';
    expect(resolveOpenRouterChatTransport()).toEqual({
      enabled: false,
      reason: 'model-not-explicit-anthropic',
    });
  });

  it('is disabled when a custom origin is not https', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    process.env.OPENROUTER_BASE_URL = 'http://openrouter.ai/api';
    expect(resolveOpenRouterChatTransport()).toEqual({ enabled: false, reason: 'unapproved-origin' });
  });

  it('is disabled when a custom origin host is unapproved', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-sonnet-4.5';
    process.env.OPENROUTER_BASE_URL = 'https://evil.example.com';
    expect(resolveOpenRouterChatTransport()).toEqual({ enabled: false, reason: 'unapproved-origin' });
  });

  it('enables with the default origin, bearer key (trimmed), and explicit anthropic model', () => {
    process.env.OPENROUTER_API_KEY = '  sk-or-abc  ';
    process.env.CLAUDE_CHAT_MODEL = '  anthropic/claude-sonnet-4.5  ';
    expect(resolveOpenRouterChatTransport()).toEqual({
      enabled: true,
      baseURL: DEFAULT_OPENROUTER_BASE_URL,
      apiKey: 'sk-or-abc',
      model: 'anthropic/claude-sonnet-4.5',
    });
  });

  it('honors an approved custom https origin', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc';
    process.env.CLAUDE_CHAT_MODEL = 'anthropic/claude-opus-4.1';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
    expect(resolveOpenRouterChatTransport()).toEqual({
      enabled: true,
      baseURL: 'https://openrouter.ai/api',
      apiKey: 'sk-or-abc',
      model: 'anthropic/claude-opus-4.1',
    });
  });
});
