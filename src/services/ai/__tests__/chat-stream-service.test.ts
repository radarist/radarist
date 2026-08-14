/**
 * @file chat-stream-service.test.ts
 * @description Unit tests for sendChatMessageStreaming's request-body construction.
 *
 * Focus: the `images` passthrough added in Phase C3, mirroring the equivalent
 * `sendChatMessage` coverage in chat-service.test.ts (Phase C1).
 */

jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { sendChatMessageStreaming } from '../chat-stream-service';

const fetchWithAuthMock = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

describe('sendChatMessageStreaming — images passthrough (Phase C3)', () => {
  const ctx = { currentRoute: '/', currentPage: 'dashboard', recentEntities: [] } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, message: 'ok' }),
    } as unknown as Response);
  });

  it('threads images into the request body', async () => {
    await sendChatMessageStreaming('describe this', ctx, undefined, {}, undefined, undefined, [
      { data: 'AAAA', mimeType: 'image/png', name: 'chart.png' },
    ]);
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.images).toEqual([{ data: 'AAAA', mimeType: 'image/png', name: 'chart.png' }]);
  });

  it('omits images when none are passed', async () => {
    await sendChatMessageStreaming('hi', ctx, undefined, {});
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.images).toBeUndefined();
  });

  it('still sets stream: true regardless of images', async () => {
    await sendChatMessageStreaming('hi', ctx, undefined, {}, undefined, undefined, [
      { data: 'BBBB', mimeType: 'image/jpeg' },
    ]);
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.stream).toBe(true);
  });

  it('threads explicit app quick-action provenance', async () => {
    await sendChatMessageStreaming('Show insights', ctx, undefined, {}, undefined, undefined, undefined, {
      source: 'assistant-quick-action',
      actionId: 'proactive_insights',
    });
    const body = JSON.parse(fetchWithAuthMock.mock.calls[0][1]?.body as string);
    expect(body.quickAction).toEqual({
      source: 'assistant-quick-action',
      actionId: 'proactive_insights',
    });
  });
});

describe('sendChatMessageStreaming — typed paid-action refusals (UX-045)', () => {
  const ctx = { currentRoute: '/', currentPage: 'dashboard', recentEntities: [] } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delivers a typed paid-action 409 through onDone as a failure envelope', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'This spend confirmation was already used.',
        pendingActionError: { reason: 'already_used', canRestage: true },
      }),
    } as unknown as Response);

    const onDone = jest.fn();
    const onError = jest.fn();
    await sendChatMessageStreaming('CONFIRM SPEND $31 abc', ctx, undefined, { onDone, onError });

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        pendingActionError: { reason: 'already_used', canRestage: true },
      })
    );
  });

  it('keeps the legacy onError contract for non-typed error statuses', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'unavailable' }),
    } as unknown as Response);

    const onDone = jest.fn();
    const onError = jest.fn();
    await sendChatMessageStreaming('hi', ctx, undefined, { onDone, onError });

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('HTTP 503');
  });
});
