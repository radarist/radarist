/** @jest-environment jsdom */

/**
 * @file useUseCasesPage.add-relation.test.tsx
 * @description UX-054 — every advertised relation target must actually write.
 *
 * The Use Case relation picker offers nine entity types. The handler resolved
 * six with an inline `switch`; Pain Point, Org Unit, and Initiative fell through
 * to `targetSnapshot === null` and the Add closed having created nothing while
 * the picker removed the row exactly as it does on success.
 *
 * These tests pin the repaired contract:
 *   1. every advertised type reaches the canonical server boundary
 *      (`POST /api/relations/from-ids`) with the exact endpoints, so the SERVER
 *      resolves both snapshots and authorizes the write;
 *   2. a foreign / unresolvable target writes nothing and surfaces the failure;
 *   3. a failed Add REJECTS, so the picker cannot mistake it for success.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { UseCase, EntityType } from '@/lib/types';
import { RELATION_TARGET_ENTITY_TYPES } from '@/components/sheets/tabs/relation-target-types';

const mockToast = jest.fn();

const SELECTED_USE_CASE = {
  id: 'use-case-1',
  title: 'Reduce warehouse pick errors',
  description: 'Pickers mis-scan bins under time pressure',
  status: 'Proposed',
} as UseCase;

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
jest.mock('@/lib/relation-api-client', () => ({
  createRelationFromIds: jest.fn(),
  DuplicateRelationApiError: class DuplicateRelationApiError extends Error {},
}));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/hooks/useSheetUrl', () => ({
  useControlledSheet: () => ({
    selectedEntity: SELECTED_USE_CASE,
    isOpen: true,
    open: jest.fn(),
    close: jest.fn(),
    onOpenChange: jest.fn(),
  }),
}));
jest.mock('@/hooks/useDataRefresh', () => ({ useDataRefresh: jest.fn() }));

import { useUseCasesPage } from '../useUseCasesPage';
import { getUseCases } from '@/lib/use-cases';
import { getRelationsForEntities, getRelationsForEntity, createRelation } from '@/lib/relations';
import { createRelationFromIds, DuplicateRelationApiError } from '@/lib/relation-api-client';

const mockedGetUseCases = getUseCases as jest.MockedFunction<typeof getUseCases>;
const mockedGetRelationsForEntities = getRelationsForEntities as jest.MockedFunction<typeof getRelationsForEntities>;
const mockedGetRelationsForEntity = getRelationsForEntity as jest.MockedFunction<typeof getRelationsForEntity>;
const mockedCreateRelation = createRelation as jest.MockedFunction<typeof createRelation>;
const mockedCreateRelationFromIds = createRelationFromIds as jest.MockedFunction<typeof createRelationFromIds>;

async function mountHook() {
  const { result } = renderHook(() => useUseCasesPage());
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  return result;
}

describe('useUseCasesPage — every advertised relation target resolves', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUseCases.mockResolvedValue([SELECTED_USE_CASE]);
    mockedGetRelationsForEntities.mockResolvedValue({});
    mockedGetRelationsForEntity.mockResolvedValue([]);
    mockedCreateRelationFromIds.mockResolvedValue({ id: 'relation-1' } as never);
  });

  it.each(RELATION_TARGET_ENTITY_TYPES.map((type) => [type] as [EntityType]))(
    'creates a %s relation through the server snapshot boundary',
    async (targetType) => {
      const result = await mountHook();

      await act(async () => {
        await result.current.handleAddRelation(`target-${targetType}`, targetType, 'solves');
      });

      expect(mockedCreateRelationFromIds).toHaveBeenCalledTimes(1);
      expect(mockedCreateRelationFromIds).toHaveBeenCalledWith({
        sourceId: SELECTED_USE_CASE.id,
        sourceType: 'useCase',
        targetId: `target-${targetType}`,
        targetType,
        relationType: 'solves',
      });
      // The client must not build the snapshot itself — that is exactly the
      // path that silently accepted unresolvable types.
      expect(mockedCreateRelation).not.toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Relation Added' }));
    }
  );

  it('refreshes the sheet relations after a successful add', async () => {
    const result = await mountHook();

    await act(async () => {
      await result.current.handleAddRelation('pain-point-1', 'painPoint', 'solves');
    });

    expect(mockedGetRelationsForEntity).toHaveBeenCalledWith(SELECTED_USE_CASE.id);
  });

  // ==========================================================================
  // Failures are visible, and they REJECT
  // ==========================================================================

  it('surfaces a server-side resolution failure instead of reporting success', async () => {
    mockedCreateRelationFromIds.mockRejectedValue(new Error('PainPoint not found: ghost-1'));
    const result = await mountHook();

    await expect(
      act(async () => {
        await result.current.handleAddRelation('ghost-1', 'painPoint', 'solves');
      })
    ).rejects.toThrow('PainPoint not found: ghost-1');

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Relation Added' }));
  });

  it('names a duplicate as already linked rather than as a failure', async () => {
    mockedCreateRelationFromIds.mockRejectedValue(new DuplicateRelationApiError('already linked'));
    const result = await mountHook();

    await expect(
      act(async () => {
        await result.current.handleAddRelation('pain-point-1', 'painPoint', 'solves');
      })
    ).rejects.toBeInstanceOf(DuplicateRelationApiError);

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Already Linked' }));
  });

  it('rejects rather than writing when no use case is open', async () => {
    const result = await mountHook();

    act(() => {
      result.current.handleAddNew();
    });

    await expect(
      act(async () => {
        await result.current.handleAddRelation('pain-point-1', 'painPoint', 'solves');
      })
    ).rejects.toThrow();

    expect(mockedCreateRelationFromIds).not.toHaveBeenCalled();
  });
});
