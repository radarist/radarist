/**
 * @file useTrackEntityView.test.ts
 * @description Unit tests for response-aware, bounded session tracking.
 */

import { act, renderHook } from '@testing-library/react';

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useTrackEntityView } from '../useTrackEntityView';

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedFetch = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function response(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useTrackEntityView', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false } as ReturnType<typeof useAuth>);
    mockedFetch.mockResolvedValue(response({ success: true, tracked: true }));
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('tracks an authenticated entity and deduplicates only after confirmation', async () => {
    const { rerender } = renderHook(() => useTrackEntityView('tech-1', 'technology'));
    await flush();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedFetch.mock.calls[0]!;
    expect(url).toBe('/api/session/track');
    expect(opts?.method).toBe('POST');
    expect(JSON.parse(opts?.body as string)).toEqual({ entityId: 'tech-1', entityType: 'technology' });
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    rerender();
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('waits for auth restoration instead of permanently dropping the first view', async () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: true } as ReturnType<typeof useAuth>);
    const { rerender } = renderHook(() => useTrackEntityView('tech-1', 'technology'));
    await flush();
    expect(mockedFetch).not.toHaveBeenCalled();

    mockedUseAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false } as ReturnType<typeof useAuth>);
    rerender();
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('tracks the same entity again after the authenticated user changes', async () => {
    const { rerender } = renderHook(() => useTrackEntityView('tech-1', 'technology'));
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    mockedUseAuth.mockReturnValue({ user: { uid: 'user-2' }, loading: false } as ReturnType<typeof useAuth>);
    rerender();
    await flush();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not fire without a user or a complete entity pair', async () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: false } as ReturnType<typeof useAuth>);
    const first = renderHook(() => useTrackEntityView('tech-1', 'technology'));
    const second = renderHook(() => useTrackEntityView(undefined, 'technology'));
    const third = renderHook(() => useTrackEntityView('tech-1', null));
    await flush();
    expect(mockedFetch).not.toHaveBeenCalled();
    first.unmount();
    second.unmount();
    third.unmount();
  });

  it('retries a tracked:false graph-sync race and stops after tracked:true', async () => {
    mockedFetch
      .mockResolvedValueOnce(response({ success: true, tracked: false, sessionId: 'session-1' }))
      .mockResolvedValueOnce(response({ success: true, tracked: true, sessionId: 'session-1' }));

    renderHook(() => useTrackEntityView('tech-new', 'technology'));
    await flush();
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await advance(500);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['graph-disabled', 'graph-unconfigured'])('does not retry the intentional %s mode', async (reason) => {
    mockedFetch.mockResolvedValue(response({ success: true, tracked: false, reason }));
    renderHook(() => useTrackEntityView('tech-1', 'technology'));
    await flush();
    await advance(10_000);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry when the viewed entity changes', async () => {
    mockedFetch
      .mockResolvedValueOnce(response({ success: true, tracked: false, sessionId: 'session-1' }))
      .mockResolvedValueOnce(response({ success: true, tracked: true, sessionId: 'session-1' }));
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useTrackEntityView(id, 'technology'),
      { initialProps: { id: 'tech-1' } }
    );
    await flush();

    rerender({ id: 'tech-2' });
    await flush();
    await advance(10_000);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockedFetch.mock.calls[1]![1]?.body as string)).toMatchObject({ entityId: 'tech-2' });
    expect(mockedFetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('retries transient failures but stops on a client failure', async () => {
    mockedFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response({ error: 'unauthorized' }, 401));

    renderHook(() => useTrackEntityView('tech-1', 'technology'));
    await flush();
    await advance(500);
    await advance(10_000);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
