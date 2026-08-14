/**
 * @file hooks/useRadarEntriesDecoupled.ts
 * @description Hook that manages radar entries using the decoupled Technology + RadarPlacement model.
 * Provides the same API as useRadarEntries for backward compatibility with UI components.
 *
 * This hook enables gradual migration from the legacy model to the new decoupled model
 * while keeping the same component interfaces.
 *
 * Key differences from useRadarEntries:
 * - Reads from `technologies` and `radar_placements` collections (via useRadarDataDecoupled)
 * - Writes to `technologies` and `radar_placements` collections (instead of subcollection)
 * - Provides `getTechnologyId` to get original technology ID from legacy entry ID
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { useState, useCallback, useMemo } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useRadarEntriesDecoupled');
import { auth } from '@/lib/firebase';
import type { RadarEntry, RadarEntrySaveInput, Technology, TechnologyWithPlacement } from '@/lib/types';
import { useRadarDataDecoupled } from './useRadarDataDecoupled';
import { createTechnology, updateTechnology, getTechnologyById, getTechnologyBySlug } from '@/lib/technology-service';
import { createRadarPlacement, updateRadarPlacement, deleteRadarPlacement } from '@/lib/radar-placement-service';
import { hashStringToNumber, slugify, inferCategoryFromQuadrantName } from '@/lib/technology-adapters';

type TechnologyTimeToImpact = 'H1' | 'H2' | 'H3';

// ============================================================================
// HELPER FUNCTIONS FOR FIELD CONVERSION
// ============================================================================

/**
 * Convert form timeToImpact string (e.g., "H1 (0-6mo)") to TimeToImpact enum
 */
function parseTimeToImpact(value: string | undefined): TechnologyTimeToImpact | undefined {
  if (!value) return undefined;
  // Extract H1, H2, or H3 from values like "H1 (0-6mo)"
  const match = value.match(/^(H[123])/);
  if (match) {
    return match[1] as TechnologyTimeToImpact;
  }
  // Also accept raw H1, H2, H3 values
  if (value === 'H1' || value === 'H2' || value === 'H3') {
    return value as TechnologyTimeToImpact;
  }
  return undefined;
}

/**
 * Convert form TRL string (e.g., "TRL 5") to numeric trlScore (1-9)
 */
function parseTrlScore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/TRL\s*(\d)/i);
  if (match) {
    const score = parseInt(match[1], 10);
    if (score >= 1 && score <= 9) {
      return score;
    }
  }
  return undefined;
}

interface UseRadarEntriesDecoupledProps {
  radarId: string;
}

interface UseRadarEntriesDecoupledResult {
  // State
  activeTags: string[];
  hoveredEntryId: number | null;
  setHoveredEntryId: (id: number | null) => void;
  entryToEdit: RadarEntry | null;
  setEntryToEdit: (entry: RadarEntry | null) => void;
  entryToResearch: RadarEntry | null;
  setEntryToResearch: (entry: RadarEntry | null) => void;
  filteredEntries: RadarEntry[];
  allTags: string[];

  // Handlers (same API as useRadarEntries)
  handleSaveEntry: (entry: RadarEntrySaveInput) => Promise<RadarEntry | void>;
  handleDeleteEntry: (id: number) => Promise<void>;
  handleTagClick: (tag: string) => void;
  handleClearTags: () => void;
  handleSaveAnalysis: (entryId: number, analysis: string) => Promise<void>;
  handleSaveEntryPosition: (entryId: number, x: number, y: number) => Promise<void>;

  // Additional utilities for decoupled model
  getTechnologyId: (entryId: number) => string | undefined;
  getTechnologyForEntry: (entryId: number) => TechnologyWithPlacement | undefined;

  // Data loading state
  isLoading: boolean;
  isError: boolean;

  // Raw data
  entries: RadarEntry[];
  technologies: TechnologyWithPlacement[];

  // Refresh
  refresh: () => void;
}

/**
 * Hook that manages radar entries using the decoupled model
 *
 * @example
 * ```tsx
 * const {
 *   filteredEntries,
 *   handleSaveEntry,
 *   handleEntryClick,
 *   getTechnologyForEntry,
 * } = useRadarEntriesDecoupled({ radarId: 'my-radar' });
 * ```
 */
export function useRadarEntriesDecoupled({ radarId }: UseRadarEntriesDecoupledProps): UseRadarEntriesDecoupledResult {
  // ============================================================================
  // DATA HOOK
  // ============================================================================

  const {
    entries,
    technologies,
    technologyMap,
    entryToTechnologyMap,
    isLoading,
    isError,
    getTechnologyForEntry,
    updatePlacement,
    refresh,
  } = useRadarDataDecoupled(radarId);

  // ============================================================================
  // LOCAL STATE
  // ============================================================================

  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [hoveredEntryId, setHoveredEntryId] = useState<number | null>(null);
  const [entryToEdit, setEntryToEdit] = useState<RadarEntry | null>(null);
  const [entryToResearch, setEntryToResearch] = useState<RadarEntry | null>(null);

  // ============================================================================
  // DERIVED DATA
  // ============================================================================

  const filteredEntries = useMemo(() => {
    if (activeTags.length === 0) {
      return entries;
    }
    return entries.filter((entry) => activeTags.some((tag) => entry.tags?.includes(tag)));
  }, [entries, activeTags]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    entries.forEach((entry) => {
      entry.tags?.forEach((tag) => tags.add(tag));
    });
    return Array.from(tags);
  }, [entries]);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  const getTechnologyId = useCallback(
    (entryId: number): string | undefined => {
      return entryToTechnologyMap.get(entryId);
    },
    [entryToTechnologyMap]
  );

  // ============================================================================
  // HANDLERS
  // ============================================================================

  /**
   * Save an entry - creates or updates technology + placement in decoupled model
   */
  const handleSaveEntry = useCallback(
    async (savedEntry: RadarEntrySaveInput): Promise<RadarEntry | void> => {
      // Adversarial #5: these degraded paths used to return silently — the
      // awaited caller (AddEntrySheet) then closed the sheet with a
      // success-looking UX while nothing was saved. Fail loud instead.
      if (!radarId) throw new Error('No radar selected — cannot save the entry.');

      const isEditing = !!savedEntry.id;

      try {
        if (isEditing) {
          // Update existing technology and placement
          const techId = getTechnologyId(savedEntry.id!);
          if (!techId) {
            log.error('No technology found for entry', undefined, { entryId: savedEntry.id });
            throw new Error('This entry no longer maps to a technology — reload and try again.');
          }

          const tech = technologyMap.get(techId);
          if (!tech) throw new Error('Technology not loaded yet — try again in a moment.');

          // Build technology updates - only include fields that actually changed
          // This prevents unnecessary slug regeneration checks
          const techUpdates: Parameters<typeof updateTechnology>[1] = {};

          if (savedEntry.name !== tech.name) {
            techUpdates.name = savedEntry.name;
          }
          if (savedEntry.description !== tech.description) {
            techUpdates.description = savedEntry.description;
          }
          const newTags = savedEntry.tags || [];
          const currentTags = tech.tags || [];
          if (JSON.stringify(newTags.sort()) !== JSON.stringify(currentTags.sort())) {
            techUpdates.tags = newTags;
          }

          // Parse TRL and TimeToImpact from the form values
          const parsedTrl = parseTrlScore(savedEntry.trl);
          const parsedTimeToImpact = parseTimeToImpact(savedEntry.timeToImpact);

          // Sync TRL and TimeToImpact to technology entity (bidirectional sync)
          if (parsedTrl !== undefined && parsedTrl !== tech.trl) {
            techUpdates.trl = parsedTrl;
          }
          if (parsedTimeToImpact !== undefined && parsedTimeToImpact !== tech.timeToImpact) {
            techUpdates.timeToImpact = parsedTimeToImpact;
          }

          // Only call updateTechnology if there are actual changes
          if (Object.keys(techUpdates).length > 0) {
            await updateTechnology(techId, techUpdates);
          }

          // Update placement with all fields including timeToImpact and trlScore
          await updateRadarPlacement(tech.placement.id, {
            quadrantId: savedEntry.quadrantId,
            ring: savedEntry.ring,
            status: savedEntry.status,
            x: savedEntry.x,
            y: savedEntry.y,
            timeToImpact: parsedTimeToImpact,
            trlScore: parsedTrl,
          });

          refresh();

          // Return updated entry (legacy format)
          return {
            ...savedEntry,
            id: savedEntry.id!,
            history: [],
          } as RadarEntry;
        } else {
          const selectedTechnologyId = savedEntry.technologyId?.trim();
          const slug = slugify(savedEntry.name);
          let tech: Technology | null;

          if (selectedTechnologyId) {
            // A selection is an explicit document reference. If that
            // reference went stale, falling back to a slug could silently
            // create or reuse a different global Technology.
            tech = await getTechnologyById(selectedTechnologyId);
            if (!tech) {
              throw new Error('The selected technology no longer exists. Clear it and select it again.');
            }
            if (tech.id !== selectedTechnologyId || tech.name !== savedEntry.name) {
              throw new Error('The selected technology changed. Clear it and select it again.');
            }
            log.info('Using explicitly selected technology', { technologyId: tech.id });
          } else {
            // Manual free text retains the existing slug lookup/create flow.
            tech = await getTechnologyBySlug(slug);
          }

          if (tech) {
            // Technology exists - just create placement for it on this radar
            log.info('Technology already exists, using existing', { name: savedEntry.name });
          } else {
            // Create new technology. Category inference is best-effort:
            // `inferCategoryFromQuadrantName` only recognizes the 9 classic
            // ThoughtWorks quadrant names and returns `undefined` for custom
            // ones — callers can set category explicitly in that case.
            tech = await createTechnology({
              name: savedEntry.name,
              slug,
              description: savedEntry.description,
              category: savedEntry.quadrantName ? inferCategoryFromQuadrantName(savedEntry.quadrantName) : undefined,
              tags: savedEntry.tags || [],
              createdBy: auth.currentUser?.uid || 'anonymous',
            });
          }

          await createRadarPlacement({
            technologyId: tech.id,
            radarId,
            quadrantId: savedEntry.quadrantId,
            ring: savedEntry.ring,
            status: savedEntry.status,
            x: savedEntry.x,
            y: savedEntry.y,
            placedBy: auth.currentUser?.uid || 'anonymous',
            timeToImpact: parseTimeToImpact(savedEntry.timeToImpact),
            trlScore: parseTrlScore(savedEntry.trl),
          });

          refresh();

          // Return new entry (legacy format). `technologyId` carries the REAL
          // Firestore Technology id — the legacy numeric `id` is a hash and
          // NOT recoverable to a doc id (AUDIT-010: provenance writers need
          // the bare Technology id or the BECAME sync can never match).
          return {
            ...savedEntry,
            id: hashStringToNumber(tech.id),
            technologyId: tech.id,
            history: [],
          } as RadarEntry;
        }
      } catch (error) {
        log.error('Error saving entry', error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        setEntryToEdit(null);
      }
    },
    [radarId, getTechnologyId, technologyMap, refresh]
  );

  /**
   * Delete an entry - deletes technology and its placements
   */
  const handleDeleteEntry = useCallback(
    async (id: number): Promise<void> => {
      const techId = getTechnologyId(id);
      if (!techId) {
        log.error('No technology found for entry', undefined, { entryId: id });
        return;
      }

      const tech = technologyMap.get(techId);
      if (!tech) return;

      try {
        // Delete the placement first
        await deleteRadarPlacement(tech.placement.id);

        // Note: We don't delete the technology here because it might be on other radars
        // In the future, we could check if this was the last placement and offer to delete

        refresh();
        setEntryToResearch(null);
      } catch (error) {
        log.error('Error deleting entry', error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    [getTechnologyId, technologyMap, refresh]
  );

  /**
   * Toggle a tag filter
   */
  const handleTagClick = useCallback((tag: string) => {
    setActiveTags((prev) => {
      if (prev.includes(tag)) {
        return prev.filter((t) => t !== tag);
      } else {
        return [...prev, tag];
      }
    });
  }, []);

  /**
   * Clear all tag filters
   */
  const handleClearTags = useCallback(() => {
    setActiveTags([]);
  }, []);

  /**
   * Save analysis for an entry
   * Note: In decoupled model, analysis is stored on RadarPlacement
   */
  const handleSaveAnalysis = useCallback(
    async (entryId: number, analysis: string): Promise<void> => {
      const tech = getTechnologyForEntry(entryId);
      if (!tech) {
        log.error('No technology found for entry', undefined, { entryId });
        return;
      }

      try {
        // Store analysis on the placement (radar-specific analysis)
        await updateRadarPlacement(tech.placement.id, {
          rationale: analysis, // Using rationale field for analysis
        });

        refresh();

        // Update local state for entryToResearch
        if (entryToResearch && entryToResearch.id === entryId) {
          setEntryToResearch((prev) => (prev ? { ...prev, analysis } : null));
        }
      } catch (error) {
        log.error('Error saving analysis', error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    [getTechnologyForEntry, entryToResearch, refresh]
  );

  /**
   * Save entry position (x, y coordinates)
   */
  const handleSaveEntryPosition = useCallback(
    async (entryId: number, x: number, y: number): Promise<void> => {
      const tech = getTechnologyForEntry(entryId);
      if (!tech) {
        log.error('No technology found for entry', undefined, { entryId });
        return;
      }

      try {
        await updatePlacement(tech.placement.id, { x, y });
      } catch (error) {
        log.error('Error saving position', error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    [getTechnologyForEntry, updatePlacement]
  );

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    // State
    activeTags,
    hoveredEntryId,
    setHoveredEntryId,
    entryToEdit,
    setEntryToEdit,
    entryToResearch,
    setEntryToResearch,
    filteredEntries,
    allTags,

    // Handlers
    handleSaveEntry,
    handleDeleteEntry,
    handleTagClick,
    handleClearTags,
    handleSaveAnalysis,
    handleSaveEntryPosition,

    // Utilities
    getTechnologyId,
    getTechnologyForEntry,

    // Data loading state
    isLoading,
    isError,

    // Raw data
    entries,
    technologies,

    // Refresh
    refresh,
  };
}
