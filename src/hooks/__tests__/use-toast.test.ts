/**
 * Unit Tests for use-toast Hook
 *
 * Tests the toast management system:
 * - reducer: ADD_TOAST, UPDATE_TOAST, DISMISS_TOAST, REMOVE_TOAST
 * - TOAST_LIMIT enforcement (maximum 1 toast visible at a time)
 * - toast() imperative function: id generation, dismiss, update
 * - useToast() hook: subscribes to state, returns toasts + helpers
 *
 * State isolation:
 * use-toast.ts holds module-level mutable state (memoryState, listeners,
 * count). The reducer tests are pure functions and never touch that state.
 * The integration tests (toast / useToast) share one module instance; we
 * flush global state in beforeEach by dispatching REMOVE_TOAST via a
 * short-lived hook render so each test starts with an empty toasts array.
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCK: @/components/ui/toast
// The toast component is purely a UI concern; its types are not needed here.
// ============================================================================
jest.mock('@/components/ui/toast', () => ({}));

// Import AFTER the mock so the module resolves the mocked dependency.
import { reducer, useToast, toast } from '../use-toast';

// ============================================================================
// HELPERS
// ============================================================================

/** Minimal ToasterToast shape accepted by the reducer */
const baseToast = {
  id: 'test-id',
  title: 'Test Toast',
  open: true as boolean,
  onOpenChange: jest.fn() as (open: boolean) => void,
};

/**
 * Flush the shared module-level state between integration tests.
 * Renders the hook once and dispatches REMOVE_TOAST (no id → clear all),
 * then immediately unmounts. After this, memoryState.toasts === [].
 */
function flushToastState() {
  const { result, unmount } = renderHook(() => useToast());
  act(() => {
    // dismiss() with no argument calls DISMISS_TOAST (marks open=false).
    // We then need REMOVE_TOAST to actually clear from the list.
    // Access it through the imperative toast path that uses dispatch directly.
    result.current.dismiss();   // DISMISS_TOAST all (sets open=false)
    // Force-remove by calling dismiss on each toast's id — but the cleanest
    // approach is to use the fact that `dismiss` calls `addToRemoveQueue`
    // which eventually dispatches REMOVE_TOAST. Since we control fake timers
    // we skip that and just verify we get a clean render via dismiss+reset.
  });
  unmount();
}

// ============================================================================
// REDUCER TESTS
// Pure-function tests — never touch module-level state.
// ============================================================================

describe('reducer', () => {
  const emptyState: Parameters<typeof reducer>[0] = { toasts: [] };

  // --------------------------------------------------------------------------
  // ADD_TOAST
  // --------------------------------------------------------------------------

  describe('ADD_TOAST', () => {
    it('adds a toast to an empty state', () => {
      const next = reducer(emptyState, {
        type: 'ADD_TOAST',
        toast: baseToast,
      });

      expect(next.toasts).toHaveLength(1);
      expect(next.toasts[0].id).toBe('test-id');
      expect(next.toasts[0].title).toBe('Test Toast');
    });

    it('prepends the newest toast so newest appears at index 0', () => {
      // TOAST_LIMIT is 1, so the old toast is discarded and only newest survives.
      const stateWithOne: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'old', title: 'Old Toast' }],
      };
      const newToast = { ...baseToast, id: 'new', title: 'New Toast' };

      const next = reducer(stateWithOne, { type: 'ADD_TOAST', toast: newToast });

      expect(next.toasts[0].id).toBe('new');
    });

    it('enforces TOAST_LIMIT=1 — only one toast is retained', () => {
      const stateWithOne: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'first' }],
      };
      const second = { ...baseToast, id: 'second' };

      const next = reducer(stateWithOne, { type: 'ADD_TOAST', toast: second });

      expect(next.toasts).toHaveLength(1);
    });

    it('does not mutate the original state object', () => {
      const original: Parameters<typeof reducer>[0] = { toasts: [] };
      reducer(original, { type: 'ADD_TOAST', toast: baseToast });
      expect(original.toasts).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // UPDATE_TOAST
  // --------------------------------------------------------------------------

  describe('UPDATE_TOAST', () => {
    it('merges partial props into the toast matching the given id', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'abc', title: 'Original Title' }],
      };

      const next = reducer(state, {
        type: 'UPDATE_TOAST',
        toast: { id: 'abc', title: 'Updated Title' },
      });

      expect(next.toasts[0].title).toBe('Updated Title');
      expect(next.toasts[0].open).toBe(true); // other fields preserved
    });

    it('leaves toasts with non-matching ids unchanged', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'abc', title: 'Toast A' }],
      };

      const next = reducer(state, {
        type: 'UPDATE_TOAST',
        toast: { id: 'xyz', title: 'Ghost' },
      });

      expect(next.toasts[0].title).toBe('Toast A');
    });
  });

  // --------------------------------------------------------------------------
  // DISMISS_TOAST
  // --------------------------------------------------------------------------

  describe('DISMISS_TOAST', () => {
    it('sets open=false for the specified toastId', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [
          { ...baseToast, id: 'one', open: true },
          { ...baseToast, id: 'two', open: true },
        ],
      };

      const next = reducer(state, { type: 'DISMISS_TOAST', toastId: 'one' });

      expect(next.toasts.find((t) => t.id === 'one')!.open).toBe(false);
      expect(next.toasts.find((t) => t.id === 'two')!.open).toBe(true);
    });

    it('sets open=false for ALL toasts when toastId is undefined', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [
          { ...baseToast, id: 'one', open: true },
          { ...baseToast, id: 'two', open: true },
        ],
      };

      const next = reducer(state, { type: 'DISMISS_TOAST', toastId: undefined });

      expect(next.toasts.every((t) => t.open === false)).toBe(true);
    });

    it('retains the toast record (does not remove it from the array)', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'one', open: true }],
      };

      const next = reducer(state, { type: 'DISMISS_TOAST', toastId: 'one' });

      expect(next.toasts).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // REMOVE_TOAST
  // --------------------------------------------------------------------------

  describe('REMOVE_TOAST', () => {
    it('removes the toast with the matching id', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [
          { ...baseToast, id: 'one' },
          { ...baseToast, id: 'two' },
        ],
      };

      const next = reducer(state, { type: 'REMOVE_TOAST', toastId: 'one' });

      expect(next.toasts).toHaveLength(1);
      expect(next.toasts[0].id).toBe('two');
    });

    it('clears all toasts when toastId is undefined', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [
          { ...baseToast, id: 'one' },
          { ...baseToast, id: 'two' },
        ],
      };

      const next = reducer(state, { type: 'REMOVE_TOAST', toastId: undefined });

      expect(next.toasts).toHaveLength(0);
    });

    it('returns unchanged state when the id does not match any toast', () => {
      const state: Parameters<typeof reducer>[0] = {
        toasts: [{ ...baseToast, id: 'one' }],
      };

      const next = reducer(state, {
        type: 'REMOVE_TOAST',
        toastId: 'nonexistent',
      });

      expect(next.toasts).toHaveLength(1);
      expect(next.toasts[0].id).toBe('one');
    });
  });
});

// ============================================================================
// INTEGRATION TESTS: toast() + useToast()
//
// All integration tests share the same module instance. We reset global state
// before each test by rendering the hook briefly and triggering dismiss (which
// sets open=false). Because TOAST_REMOVE_DELAY is very large (1000000 ms) the
// toasts are NOT actually removed from memoryState by the timer — they stay
// in the list with open=false. For true isolation we instead track a "test
// namespace" by observing only the toast id created within each test.
//
// A simpler strategy: use fake timers and advance them past TOAST_REMOVE_DELAY
// in afterEach to fully drain the queue. This guarantees each test begins with
// an empty memoryState.
// ============================================================================

describe('toast() imperative function', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Drain any toasts left from previous test (advance past TOAST_REMOVE_DELAY)
    flushToastState();
    jest.runAllTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns an object with a string id, a dismiss function, and an update function', () => {
    const result = toast({ title: 'Hello' });

    expect(typeof result.id).toBe('string');
    expect(typeof result.dismiss).toBe('function');
    expect(typeof result.update).toBe('function');
  });

  it('generates a unique auto-incrementing id for each call', () => {
    const a = toast({ title: 'A' });
    // Dismiss first so second one is not blocked by TOAST_LIMIT
    act(() => { a.dismiss(); });
    jest.runAllTimers();

    const b = toast({ title: 'B' });

    expect(a.id).not.toBe(b.id);
  });

  it('creates a toast with open=true in the shared state', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      toast({ title: 'My Toast' });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].open).toBe(true);
    expect(result.current.toasts[0].title).toBe('My Toast');
  });

  it('dismiss() from the returned handle sets open=false for that toast', () => {
    const { result } = renderHook(() => useToast());

    let handle: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ title: 'Dismissible' });
    });

    act(() => {
      handle!.dismiss();
    });

    expect(result.current.toasts[0].open).toBe(false);
  });

  it('update() from the returned handle merges props into the existing toast', () => {
    const { result } = renderHook(() => useToast());

    let handle: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ title: 'Before' });
    });

    act(() => {
      handle!.update({ ...result.current.toasts[0], title: 'After' });
    });

    expect(result.current.toasts[0].title).toBe('After');
  });
});

describe('useToast() hook', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    flushToastState();
    jest.runAllTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns toasts array, toast function, and dismiss function', () => {
    const { result } = renderHook(() => useToast());

    expect(Array.isArray(result.current.toasts)).toBe(true);
    expect(typeof result.current.toast).toBe('function');
    expect(typeof result.current.dismiss).toBe('function');
  });

  it('starts with an empty toasts array when state has been flushed', () => {
    const { result } = renderHook(() => useToast());

    expect(result.current.toasts).toHaveLength(0);
  });

  it('reflects toasts added via toast() after the hook mounts', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      toast({ title: 'Hook test toast' });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('Hook test toast');
  });

  it('dismiss() with no argument sets open=false on all visible toasts', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      toast({ title: 'Dismissible' });
    });
    act(() => {
      result.current.dismiss();
    });

    expect(result.current.toasts[0].open).toBe(false);
  });

  it('dismiss(id) sets open=false only for the identified toast', () => {
    const { result } = renderHook(() => useToast());

    let targetId: string;
    act(() => {
      targetId = toast({ title: 'Target' }).id;
    });
    act(() => {
      result.current.dismiss(targetId!);
    });

    const target = result.current.toasts.find((t) => t.id === targetId!);
    expect(target!.open).toBe(false);
  });

  it('unsubscribes from state updates on unmount without causing errors', () => {
    const { result: live, unmount } = renderHook(() => useToast());
    unmount();

    // Dispatching after unmount must not throw a React state-update warning
    expect(() => {
      act(() => {
        toast({ title: 'After unmount' });
      });
    }).not.toThrow();

    // live.current reflects the state at the time of unmount — not updated
    void live; // referenced to avoid unused-variable lint warnings
  });
});
