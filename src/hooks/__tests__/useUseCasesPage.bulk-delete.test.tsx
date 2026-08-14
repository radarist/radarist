/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { UseCase } from '@/lib/types';

const mockToast = jest.fn();

jest.mock('@/lib/use-cases', () => ({
  getUseCases: jest.fn(),
  deleteUseCase: jest.fn(),
  createUseCase: jest.fn(),
  updateUseCase: jest.fn(),
  getUseCaseById: jest.fn(),
}));
jest.mock('@/lib/relations', () => ({
  getRelationsForEntities: jest.fn(),
  getRelationsForEntity: jest.fn(),
  createRelation: jest.fn(),
  deleteRelation: jest.fn(),
}));
jest.mock('@/lib/companies', () => ({ getCompanyById: jest.fn() }));
jest.mock('@/lib/technology-service', () => ({ getTechnologyById: jest.fn() }));
jest.mock('@/lib/prototypes', () => ({ getPrototypeById: jest.fn() }));
jest.mock('@/lib/strategies', () => ({ getStrategyById: jest.fn() }));
jest.mock('@/lib/signals-client', () => ({ getSignalById: jest.fn() }));
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

import { useUseCasesPage } from '../useUseCasesPage';
import { getUseCases } from '@/lib/use-cases';
import { getRelationsForEntities } from '@/lib/relations';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

const USE_CASE_ONE = { id: 'use-case-1', title: 'Use Case One', status: 'Proposed' } as UseCase;
const USE_CASE_TWO = { id: 'use-case-2', title: 'Use Case Two', status: 'Proposed' } as UseCase;

const mockedGetUseCases = getUseCases as jest.MockedFunction<typeof getUseCases>;
const mockedGetRelationsForEntities = getRelationsForEntities as jest.MockedFunction<
  typeof getRelationsForEntities
>;
const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function selectBoth(result: { current: ReturnType<typeof useUseCasesPage> }): void {
  act(() => {
    result.current.toggleSelection(USE_CASE_ONE);
    result.current.toggleSelection(USE_CASE_TWO);
  });
}

describe('useUseCasesPage bulk delete selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUseCases.mockResolvedValue([USE_CASE_ONE, USE_CASE_TWO]);
    mockedGetRelationsForEntities.mockResolvedValue({});
  });

  it('retains only the exact failed IDs after an HTTP-200 partial response', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, deleted: 1, failed: ['use-case-2'], relationsDeleted: 2 }),
    } as Response);
    const { result } = renderHook(() => useUseCasesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['use-case-2']);
    expect(mockedFetchWithAuth).toHaveBeenCalledWith(
      '/api/use-cases/bulk-delete',
      expect.objectContaining({ body: JSON.stringify({ ids: ['use-case-1', 'use-case-2'] }) })
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Use Cases Partially Deleted', variant: 'destructive' })
    );
  });

  it('clears selection after a complete HTTP-200 success', async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: 2, failed: [], relationsDeleted: 0 }),
    } as Response);
    const { result } = renderHook(() => useUseCasesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual([]);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Use Cases Deleted' }));
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
    const { result } = renderHook(() => useUseCasesPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    selectBoth(result);

    await act(async () => {
      await result.current.handleBulkDelete();
    });

    expect(result.current.selectedIds).toEqual(['use-case-1', 'use-case-2']);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});
