'use client';

import { useEffect, useState } from 'react';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';

const log = createLogger('shared-radar');
import { ShareableRadarLayout } from '@/components/radar-page/ShareableRadarLayout';
import type { RadarData, RadarEntry } from '@/lib/types';
import { resolveQuadrantConfigs } from '@/lib/radar-quadrants';
import { Loader2 } from 'lucide-react';
import { getTechnologiesWithPlacementsForRadar } from '@/lib/radar-placement-service';
import { toRadarEntries } from '@/lib/technology-adapters';

/**
 * Client-side wrapper for fetching and displaying a shared radar.
 * Fetches the radar data and its entries from Firestore based on the ID.
 *
 * Supports both the decoupled model (technologies + radar_placements) and
 * the legacy model (radars/{radarId}/entries subcollection).
 *
 * @param props - Component props.
 * @param props.radarId - The ID of the radar to fetch.
 * @returns The shareable radar layout or loading/error state.
 */
export function SharedRadarClientWrapper({ radarId }: { radarId: string }) {
  const [radar, setRadar] = useState<RadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRadar() {
      try {
        const docRef = doc(db, 'radars', radarId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const data = docSnap.data();

          // AUDIT-001: public rendering is an explicit opt-in — fail closed
          // exactly like the report/visualization share pages (`!== true`,
          // so legacy radars without the field read as unshared).
          if (data.shared !== true) {
            setError('This radar is not shared');
            return;
          }
          let entries: RadarEntry[] = [];

          // First, try to get entries from decoupled model (technologies + radar_placements)
          try {
            const technologiesWithPlacements = await getTechnologiesWithPlacementsForRadar(radarId);
            if (technologiesWithPlacements.length > 0) {
              // Adapter denormalizes `quadrantName` from the radar's quadrant config.
              entries = toRadarEntries(technologiesWithPlacements, { quadrants: data.quadrants ?? [] });
              log.info(`Loaded ${entries.length} entries from decoupled model`);
            }
          } catch (err) {
            log.warn('Failed to load from decoupled model, falling back to legacy', {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Fallback: If no entries from decoupled model, try legacy subcollection
          if (entries.length === 0) {
            const entriesRef = collection(db, 'radars', radarId, 'entries');
            const entriesSnap = await getDocs(entriesRef);
            entries = entriesSnap.docs.map((d) => d.data() as RadarEntry);
            log.info(`Loaded ${entries.length} entries from legacy subcollection`);
          }

          setRadar({
            id: docSnap.id,
            ...data,
            entries: entries,
          } as RadarData);
        } else {
          setError('Radar not found');
        }
      } catch (err) {
        log.error('Error fetching radar', err instanceof Error ? err : new Error(String(err)));
        setError('Failed to load radar');
      } finally {
        setLoading(false);
      }
    }

    fetchRadar();
  }, [radarId]);

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !radar) {
    return (
      <div className="h-screen w-full flex items-center justify-center text-destructive">
        {error || 'Radar not found'}
      </div>
    );
  }

  // Resolve canonical QuadrantConfig[] with defensive fallback for legacy
  // radars that may still have `quadrants: string[]` (pre-migration).
  const quadrants = resolveQuadrantConfigs(radar);

  return <ShareableRadarLayout radar={radar} quadrants={quadrants} />;
}
