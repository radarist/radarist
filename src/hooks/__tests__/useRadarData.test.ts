/**
 * Unit Tests for useRadarData Hook
 *
 * Covers the minimal radar-metadata surface that survived D4.2:
 * - Initial loading state
 * - Real-time radar fetching via onSnapshot
 * - Auto-selection of first radar
 * - handleCreateRadar delegates to the canonical createRadar service
 * - handleRenameRadar updates the radar doc
 * - handleDeleteRadar delegates to the deleteRadar service
 * - handleSaveSettings delegates to updateRadarQuadrants
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

type SnapshotCallback = (snapshot: MockQuerySnapshot) => void;
const onSnapshotCallbacks: SnapshotCallback[] = [];
const unsubscribeFns: jest.Mock[] = [];

interface MockDocData {
  id?: string;
  [key: string]: unknown;
}

interface MockDoc {
  data: () => MockDocData;
  id: string;
  ref: { path: string };
}

interface MockQuerySnapshot {
  docs: MockDoc[];
  empty: boolean;
  forEach: (cb: (doc: MockDoc) => void) => void;
  size: number;
}

function createMockSnapshot(docs: MockDocData[]): MockQuerySnapshot {
  const mockDocs: MockDoc[] = docs.map((d) => ({
    data: () => d,
    id: (d.id as string) ?? 'mock-id',
    ref: { path: `radars/${d.id ?? 'mock-id'}` },
  }));
  return {
    docs: mockDocs,
    empty: docs.length === 0,
    forEach: (cb: (doc: MockDoc) => void) => mockDocs.forEach(cb),
    size: docs.length,
  };
}

jest.mock('@/lib/logger', () => {
  const _mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => _mockLogger) };
});

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/lib/constants', () => ({
  DEFAULT_QUADRANTS: ['Techniques', 'Tools', 'Platforms', 'Languages & Frameworks'],
  MIN_QUADRANTS: 1,
  MAX_QUADRANTS: 8,
  buildDefaultQuadrantConfigs: () => [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ],
}));

const mockUpdateRadarQuadrants = jest.fn().mockResolvedValue({ radar: {}, reassigned: 0, deleted: 0 });
const mockCreateRadar = jest.fn(async (name: string, _description?: string, quadrants?: unknown[]) => ({
  id: name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, ''),
  name,
  slug: name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, ''),
  description: '',
  quadrants: quadrants ?? [],
  entries: [],
  createdAt: 0,
  updatedAt: 0,
}));
jest.mock('@/lib/radars', () => ({
  __esModule: true,
  updateRadarQuadrants: (...args: unknown[]) => mockUpdateRadarQuadrants(...args),
  createRadar: (...args: unknown[]) => mockCreateRadar(...(args as [string, string?, unknown[]?])),
}));

// LOCAL-010: deletion goes through the server-owned authenticated route, not
// the client-SDK service.
const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

jest.mock('@/lib/entity-factory', () => ({
  __esModule: true,
  DuplicateEntityError: class extends Error {
    existingId: string;
    constructor(_entityType: string, _field: string, _value: string, existingId: string) {
      super('duplicate entity');
      this.existingId = existingId;
    }
  },
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockGetDocs = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDoc = jest.fn((..._args: unknown[]) => ({ id: 'doc-ref', path: 'mock-path' }));
const mockCollection = jest.fn();
const mockQuery = jest.fn((...args: unknown[]) => args[0]);
const mockOnSnapshot = jest.fn((_queryRef: unknown, callback: SnapshotCallback) => {
  onSnapshotCallbacks.push(callback);
  const unsub = jest.fn();
  unsubscribeFns.push(unsub);
  return unsub;
});

const mockBatchSet = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: (...args: unknown[]) => mockCollection(...args),
  doc: (...args: unknown[]) => mockDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  onSnapshot: (...args: unknown[]) => mockOnSnapshot(args[0], args[1] as SnapshotCallback),
  writeBatch: () => ({
    set: mockBatchSet,
    commit: mockBatchCommit,
  }),
}));

import { useRadarData } from '../useRadarData';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// UX-043: the hook now invalidates radar-derived TanStack queries after a
// quadrant-config save, so renders need a QueryClientProvider — exactly like
// the app shell provides.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children);

// ============================================================================
// TESTS
// ============================================================================

describe('useRadarData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    onSnapshotCallbacks.length = 0;
    unsubscribeFns.length = 0;
    mockGetDocs.mockResolvedValue(createMockSnapshot([{ id: 'existing-radar' }]));
    mockUpdateDoc.mockResolvedValue(undefined);
  });

  describe('initial state', () => {
    it('starts with isLoading true', () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      expect(result.current.isLoading).toBe(true);
    });

    it('starts with empty radars array', () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      expect(result.current.radars).toEqual([]);
    });

    it('starts with empty selectedRadarId', () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      expect(result.current.selectedRadarId).toBe('');
    });
  });

  describe('radar fetching', () => {
    it('subscribes to the radars collection via onSnapshot', async () => {
      renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
    });

    it('sets radars and isLoading=false when snapshot fires', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](createMockSnapshot([{ id: 'radar-1', name: 'Radar 1', quadrants: ['Q1', 'Q2'] }]));
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.radars).toHaveLength(1);
    });

    it('auto-selects the first radar when none is selected', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](
          createMockSnapshot([
            { id: 'radar-1', name: 'Radar 1' },
            { id: 'radar-2', name: 'Radar 2' },
          ])
        );
      });
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));
    });

    it('clears selectedRadarId when snapshot is empty', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => onSnapshotCallbacks[0](createMockSnapshot([])));
      await waitFor(() => expect(result.current.selectedRadarId).toBe(''));
    });
  });

  describe('blank workspace (LOCAL-010)', () => {
    it('never seeds radars when the collection is empty', async () => {
      mockGetDocs.mockResolvedValue(createMockSnapshot([]));
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => onSnapshotCallbacks[0](createMockSnapshot([])));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // A blank workspace stays blank: no probe read, no seed batch write.
      expect(mockGetDocs).not.toHaveBeenCalled();
      expect(mockBatchSet).not.toHaveBeenCalled();
      expect(mockBatchCommit).not.toHaveBeenCalled();
      expect(result.current.radars).toEqual([]);
      expect(result.current.selectedRadarId).toBe('');
    });
  });

  describe('handleCreateRadar', () => {
    it('delegates to the canonical createRadar service', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      let outcome;
      await act(async () => {
        outcome = await result.current.handleCreateRadar('My New Radar');
      });
      expect(mockCreateRadar).toHaveBeenCalledWith('My New Radar', undefined, expect.any(Array));
      expect(outcome).toEqual({ ok: true });
    });

    it('optimistically selects the new radar', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await act(async () => {
        await result.current.handleCreateRadar('Fresh Radar');
      });
      await waitFor(() => expect(result.current.selectedRadarId).toBe('fresh-radar'));
    });

    it('shows a toast when the radar already exists', async () => {
      const { DuplicateEntityError } = jest.requireMock('@/lib/entity-factory') as {
        DuplicateEntityError: typeof Error;
      };
      mockCreateRadar.mockRejectedValueOnce(
        new (DuplicateEntityError as unknown as new (a: string, b: string, c: string, d: string) => Error)(
          'radar',
          'name',
          'Dup',
          'existing-id'
        )
      );
      const { result } = renderHook(() => useRadarData(), { wrapper });
      let outcome;
      await act(async () => {
        outcome = await result.current.handleCreateRadar('Dup');
      });
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Radar already exists', variant: 'destructive' })
      );
      expect(outcome).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/different name/i) }));
    });
  });

  describe('handleRenameRadar', () => {
    it('updates the radar doc with the new name', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](createMockSnapshot([{ id: 'radar-1', name: 'Old' }]));
      });
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));
      let outcome;
      await act(async () => {
        outcome = await result.current.handleRenameRadar('New Name');
      });
      expect(mockUpdateDoc).toHaveBeenCalledWith(expect.anything(), { name: 'New Name' });
      expect(outcome).toEqual({ ok: true });
    });

    it('does nothing when no radar is selected', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      let outcome;
      await act(async () => {
        outcome = await result.current.handleRenameRadar('Whatever');
      });
      expect(mockUpdateDoc).not.toHaveBeenCalled();
      expect(outcome).toEqual(expect.objectContaining({ ok: false }));
    });

    it('restores the optimistic name when the backend rename fails', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](createMockSnapshot([{ id: 'radar-1', name: 'Old name' }]));
      });
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));
      mockUpdateDoc.mockRejectedValueOnce(new Error('backend unavailable'));

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.handleRenameRadar('Optimistic name');
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ message: 'backend unavailable' }));
      expect(result.current.radars[0].name).toBe('Old name');
    });
  });

  describe('handleDeleteRadar (LOCAL-010 server-owned boundary)', () => {
    async function renderWithRadars(radars: MockDocData[]) {
      const rendered = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](createMockSnapshot(radars));
      });
      await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
      return rendered;
    }

    it('deletes through the authenticated server route and reselects the next radar', async () => {
      mockFetchWithAuth.mockResolvedValue(jsonResponse(200, { ok: true, radarId: 'radar-1', placementsDeleted: 2 }));
      const { result } = await renderWithRadars([
        { id: 'radar-1', name: 'A' },
        { id: 'radar-2', name: 'B' },
      ]);
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.handleDeleteRadar();
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/radars/radar-1', { method: 'DELETE' });
      expect(outcome).toEqual({ ok: true });
      expect(result.current.radars.map((r) => r.id)).toEqual(['radar-2']);
      expect(result.current.selectedRadarId).toBe('radar-2');
    });

    it('allows deleting the final radar into an empty workspace', async () => {
      mockFetchWithAuth.mockResolvedValue(jsonResponse(200, { ok: true, radarId: 'only-radar', placementsDeleted: 0 }));
      const { result } = await renderWithRadars([{ id: 'only-radar', name: 'Only' }]);
      await waitFor(() => expect(result.current.selectedRadarId).toBe('only-radar'));

      let outcome;
      await act(async () => {
        outcome = await result.current.handleDeleteRadar();
      });

      expect(outcome).toEqual({ ok: true });
      expect(result.current.radars).toEqual([]);
      expect(result.current.selectedRadarId).toBe('');
    });

    it('keeps the radar visible and reports the error when the server fails', async () => {
      mockFetchWithAuth.mockResolvedValue(
        jsonResponse(502, { error: 'Failed to schedule radar graph cleanup: dev server unreachable', retryable: true })
      );
      const { result } = await renderWithRadars([
        { id: 'radar-1', name: 'A' },
        { id: 'radar-2', name: 'B' },
      ]);
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));

      let outcome: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        outcome = await result.current.handleDeleteRadar();
      });

      // No optimistic success: the radar stays listed and selected.
      expect(outcome).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/graph cleanup/) }));
      expect(result.current.radars.map((r) => r.id)).toEqual(['radar-1', 'radar-2']);
      expect(result.current.selectedRadarId).toBe('radar-1');
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it('keeps the radar visible when the network request itself throws', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('network down'));
      const { result } = await renderWithRadars([{ id: 'radar-1', name: 'A' }]);
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));

      let outcome: { ok: boolean } | undefined;
      await act(async () => {
        outcome = await result.current.handleDeleteRadar();
      });

      expect(outcome).toEqual(expect.objectContaining({ ok: false }));
      expect(result.current.radars.map((r) => r.id)).toEqual(['radar-1']);
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it('treats 404 as an already-converged deletion and removes the radar locally', async () => {
      mockFetchWithAuth.mockResolvedValue(jsonResponse(404, { error: 'Radar radar-1 not found', code: 'not-found' }));
      const { result } = await renderWithRadars([
        { id: 'radar-1', name: 'A' },
        { id: 'radar-2', name: 'B' },
      ]);
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));

      let outcome;
      await act(async () => {
        outcome = await result.current.handleDeleteRadar();
      });

      expect(outcome).toEqual({ ok: true });
      expect(result.current.radars.map((r) => r.id)).toEqual(['radar-2']);
    });
  });

  describe('handleSaveSettings', () => {
    it('delegates quadrant changes to updateRadarQuadrants', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await waitFor(() => expect(onSnapshotCallbacks.length).toBeGreaterThan(0));
      act(() => {
        onSnapshotCallbacks[0](createMockSnapshot([{ id: 'radar-1', name: 'A' }]));
      });
      await waitFor(() => expect(result.current.selectedRadarId).toBe('radar-1'));

      const newQuadrants = [{ id: 'q_a', name: 'A', order: 0 }];
      await act(async () => {
        await result.current.handleSaveSettings(newQuadrants, 'Standard');
      });
      expect(mockUpdateRadarQuadrants).toHaveBeenCalledWith('radar-1', newQuadrants, {});
      expect(mockUpdateDoc).toHaveBeenCalledWith(expect.anything(), { ringSystem: 'Standard' });
    });

    it('does nothing when no radar is selected', async () => {
      const { result } = renderHook(() => useRadarData(), { wrapper });
      await act(async () => {
        await result.current.handleSaveSettings([], 'Standard');
      });
      expect(mockUpdateRadarQuadrants).not.toHaveBeenCalled();
    });
  });
});
