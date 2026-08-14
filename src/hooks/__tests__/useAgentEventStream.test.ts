/**
 * @file useAgentEventStream.test.ts
 * @jest-environment jsdom
 * @description Unit tests for the useAgentEventStream SSE hook.
 *
 * @phase Phase 3: SSE Event Gateway
 */

import { renderHook, act, waitFor } from '@testing-library/react';

const mockGetIdToken = jest.fn().mockResolvedValue('mock-token');

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    currentUser: {
      getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    },
  },
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

import { useAgentEventStream } from '../useAgentEventStream';

/** Helper: create a ReadableStream that emits SSE chunks then closes */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchSSE(chunks: string[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    body: createSSEStream(chunks),
    headers: new Headers({ 'Content-Type': 'text/event-stream' }),
  } as unknown as Response);
}

describe('useAgentEventStream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start disconnected then connect', async () => {
    mockFetchSSE([
      `id: evt-1\ndata: ${JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} })}\n\n`,
    ]);

    const { result } = renderHook(() => useAgentEventStream(true));

    expect(result.current.isConnected).toBe(false);
    expect(result.current.events).toEqual([]);

    await waitFor(() => {
      expect(result.current.events.length).toBe(1);
    });

    expect(result.current.events[0].id).toBe('evt-1');
  });

  it('should not connect when disabled', async () => {
    const { result } = renderHook(() => useAgentEventStream(false));

    // Advance timers to see if any connection attempt is made
    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('should parse multiple events from stream', async () => {
    mockFetchSSE([
      `id: evt-1\ndata: ${JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} })}\n\n` +
        `id: evt-2\ndata: ${JSON.stringify({ id: 'evt-2', type: 'agent.completed', sequence: 2, data: {} })}\n\n`,
    ]);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(result.current.events.length).toBe(2);
    });

    expect(result.current.events[0].id).toBe('evt-1');
    expect(result.current.events[1].id).toBe('evt-2');
  });

  it('should deduplicate events by id', async () => {
    const eventData = JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} });
    mockFetchSSE([`id: evt-1\ndata: ${eventData}\n\n` + `id: evt-1\ndata: ${eventData}\n\n`]);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(result.current.events.length).toBe(1);
    });
  });

  it('should skip keepalive comments', async () => {
    mockFetchSSE([
      `: keepalive\n\n`,
      `id: evt-1\ndata: ${JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} })}\n\n`,
    ]);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(result.current.events.length).toBe(1);
    });

    expect(result.current.events[0].id).toBe('evt-1');
  });

  it('should clear events when clearEvents is called', async () => {
    mockFetchSSE([
      `id: evt-1\ndata: ${JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} })}\n\n`,
    ]);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(result.current.events.length).toBe(1);
    });

    act(() => {
      result.current.clearEvents();
    });

    expect(result.current.events).toEqual([]);
  });

  it('should handle non-ok response gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.events).toEqual([]);
  });

  it('should skip malformed JSON gracefully', async () => {
    mockFetchSSE([
      `id: bad\ndata: {not valid json}\n\n` +
        `id: evt-1\ndata: ${JSON.stringify({ id: 'evt-1', type: 'agent.started', sequence: 1, data: {} })}\n\n`,
    ]);

    const { result } = renderHook(() => useAgentEventStream(true));

    await waitFor(() => {
      expect(result.current.events.length).toBe(1);
    });

    expect(result.current.events[0].id).toBe('evt-1');
  });

  describe('drop + reconnect (G9)', () => {
    it('dedupes events that arrive again after reconnect with stale lastSequence', async () => {
      // Connect-1: emits evt-1 (seq=1) and evt-2 (seq=2), then stream closes.
      mockFetchSSE([
        `data: ${JSON.stringify({ id: 'evt-1', sequence: 1, timestamp: 1000, type: 'agent.started', userId: 'u1', data: {} })}\n\n`,
        `data: ${JSON.stringify({ id: 'evt-2', sequence: 2, timestamp: 2000, type: 'agent.thinking', userId: 'u1', data: {} })}\n\n`,
      ]);
      // Connect-2 (after reconnect backoff): server re-sends evt-2 (same id) due
      // to a race where the client's cursor hadn't been persisted yet, plus a
      // genuinely new evt-3. The hook MUST dedupe by id, not blindly append.
      mockFetchSSE([
        `data: ${JSON.stringify({ id: 'evt-2', sequence: 2, timestamp: 2000, type: 'agent.thinking', userId: 'u1', data: {} })}\n\n`,
        `data: ${JSON.stringify({ id: 'evt-3', sequence: 3, timestamp: 3000, type: 'agent.completed', userId: 'u1', data: {} })}\n\n`,
      ]);

      const { result, unmount } = renderHook(() => useAgentEventStream(true));

      try {
        await waitFor(() => {
          expect(result.current.events.length).toBe(2);
        });

        // First stream's createSSEStream auto-closes after pulling all chunks,
        // so connect() returns and connectWithReconnect schedules a 1000ms timeout.
        await act(async () => {
          jest.advanceTimersByTime(INITIAL_RECONNECT_DELAY_MS);
        });

        await waitFor(() => {
          expect(result.current.events.length).toBe(3);
        });

        expect(result.current.events.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
      }
    });

    it('preserves order and dedupes when stream drops mid-batch and resumes', async () => {
      // Connect-1: only the first half of a logical batch lands before the
      // stream drops — evt-a (seq=10), evt-b (seq=11).
      mockFetchSSE([
        `data: ${JSON.stringify({ id: 'evt-a', sequence: 10, timestamp: 10000, type: 'agent.started', userId: 'u1', data: {} })}\n\n` +
          `data: ${JSON.stringify({ id: 'evt-b', sequence: 11, timestamp: 11000, type: 'agent.thinking', userId: 'u1', data: {} })}\n\n`,
      ]);
      // Connect-2: server replays evt-b (overlap), then delivers evt-c (12) and
      // evt-d (13). Final state must be [a, b, c, d] in order, no duplicate b.
      mockFetchSSE([
        `data: ${JSON.stringify({ id: 'evt-b', sequence: 11, timestamp: 11000, type: 'agent.thinking', userId: 'u1', data: {} })}\n\n` +
          `data: ${JSON.stringify({ id: 'evt-c', sequence: 12, timestamp: 12000, type: 'agent.tool_call', userId: 'u1', data: {} })}\n\n` +
          `data: ${JSON.stringify({ id: 'evt-d', sequence: 13, timestamp: 13000, type: 'agent.completed', userId: 'u1', data: {} })}\n\n`,
      ]);

      const { result, unmount } = renderHook(() => useAgentEventStream(true));

      try {
        await waitFor(() => {
          expect(result.current.events.length).toBe(2);
        });

        await act(async () => {
          jest.advanceTimersByTime(INITIAL_RECONNECT_DELAY_MS);
        });

        await waitFor(() => {
          expect(result.current.events.length).toBe(4);
        });

        expect(result.current.events.map((e) => e.id)).toEqual(['evt-a', 'evt-b', 'evt-c', 'evt-d']);
      } finally {
        unmount();
      }
    });

    it('sends updated lastSequence on reconnect URL', async () => {
      mockFetchSSE([
        `data: ${JSON.stringify({ id: 'evt-1', sequence: 1, timestamp: 1000, type: 'agent.started', userId: 'u1', data: {} })}\n\n`,
        `data: ${JSON.stringify({ id: 'evt-2', sequence: 2, timestamp: 2000, type: 'agent.completed', userId: 'u1', data: {} })}\n\n`,
      ]);
      mockFetchSSE([]);

      const { result, unmount } = renderHook(() => useAgentEventStream(true));

      try {
        await waitFor(() => {
          expect(result.current.events.length).toBe(2);
        });

        await act(async () => {
          jest.advanceTimersByTime(INITIAL_RECONNECT_DELAY_MS);
        });

        await waitFor(() => {
          expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        const secondCallUrl = mockFetch.mock.calls[1][0] as string;
        expect(secondCallUrl).toContain('/api/events/stream');
        // Cursor must reflect the highest sequence seen on connect-1, NOT the
        // initial Date.now()*1000 sentinel.
        expect(secondCallUrl).toContain('lastSequence=2');
      } finally {
        unmount();
      }
    });
  });
});

/** Mirrors the constant in src/hooks/useAgentEventStream.ts */
const INITIAL_RECONNECT_DELAY_MS = 1000;
