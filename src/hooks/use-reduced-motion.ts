/**
 * @file use-reduced-motion.ts
 * @description Subscribe to the operator's `prefers-reduced-motion` setting.
 *
 * UX-069 — before this hook, `prefers-reduced-motion` appeared exactly once in
 * the whole `src/` tree, and only inside the Cytoscape layout path. Every other
 * animated surface ignored the preference, including the Relationship Map's
 * permanently-running directional particles.
 *
 * Uses `useSyncExternalStore` so the value is correct on the first client render
 * and stays correct if the operator changes the setting while the page is open.
 * The server snapshot is deliberately `false`: it must match the pre-hydration
 * HTML, and the media query is unknowable on the server.
 */

'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function getMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = getMediaQueryList();
  if (!list) return () => {};

  // Safari < 14 exposes only the deprecated addListener/removeListener pair.
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True when the operator has asked for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
