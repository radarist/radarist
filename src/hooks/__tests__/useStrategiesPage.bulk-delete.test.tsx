/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { Strategy } from '@/lib/strategies';

const mockToast = jest.fn();

jest.mock('@/lib/strategies', () => ({
  getStrategies: jest.fn(),
  deleteStrategy: jest.fn(),
  createStrategy: jest.fn(),
  updateStrategy: jest.fn(),
}));
jest.mock('@/lib/relations', () => ({
  getRelationsForEntities: jest.fn(),
  getRelationsForEntity: jest.fn(),
  deleteRelation: jest.fn(),
  createRelationFromIds: jest.fn(),
}));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/hooks/useSheetUrl', () => ({
  useControlledSheet: () => ({
    selectedEntity: null,
    isOpen: false,
    open: jest.fn(),
    close: jest.fn(),
    onOpenChange: jest.fn(),
  }),
}));
jest.mock('@/hooks/useDataRefresh', () => ({ useDataRefresh: jest.fn() }));

import { useStrategiesPage } from '../useStrategiesPage';
import { getStrategies } from '@/lib/strategies';
import { getRelationsForEntities } from '@/lib/relations';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

const STRATEGY_ONE = { id: 'strategy-1', name: 'Strategy One' } as Strategy;
const STRATEGY_TWO = { id: 'strategy-2', name: 'Strategy Two' } as Strategy;

const mockedGetStrategies = getStrategies as jest.MockedFunction<typeof getStrategies>;
const mockedGetRelationsForEntities = getRelationsForEntities as jest.MockedFunction<
  typeof getRelationsForEntities
>;
const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function selectBoth(result: { current: ReturnType<typeof useStrategiesPage> }): void {
  act(() => {
    result.current.toggleSelection(STRATEGY_ONE);
    result.current.toggleSelection(STRATEGY_TWO);
  });
}

describe('useStrategiesPage bulk delete selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetStrategies.mockResolvedValue([STRATEGY_ONE, STRATEGY_TWO]);
    mockedGetRelationsForEntities.mockResolvedValue({});
  });

  it('retains only the exact failed IDs after an HTTP-200 partial response', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, deleted: 1, failed: ['strategy-2'], relationsDeleted: 2 }),
    } as Response);
    const { result } = renderHook(() => useStrategiesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['strategy-2']);
    expect(mockedFetchWithAuth).toHaveBeenCalledWith(
      '/api/strategies/bulk-delete',
      expect.objectContaining({ body: JSON.stringify({ ids: ['strategy-1', 'strategy-2'] }) })
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Strategies Partially Deleted', variant: 'destructive' })
    );
  });

  it('clears selection after a complete HTTP-200 success', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: 2, failed: [], relationsDeleted: 0 }),
    } as Response);
    const { result } = renderHook(() => useStrategiesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual([]);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Strategies Deleted' }));
  });

  it.each([
    ['a non-OK response', { ok: false, json: async () => ({ error: 'delete unavailable' }) }],
    [
      'a malformed success response',
      { ok: true, json: async () => ({ success: true, deleted: 2, relationsDeleted: 0 }) },
    ],
    [
      'an unknown failed ID',
      {
        ok: true,
        json: async () => ({ success: false, deleted: 1, failed: ['unknown'], relationsDeleted: 0 }),
      },
    ],
    [
      'a contradictory partition',
      { ok: true, json: async () => ({ success: true, deleted: 0, failed: [], relationsDeleted: 0 }) },
    ],
  ])('preserves the original selection for %s', async (_label, response) => {
    mockedFetchWithAuth.mockResolvedValue(response as Response);
    const { result } = renderHook(() => useStrategiesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['strategy-1', 'strategy-2']);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});
