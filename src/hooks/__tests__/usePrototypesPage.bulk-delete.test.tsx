/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { Prototype } from '@/lib/types';

const mockToast = jest.fn();

jest.mock('@/lib/prototypes', () => ({
  getPrototypes: jest.fn(),
  deletePrototype: jest.fn(),
  createPrototype: jest.fn(),
  updatePrototype: jest.fn(),
}));
jest.mock('@/lib/relations', () => ({
  getRelationsForEntities: jest.fn(),
  getRelationsForEntity: jest.fn(),
  createRelation: jest.fn(),
  deleteRelation: jest.fn(),
}));
jest.mock('@/lib/relation-snapshot', () => ({ buildTargetSnapshot: jest.fn() }));
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

import { usePrototypesPage } from '../usePrototypesPage';
import { getPrototypes } from '@/lib/prototypes';
import { getRelationsForEntities } from '@/lib/relations';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

const PROTOTYPE_ONE = { id: 'prototype-1', name: 'Prototype One', status: 'Ideation' } as Prototype;
const PROTOTYPE_TWO = { id: 'prototype-2', name: 'Prototype Two', status: 'Ideation' } as Prototype;

const mockedGetPrototypes = getPrototypes as jest.MockedFunction<typeof getPrototypes>;
const mockedGetRelationsForEntities = getRelationsForEntities as jest.MockedFunction<
  typeof getRelationsForEntities
>;
const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function selectBoth(result: { current: ReturnType<typeof usePrototypesPage> }): void {
  act(() => {
    result.current.toggleSelection(PROTOTYPE_ONE);
    result.current.toggleSelection(PROTOTYPE_TWO);
  });
}

describe('usePrototypesPage bulk delete selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetPrototypes.mockResolvedValue([PROTOTYPE_ONE, PROTOTYPE_TWO]);
    mockedGetRelationsForEntities.mockResolvedValue({});
  });

  it('retains only the exact failed IDs after an HTTP-200 partial response', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, deleted: 1, failed: ['prototype-2'], relationsDeleted: 2 }),
    } as Response);
    const { result } = renderHook(() => usePrototypesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['prototype-2']);
    expect(mockedFetchWithAuth).toHaveBeenCalledWith(
      '/api/prototypes/bulk-delete',
      expect.objectContaining({ body: JSON.stringify({ ids: ['prototype-1', 'prototype-2'] }) })
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Experiments Partially Deleted', variant: 'destructive' })
    );
  });

  it('clears selection after a complete HTTP-200 success', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: 2, failed: [], relationsDeleted: 0 }),
    } as Response);
    const { result } = renderHook(() => usePrototypesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual([]);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Experiments Deleted' }));
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
    const { result } = renderHook(() => usePrototypesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['prototype-1', 'prototype-2']);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});
