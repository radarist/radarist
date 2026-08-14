/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { Technology } from '@/lib/types';
import type { TechnologyWithRadar } from '@/lib/technologies';

const mockToast = jest.fn();
const mockInvalidateQueries = jest.fn();

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'local-user' } }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/hooks/useDataRefresh', () => ({
  useDataRefresh: jest.fn(),
}));

jest.mock('@/hooks/useSheetUrl', () => ({
  useControlledSheet: () => ({
    selectedEntity: undefined,
    isOpen: false,
    open: jest.fn(),
    close: jest.fn(),
  }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock('@/lib/radar-placement-service', () => ({
  getAllTechnologiesWithPlacements: jest.fn(),
}));

jest.mock('@/lib/technology-service', () => ({
  getTechnologies: jest.fn(),
  createTechnology: jest.fn(),
  updateTechnology: jest.fn(),
  updateTechnologyWithSync: jest.fn(),
}));

jest.mock('@/lib/relations', () => ({
  getRelationsForEntities: jest.fn(),
  createRelationFromIds: jest.fn(),
  deleteRelation: jest.fn(),
}));

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  parseTechnologyDeleteResponse,
  useTechnologiesPage,
} from '../useTechnologiesPage';
import { getAllTechnologiesWithPlacements } from '@/lib/radar-placement-service';
import { getTechnologies } from '@/lib/technology-service';
import { getRelationsForEntities } from '@/lib/relations';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

const mockedGetPlacements = getAllTechnologiesWithPlacements as jest.MockedFunction<
  typeof getAllTechnologiesWithPlacements
>;
const mockedGetTechnologies = getTechnologies as jest.MockedFunction<typeof getTechnologies>;
const mockedGetRelations = getRelationsForEntities as jest.MockedFunction<typeof getRelationsForEntities>;
const mockedFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

const TECHNOLOGIES = [
  {
    id: 'tech-alpha',
    name: 'Alpha',
    description: '',
    category: 'Platform',
    tags: [],
    websiteUrl: 'https://alpha.example',
    githubUrl: 'https://github.com/example/alpha',
    documentationUrl: 'https://docs.alpha.example',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'tech-beta',
    name: 'Beta',
    description: '',
    category: 'Platform',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
] as unknown as Technology[];

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetPlacements.mockResolvedValue([]);
  mockedGetTechnologies.mockResolvedValue(TECHNOLOGIES);
  mockedGetRelations.mockResolvedValue({});
});

describe('parseTechnologyDeleteResponse', () => {
  it('accepts an exact success/failure partition', () => {
    expect(
      parseTechnologyDeleteResponse(
        {
          success: false,
          deleted: 1,
          failed: ['tech-beta'],
          relationsDeleted: 2,
          placementsDeleted: 1,
        },
        ['tech-alpha', 'tech-beta']
      )
    ).toEqual({
      success: false,
      deleted: 1,
      failed: ['tech-beta'],
      relationsDeleted: 2,
      placementsDeleted: 1,
    });
  });

  it.each([
    {
      success: true,
      deleted: 1,
      failed: ['tech-beta'],
      relationsDeleted: 0,
      placementsDeleted: 0,
    },
    {
      success: false,
      deleted: 1,
      failed: ['unknown'],
      relationsDeleted: 0,
      placementsDeleted: 0,
    },
    {
      success: false,
      deleted: 0,
      failed: ['tech-beta'],
      relationsDeleted: 0,
      placementsDeleted: 0,
    },
  ])('rejects an incomplete or contradictory acknowledgement', (body) => {
    expect(() => parseTechnologyDeleteResponse(body, ['tech-alpha', 'tech-beta'])).toThrow(
      'bulk delete acknowledgement'
    );
  });
});

describe('useTechnologiesPage deletion outcomes', () => {
  async function renderLoadedHook() {
    const hook = renderHook(() => useTechnologiesPage());
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    expect(hook.result.current.paginatedTechnologies).toHaveLength(2);
    return hook;
  }

  async function selectAll(
    result: { current: ReturnType<typeof useTechnologiesPage> }
  ): Promise<void> {
    await act(async () => {
      result.current.handleSelectAllChange(
        true,
        result.current.paginatedTechnologies as TechnologyWithRadar[]
      );
    });
  }

  it('preserves links when adapting a library-only technology for the sheet', async () => {
    const { result } = await renderLoadedHook();

    expect(result.current.paginatedTechnologies[0]).toEqual(
      expect.objectContaining({
        websiteUrl: 'https://alpha.example',
        githubUrl: 'https://github.com/example/alpha',
        documentationUrl: 'https://docs.alpha.example',
      })
    );
  });

  it('retains only failed IDs and keeps the bulk dialog open for retry', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      response({
        success: false,
        deleted: 1,
        failed: ['tech-beta'],
        relationsDeleted: 1,
        placementsDeleted: 2,
      })
    );
    const { result } = await renderLoadedHook();
    await selectAll(result);

    let shouldClose = true;
    await act(async () => {
      shouldClose = await result.current.handleBulkDelete();
    });

    expect(shouldClose).toBe(false);
    expect(result.current.selectedIds).toEqual(['tech-beta']);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Technologies Partially Deleted',
        variant: 'destructive',
      })
    );
    expect(JSON.parse(String(mockedFetchWithAuth.mock.calls[0]?.[1]?.body))).toEqual({
      ids: ['tech-alpha', 'tech-beta'],
    });
  });

  it('retains the full selection when the acknowledgement is malformed', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      response({
        success: true,
        deleted: 2,
        relationsDeleted: 0,
        placementsDeleted: 0,
      })
    );
    const { result } = await renderLoadedHook();
    await selectAll(result);

    let shouldClose = true;
    await act(async () => {
      shouldClose = await result.current.handleBulkDelete();
    });

    expect(shouldClose).toBe(false);
    expect(result.current.selectedIds).toEqual(['tech-alpha', 'tech-beta']);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Error', variant: 'destructive' })
    );
  });

  it('keeps a single-delete dialog retryable when its parent was retained', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      response({
        success: false,
        deleted: 0,
        failed: ['tech-alpha'],
        relationsDeleted: 1,
        placementsDeleted: 0,
      })
    );
    const { result } = await renderLoadedHook();

    act(() => {
      result.current.handleDeleteTechnologyClick(result.current.paginatedTechnologies[0]);
    });

    let shouldClose = true;
    await act(async () => {
      shouldClose = await result.current.handleDeleteTechnology();
    });

    expect(shouldClose).toBe(false);
    expect(result.current.showDeleteDialog).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Technology Not Deleted', variant: 'destructive' })
    );
  });

  it('deletes an explicit sheet subject without opening the row confirmation dialog', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      response({
        success: true,
        deleted: 1,
        failed: [],
        relationsDeleted: 1,
        placementsDeleted: 2,
      })
    );
    const { result } = await renderLoadedHook();
    const target = result.current.paginatedTechnologies[0];

    let shouldClose = false;
    await act(async () => {
      shouldClose = await result.current.handleDeleteTechnology(target);
    });

    expect(shouldClose).toBe(true);
    expect(result.current.showDeleteDialog).toBe(false);
    expect(JSON.parse(String(mockedFetchWithAuth.mock.calls[0]?.[1]?.body))).toEqual({
      ids: ['tech-alpha'],
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Technology Deleted',
        description: expect.stringContaining('1 relation'),
      })
    );
  });

  it('clears selection and permits close only after complete acknowledgement', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      response({
        success: true,
        deleted: 2,
        failed: [],
        relationsDeleted: 0,
        placementsDeleted: 0,
      })
    );
    const { result } = await renderLoadedHook();
    await selectAll(result);

    let shouldClose = false;
    await act(async () => {
      shouldClose = await result.current.handleBulkDelete();
    });

    expect(shouldClose).toBe(true);
    expect(result.current.selectedIds).toEqual([]);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Technologies Deleted' })
    );
  });
});
