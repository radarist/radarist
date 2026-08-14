/**
 * @file useBriefingKeyboardShortcuts.ts
 * @description Keyboard shortcuts for the briefing table.
 *
 * Bindings (single-key, no modifier):
 *
 *   ↑   Move focus to the previous row
 *   ↓   Move focus to the next row
 *   L   Like / unlike the focused row
 *   D   Dismiss the focused row
 *   Enter   Open the focused row's detail page
 *
 * Scope: a global `keydown` listener that *short-circuits* when the
 * active element is a text input, textarea, or contenteditable region.
 * This is the same scope rule the signals page uses for its A / R / ↑ / ↓
 * shortcuts — single-letter shortcuts are dangerous next to text fields.
 *
 * Caller owns:
 *
 *   - The visible insight list (`insights`) — required so the hook can
 *     translate "next" / "previous" into a concrete focused id and so
 *     `L` / `D` know which insight to act on.
 *   - The dismiss / like mutations passed via the `actions` object —
 *     we don't import the hooks here to keep this file framework-pure
 *     and testable without React Query / sonner mocks.
 *   - The router for the Enter binding (same reason — keeps the hook
 *     decoupled from `next/navigation`).
 *
 * The hook returns `{ focusedId, setFocusedId }` so the table can
 * render a visual focus ring on the matching row. `null` means
 * "nothing focused yet" — the first arrow-key press focuses the first
 * row instead of `null + 1`.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BriefingInsight } from '@/hooks/useBriefing';

interface ShortcutActions {
  /** Toggle the focused row's `liked` state. Receives the live snapshot. */
  onLike: (insight: BriefingInsight) => void;
  /** Dismiss the focused row. Receives the live snapshot. */
  onDismiss: (insight: BriefingInsight) => void;
  /** Open the focused row's detail page. */
  onOpen: (insight: BriefingInsight) => void;
}

interface UseBriefingKeyboardShortcutsArgs {
  insights: BriefingInsight[];
  actions: ShortcutActions;
  /**
   * When false, the listener is registered but every event is ignored.
   * Lets a parent disable shortcuts during modal-open windows etc. without
   * tearing down + re-creating the listener.
   */
  enabled?: boolean;
}

/**
 * True when the focused element is a text input where single-letter
 * shortcuts would steal keystrokes the user actually wants to type.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useBriefingKeyboardShortcuts({ insights, actions, enabled = true }: UseBriefingKeyboardShortcutsArgs): {
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
} {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Index lookup memoised against the insights list. A re-sort or
  // filter that drops the focused row's id transparently snaps focus
  // back to "nothing" — the next ↓ press picks up the first row.
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    insights.forEach((insight, idx) => map.set(insight.id, idx));
    return map;
  }, [insights]);

  // Keep the latest values inside a ref so the keydown handler doesn't
  // need to be re-bound on every render. React's setter is stable, but
  // the actions + insights aren't, and rebinding the window listener
  // on every render would race the user's keypress.
  const stateRef = useRef({ insights, actions, focusedId, indexById });
  stateRef.current = { insights, actions, focusedId, indexById };

  const moveFocus = useCallback((delta: 1 | -1) => {
    const { insights: list, focusedId: current, indexById: index } = stateRef.current;
    if (list.length === 0) return;
    if (current === null) {
      // First arrow key — anchor on the first row regardless of delta.
      setFocusedId(list[0]?.id ?? null);
      return;
    }
    const i = index.get(current);
    if (i === undefined) {
      // Focused row got filtered out; snap to the first visible row.
      setFocusedId(list[0]?.id ?? null);
      return;
    }
    const next = Math.max(0, Math.min(list.length - 1, i + delta));
    setFocusedId(list[next]?.id ?? null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      // Ignore modifier combinations — `Cmd+L` / `Ctrl+L` are reserved
      // for the browser's address-bar focus.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const { insights: list, actions: acts, focusedId: current } = stateRef.current;
      const focused = current ? (list.find((i) => i.id === current) ?? null) : null;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(-1);
          break;
        case 'l':
        case 'L':
          if (focused) {
            event.preventDefault();
            acts.onLike(focused);
          }
          break;
        case 'd':
        case 'D':
          if (focused) {
            event.preventDefault();
            acts.onDismiss(focused);
          }
          break;
        case 'Enter':
          if (focused) {
            event.preventDefault();
            acts.onOpen(focused);
          }
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, moveFocus]);

  return { focusedId, setFocusedId };
}
