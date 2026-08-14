/**
 * @file hooks/useRadarSignalImport.ts
 * @description Owns the `?importSignal=<id>` → radar-entry import flow for the
 * Tech Radar page. Extracted from app/radar/page.tsx (ARCH-008) so the page is
 * responsible for composition while this hook owns the import state machine and
 * its adversarially-hardened invariants:
 *
 * - default a freshly-imported signal onto the radar's FIRST quadrant;
 * - persist the entry BEFORE marking the signal imported (ordering matters —
 *   the provenance back-link needs the saved Technology's real id);
 * - never reject the save just because the provenance write failed;
 * - strip `?importSignal` through the router so `useSearchParams` actually
 *   updates (a bare history.replaceState left the hook stale and re-fired the
 *   effect into an empty sheet — AUDIT-010);
 * - a `handledImportRef` dedup guard so a consumed/abandoned id can never
 *   re-open the sheet on a stale-param effect pass.
 *
 * The page injects `saveEntry` (the decoupled entries hook's raw save),
 * `setEntryToEdit` (entries-hook form state) and `openEntrySheet` (page UI
 * state); this hook wraps them.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import { getSignalById, markSignalAsImported } from '@/lib/signals-client';
import { DEFAULT_COST_TO_PROTOTYPE } from '@/lib/constants';
import { createLogger } from '@/lib/logger';
import type { QuadrantConfig, RadarEntry, RadarEntrySaveInput, Signal } from '@/lib/types';

const log = createLogger('hooks/useRadarSignalImport');

type SaveEntryFn = (entry: RadarEntrySaveInput) => Promise<RadarEntry | void>;

export interface UseRadarSignalImportParams {
  /** Currently selected radar — provenance is only written when one is active. */
  selectedRadarId: string;
  /** The selected radar's resolved quadrants; index 0 is the import default. */
  quadrants: QuadrantConfig[];
  /** The decoupled entries hook's raw save handler (originalHandleSaveEntry). */
  saveEntry: SaveEntryFn;
  /** Preset the entry form — owned by the entries hook. */
  setEntryToEdit: (entry: RadarEntry | null) => void;
  /** Open the add/edit entry sheet — owned by the page's UI state. */
  openEntrySheet: () => void;
}

export interface UseRadarSignalImportResult {
  importingSignal: Signal | null;
  /** Save wrapper that also writes signal provenance + cleans the query param. */
  handleSaveEntry: SaveEntryFn;
  /** Close the sheet without saving — clears the pending signal + query param. */
  abandonSignalImport: () => void;
}

export function useRadarSignalImport({
  selectedRadarId,
  quadrants,
  saveEntry,
  setEntryToEdit,
  openEntrySheet,
}: UseRadarSignalImportParams): UseRadarSignalImportResult {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const importSignalId = searchParams.get('importSignal');

  const [importingSignal, setImportingSignal] = useState<Signal | null>(null);
  // Once an ?importSignal id has been consumed OR abandoned, the import
  // effect must never re-fire for it — router.replace updates useSearchParams
  // asynchronously, so state alone races (adversarial findings #1/#4).
  const handledImportRef = useRef<string | null>(null);

  /** Abandoning the import (closing the sheet without saving) must clear the
   * pending signal — otherwise the NEXT unrelated manual save would write
   * this signal's provenance onto the wrong technology (adversarial #1;
   * before AUDIT-010 that mis-write was inert composite garbage, after it
   * it would be a live wrong BECAME edge). */
  const abandonSignalImport = () => {
    if (importingSignal || importSignalId) {
      handledImportRef.current = importSignalId ?? importingSignal?.id ?? null;
      setImportingSignal(null);
      router.replace(window.location.pathname, { scroll: false });
    }
  };

  const handleSaveEntry = async (entry: RadarEntrySaveInput): Promise<RadarEntry | void> => {
    const result = await saveEntry(entry);

    if (importingSignal && result && selectedRadarId) {
      // AUDIT-010: provenance must be the BARE Technology id — the old
      // `${radarId}:${legacyHash}` composite matched nothing downstream, so
      // the Signal→Technology BECAME edge was silently never created and two
      // Firestore consumers mis-resolved. Skip (loudly) rather than write a
      // garbage id when the save path didn't surface the real id.
      const technologyId = (result as { technologyId?: string }).technologyId;
      handledImportRef.current = importingSignal.id;
      if (technologyId) {
        try {
          await markSignalAsImported(importingSignal.id, 'technology', technologyId);
        } catch (provenanceError) {
          // The ENTRY was saved — only the signal back-link failed. Don't
          // reject (that would show a lying "Failed to save entry" toast and
          // a dead-end retry, adversarial #6); say what actually happened.
          log.error(
            'Signal import: entry saved but provenance write failed',
            provenanceError instanceof Error ? provenanceError : new Error(String(provenanceError)),
            { signalId: importingSignal.id, technologyId }
          );
          toast({
            title: 'Entry added, signal link failed',
            description: 'The technology is on the radar, but the signal could not be marked imported.',
            variant: 'destructive',
          });
        }
      } else {
        log.warn('Signal import: save returned no technologyId — provenance not written', {
          signalId: importingSignal.id,
        });
      }
      setImportingSignal(null);
      // Strip the ?importSignal param via the ROUTER so useSearchParams
      // actually updates — a bare history.replaceState left the hook stale,
      // and once importingSignal reset the import effect re-fired and
      // reopened an empty sheet (found live in the AUDIT-010 Playwright
      // pass). Keeping the current pathname also preserves the sidebar
      // active state on /visualizations/radar (AUDIT-012).
      router.replace(window.location.pathname, { scroll: false });
    }

    return result;
  };

  useEffect(() => {
    if (importSignalId && !importingSignal && handledImportRef.current !== importSignalId) {
      getSignalById(importSignalId).then((signal) => {
        // Already-imported signals never (re)open the import sheet — guards
        // both a deep link to a consumed signal and any residual stale-param
        // re-fire of this effect.
        if (signal && signal.status !== 'Imported') {
          setImportingSignal(signal);
          // Default to the radar's first quadrant — user can change via the
          // entry form before saving.
          setEntryToEdit({
            id: 0,
            name: signal.title,
            description: signal.description,
            quadrantId: quadrants[0]?.id ?? '',
            ring: 'Assess',
            tags: [],
            status: 'Stable',
            costToPrototype: DEFAULT_COST_TO_PROTOTYPE,
            history: [],
          });
          openEntrySheet();
        }
      });
    }
    // Intentionally NOT depending on quadrants/setEntryToEdit/openEntrySheet:
    // quadrants and openEntrySheet get a fresh identity every render, so
    // depending on them would re-run this import effect on every render and
    // reopen the sheet. The effect must fire ONLY when the target signal id or
    // the in-progress signal changes; the first-quadrant/callback values are
    // read via closure at that moment, matching the pre-extraction behaviour.
  }, [importSignalId, importingSignal]);

  return { importingSignal, handleSaveEntry, abandonSignalImport };
}
