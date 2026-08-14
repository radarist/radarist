/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-1' }, loading: false }),
}));
jest.mock('@/lib/missions-client', () => ({ getBuildMissions: jest.fn() }));

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { useResumeBuildArtifact } from '@/hooks/queries/useBuildMissions';

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('useResumeBuildArtifact', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dispatches turns-only recovery immediately with explicit zero spend authority', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      response(200, {
        ok: true,
        missionId: 'mission-1',
        additionalTurns: 40,
        additionalBudgetUsd: 0,
        authorizedMaxTurns: 40,
        capUsd: 50,
      })
    );
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    let value: unknown;
    await act(async () => {
      value = await result.current.mutateAsync({
        missionId: 'mission-1',
        additionalTurns: 40,
        additionalBudgetUsd: 0,
      });
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/missions/mission-1/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additionalTurns: 40, additionalBudgetUsd: 0 }),
    });
    expect(value).toEqual(expect.objectContaining({ ok: true, authorizedMaxTurns: 40, capUsd: 50 }));
  });

  it.each([409, 428])('returns an HTTP %i confirmation challenge as UI state instead of throwing', async (status) => {
    const challenge = {
      requiresConfirmation: true,
      confirmationPhrase: 'CONFIRM SPEND $12.00 abc123',
      amountUsd: 12,
      message: 'Nothing was dispatched.',
    };
    mockFetchWithAuth.mockResolvedValueOnce(response(status, challenge));
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    let value: unknown;
    await act(async () => {
      value = await result.current.mutateAsync({
        missionId: 'mission-1',
        additionalTurns: 60,
        additionalBudgetUsd: 12,
      });
    });

    expect(value).toEqual(challenge);
    expect(result.current.isError).toBe(false);
  });

  it('rejects an empty confirmation phrase instead of enabling a blank authorization', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      response(428, { requiresConfirmation: true, confirmationPhrase: '', amountUsd: 12 })
    );
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.mutateAsync({
          missionId: 'mission-1',
          additionalTurns: 60,
          additionalBudgetUsd: 12,
        });
      })
    ).rejects.toThrow('Resume failed (428)');
  });

  it('sends the exact phrase on the second paid request', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      response(200, {
        ok: true,
        missionId: 'mission-1',
        additionalTurns: 60,
        additionalBudgetUsd: 12,
        authorizedMaxTurns: 60,
        capUsd: 62,
      })
    );
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({
        missionId: 'mission-1',
        additionalTurns: 60,
        additionalBudgetUsd: 12,
        confirmationText: 'CONFIRM SPEND $12.00 abc123',
      });
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/missions/mission-1/resume',
      expect.objectContaining({
        body: JSON.stringify({
          additionalTurns: 60,
          additionalBudgetUsd: 12,
          confirmationText: 'CONFIRM SPEND $12.00 abc123',
        }),
      })
    );
  });

  it('throws an honest server refusal that is not a confirmation challenge', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(response(410, { error: 'The retained workspace was reclaimed' }));
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.mutateAsync({
          missionId: 'mission-1',
          additionalTurns: 40,
          additionalBudgetUsd: 0,
        });
      })
    ).rejects.toThrow('The retained workspace was reclaimed');
  });

  it('fails closed when a successful response does not satisfy the recovery contract', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(response(200, { missionId: 'mission-1' }));
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useResumeBuildArtifact(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.mutateAsync({
          missionId: 'mission-1',
          additionalTurns: 40,
          additionalBudgetUsd: 0,
        });
      })
    ).rejects.toThrow('invalid response');
  });
});
