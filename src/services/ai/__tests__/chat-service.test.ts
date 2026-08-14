/**
 * @file chat-service.test.ts
 * @description Unit tests for chat-service pure helpers.
 *
 * Focus: the AI-interaction disclosure (EU AI Act Art 50(1)) added to every
 * welcome message, plus the daily-greeting helpers (localStorage 6h gate and
 * fail-soft /api/ai/greeting fetch). fetch/logger deps are mocked so the
 * module imports cleanly.
 */

jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import {
  getWelcomeMessage,
  shouldShowGreeting,
  markGreetingShown,
  fetchDailyGreeting,
  sendChatMessage,
  GREETING_LAST_SHOWN_KEY,
  GREETING_MIN_INTERVAL_MS,
} from '../chat-service';
import type { AIPageType } from '@/types/ai-assistant';

const fetchWithAuthMock = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

describe('sendChatMessage — images passthrough (Phase C1)', () => {
  const ctx = { currentRoute: '/', currentPage: 'dashboard', recentEntities: [] } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'ok' }),
    } as unknown as Response);
  });

  it('threads images into the request body', async () => {
    await sendChatMessage('describe this', ctx, undefined, undefined, undefined, [
      { data: 'AAAA', mimeType: 'image/png', name: 'chart.png' },
    ]);
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.images).toEqual([{ data: 'AAAA', mimeType: 'image/png', name: 'chart.png' }]);
  });

  it('omits images when none are passed', async () => {
    await sendChatMessage('hi', ctx);
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.images).toBeUndefined();
  });

  it('threads explicit app quick-action provenance without adding it to typed chat', async () => {
    await sendChatMessage('Show insights', ctx, undefined, undefined, undefined, undefined, {
      source: 'assistant-quick-action',
      actionId: 'proactive_insights',
    });
    const quickBody = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(quickBody.quickAction).toEqual({
      source: 'assistant-quick-action',
      actionId: 'proactive_insights',
    });

    await sendChatMessage('Show insights', ctx);
    const typedBody = JSON.parse(fetchWithAuthMock.mock.calls[1][1]?.body as string);
    expect(typedBody.quickAction).toBeUndefined();
  });
});

describe('sendChatMessage — typed paid-action refusals (UX-045)', () => {
  const ctx = { currentRoute: '/', currentPage: 'dashboard', recentEntities: [] } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the typed envelope for a paid-action 409 instead of throwing', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'This spend confirmation expired before it was submitted.',
        pendingActionError: { reason: 'expired', canRestage: true },
      }),
    } as unknown as Response);

    const result = await sendChatMessage('CONFIRM SPEND $31 abc', ctx);
    expect(result.success).toBe(false);
    expect(result.pendingActionError).toEqual({ reason: 'expired', canRestage: true });
    expect(result.error).toMatch(/expired/i);
  });

  it('still throws for a non-typed error status', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'AI service temporarily unavailable.' }),
    } as unknown as Response);

    await expect(sendChatMessage('hi', ctx)).rejects.toThrow('AI service temporarily unavailable.');
  });
});

describe('getWelcomeMessage — AI-interaction disclosure (Art 50(1))', () => {
  const pages: AIPageType[] = ['dashboard', 'radar', 'signals', 'agents', 'settings'];

  it.each(pages)('prepends the explicit AI-interaction notice on the %s page', (page) => {
    const msg = getWelcomeMessage(page);
    expect(msg).toMatch(/chatting with an AI assistant/i);
    expect(msg).toMatch(/can make mistakes/i);
  });

  it('keeps the page-specific body after the notice', () => {
    const msg = getWelcomeMessage('radar');
    expect(msg).toContain('technology radar');
    // Notice comes first, body second.
    expect(msg.indexOf('AI assistant')).toBeLessThan(msg.indexOf('technology radar'));
  });

  it('still renders the entity name on entity-detail pages', () => {
    const msg = getWelcomeMessage('entity-detail', 'Acme Corp');
    expect(msg).toMatch(/chatting with an AI assistant/i);
    expect(msg).toContain('Acme Corp');
  });
});

describe('shouldShowGreeting — 6h localStorage gate', () => {
  const NOW = 1_750_000_000_000;

  beforeEach(() => {
    localStorage.clear();
  });

  it('returns true when no greeting has ever been shown', () => {
    expect(shouldShowGreeting(NOW)).toBe(true);
  });

  it('returns false when the last greeting was shown less than 6h ago', () => {
    localStorage.setItem(GREETING_LAST_SHOWN_KEY, String(NOW - 60 * 60 * 1000)); // 1h ago
    expect(shouldShowGreeting(NOW)).toBe(false);
  });

  it('returns true when the last greeting was shown 6h or more ago', () => {
    localStorage.setItem(GREETING_LAST_SHOWN_KEY, String(NOW - GREETING_MIN_INTERVAL_MS));
    expect(shouldShowGreeting(NOW)).toBe(true);
  });

  it('returns true when the stored value is not a parsable number', () => {
    localStorage.setItem(GREETING_LAST_SHOWN_KEY, 'not-a-timestamp');
    expect(shouldShowGreeting(NOW)).toBe(true);
  });

  it('returns false when localStorage access throws', () => {
    const getItemSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(shouldShowGreeting(NOW)).toBe(false);
    } finally {
      getItemSpy.mockRestore();
    }
  });
});

describe('markGreetingShown', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists the provided timestamp under the greeting key', () => {
    markGreetingShown(123456789);
    expect(localStorage.getItem(GREETING_LAST_SHOWN_KEY)).toBe('123456789');
  });

  it('gates a subsequent shouldShowGreeting call within the interval', () => {
    const now = Date.now();
    markGreetingShown(now);
    expect(shouldShowGreeting(now + 1000)).toBe(false);
    expect(shouldShowGreeting(now + GREETING_MIN_INTERVAL_MS)).toBe(true);
  });

  it('does not throw when localStorage write fails', () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => markGreetingShown()).not.toThrow();
    } finally {
      setItemSpy.mockRestore();
    }
  });
});

describe('fetchDailyGreeting — fail-soft /api/ai/greeting client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: async () => body } as unknown as Response;
  }

  it('returns the greeting text on a successful response', async () => {
    fetchWithAuthMock.mockResolvedValue(
      mockJsonResponse({
        greeting: '2 new signals came in overnight.',
        stats: { newSignals: 2, completedRuns: 0 },
        generatedAt: new Date().toISOString(),
      })
    );

    await expect(fetchDailyGreeting()).resolves.toBe('2 new signals came in overnight.');
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/api/ai/greeting',
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it('returns null when the API returns greeting: null (AI-failure fallback)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      mockJsonResponse({ greeting: null, stats: { newSignals: 3, completedRuns: 1 } })
    );
    await expect(fetchDailyGreeting()).resolves.toBeNull();
  });

  it('returns null when the greeting is an empty/whitespace string', async () => {
    fetchWithAuthMock.mockResolvedValue(mockJsonResponse({ greeting: '   ' }));
    await expect(fetchDailyGreeting()).resolves.toBeNull();
  });

  it('returns null on a non-OK HTTP status', async () => {
    fetchWithAuthMock.mockResolvedValue(mockJsonResponse({ error: 'Unauthorized' }, false, 401));
    await expect(fetchDailyGreeting()).resolves.toBeNull();
  });

  it('returns null when the response body is not valid JSON', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    } as unknown as Response);
    await expect(fetchDailyGreeting()).resolves.toBeNull();
  });

  it('returns null when the network request rejects (timeout/abort)', async () => {
    fetchWithAuthMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(fetchDailyGreeting()).resolves.toBeNull();
  });

  // T1-10: the 6h window is marked whenever the API RESPONDS — including
  // greeting:null — so keyless demos retry at most once per window.
  describe('6h-window marking', () => {
    it('marks the window when the API returns a greeting', async () => {
      fetchWithAuthMock.mockResolvedValue(mockJsonResponse({ greeting: 'Hi there.' }));

      await fetchDailyGreeting();

      expect(localStorage.getItem(GREETING_LAST_SHOWN_KEY)).not.toBeNull();
    });

    it('marks the window even when the API responds with greeting: null (keyless demo)', async () => {
      fetchWithAuthMock.mockResolvedValue(
        mockJsonResponse({ greeting: null, stats: { newSignals: 1, completedRuns: 0 } })
      );

      await expect(fetchDailyGreeting()).resolves.toBeNull();
      expect(localStorage.getItem(GREETING_LAST_SHOWN_KEY)).not.toBeNull();
      expect(shouldShowGreeting()).toBe(false);
    });

    it('does not mark the window on a non-OK HTTP response', async () => {
      fetchWithAuthMock.mockResolvedValue(mockJsonResponse({ error: 'boom' }, false, 500));

      await expect(fetchDailyGreeting()).resolves.toBeNull();
      expect(localStorage.getItem(GREETING_LAST_SHOWN_KEY)).toBeNull();
    });

    it('does not mark the window when the network request rejects', async () => {
      fetchWithAuthMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(fetchDailyGreeting()).resolves.toBeNull();
      expect(localStorage.getItem(GREETING_LAST_SHOWN_KEY)).toBeNull();
    });
  });
});
