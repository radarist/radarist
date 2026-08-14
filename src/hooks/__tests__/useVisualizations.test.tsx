/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { useVisualization, VisualizationFetchError } from '../useVisualizations';

const VISUALIZATION = {
  id: 'viz-1',
  title: 'Architecture map',
  prompt: 'Map the architecture.',
  refinedPrompt: 'Map the approved architecture.',
  imageUrl: 'https://storage.example.test/viz-1.png',
  mimeType: 'image/png',
  style: 'professional',
  dataSnapshot: { entities: [], description: 'Architecture summary.' },
  createdAt: '2026-07-20T00:00:00.000Z',
  createdBy: 'user',
  shared: false,
  userId: 'user-1',
  metadata: { model: 'test', width: 1600, height: 900, sizeBytes: 1024 },
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useVisualization truthful read contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a typed found result', async () => {
    mockFetchWithAuth.mockResolvedValue(response(200, { status: 'found', visualization: VISUALIZATION }));

    const { result } = renderHook(() => useVisualization('viz-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', visualization: VISUALIZATION });
  });

  it('returns not-found only for the API confirmed-absent contract', async () => {
    mockFetchWithAuth.mockResolvedValue(response(404, { status: 'not-found' }));

    const { result } = renderHook(() => useVisualization('viz-missing'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'not-found' });
  });

  it('does not treat an unverified 404 payload as confirmed absence', async () => {
    mockFetchWithAuth.mockResolvedValue(response(404, { error: 'proxy failure' }));

    const { result } = renderHook(() => useVisualization('viz-unknown'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatchObject({ kind: 'protocol', status: 404 });
  });

  it.each([
    [401, 'auth'],
    [503, 'service'],
  ] as const)('keeps an HTTP %s outage distinct from not-found', async (status, kind) => {
    mockFetchWithAuth.mockResolvedValue(response(status, { status: status === 401 ? 'unauthorized' : 'unavailable' }));

    const { result } = renderHook(() => useVisualization('viz-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(VisualizationFetchError);
    expect(result.current.error).toMatchObject({ kind, status });
  });

  it('keeps a network/Auth-token acquisition failure distinct from not-found', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('auth token service offline'));

    const { result } = renderHook(() => useVisualization('viz-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatchObject({ kind: 'network', status: undefined });
  });

  it('recovers through the existing refetch path after a transient outage', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(response(503, { status: 'unavailable' }))
      .mockResolvedValueOnce(response(200, { status: 'found', visualization: VISUALIZATION }));

    const { result } = renderHook(() => useVisualization('viz-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'found', visualization: VISUALIZATION });
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });
});
