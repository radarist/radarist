import { useState, useEffect } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useRadarData');
import { collection, onSnapshot, query, doc, updateDoc } from 'firebase/firestore';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { db } from '@/lib/firebase';
import type { RadarData, RadarManagementResult, QuadrantConfig, RingSystem } from '@/lib/types';
import { isQuadrantConfig } from '@/lib/types';
import { createRadar } from '@/lib/radars';
import { DuplicateEntityError } from '@/lib/entity-factory';
import { useToast } from '@/hooks/use-toast';
import { buildDefaultQuadrantConfigs } from '@/lib/constants';
import { radarKeys, technologyKeys } from '@/lib/query-keys';

/**
 * Invalidate the TanStack caches derived from one radar's quadrant config
 * (UX-043). The entries sidebar resolves quadrant names through the cached
 * `radarKeys.detail` radar and the cached placements list; a quadrant
 * rename/reorder/delete must refresh both or the sidebar keeps serving the
 * stale pre-edit names while the canvas (live onSnapshot) shows the new ones.
 */
export function invalidateRadarDerivedQueries(queryClient: QueryClient, radarId: string): void {
  void queryClient.invalidateQueries({ queryKey: radarKeys.detail(radarId) });
  void queryClient.invalidateQueries({ queryKey: technologyKeys.withPlacements(radarId) });
}

/**
 * Custom hook to manage Radar (board) metadata.
 *
 * Returns the list of radars, plus create/rename/delete/save-settings handlers.
 * Radar entries themselves come from the decoupled `Technology` +
 * `RadarPlacement` collections via `useRadarEntriesDecoupled` — see
 * `/app/radar/page.tsx`.
 */
export function useRadarData() {
  const [radars, setRadars] = useState<Omit<RadarData, 'entries'>[]>([]);
  const [selectedRadarId, setSelectedRadarId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  /**
   * Triggers a data refresh by incrementing a counter.
   */
  const refresh = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  // LOCAL-010: an empty radars collection is a valid, durable state. Showcase
  // data is seeded only by the explicit `--showcase` startup profile
  // (`scripts/seed-demo.ts`); the client never writes seed radars.

  // Fetch Radars
  useEffect(() => {
    const radarsQuery = query(collection(db, 'radars'));
    const unsubscribeRadars = onSnapshot(radarsQuery, (snapshot) => {
      const fetchedRadars = snapshot.docs.map((doc) => {
        const raw = doc.data() as Record<string, unknown>;
        // Normalize legacy string[] quadrants to QuadrantConfig[] on read so
        // display code is always strict. This is crash-avoidance, not dual-read —
        // post-migration all radar docs already have the new shape.
        const rawQuadrants = raw.quadrants;
        if (Array.isArray(rawQuadrants) && rawQuadrants.length > 0 && !isQuadrantConfig(rawQuadrants[0])) {
          const migrated: QuadrantConfig[] = (rawQuadrants as unknown[]).map((name, i) => ({
            id: `legacy-${i}`,
            name: String(name),
            order: i,
          }));
          return { ...(raw as object), quadrants: migrated } as unknown as Omit<RadarData, 'entries'>;
        }
        return raw as unknown as Omit<RadarData, 'entries'>;
      });
      setRadars(fetchedRadars);

      if (fetchedRadars.length > 0 && !selectedRadarId) {
        setSelectedRadarId(fetchedRadars[0].id);
      } else if (snapshot.empty) {
        setSelectedRadarId('');
      }
      setIsLoading(false);
    });

    return () => unsubscribeRadars();
  }, [selectedRadarId, refreshTrigger]);

  /**
   * Creates a new radar.
   *
   * @param name - The name of the new radar.
   */
  const handleCreateRadar = async (name: string): Promise<RadarManagementResult> => {
    const defaultConfigs = buildDefaultQuadrantConfigs();

    // Delegate to the canonical createRadar service: it stamps createdAt/
    // updatedAt, generates a slug-prefixed timestamped id, validates the
    // quadrant configs, and uses a transaction with duplicate-slug detection.
    let newRadar: RadarData;
    try {
      newRadar = await createRadar(name, undefined, defaultConfigs);
    } catch (e) {
      if (e instanceof DuplicateEntityError) {
        toast({
          title: 'Radar already exists',
          description: `A radar with the name "${name}" already exists.`,
          variant: 'destructive',
        });
        return { ok: false, error: `A radar named "${name}" already exists. Choose a different name.` };
      }
      throw e;
    }

    // Optimistic UI update — onSnapshot will reconcile shortly, but updating
    // immediately makes the UI feel responsive.
    setRadars((prev) => [...prev, { id: newRadar.id, name: newRadar.name, quadrants: newRadar.quadrants }]);
    setSelectedRadarId(newRadar.id);
    return { ok: true };
  };

  /**
   * Renames the currently selected radar.
   *
   * @param newName - The new name for the radar.
   */
  const handleRenameRadar = async (newName: string): Promise<RadarManagementResult> => {
    if (!selectedRadarId) {
      return { ok: false, error: 'The selected radar is no longer available. Refresh and try again.' };
    }

    const previousName = radars.find((radar) => radar.id === selectedRadarId)?.name;
    if (!previousName) {
      return { ok: false, error: 'The selected radar is no longer available. Refresh and try again.' };
    }

    // Optimistic UI update
    setRadars((prev) => prev.map((r) => (r.id === selectedRadarId ? { ...r, name: newName } : r)));

    // Firestore update
    const radarDocRef = doc(db, 'radars', selectedRadarId);
    try {
      await updateDoc(radarDocRef, { name: newName });
      return { ok: true };
    } catch (error) {
      // Only undo this operation's optimistic value. A newer snapshot or
      // rename must not be overwritten by a late failed request.
      setRadars((prev) =>
        prev.map((radar) =>
          radar.id === selectedRadarId && radar.name === newName ? { ...radar, name: previousName } : radar
        )
      );
      throw error;
    }
  };

  /**
   * Deletes the currently selected radar through the server-owned,
   * authenticated boundary (LOCAL-010): `DELETE /api/radars/:radarId`.
   *
   * The server orders relations → placements → required graph handoff →
   * radar doc and fails closed before removing the doc if the handoff was
   * not accepted. This handler therefore never reports optimistic success:
   * the radar disappears from local state only after the server confirmed
   * the deletion (or reported it already converged with 404). On failure the
   * radar stays listed and the error is surfaced as retryable.
   */
  const handleDeleteRadar = async (): Promise<RadarManagementResult> => {
    if (!selectedRadarId) {
      return { ok: false, error: 'The selected radar is no longer available. Refresh and try again.' };
    }

    const radarIdToDelete = selectedRadarId;

    let failure: string;
    try {
      const { fetchWithAuth } = await import('@/lib/fetch-with-auth');
      const response = await fetchWithAuth(`/api/radars/${encodeURIComponent(radarIdToDelete)}`, {
        method: 'DELETE',
      });

      if (response.ok || response.status === 404) {
        // 404 = the doc is already gone (deletion converged earlier). Either
        // way the server says this radar no longer exists — reflect it now;
        // onSnapshot reconciles shortly after.
        const remainingRadars = radars.filter((r) => r.id !== radarIdToDelete);
        setRadars(remainingRadars);
        setSelectedRadarId(remainingRadars.length > 0 ? remainingRadars[0].id : '');
        return { ok: true };
      }

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      failure = body.error ?? `Radar deletion failed (HTTP ${response.status})`;
    } catch (error) {
      log.error('Error deleting radar', error instanceof Error ? error : new Error(String(error)), {
        radarId: radarIdToDelete,
      });
      failure = error instanceof Error ? error.message : String(error);
    }

    toast({
      title: 'Radar not deleted',
      description: `${failure} — the radar is unchanged and it is safe to retry.`,
      variant: 'destructive',
    });
    return { ok: false, error: failure };
  };

  /**
   * Updates the settings (quadrants, ring system) for the currently selected radar.
   *
   * Routes quadrant changes through the orphan-aware `updateRadarQuadrants`
   * service so the caller gets a chance to resolve orphaned placements
   * before the shrink is committed. If orphans exist and the caller has not
   * provided a resolution plan via `reassignBeforeShrinking`, the service
   * throws `OrphanedPlacementsError` — the SettingsDialog catches it and
   * opens the resolution modal.
   *
   * @param newQuadrants - The new set of quadrants (1–8).
   * @param newRingSystem - The new ring system configuration.
   * @param options - Optional orphan-handling instructions. Pass
   *   `{ reassignments: { [oldId]: newId } }` to move orphaned placements to
   *   a surviving quadrant, or `{ deleteOrphans: true }` to delete them.
   */
  const handleSaveSettings = async (
    newQuadrants: QuadrantConfig[],
    newRingSystem: RingSystem,
    options?: { reassignments?: Record<string, string>; deleteOrphans?: boolean }
  ) => {
    if (!selectedRadarId) return;

    // Delegate the quadrant write to `updateRadarQuadrants` — orphan-aware,
    // validates 1–8 range, mints missing ids, and runs the Firestore batch
    // for any reassignments/deletions. Any ring-system change is written
    // AFTER the quadrant update succeeds so we never half-commit.
    const { updateRadarQuadrants } = await import('@/lib/radars');
    const { radar: updatedRadar } = await updateRadarQuadrants(selectedRadarId, newQuadrants, options ?? {});

    // Ring system isn't part of updateRadarQuadrants — update it separately.
    const radarDocRef = doc(db, 'radars', selectedRadarId);
    await updateDoc(radarDocRef, { ringSystem: newRingSystem });

    // UX-043: the entries sidebar derives quadrant names from the cached
    // radar detail + placements queries — refresh them so a quadrant
    // rename/reorder/delete (incl. orphan reassignment) shows immediately.
    invalidateRadarDerivedQueries(queryClient, selectedRadarId);

    // Optimistic UI update for the ring system only — quadrants come back
    // via the onSnapshot subscription after the service write.
    setRadars((prev) =>
      prev.map((r) =>
        r.id === selectedRadarId ? { ...r, quadrants: updatedRadar.quadrants, ringSystem: newRingSystem } : r
      )
    );
  };

  return {
    radars,
    selectedRadarId,
    setSelectedRadarId,
    isLoading,
    handleCreateRadar,
    handleRenameRadar,
    handleDeleteRadar,
    handleSaveSettings,
    refresh,
  };
}
