/**
 * @file briefing-ui-store.ts
 * @description Zustand store for UI preferences on the briefing surface.
 *
 * Currently scoped to one thing: `viewMode` (table | card). Persisted to
 * localStorage so the toggle survives reloads — making it a Zustand
 * store rather than a `useState` keeps the same instance addressable
 * from both the toolbar (which sets it) and the feed (which reads it),
 * without prop-drilling through layers we don't otherwise need to share.
 *
 * Why not URL state for viewMode: a URL parameter would make every
 * `viewMode` flip create a history entry, and copying a `/briefing?view=card`
 * link off to a colleague would force them into your preference. Local
 * preference, not shareable state.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type BriefingViewMode = 'table' | 'card';

interface BriefingUIState {
  viewMode: BriefingViewMode;
  setViewMode: (mode: BriefingViewMode) => void;
}

export const useBriefingUIStore = create<BriefingUIState>()(
  persist(
    (set) => ({
      // Default is `table` per plan §5.1 — the table is the new primary
      // surface. Card view stays available for parity with signals.
      viewMode: 'table',
      setViewMode: (mode) => set({ viewMode: mode }),
    }),
    {
      name: 'briefing-ui',
      storage: createJSONStorage(() => localStorage),
      // Persist only `viewMode` — `setViewMode` is a function, not data,
      // so partialize would otherwise emit a useless field on disk.
      partialize: (state) => ({ viewMode: state.viewMode }),
    }
  )
);
