/**
 * Unit Tests for useDigests hooks (Task 25 / P-A6 review fix)
 *
 * fetchWithAuth is a thin fetch wrapper that does NOT throw on non-2xx, so
 * both mark-read mutations must check response.ok themselves. These tests
 * lock in: non-2xx → mutation rejects + toast.error fires + the unread query
 * is NOT invalidated; 2xx → success path (invalidation, no error toast).
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ============================================================================
// MOCKS
// ============================================================================

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockToastError = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-1' }, loading: false }),
}));

// Import hooks after mocks
import { useMarkDigestRead, useMarkAllDigestsRead, useUnreadDigests, digestKeys } from '../useDigests';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    },
    queryClient,
  };
}

function okResponse(): Partial<Response> {
  return { ok: true, status: 200, json: async () => ({ success: true }) };
}

function errorResponse(status: number, body = 'boom'): Partial<Response> {
  return { ok: false, status, statusText: 'Internal Server Error', text: async () => body };
}

// ============================================================================
// TESTS
// ============================================================================

describe('useUnreadDigests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches unread digests when auth is ready', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ digests: [{ id: 'd1' }] }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUnreadDigests(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ digests: [{ id: 'd1' }] });
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/digests?unread=true');
  });

  it('non-2xx: surfaces a query error instead of swallowing into an empty list (AUDIT-008)', async () => {
    mockFetchWithAuth.mockResolvedValue(errorResponse(500, 'digest backend down'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUnreadDigests(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect((result.current.error as Error).message).toContain('500');
    expect((result.current.error as Error).message).toContain('digest backend down');
  });
});

/**
 * Both mutation hooks normalized to the shape these shared tests exercise —
 * their real TanStack variable types differ (`string` vs `void`), which a
 * `describe.each` tuple can't union without widening.
 */
interface MutationLike {
  mutate: (arg?: unknown) => void;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
}

describe.each([
  [
    'useMarkDigestRead',
    () => useMarkDigestRead() as unknown as MutationLike,
    'digest-1' as string | undefined,
    'markRead',
  ],
  ['useMarkAllDigestsRead', () => useMarkAllDigestsRead() as unknown as MutationLike, undefined, 'markAllRead'],
] as const)('%s', (_name, useHook, mutateArg, action) => {
  beforeEach(() => jest.clearAllMocks());

  it('2xx: resolves, invalidates the unread query, and shows no error toast', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse());

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(useHook, { wrapper });

    result.current.mutate(mutateArg);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: digestKeys.unread() });
    expect(mockToastError).not.toHaveBeenCalled();

    const [, requestInit] = mockFetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string)).toEqual(mutateArg ? { digestId: mutateArg, action } : { action });
  });

  it('non-2xx: rejects with status context, fires toast.error, and does NOT invalidate', async () => {
    mockFetchWithAuth.mockResolvedValue(errorResponse(500, 'batch partially failed'));

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(useHook, { wrapper });

    result.current.mutate(mutateArg);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toContain('500');
    expect((result.current.error as Error).message).toContain('batch partially failed');
    expect(mockToastError).toHaveBeenCalledWith('Failed to mark notifications read');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('non-2xx with an unreadable body: still rejects with the status', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => {
        throw new Error('body stream already read');
      },
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(useHook, { wrapper });

    result.current.mutate(mutateArg);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as Error).message).toContain('503');
    expect((result.current.error as Error).message).toContain('Service Unavailable');
    expect(mockToastError).toHaveBeenCalledWith('Failed to mark notifications read');
  });
});
