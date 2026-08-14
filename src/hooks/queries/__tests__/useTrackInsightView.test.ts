/**
 * @file useTrackInsightView.test.ts
 * @description Tests for the fire-and-forget view tracker (Chunk 1).
 *
 * Pins:
 *   1. POSTs to `/api/impulse/briefing/[id]/view` with method only — no
 *      body required (the route reads the id from the path segment).
 *   2. Rate-limit 429 surfaces a "Rate limit" Error and the retry policy
 *      does NOT retry it (signal: pointless to hammer when throttled).
 *   3. 404 also does NOT retry — terminal failure.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useTrackInsightView } from '../useTrackInsightView';

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useTrackInsightView', () => {
  let qc: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it('POSTs to the [id]/view path and parses the recorded flag', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ recorded: true, topicsWritten: 2 }),
    });

    const { result } = renderHook(() => useTrackInsightView(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/impulse/briefing/pi-1/view',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.current.data).toEqual({ recorded: true, topicsWritten: 2 });
  });

  it('does not retry 429s', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });
    qc = new QueryClient({ defaultOptions: { mutations: { retry: 3 } } });

    const { result } = renderHook(() => useTrackInsightView(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The custom retry callback short-circuits 429 — exactly one fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toMatch(/Rate limit/i);
  });

  it('does not retry 404s', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    qc = new QueryClient({ defaultOptions: { mutations: { retry: 3 } } });

    const { result } = renderHook(() => useTrackInsightView(), { wrapper: createWrapper(qc) });

    await act(async () => {
      result.current.mutate({ insightId: 'pi-1' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
