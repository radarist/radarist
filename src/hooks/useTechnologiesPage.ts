'use client';

import { useState, useEffect, useMemo } from 'react';
import { createLogger } from '@/lib/logger';
import { useAuth } from '@/components/providers/AuthProvider';

const log = createLogger('hooks/useTechnologiesPage');
import { useToast } from '@/hooks/use-toast';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { useQueryClient } from '@tanstack/react-query';
import { technologyKeys, radarPlacementKeys } from '@/lib/query-keys';
import { createTechnologyId, type TechnologyWithRadar } from '@/lib/technologies';
import { getAllTechnologiesWithPlacements } from '@/lib/radar-placement-service';
import { getTechnologies as getDecoupledTechnologies } from '@/lib/technology-service';
import { resolveTechnologyCreateOutcome, resolveTechnologyUpdateOutcome, resolveTechnologyUpdateWithPlacementSyncOutcome } from '@/lib/mutation-outcome/technology';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import {
  toTechnologyWithRadar,
  hashStringToNumber,
  mapDisplayToTimeToImpact,
  mapTimeToImpactToDisplay,
} from '@/lib/technology-adapters';
import { idResolver } from '@/lib/migration';
import { getRelationsForEntities, createRelationFromIds, deleteRelation } from '@/lib/relations';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement, type BulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import { buildDefaultQuadrantConfigs } from '@/lib/constants';
import type {
  Relation,
  Ring,
  Status,
  RadarData,
  Technology,
  RadarPlacement,
  CreateTechnologyInput,
  TechnologyCategory,
  TechnologyNote,
  EntityType,
  RelationType,
} from '@/lib/types';
import type { SortConfig, PaginationState } from '@/components/library/shared/types';

// ============================================================================
// CONSTANTS
// ============================================================================

// Library-view fallback configs for technologies that don't have a placement
// on any radar. Shared between the "library" pseudo-radar and any "without
// placement" tech row. Uses the canonical default quadrants with stable ids.
const FALLBACK_LIBRARY_CONFIGS = buildDefaultQuadrantConfigs();
const FALLBACK_LIBRARY_QUADRANT_ID = FALLBACK_LIBRARY_CONFIGS[1].id; // "Tools"
const FALLBACK_LIBRARY_QUADRANT_NAME = FALLBACK_LIBRARY_CONFIGS[1].name;

const RING_ORDER: Record<Ring, number> = {
  Adopt: 0,
  Trial: 1,
  Assess: 2,
  Hold: 3,
};

// ============================================================================
// UTILITY
// ============================================================================

type TechnologySortKey = 'name' | 'category' | 'ring' | 'status' | 'quadrant' | 'trl';

/**
 * Get the correct entity ID for a technology.
 * Handles both new (tech-xxx) and legacy (radarId:numericId) formats.
 */
export function getTechnologyEntityId(tech: TechnologyWithRadar): string {
  if (idResolver.isNewFormat(String(tech.id))) {
    return String(tech.id);
  }
  return `${tech.radarId}:${tech.id}`;
}

/**
 * Stable Firestore document id for a TechnologyWithRadar row. Prefers the
 * decoupled `originalTechId` (set by both adapter paths); falls back to the
 * legacy composite id for rows hydrated from old radar entries. This is the
 * id that round-trips through the `?technology=` sheet URL param, so graph /
 * command-palette deep links resolve to the same row the table selects.
 */
export function getTechnologySheetId(tech: TechnologyWithRadar): string {
  if (tech.originalTechId) {
    return tech.originalTechId;
  }
  if (String(tech.id).startsWith('tech-')) {
    return String(tech.id);
  }
  return createTechnologyId(tech.radarId, tech.id);
}

export interface TechnologyDeleteResponse extends BulkDeleteAcknowledgement {
  relationsDeleted: number;
  placementsDeleted: number;
}

/**
 * Treat the bulk-delete response as an acknowledgement, not a success hint.
 * Keeping this strict prevents a malformed or incomplete response from clearing
 * rows that the server did not confirm as deleted.
 */
export function parseTechnologyDeleteResponse(
  value: unknown,
  requestedIds: readonly string[]
): TechnologyDeleteResponse {
  return parseBulkDeleteAcknowledgement(value, requestedIds, ['relationsDeleted', 'placementsDeleted'] as const);
}

// ============================================================================
// HOOK
// ============================================================================

export function useTechnologiesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const graphSync = useLibraryEntityGraphSync<Technology>({
    entityType: 'technology',
    entityTypeLabel: 'technology',
    getName: (technology) => technology.name,
  });
  const queryClient = useQueryClient();

  // Data state
  const [technologies, setTechnologies] = useState<TechnologyWithRadar[]>([]);
  const [relationsMap, setRelationsMap] = useState<Map<string, Relation[]>>(new Map());
  const [_radarsMap, setRadarsMap] = useState<Map<string, RadarData>>(new Map());
  const [placementsMap, setPlacementsMap] = useState<Map<string, RadarPlacement[]>>(new Map());
  const [numericIdToTechIdMap, setNumericIdToTechIdMap] = useState<Map<number, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  // UX-052: a failed load is "unavailable", never "empty" — the page renders
  // a retryable unavailable state instead of the blank empty state.
  const [loadFailed, setLoadFailed] = useState(false);

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination state (shared between views)
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  // Sorting state
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRadar, setSelectedRadar] = useState<string>('all');

  // Bulk delete dialog state
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Individual delete dialog state
  const [techToDelete, setTechToDelete] = useState<TechnologyWithRadar | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Research in-progress tracking
  const [researchingTechIds, setResearchingTechIds] = useState<Set<string>>(new Set());

  // Selection state for bulk operations
  const {
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    setSelection,
    selectedCount,
  } = useTableSelection<TechnologyWithRadar>({
    getItemId: getTechnologySheetId,
  });

  // Edit sheet state — URL-controlled (`?technology=<id>`) so deep links from
  // the graph workbench / command palette open the sheet directly. The param
  // name must stay in sync with ENTITY_SHEET_PARAMS in entity-links.ts.
  const {
    selectedEntity: urlSelectedTechnology,
    isOpen: isTechSheetOpenFromUrl,
    open: openTechnologySheet,
    close: closeTechnologySheet,
  } = useControlledSheet({
    entities: technologies,
    getId: getTechnologySheetId,
    paramName: 'technology',
  });
  // The create flow has no entity id to put in the URL, so it keeps local state.
  const [isCreateSheetOpen, setIsCreateSheetOpen] = useState(false);
  const [isAddingNew, setIsAddingNew] = useState(false);

  const selectedTechnology = urlSelectedTechnology ?? null;
  const isEditSheetOpen = (isTechSheetOpenFromUrl && !!urlSelectedTechnology) || isCreateSheetOpen;

  /** Back-compat setter for the page component: close tears down both modes. */
  function setIsEditSheetOpen(open: boolean) {
    if (open) {
      // Edit opens go through handleEditTechnology with a target entity; an
      // untargeted `true` can only mean the create sheet.
      setIsCreateSheetOpen(true);
    } else {
      setIsCreateSheetOpen(false);
      closeTechnologySheet();
    }
  }

  /** Back-compat setter for the page component: selection is URL-driven now. */
  function setSelectedTechnology(tech: TechnologyWithRadar | null) {
    if (tech) {
      openTechnologySheet(tech);
    } else {
      closeTechnologySheet();
    }
  }

  // Get unique radar names for filter dropdown
  const radarNames = useMemo(() => {
    const names = new Set<string>();
    technologies.forEach((tech) => names.add(tech.radarName));
    return Array.from(names).sort();
  }, [technologies]);

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  useEffect(() => {
    loadData();
  }, []);

  useDataRefresh(['technologies', 'relations'], () => {
    log.info('Auto-refreshing data after AI Assistant action');
    loadData();
  });

  async function loadData() {
    try {
      setIsLoading(true);
      setLoadFailed(false);

      const [technologiesWithPlacements, allTechnologies] = await Promise.all([
        getAllTechnologiesWithPlacements(),
        getDecoupledTechnologies(),
      ]);

      log.debug('Fetched from decoupled model', {
        withPlacements: technologiesWithPlacements.length,
        allTechnologies: allTechnologies.length,
        withPlacementCategories: technologiesWithPlacements
          .slice(0, 5)
          .map((t) => ({ name: t.name, category: t.category })),
        allTechCategories: allTechnologies.slice(0, 5).map((t) => ({ name: t.name, category: t.category })),
      });

      // Build a set of technology IDs that have placements
      const techIdsWithPlacements = new Set(technologiesWithPlacements.map((twp) => twp.id));

      // Display deduplication: Group placements by technology ID, pick first for display.
      const techByIdMap = new Map<string, (typeof technologiesWithPlacements)[0]>();
      technologiesWithPlacements.forEach((twp) => {
        if (!techByIdMap.has(twp.id)) {
          techByIdMap.set(twp.id, twp);
        }
      });

      // Library view doesn't have per-radar quadrant configs loaded, so we
      // use the canonical default configs as a stub for every radar the tech
      // is placed on. The adapter reads only `quadrants` off the radar.
      // Proper fix is Phase 9 work (load real configs per radar id).
      const stubRadar = { quadrants: FALLBACK_LIBRARY_CONFIGS };

      const techsWithPlacements: TechnologyWithRadar[] = Array.from(techByIdMap.values()).map((twp) =>
        toTechnologyWithRadar(twp, twp.radarName, stubRadar)
      );

      // Add technologies WITHOUT placements (library-only)
      const techsWithoutPlacements: TechnologyWithRadar[] = allTechnologies
        .filter((tech) => !techIdsWithPlacements.has(tech.id))
        .map((tech) => ({
          id: hashStringToNumber(tech.id),
          name: tech.name,
          description: tech.description || '',
          quadrantId: FALLBACK_LIBRARY_QUADRANT_ID,
          quadrantName: FALLBACK_LIBRARY_QUADRANT_NAME,
          ring: 'Assess' as Ring,
          status: 'New' as Status,
          tags: tech.tags || [],
          costToPrototype: 50,
          analysis: '',
          history: [],
          radarId: 'library',
          radarName: 'Library',
          originalTechId: tech.id,
          category: tech.category,
          trl: tech.trl ? `TRL ${tech.trl}` : undefined,
          timeToImpact: mapTimeToImpactToDisplay(tech.timeToImpact),
          deepResearch: tech.deepResearch,
          comprehensiveResearch: tech.comprehensiveResearch,
          researchStatus: tech.researchStatus,
          websiteUrl: tech.websiteUrl,
          githubUrl: tech.githubUrl,
          documentationUrl: tech.documentationUrl,
        }));

      const techs: TechnologyWithRadar[] = [...techsWithPlacements, ...techsWithoutPlacements];

      // Build radar map from placement data. Uses `FALLBACK_LIBRARY_CONFIGS`
      // as a stub — the library view only needs `quadrants.length` and basic
      // metadata, not the real per-radar config.
      const radars = new Map<string, RadarData>();
      technologiesWithPlacements.forEach((twp) => {
        if (!radars.has(twp.radarId)) {
          radars.set(twp.radarId, {
            id: twp.radarId,
            name: twp.radarName,
            quadrants: FALLBACK_LIBRARY_CONFIGS,
            entries: [],
          });
        }
      });
      if (techsWithoutPlacements.length > 0) {
        radars.set('library', {
          id: 'library',
          name: 'Library',
          quadrants: FALLBACK_LIBRARY_CONFIGS,
          entries: [],
        });
      }

      // Build placements map by technology ID for TechnologySheet
      const placements = new Map<string, RadarPlacement[]>();
      const numericToTechId = new Map<number, string>();
      technologiesWithPlacements.forEach((twp) => {
        const existing = placements.get(twp.id) || [];
        existing.push(twp.placement);
        placements.set(twp.id, existing);
        numericToTechId.set(hashStringToNumber(twp.id), twp.id);
      });
      techsWithoutPlacements.forEach((tech) => {
        numericToTechId.set(tech.id, tech.originalTechId!);
      });
      setPlacementsMap(placements);
      setNumericIdToTechIdMap(numericToTechId);

      setTechnologies(techs);
      setRadarsMap(radars);

      // Clear researching state for technologies that are no longer pending
      setResearchingTechIds((prev) => {
        if (prev.size === 0) return prev;
        const stillPending = new Set<string>();
        prev.forEach((techId) => {
          const tech = techs.find((t) => {
            const id =
              (t as TechnologyWithRadar & { originalTechId?: string }).originalTechId || getTechnologyEntityId(t);
            return id === techId;
          }) as (TechnologyWithRadar & { researchStatus?: string }) | undefined;
          if (tech?.researchStatus === 'pending') {
            stillPending.add(techId);
          }
        });
        return stillPending;
      });

      // Load relations in a single bulk query (batched `in` reads with bounded
      // concurrency) instead of an unbounded per-entity fan-out, which fired 2N
      // concurrent Firestore reads and tripped the client SDK's
      // "resource-exhausted: Too many outstanding requests" guard.
      const entityIds = techs.map(
        (tech) =>
          (tech as TechnologyWithRadar & { originalTechId?: string }).originalTechId || getTechnologyEntityId(tech)
      );
      let relationsByEntity: Record<string, Relation[]> = {};
      try {
        relationsByEntity = await getRelationsForEntities(entityIds);
      } catch (error) {
        log.error('Failed to load relations', error instanceof Error ? error : new Error(String(error)));
      }

      const relations = new Map<string, Relation[]>();
      Object.entries(relationsByEntity).forEach(([entityId, techRelations]) => {
        if (techRelations.length > 0) {
          relations.set(entityId, [...techRelations]);
        }
      });
      setRelationsMap(relations);
    } catch (error) {
      log.error('Error loading technologies', error instanceof Error ? error : new Error(String(error)));
      setLoadFailed(true);
      toast({
        title: 'Error',
        description: 'Failed to load technologies. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }

  // ============================================================================
  // FILTERING
  // ============================================================================

  const filteredTechnologies = useMemo(() => {
    let filtered = [...technologies];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (tech) =>
          tech.name.toLowerCase().includes(query) ||
          tech.description?.toLowerCase().includes(query) ||
          tech.radarName.toLowerCase().includes(query)
      );
    }

    if (selectedRadar !== 'all') {
      filtered = filtered.filter((tech) => tech.radarName === selectedRadar);
    }

    return filtered;
  }, [technologies, searchQuery, selectedRadar]);

  // ============================================================================
  // SORTING
  // ============================================================================

  const sortedTechnologies = useMemo(() => {
    if (!sortConfig) return filteredTechnologies;

    return [...filteredTechnologies].sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key as TechnologySortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'category':
          comparison = (a.category || '').localeCompare(b.category || '');
          break;
        case 'ring':
          comparison = RING_ORDER[a.ring] - RING_ORDER[b.ring];
          break;
        case 'status':
          comparison = (a.status || '').localeCompare(b.status || '');
          break;
        case 'quadrant':
          // Sort by the denormalized display name (falls back to id when absent)
          comparison = (a.quadrantName ?? a.quadrantId).localeCompare(b.quadrantName ?? b.quadrantId);
          break;
        case 'trl': {
          const parseTrl = (trl: string | number | undefined): number => {
            if (trl === undefined || trl === null) return 0;
            if (typeof trl === 'number') return trl;
            const match = String(trl).match(/\d+/);
            return match ? parseInt(match[0], 10) : 0;
          };
          const aTrl = parseTrl(a.trl);
          const bTrl = parseTrl(b.trl);
          comparison = aTrl - bTrl;
          break;
        }
      }

      return sortConfig.direction === 'desc' ? -comparison : comparison;
    });
  }, [filteredTechnologies, sortConfig]);

  // ============================================================================
  // PAGINATION
  // ============================================================================

  const paginatedTechnologies = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;
    const end = start + pagination.pageSize;
    return sortedTechnologies.slice(start, end);
  }, [sortedTechnologies, pagination.pageIndex, pagination.pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(selectedIds, paginatedTechnologies, (tech) =>
    createTechnologyId(tech.radarId, tech.id)
  );

  // Reset to first page when filters change
  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, [searchQuery, selectedRadar]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  function handleSort(key: string) {
    setSortConfig((current) => {
      if (current?.key === key) {
        if (current.direction === 'asc') {
          return { key, direction: 'desc' };
        } else {
          return null;
        }
      }
      return { key, direction: 'asc' };
    });
  }

  function handlePageChange(pageIndex: number) {
    setPagination((prev) => ({ ...prev, pageIndex }));
  }

  function handlePageSizeChange(pageSize: number) {
    setPagination((prev) => ({ ...prev, pageSize }));
  }

  function clearFilters() {
    setSearchQuery('');
    setSelectedRadar('all');
  }

  async function handleBulkDelete(): Promise<boolean> {
    const requestedIds = [...selectedIds];
    try {
      const response = await fetchWithAuth('/api/technologies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: requestedIds }),
      });

      if (!response.ok) {
        throw new Error('Failed to delete technologies');
      }

      const result = parseTechnologyDeleteResponse(await response.json(), requestedIds);

      toast({
        title: result.failed.length > 0 ? 'Technologies Partially Deleted' : 'Technologies Deleted',
        description: `Deleted ${result.deleted} of ${requestedIds.length} technolog${requestedIds.length === 1 ? 'y' : 'ies'}${result.relationsDeleted > 0 ? `, ${result.relationsDeleted} relation${result.relationsDeleted === 1 ? '' : 's'}` : ''}${result.placementsDeleted > 0 ? `, and ${result.placementsDeleted} radar placement${result.placementsDeleted === 1 ? '' : 's'}` : ''}.${result.failed.length > 0 ? ` ${result.failed.length} retained for retry.` : ''}`,
        ...(result.failed.length > 0 ? { variant: 'destructive' as const } : {}),
      });

      queryClient.invalidateQueries({ queryKey: technologyKeys.all });
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all });

      setSelection(result.failed);
      await loadData();
      return result.failed.length === 0;
    } catch (error) {
      log.error('Bulk delete failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete technologies. Please try again.',
        variant: 'destructive',
      });
      return false;
    }
  }

  function handleDeleteTechnologyClick(tech: TechnologyWithRadar) {
    setTechToDelete(tech);
    setShowDeleteDialog(true);
  }

  async function handleDeleteTechnology(target: TechnologyWithRadar | null = techToDelete): Promise<boolean> {
    if (!target) return false;

    try {
      const techId =
        target.originalTechId ||
        (String(target.id).startsWith('tech-') ? String(target.id) : createTechnologyId(target.radarId, target.id));

      const response = await fetchWithAuth('/api/technologies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [techId] }),
      });

      if (!response.ok) {
        throw new Error('Failed to delete technology');
      }

      const result = parseTechnologyDeleteResponse(await response.json(), [techId]);

      if (result.failed.length > 0) {
        toast({
          title: 'Technology Not Deleted',
          description: `"${target.name}" was retained because a required cleanup did not complete. Retry the deletion.`,
          variant: 'destructive',
        });
        queryClient.invalidateQueries({ queryKey: technologyKeys.all });
        queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all });
        await loadData();
        return false;
      }

      toast({
        title: 'Technology Deleted',
        description: `Successfully deleted "${target.name}"${result.relationsDeleted > 0 ? ` and ${result.relationsDeleted} relation${result.relationsDeleted === 1 ? '' : 's'}` : ''}${result.placementsDeleted > 0 ? `, ${result.placementsDeleted} radar placement${result.placementsDeleted === 1 ? '' : 's'}` : ''}.`,
      });

      queryClient.invalidateQueries({ queryKey: technologyKeys.all });
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all });

      setTechToDelete(null);
      await loadData();
      return true;
    } catch (error) {
      log.error('Delete failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete technology. Please try again.',
        variant: 'destructive',
      });
      return false;
    }
  }

  function handleEditTechnology(tech: TechnologyWithRadar) {
    log.debug('handleEditTechnology called', {
      id: tech.id,
      name: tech.name,
      category: tech.category,
      originalTechId: tech.originalTechId,
    });
    setIsAddingNew(false);
    setIsCreateSheetOpen(false);
    openTechnologySheet(tech);
  }

  async function handleResearchTechnology(tech: TechnologyWithRadar) {
    const techId =
      tech.originalTechId ||
      (String(tech.id).startsWith('tech-') ? String(tech.id) : createTechnologyId(tech.radarId, tech.id));

    setResearchingTechIds((prev) => new Set([...prev, techId]));

    try {
      log.info('Triggering research', { techId });

      const response = await fetchWithAuth('/api/technologies/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technologyId: techId,
          comprehensive: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to trigger research');
      }

      const result = await response.json();
      log.info('Research triggered', { result });

      toast({
        title: 'Research Started',
        description: `AI research started for "${tech.name}". This may take a few minutes.`,
      });

      setTimeout(() => {
        log.info('Auto-refreshing after research trigger');
        loadData();
      }, 30000);
    } catch (error) {
      log.error('Research trigger failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Research Failed',
        description: error instanceof Error ? error.message : 'Failed to start research. Please try again.',
        variant: 'destructive',
      });
      setResearchingTechIds((prev) => {
        const next = new Set(prev);
        next.delete(techId);
        return next;
      });
    }
  }

  const hasActiveFilters = !!searchQuery || selectedRadar !== 'all';

  // ============================================================================
  // SHEET HANDLERS (create, edit, notes, relations)
  // ============================================================================

  function openCreateSheet() {
    closeTechnologySheet();
    setIsAddingNew(true);
    setIsCreateSheetOpen(true);
  }

  async function handleCreateTechnology(data: Record<string, unknown>) {
    try {
      // GRAPH-058: an unacknowledged graph handoff used to land here as
      // "Failed to create technology", telling the operator to retry a write
      // that had already committed. Route through the shared truth contract.
      const outcome = await resolveTechnologyCreateOutcome({
        ...data,
        createdBy: user?.uid || 'anonymous',
      } as CreateTechnologyInput);
      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Success', description: 'Technology created successfully' },
      });
      await loadData();
      setIsEditSheetOpen(false);
      setIsAddingNew(false);
    } catch (error) {
      log.error('Error creating technology', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create technology. Please try again.',
        variant: 'destructive',
      });
    }
  }

  function getSheetTechnologyProps() {
    if (!selectedTechnology) return null;

    const originalTechId =
      selectedTechnology.originalTechId ||
      numericIdToTechIdMap.get(selectedTechnology.id) ||
      getTechnologyEntityId(selectedTechnology);
    const techPlacements = placementsMap.get(originalTechId) || [];

    const rawTrl = selectedTechnology.trl;
    const parsedTrl =
      typeof rawTrl === 'number'
        ? rawTrl
        : typeof rawTrl === 'string' && rawTrl.startsWith('TRL ')
          ? parseInt(rawTrl.replace('TRL ', ''), 10)
          : undefined;

    const rawTimeToImpact = selectedTechnology.timeToImpact;
    const parsedTimeToImpact = (
      rawTimeToImpact === 'H1' || rawTimeToImpact === 'H2' || rawTimeToImpact === 'H3'
        ? rawTimeToImpact
        : mapDisplayToTimeToImpact(rawTimeToImpact)
    ) as 'H1' | 'H2' | 'H3' | undefined;

    const technologyProp = {
      ...(selectedTechnology as unknown as Technology),
      id: originalTechId,
      category: selectedTechnology.category as TechnologyCategory | undefined,
      trl: parsedTrl,
      timeToImpact: parsedTimeToImpact,
    };

    log.debug('TechnologySheet rendering', {
      originalTechId,
      fromOriginalTechId: selectedTechnology.originalTechId,
      fromMap: numericIdToTechIdMap.get(selectedTechnology.id),
      fallback: getTechnologyEntityId(selectedTechnology),
      relationsCount: relationsMap.get(originalTechId)?.length || 0,
      selectedTechnologyCategory: selectedTechnology.category,
      technologyPropCategory: technologyProp.category,
      rawTrl,
      parsedTrl,
      rawTimeToImpact,
      parsedTimeToImpact,
      selectedTechnologyKeys: Object.keys(selectedTechnology),
    });

    return {
      originalTechId,
      technologyProp,
      techPlacements,
      relations: relationsMap.get(originalTechId) || relationsMap.get(getTechnologyEntityId(selectedTechnology)) || [],
    };
  }

  async function handleSheetAddRelation(
    originalTechId: string,
    targetId: string,
    targetType: EntityType,
    relationType: RelationType
  ) {
    try {
      await createRelationFromIds({
        sourceId: originalTechId,
        sourceType: 'technology',
        targetId,
        targetType,
        relationType,
      });
      await loadData();
      toast({
        title: 'Success',
        description: 'Relation added successfully',
      });
    } catch (error) {
      log.error('Error adding relation', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to add relation. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetRemoveRelation(relationId: string) {
    try {
      await deleteRelation(relationId);
      await loadData();
      toast({
        title: 'Success',
        description: 'Relation removed successfully',
      });
    } catch (error) {
      log.error('Error removing relation', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to remove relation. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetSave(originalTechId: string, data: Record<string, unknown>) {
    try {
      const { outcome, syncResult } = await resolveTechnologyUpdateWithPlacementSyncOutcome(
        { id: originalTechId },
        data
      );

      let description = 'Technology updated successfully';
      if (syncResult && syncResult.updated > 0) {
        description += `. ${syncResult.updated} radar placement(s) synced.`;
      }
      if (syncResult && syncResult.failed.length > 0) {
        description += ` Warning: ${syncResult.failed.length} placement(s) failed to sync.`;
      }

      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Success', description },
      });
      await loadData();
      setIsEditSheetOpen(false);
      setSelectedTechnology(null);
    } catch (error) {
      log.error('Error saving technology', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to save technology. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetAddNote(originalTechId: string, content: string, currentNotes: TechnologyNote[]) {
    try {
      const newNote: TechnologyNote = {
        id: `note-${Date.now()}`,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const outcome = await resolveTechnologyUpdateOutcome(
        { id: originalTechId },
        { notes: [...currentNotes, newNote] }
      );
      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Note Added', description: 'Your note has been saved.' },
      });
      await loadData();
    } catch (error) {
      log.error('Error adding note', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to add note. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetUpdateNote(
    originalTechId: string,
    noteId: string,
    content: string,
    currentNotes: TechnologyNote[]
  ) {
    try {
      const updatedNotes = currentNotes.map((note) =>
        note.id === noteId ? { ...note, content, updatedAt: Date.now() } : note
      );
      const outcome = await resolveTechnologyUpdateOutcome({ id: originalTechId }, { notes: updatedNotes });
      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Note Updated', description: 'Your note has been updated.' },
      });
      await loadData();
    } catch (error) {
      log.error('Error updating note', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to update note. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetDeleteNote(originalTechId: string, noteId: string, currentNotes: TechnologyNote[]) {
    try {
      const filteredNotes = currentNotes.filter((note) => note.id !== noteId);
      const outcome = await resolveTechnologyUpdateOutcome({ id: originalTechId }, { notes: filteredNotes });
      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Note Deleted', description: 'The note has been removed.' },
      });
      await loadData();
    } catch (error) {
      log.error('Error deleting note', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete note. Please try again.',
        variant: 'destructive',
      });
    }
  }

  async function handleSheetAIResearch() {
    await loadData();
  }

  return {
    // Data
    technologies,

    // GRAPH-058 saved-locally recovery
    graphSyncRecoveries: graphSync.recoveries,
    maxGraphSyncRetries: graphSync.maxRetryAttempts,
    graphSyncEntityTypeLabel: graphSync.entityTypeLabel,
    getGraphSyncRecoveryLabel: graphSync.getRecoveryLabel,
    retryGraphSync: graphSync.retryGraphSync,
    relationsMap,
    placementsMap,
    isLoading,
    loadFailed,
    retryLoad: loadData,
    radarNames,

    // View state
    viewMode,
    setViewMode,

    // Pagination
    pagination,
    paginatedTechnologies,
    sortedTechnologies,
    handlePageChange,
    handlePageSizeChange,

    // Sorting
    sortConfig,
    handleSort,

    // Filters
    searchQuery,
    setSearchQuery,
    selectedRadar,
    setSelectedRadar,
    hasActiveFilters,
    clearFilters,

    // Selection
    selectedIds,
    selectedCount,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    isAllSelected,
    isSomeSelected,

    // Delete dialogs
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    handleBulkDelete,
    handleDeleteTechnologyClick,
    handleDeleteTechnology,

    // Research
    researchingTechIds,
    handleResearchTechnology,

    // Edit sheet
    isEditSheetOpen,
    setIsEditSheetOpen,
    selectedTechnology,
    setSelectedTechnology,
    isAddingNew,
    setIsAddingNew,
    handleEditTechnology,

    // Sheet operations
    openCreateSheet,
    handleCreateTechnology,
    getSheetTechnologyProps,
    handleSheetAddRelation,
    handleSheetRemoveRelation,
    handleSheetSave,
    handleSheetAddNote,
    handleSheetUpdateNote,
    handleSheetDeleteNote,
    handleSheetAIResearch,
  };
}
