/**
 * @file useBriefingKeyboardShortcuts.test.tsx
 * @description Pins the keyboard binding contract.
 *
 * Bindings under test (all single-key, no modifier):
 *   ↑ / ↓ — move focus, clamped to list bounds
 *   L      — onLike(focused)
 *   D      — onDismiss(focused)
 *   Enter  — onOpen(focused)
 *
 * Edge cases:
 *   - First ArrowDown with no focus anchors on the first row.
 *   - Modifier combinations (Cmd/Ctrl/Alt+L) are ignored — reserved
 *     for browser shortcuts.
 *   - Events from text-input targets are ignored.
 *   - `enabled: false` short-circuits every binding.
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { useBriefingKeyboardShortcuts } from '../useBriefingKeyboardShortcuts';
import type { BriefingInsight } from '@/hooks/useBriefing';

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

function makeInsight(id: string): BriefingInsight {
  return {
    id,
    type: 'discovery',
    title: id,
    summary: '',
    agentName: 'scout',
    confidenceScore: 0.5,
    relatedEntities: [],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
  };
}

const INSIGHTS: BriefingInsight[] = ['a', 'b', 'c'].map(makeInsight);

function dispatch(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...modifiers, bubbles: true }));
  });
}

describe('useBriefingKeyboardShortcuts', () => {
  it('anchors focus on the first row on the first ArrowDown', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    const { result } = renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    expect(result.current.focusedId).toBeNull();
    dispatch('ArrowDown');
    expect(result.current.focusedId).toBe('a');
  });

  it('moves focus down then up, clamped at the bounds', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    const { result } = renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown'); // → a
    dispatch('ArrowDown'); // → b
    dispatch('ArrowDown'); // → c
    dispatch('ArrowDown'); // clamp → c
    expect(result.current.focusedId).toBe('c');
    dispatch('ArrowUp'); // → b
    dispatch('ArrowUp'); // → a
    dispatch('ArrowUp'); // clamp → a
    expect(result.current.focusedId).toBe('a');
  });

  it('L fires onLike with the focused insight', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown'); // focus a
    dispatch('l');
    expect(actions.onLike).toHaveBeenCalledTimes(1);
    expect(actions.onLike.mock.calls[0][0].id).toBe('a');
  });

  it('uppercase L also fires onLike (case-insensitive)', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown');
    dispatch('L');
    expect(actions.onLike).toHaveBeenCalledTimes(1);
  });

  it('D fires onDismiss', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown');
    dispatch('ArrowDown'); // focus b
    dispatch('d');
    expect(actions.onDismiss).toHaveBeenCalledTimes(1);
    expect(actions.onDismiss.mock.calls[0][0].id).toBe('b');
  });

  it('Enter fires onOpen', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown');
    dispatch('Enter');
    expect(actions.onOpen).toHaveBeenCalledTimes(1);
    expect(actions.onOpen.mock.calls[0][0].id).toBe('a');
  });

  it('does nothing on L when nothing is focused', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('l');
    expect(actions.onLike).not.toHaveBeenCalled();
  });

  it('ignores Cmd/Ctrl/Alt modifier combinations', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown');
    dispatch('l', { metaKey: true });
    dispatch('l', { ctrlKey: true });
    dispatch('l', { altKey: true });
    expect(actions.onLike).not.toHaveBeenCalled();
  });

  it('skips events fired from a text input', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions }));
    dispatch('ArrowDown'); // focus a

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    });
    document.body.removeChild(input);

    expect(actions.onLike).not.toHaveBeenCalled();
  });

  it('short-circuits when `enabled: false`', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    renderHook(() => useBriefingKeyboardShortcuts({ insights: INSIGHTS, actions, enabled: false }));
    dispatch('ArrowDown');
    dispatch('l');
    dispatch('Enter');
    expect(actions.onLike).not.toHaveBeenCalled();
    expect(actions.onOpen).not.toHaveBeenCalled();
  });

  it('snaps focus back to the first row when the focused insight is filtered out', () => {
    const actions = { onLike: jest.fn(), onDismiss: jest.fn(), onOpen: jest.fn() };
    const { result, rerender } = renderHook(({ insights }) => useBriefingKeyboardShortcuts({ insights, actions }), {
      initialProps: { insights: INSIGHTS },
    });
    dispatch('ArrowDown');
    dispatch('ArrowDown'); // focus b
    expect(result.current.focusedId).toBe('b');

    // Filter b out of the visible list.
    rerender({ insights: [makeInsight('a'), makeInsight('c')] });
    dispatch('ArrowDown');
    // Hook snaps to the first visible row when the prior id is gone.
    expect(result.current.focusedId).toBe('a');
  });
});
