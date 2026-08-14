/**
 * UX-069 — `prefers-reduced-motion` appeared exactly once in the whole `src/`
 * tree before this hook, and only inside the Cytoscape layout path. Every other
 * animated surface ignored the operator's setting.
 */

import { act, renderHook } from '@testing-library/react';
import { useReducedMotion } from '../use-reduced-motion';

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  addListener?: jest.Mock;
  removeListener?: jest.Mock;
}

const originalMatchMedia = window.matchMedia;

function installMatchMedia(list: FakeMediaQueryList | null, queries: string[] = []): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: list
      ? jest.fn((query: string) => {
          queries.push(query);
          return list as unknown as MediaQueryList;
        })
      : undefined,
  });
}

function makeList(matches: boolean, modern = true): FakeMediaQueryList {
  const listeners = new Set<() => void>();
  const list: FakeMediaQueryList = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: jest.fn((_event: string, handler: () => void) => listeners.add(handler)),
    removeEventListener: jest.fn((_event: string, handler: () => void) => listeners.delete(handler)),
  };
  if (!modern) {
    delete (list as Partial<FakeMediaQueryList>).addEventListener;
    list.addListener = jest.fn((handler: () => void) => listeners.add(handler));
    list.removeListener = jest.fn((handler: () => void) => listeners.delete(handler));
  }
  // Expose a way to fire change events at the hook.
  (list as unknown as { fire: () => void }).fire = () => listeners.forEach((handler) => handler());
  return list;
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('useReducedMotion', () => {
  it('reports the operator preference on the first render', () => {
    installMatchMedia(makeList(true));
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);

    installMatchMedia(makeList(false));
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
  });

  it('subscribes to the reduce query and reacts to a live change', () => {
    const queries: string[] = [];
    const list = makeList(false);
    installMatchMedia(list, queries);

    const { result } = renderHook(() => useReducedMotion());
    expect(queries).toContain('(prefers-reduced-motion: reduce)');
    expect(result.current).toBe(false);

    act(() => {
      list.matches = true;
      (list as unknown as { fire: () => void }).fire();
    });
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount so the listener cannot outlive the component', () => {
    const list = makeList(true);
    installMatchMedia(list);
    renderHook(() => useReducedMotion()).unmount();
    expect(list.removeEventListener).toHaveBeenCalled();
  });

  it('falls back to the deprecated addListener pair for older Safari', () => {
    const list = makeList(false, false);
    installMatchMedia(list);

    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(list.addListener).toHaveBeenCalled();

    act(() => {
      list.matches = true;
      (list as unknown as { fire: () => void }).fire();
    });
    expect(result.current).toBe(true);

    unmount();
    expect(list.removeListener).toHaveBeenCalled();
  });

  it('reports no preference when matchMedia is unavailable', () => {
    installMatchMedia(null);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
  });
});
