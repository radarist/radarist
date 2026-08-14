/**
 * @file useEntityNotes.test.tsx
 * @description Locks the shared notes hook (UX-002/003/004): load-on-select,
 * committed-value local updates (add/update/delete), undefined handlers while
 * nothing is selected, and the failure contract — toast always; rethrow ONLY
 * on update (autosave/manual-save consume it); load failures surface a toast
 * and a later add re-fetches instead of masking history.
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';

const mockToast = jest.fn();
const mockGetEntityNotes = jest.fn();
const mockCreateEntityNote = jest.fn();
const mockUpdateEntityNote = jest.fn();
const mockDeleteEntityNote = jest.fn();

jest.mock('@/lib/entity-notes', () => ({
  getEntityNotes: (...args: unknown[]) => mockGetEntityNotes(...args),
  createEntityNote: (...args: unknown[]) => mockCreateEntityNote(...args),
  updateEntityNote: (...args: unknown[]) => mockUpdateEntityNote(...args),
  deleteEntityNote: (...args: unknown[]) => mockDeleteEntityNote(...args),
}));
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-1' } }),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { useEntityNotes } from '../useEntityNotes';

const NOTE = {
  id: 'n-1',
  entityId: 'p-1',
  content: 'existing',
  createdAt: 100,
  updatedAt: 100,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEntityNotes.mockResolvedValue([NOTE]);
});

describe('useEntityNotes', () => {
  it('returns [] and undefined handlers while no entity is selected', () => {
    const { result } = renderHook(() => useEntityNotes('prototypes', undefined));
    expect(result.current.notes).toEqual([]);
    expect(result.current.onAddNote).toBeUndefined();
    expect(result.current.onUpdateNote).toBeUndefined();
    expect(result.current.onDeleteNote).toBeUndefined();
    expect(mockGetEntityNotes).not.toHaveBeenCalled();
  });

  it('loads notes when an entity is selected', async () => {
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(mockGetEntityNotes).toHaveBeenCalledWith('prototypes', 'p-1');
    expect(result.current.notes[0]).toMatchObject({ id: 'n-1', content: 'existing' });
  });

  it('onAddNote prepends the committed note (with author) to local state', async () => {
    mockCreateEntityNote.mockResolvedValue({
      id: 'n-2',
      entityId: 'p-1',
      content: 'new note',
      createdBy: 'user-1',
      createdAt: 200,
      updatedAt: 200,
    });
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    await act(async () => {
      await result.current.onAddNote!('new note');
    });

    expect(mockCreateEntityNote).toHaveBeenCalledWith('prototypes', 'p-1', 'new note', 'user-1');
    expect(result.current.notes.map((n) => n.id)).toEqual(['n-2', 'n-1']);
  });

  it('onUpdateNote applies the COMMITTED updatedAt so the edited marker matches a reload', async () => {
    mockUpdateEntityNote.mockResolvedValue({ updatedAt: 999 });
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    await act(async () => {
      await result.current.onUpdateNote!('n-1', 'edited');
    });

    expect(result.current.notes[0]).toMatchObject({ content: 'edited', updatedAt: 999 });
  });

  it('onDeleteNote removes the note from local state', async () => {
    mockDeleteEntityNote.mockResolvedValue(undefined);
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    await act(async () => {
      await result.current.onDeleteNote!('n-1');
    });

    expect(result.current.notes).toEqual([]);
  });

  it('add failure: toasts WITHOUT rethrowing (click handlers have no rejection consumer)', async () => {
    mockCreateEntityNote.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    // Must resolve — a rethrow here escaped NotesTab's catch-less onClick as
    // an unhandled promise rejection (adversarial review finding #2).
    await act(async () => {
      await result.current.onAddNote!('doomed');
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // Local state untouched on failure.
    expect(result.current.notes.map((n) => n.id)).toEqual(['n-1']);
  });

  it('update failure: toasts AND rethrows (autosave + manual-save both consume the rejection)', async () => {
    mockUpdateEntityNote.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    await expect(
      act(async () => {
        await result.current.onUpdateNote!('n-1', 'doomed edit');
      })
    ).rejects.toThrow('offline');

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(result.current.notes[0].content).toBe('existing');
  });

  it('load failure: surfaces a destructive toast instead of a silent false "No notes yet"', async () => {
    mockGetEntityNotes.mockRejectedValue(new Error('read failed'));
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('load notes') })
      )
    );
    expect(result.current.notes).toEqual([]);
  });

  it('add after a failed load re-fetches the authoritative list instead of masking history', async () => {
    // Initial load fails → history unknown.
    mockGetEntityNotes.mockRejectedValueOnce(new Error('read failed'));
    const { result } = renderHook(() => useEntityNotes('prototypes', 'p-1'));
    await waitFor(() => expect(mockGetEntityNotes).toHaveBeenCalledTimes(1));

    // The add succeeds; the hook must then RE-FETCH (server list = old note +
    // the new one) rather than presenting only the new note as the history.
    mockCreateEntityNote.mockResolvedValue({
      id: 'n-2',
      entityId: 'p-1',
      content: 'new note',
      createdAt: 200,
      updatedAt: 200,
    });
    mockGetEntityNotes.mockResolvedValueOnce([
      { id: 'n-2', entityId: 'p-1', content: 'new note', createdAt: 200, updatedAt: 200 },
      NOTE,
    ]);

    await act(async () => {
      await result.current.onAddNote!('new note');
    });

    expect(mockGetEntityNotes).toHaveBeenCalledTimes(2);
    expect(result.current.notes.map((n) => n.id)).toEqual(['n-2', 'n-1']);
  });
});
