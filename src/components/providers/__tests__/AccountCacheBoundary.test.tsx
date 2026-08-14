/**
 * @file AccountCacheBoundary.test.tsx
 * @description UX-046 — the boundary purges the entire query cache on an
 * account transition (switch or sign-out) so nothing cached under the
 * previous principal can render for, or be reused by, the next one.
 *
 * It must NOT purge on the initial auth restoration — that would wipe
 * server-prefetched state on every load for no isolation benefit.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

import { AccountCacheBoundary } from '../AccountCacheBoundary';

function renderBoundary(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountCacheBoundary>
        <div data-testid="child" />
      </AccountCacheBoundary>
    </QueryClientProvider>
  );
}

describe('AccountCacheBoundary (UX-046)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['briefing', 'user-a', 'insights'], { insights: [{ id: 'pi-a' }] });
    queryClient.setQueryData(['activity', 'user-a', 'log'], { entries: [{ id: 'run-a' }] });
  });

  it('keeps the cache across the initial auth restoration', () => {
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    renderBoundary(queryClient);
    expect(queryClient.getQueryData(['briefing', 'user-a', 'insights'])).toBeDefined();
  });

  it('keeps the cache across the loading flicker before the first resolution', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    const view = renderBoundary(queryClient);

    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AccountCacheBoundary>
          <div data-testid="child" />
        </AccountCacheBoundary>
      </QueryClientProvider>
    );

    expect(queryClient.getQueryData(['briefing', 'user-a', 'insights'])).toBeDefined();
  });

  it('purges every cached query when the account switches A→B', () => {
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    const view = renderBoundary(queryClient);

    mockUseAuth.mockReturnValue({ user: { uid: 'user-b' }, loading: false });
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AccountCacheBoundary>
          <div data-testid="child" />
        </AccountCacheBoundary>
      </QueryClientProvider>
    );

    expect(queryClient.getQueryData(['briefing', 'user-a', 'insights'])).toBeUndefined();
    expect(queryClient.getQueryData(['activity', 'user-a', 'log'])).toBeUndefined();
  });

  it('purges every cached query on sign-out (A→null)', () => {
    mockUseAuth.mockReturnValue({ user: { uid: 'user-a' }, loading: false });
    const view = renderBoundary(queryClient);

    mockUseAuth.mockReturnValue({ user: null, loading: false });
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AccountCacheBoundary>
          <div data-testid="child" />
        </AccountCacheBoundary>
      </QueryClientProvider>
    );

    expect(queryClient.getQueryData(['briefing', 'user-a', 'insights'])).toBeUndefined();
    expect(queryClient.getQueryData(['activity', 'user-a', 'log'])).toBeUndefined();
  });
});
