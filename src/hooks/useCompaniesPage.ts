'use client';

import { useState, useEffect, useMemo } from 'react';
import { getCompanies, getCompanyById, deleteCompany } from '@/lib/companies';
import { getNotesByCompanyId, createNote, updateNote, deleteNote } from '@/lib/company-notes';
import type { CompanyNote } from '@/lib/types';
import type { Note as SheetNote } from '@/components/sheets/tabs';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { getRelationsForEntity, getRelationsForEntities, createRelation, deleteRelation } from '@/lib/relations';
import { getTechnologyById } from '@/lib/technology-service';
import { getUseCaseById } from '@/lib/use-cases';
import { getPrototypeById } from '@/lib/prototypes';
import { getStrategyById } from '@/lib/strategies';
import { getSignalById } from '@/lib/signals-client';
import type {
  Company,
  Relation,
  CompanyStatus,
  EntityType,
  RelationType,
  EntitySnapshot,
  CompanyType,
  CompanySize,
  CompanyStage,
  CompanyIndustry,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('hooks/useCompaniesPage');
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import {
  researchCompanyComprehensive,
  type ComprehensiveResearchInput,
} from '@/ai/flows/research-company-comprehensive';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import type { SortConfig, PaginationState } from '@/components/library/shared/types';
import {
  resolveCompanyCreateOutcome,
  resolveCompanyUpdateOutcome,
  type CompanyUpdateInput,
  type CompanyMutationOutcome,
} from '@/lib/company-mutation-outcome';
import { useEntityGraphSyncRecoveries, type EntityGraphSyncRecovery } from '@/hooks/useEntityGraphSyncRecoveries';

// ============================================================================
// TYPES
// ============================================================================

type _CompanySortField = 'name' | 'industry' | 'location';

export type CompanyGraphSyncRecovery = EntityGraphSyncRecovery<Company>;

/**
 * The ONE research request shape, shared by every entry point that regenerates
 * a company research draft (the table row action and the sheet footer button).
 *
 * AI-043 — the current draft MUST ride along. `researchCompanyComprehensive`
 * derives the refreshed artifact's version from `existingResearch`, so an entry
 * point that omits it re-mints version 1 forever and the review artifact
 * identity never moves. That defect survived the original AI-043 fix precisely
 * because each entry point built this payload itself: the argument was added to
 * one of them (a handler nothing rendered) while the live paths drifted. One
 * builder makes that class of drift impossible.
 *
 * `overrides` carries the sheet form's unsaved values, which legitimately differ
 * from the persisted company.
 *
 * Exported for unit testing.
 */
export function buildComprehensiveResearchInput(
  company: Pick<Company, 'name' | 'website' | 'description' | 'research'>,
  overrides: { name?: string; website?: string; description?: string } = {}
): ComprehensiveResearchInput {
  return {
    name: overrides.name?.trim() || company.name,
    website: (overrides.website ?? company.website) || undefined,
    description: (overrides.description ?? company.description) || undefined,
    existingResearch: company.research ?? undefined,
  };
}

/**
 * Apply company profile data from research to an update payload.
 * Shared between handleResearchFromMenu and onAIResearch.
 *
 * Exported for unit testing the AI-028 abstain guard below.
 */
export function applyResearchToUpdate(
  research: Awaited<ReturnType<typeof researchCompanyComprehensive>>
): CompanyUpdateInput {
  // AI-028: automatic research persists one reviewable artifact and nothing
  // else. Promoting generated description, SWOT, tags, contact details, or
  // profile fields would make an unverified draft indistinguishable from facts
  // the operator entered or approved.
  return { research };
}

/**
 * Coerce a Company's `industry` field to a clean `CompanyIndustry[]`. Legacy
 * Firestore docs stored it as a single string (e.g. "AI/ML"); the typed
 * schema is `string[]`. Downstream consumers (filter/sort/dropdown) call
 * `.some`, `.includes`, `.flatMap` and crash when fed a string. Normalise
 * once at the data boundary so every consumer sees the same shape.
 */
function normalizeCompanyIndustry(c: Company): Company {
  const raw = (c as unknown as { industry?: unknown }).industry;
  if (Array.isArray(raw)) return c;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { ...c, industry: [raw as CompanyIndustry] };
  }
  return { ...c, industry: [] };
}

/**
 * Render a company's location the same way the table/grid views do:
 * "City, Country" with missing parts dropped. Returns '' when no location.
 */
export function getCompanyLocationLabel(company: Pick<Company, 'location'>): string {
  return [company.location?.city, company.location?.country].filter(Boolean).join(', ');
}

/**
 * Comparator for the companies table sort. Pure so it can be unit-tested.
 *
 * - `name` / `industry` / `location` are locale-aware via `localeCompare`.
 * - `location` compares the rendered "City, Country" label; companies with
 *   no location always sort last, regardless of direction.
 * - `Array.prototype.sort` is stable (ES2019+), so equal entries keep their
 *   relative order.
 */
export function compareCompanies(a: Company, b: Company, sortState: SortConfig): number {
  const direction = sortState.direction === 'asc' ? 1 : -1;

  if (sortState.key === 'name') {
    return direction * a.name.localeCompare(b.name);
  }

  if (sortState.key === 'industry') {
    const aIndustry = Array.isArray(a.industry) ? a.industry[0] || '' : a.industry || '';
    const bIndustry = Array.isArray(b.industry) ? b.industry[0] || '' : b.industry || '';
    return direction * aIndustry.localeCompare(bIndustry);
  }

  if (sortState.key === 'location') {
    const aLocation = getCompanyLocationLabel(a);
    const bLocation = getCompanyLocationLabel(b);
    if (!aLocation && !bLocation) return 0;
    // Missing locations always last (not multiplied by direction).
    if (!aLocation) return 1;
    if (!bLocation) return -1;
    return direction * aLocation.localeCompare(bLocation);
  }

  return 0;
}

// ============================================================================
// HOOK
// ============================================================================

export function useCompaniesPage() {
  // Data state
  const [companies, setCompanies] = useState<Company[]>([]);
  const [filteredCompanies, setFilteredCompanies] = useState<Company[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [companyRelations, setCompanyRelations] = useState<Record<string, Relation[]>>({});
  const [companyNotes, setCompanyNotes] = useState<Record<string, SheetNote[]>>({});

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination state (shared between views)
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndustry, setSelectedIndustry] = useState<string>('all');

  // Sorting state
  const [sortState, setSortState] = useState<SortConfig>({ key: 'name', direction: 'asc' });

  // Dialog state
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isResearchLoading, setIsResearchLoading] = useState(false);
  const {
    recoveries: graphSyncRecoveries,
    recordRecovery: recordGraphSyncRecovery,
    clearRecovery: clearGraphSyncRecovery,
    clearRecoveries: clearGraphSyncRecoveries,
    retryGraphSync: retryGraphSyncRecovery,
    maxRetryAttempts: maxGraphSyncRetries,
  } = useEntityGraphSyncRecoveries<Company>({ entityType: 'company' });

  // Companies with an in-flight row-level research request (drives the
  // "Researching..." badge in the table's Research column).
  const [researchingCompanyIds, setResearchingCompanyIds] = useState<Set<string>>(new Set());

  // Selection state for bulk operations
  const {
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    setSelection,
    selectedCount,
  } = useTableSelection<Company>({
    getItemId: (company) => company.id,
  });

  const { toast } = useToast();

  const {
    selectedEntity: selectedCompany,
    isOpen: isSheetOpen,
    open: openCompanySheet,
    close: closeCompanySheet,
    onOpenChange: handleSheetOpenChange,
  } = useControlledSheet({
    entities: companies,
    getId: (c) => c.id,
    paramName: 'company',
  });

  // ============================================================================
  // NOTE HELPERS
  // ============================================================================

  const mapCompanyNoteToSheetNote = (note: CompanyNote): SheetNote => ({
    id: note.id,
    content: note.content,
    createdAt: note.createdAt,
    updatedAt:
      'updatedAt' in note && typeof (note as { updatedAt?: unknown }).updatedAt === 'number'
        ? (note as { updatedAt: number }).updatedAt
        : note.createdAt,
    createdBy: note.userId,
  });

  // Load notes when a company is selected
  useEffect(() => {
    if (selectedCompany && !companyNotes[selectedCompany.id]) {
      loadNotesForCompany(selectedCompany.id);
    }
  }, [selectedCompany?.id]);

  const loadNotesForCompany = async (companyId: string) => {
    try {
      const notes = await getNotesByCompanyId(companyId);
      setCompanyNotes((prev) => ({ ...prev, [companyId]: notes.map(mapCompanyNoteToSheetNote) }));
    } catch (error) {
      log.error('Failed to load notes', error instanceof Error ? error : new Error(String(error)), { companyId });
    }
  };

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  // Listen for data refresh events from AI Assistant
  useDataRefresh(['companies', 'relations'], () => {
    log.info('Auto-refreshing data after AI Assistant action');
    loadCompanies();
  });

  // Derive paginated data
  const paginatedCompanies = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;
    const end = start + pagination.pageSize;
    return filteredCompanies.slice(start, end);
  }, [filteredCompanies, pagination.pageIndex, pagination.pageSize]);

  // Get selection state for current page (must be after paginatedCompanies is defined)
  const { isAllSelected, isSomeSelected } = useSelectionState(selectedIds, paginatedCompanies, (company) => company.id);

  // Get unique industries
  const industries = useMemo(
    () => Array.from(new Set(companies.flatMap((c) => c.industry || []).filter(Boolean))).sort(),
    [companies]
  );

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    filterCompanies();
  }, [companies, searchQuery, selectedIndustry, sortState]);

  // Reset to first page when filters change
  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, [searchQuery, selectedIndustry, sortState]);

  const loadCompanies = async () => {
    setIsLoading(true);
    try {
      const raw = await getCompanies();
      // Older Firestore docs have `industry` stored as a string instead of
      // the typed `CompanyIndustry[]`. All downstream consumers (filter,
      // sort, dropdown) assume array. Normalise once at the boundary.
      const data = raw.map(normalizeCompanyIndustry);
      setCompanies(data);
      setFilteredCompanies(data);

      let relationsMap: Record<string, Relation[]> = {};
      try {
        relationsMap = await getRelationsForEntities(data.map((company) => company.id));
      } catch (error) {
        log.error('Failed to load relations', error instanceof Error ? error : new Error(String(error)));
      }
      setCompanyRelations(relationsMap);
    } catch (error) {
      log.error('Error loading companies', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to load companies',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const filterCompanies = () => {
    let filtered = [...companies];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.description?.toLowerCase().includes(query) ||
          c.industry?.some((ind) => ind.toLowerCase().includes(query))
      );
    }

    if (selectedIndustry !== 'all') {
      filtered = filtered.filter((c) => c.industry?.includes(selectedIndustry as CompanyIndustry));
    }

    // Apply sorting (stable; see compareCompanies)
    filtered.sort((a, b) => compareCompanies(a, b, sortState));

    setFilteredCompanies(filtered);
  };

  // ============================================================================
  // SORTING
  // ============================================================================

  const toggleSort = (key: string) => {
    setSortState((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleAddCompany = () => {
    setIsAddingNew(true);
    closeCompanySheet();
  };

  const handleEditCompany = (company: Company) => {
    setIsAddingNew(false);
    openCompanySheet(company);
  };

  const handleCompanySaved = () => {
    loadCompanies();
    closeCompanySheet();
    setIsAddingNew(false);
  };

  const applyCommittedCompany = (company: Company) => {
    const committed = normalizeCompanyIndustry(company);
    const upsert = (current: Company[]) => {
      const exists = current.some(({ id }) => id === committed.id);
      return exists
        ? current.map((candidate) => (candidate.id === committed.id ? committed : candidate))
        : [committed, ...current];
    };
    setCompanies(upsert);
    setFilteredCompanies(upsert);
  };

  const applyCompanyMutationOutcome = (
    outcome: CompanyMutationOutcome,
    success: { title: string; description: string }
  ): 'saved-and-queued' | 'saved-locally' => {
    if (outcome.status === 'rejected') {
      throw outcome.error;
    }

    applyCommittedCompany(outcome.entity);
    if (outcome.status === 'saved-locally') {
      recordGraphSyncRecovery(outcome, undefined);
      toast({
        title: 'Saved locally',
        description: `"${outcome.entity.name}" is saved in this workspace, but graph synchronization was not acknowledged.`,
      });
      return outcome.status;
    }

    toast(success);
    return outcome.status;
  };

  const handleDeleteCompany = async (company: Company): Promise<boolean> => {
    try {
      await deleteCompany(company.id);
      clearGraphSyncRecovery(company.id);
      toast({
        title: 'Company Deleted',
        description: `"${company.name}" has been permanently deleted.`,
      });
      loadCompanies();
      return true;
    } catch (error) {
      log.error('Error deleting company', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete company. Please try again.',
        variant: 'destructive',
      });
      return false;
    }
  };

  /**
   * Handle row-level research (Research column in the companies table).
   * Runs research in background WITHOUT opening the company sheet and
   * tracks the in-flight company id so the row shows "Researching...".
   */
  const handleResearchFromMenu = async (company: Company) => {
    setResearchingCompanyIds((prev) => new Set([...prev, company.id]));

    // Show toast that research is starting
    toast({
      title: 'Research Started',
      description: `Researching "${company.name}"... This may take a moment.`,
    });

    // Run research in background (don't open sheet)
    try {
      const research = await researchCompanyComprehensive(buildComprehensiveResearchInput(company));

      // Build company update from research data
      const companyUpdate = applyResearchToUpdate(research);

      const outcome = await resolveCompanyUpdateOutcome(company, companyUpdate);
      applyCompanyMutationOutcome(outcome, {
        title: 'Research draft saved',
        description: `AI research draft saved for "${company.name}" — review its sources before relying on it.`,
      });
    } catch (error) {
      log.error('Row-level company research failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Research Failed',
        description: 'Could not complete company research. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setResearchingCompanyIds((prev) => {
        const next = new Set(prev);
        next.delete(company.id);
        return next;
      });
    }
  };

  const handleBulkDelete = async () => {
    try {
      const response = await fetchWithAuth('/api/companies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (!response.ok) {
        throw new Error('Failed to delete companies');
      }

      const result = parseBulkDeleteAcknowledgement(await response.json(), selectedIds, ['relationsDeleted'] as const);

      toast({
        title: result.failed.length > 0 ? 'Companies Partially Deleted' : 'Companies Deleted',
        description: `Deleted ${result.deleted} company${result.deleted === 1 ? '' : 's'}${result.relationsDeleted > 0 ? ` and ${result.relationsDeleted} relation${result.relationsDeleted === 1 ? '' : 's'}` : ''}.${result.failed.length > 0 ? ` ${result.failed.length} retained for retry.` : ''}`,
        ...(result.failed.length > 0 ? { variant: 'destructive' as const } : {}),
      });

      const failedIds = new Set(result.failed);
      clearGraphSyncRecoveries(selectedIds.filter((id) => !failedIds.has(id)));
      setSelection(result.failed);
      loadCompanies();
    } catch (error) {
      log.error('Bulk delete failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete companies. Please try again.',
        variant: 'destructive',
      });
    }
  };

  // ============================================================================
  // RELATION HANDLERS
  // ============================================================================

  const handleAddRelation = async (targetId: string, targetType: EntityType, relationType: RelationType) => {
    if (!selectedCompany) return;

    try {
      // Build source snapshot (company)
      const sourceSnapshot: EntitySnapshot = {
        type: 'company',
        id: selectedCompany.id,
        name: selectedCompany.name,
        description: selectedCompany.description,
        status: selectedCompany.status,
        snapshotAt: Date.now(),
      };

      // Build target snapshot based on type
      let targetSnapshot: EntitySnapshot | null = null;

      switch (targetType) {
        case 'company': {
          const company = await getCompanyById(targetId);
          if (company) {
            targetSnapshot = {
              type: 'company',
              id: company.id,
              name: company.name,
              description: company.description,
              status: company.status,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
        case 'technology': {
          const tech = await getTechnologyById(targetId);
          if (tech) {
            targetSnapshot = {
              type: 'technology',
              id: targetId,
              name: tech.name,
              description: tech.description,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
        case 'useCase': {
          const useCase = await getUseCaseById(targetId);
          if (useCase) {
            targetSnapshot = {
              type: 'useCase',
              id: useCase.id,
              name: useCase.title,
              description: useCase.description,
              status: useCase.status,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
        case 'prototype': {
          const prototype = await getPrototypeById(targetId);
          if (prototype) {
            targetSnapshot = {
              type: 'prototype',
              id: prototype.id,
              name: prototype.name,
              description: prototype.description,
              status: prototype.status,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
        case 'strategy': {
          const strategy = await getStrategyById(targetId);
          if (strategy) {
            targetSnapshot = {
              type: 'strategy',
              id: strategy.id,
              name: strategy.name,
              description: strategy.description,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
        case 'signal': {
          const signal = await getSignalById(targetId);
          if (signal) {
            targetSnapshot = {
              type: 'signal',
              id: signal.id,
              name: signal.title,
              description: signal.description,
              status: signal.status,
              snapshotAt: Date.now(),
            };
          }
          break;
        }
      }

      if (!targetSnapshot) {
        toast({
          title: 'Error',
          description: 'Could not find the entity to link',
          variant: 'destructive',
        });
        return;
      }

      await createRelation({
        relationType,
        sourceSnapshot,
        targetSnapshot,
      });

      // Refresh relations for the current company
      const updatedRelations = await getRelationsForEntity(selectedCompany.id);
      setCompanyRelations((prev) => ({
        ...prev,
        [selectedCompany.id]: updatedRelations,
      }));

      toast({
        title: 'Relation Added',
        description: `Linked ${selectedCompany.name} to ${targetSnapshot.name}`,
      });
    } catch (error) {
      log.error('Error adding relation', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to add relation',
        variant: 'destructive',
      });
    }
  };

  const handleRemoveRelation = async (relationId: string) => {
    try {
      await deleteRelation(relationId);

      if (selectedCompany) {
        // Refresh relations for the current company
        const updatedRelations = await getRelationsForEntity(selectedCompany.id);
        setCompanyRelations((prev) => ({
          ...prev,
          [selectedCompany.id]: updatedRelations,
        }));
      }

      toast({
        title: 'Relation Removed',
        description: 'The relation has been removed',
      });
    } catch (error) {
      log.error('Error removing relation', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to remove relation',
        variant: 'destructive',
      });
    }
  };

  // ============================================================================
  // PAGINATION HANDLERS
  // ============================================================================

  const handlePageChange = (pageIndex: number) => {
    setPagination((prev) => ({ ...prev, pageIndex }));
  };

  const handlePageSizeChange = (pageSize: number) => {
    setPagination((prev) => ({ ...prev, pageSize }));
  };

  // ============================================================================
  // SHEET HANDLERS (notes, save, research)
  // ============================================================================

  const handleAddNote = selectedCompany
    ? async (content: string) => {
        try {
          await createNote(selectedCompany.id, {
            content,
            type: 'General',
          });
          // Refresh notes
          const updated = await getNotesByCompanyId(selectedCompany.id);
          setCompanyNotes((prev) => ({
            ...prev,
            [selectedCompany.id]: updated.map(mapCompanyNoteToSheetNote),
          }));
          toast({
            title: 'Note Added',
            description: 'Your note has been saved.',
          });
        } catch (error) {
          log.error('Failed to add note', error instanceof Error ? error : new Error(String(error)));
          toast({
            title: 'Error',
            description: 'Failed to add note. Please try again.',
            variant: 'destructive',
          });
        }
      }
    : undefined;

  const handleDeleteNote = selectedCompany
    ? async (noteId: string) => {
        try {
          await deleteNote(selectedCompany.id, noteId);
          // Refresh notes
          const updated = await getNotesByCompanyId(selectedCompany.id);
          setCompanyNotes((prev) => ({
            ...prev,
            [selectedCompany.id]: updated.map(mapCompanyNoteToSheetNote),
          }));
          toast({
            title: 'Note Deleted',
            description: 'The note has been removed.',
          });
        } catch (error) {
          log.error('Failed to delete note', error instanceof Error ? error : new Error(String(error)));
          toast({
            title: 'Error',
            description: 'Failed to delete note. Please try again.',
            variant: 'destructive',
          });
        }
      }
    : undefined;

  const handleUpdateNote = selectedCompany
    ? async (noteId: string, content: string) => {
        try {
          // UX-006: use the committed updatedAt so the "edited" marker shows
          // immediately AND matches what a reload will read back.
          const { updatedAt } = await updateNote(selectedCompany.id, noteId, { content });
          setCompanyNotes((prev) => ({
            ...prev,
            [selectedCompany.id]: (prev[selectedCompany.id] ?? []).map((note) =>
              note.id === noteId ? { ...note, content, updatedAt } : note
            ),
          }));
        } catch (error) {
          const saveError = error instanceof Error ? error : new Error(String(error));
          log.error('Failed to update note', saveError, { companyId: selectedCompany.id, noteId });
          toast({
            title: 'Error',
            description: 'Failed to update note. Please try again.',
            variant: 'destructive',
          });
          // NotesTab uses rejection to show its autosave error state.
          throw saveError;
        }
      }
    : undefined;

  const handleSave = async (data: Record<string, unknown>) => {
    const operation = isAddingNew ? 'create' : 'update';
    const createPayload = {
      name: data.name as string,
      description: (data.description as string) || '',
      website: (data.website as string) || '',
      logo: '',
      type: (data.type as CompanyType[]) || ['sme'],
      industry: (data.industry as CompanyIndustry[]) || [],
      industryCustom: (data.industryCustom as string[]) || [],
      size: (data.size as CompanySize) || 'small',
      stage: (data.stage as CompanyStage) || 'seed',
      location: (data.location as Company['location']) || { city: '', country: '' },
      status: (data.status as CompanyStatus) || 'Watching',
      tags: (data.tags as string[]) || [],
      socialLinks: (data.socialLinks as Company['socialLinks']) || { linkedin: '', twitter: '', github: '' },
      technologyStack: (data.technologyStack as string[]) || [],
      documents: [],
    };
    const updatePayload: CompanyUpdateInput = {
      name: data.name as string,
      description: data.description as string,
      website: data.website as string,
      type: data.type as CompanyType[],
      industry: data.industry as CompanyIndustry[],
      industryCustom: data.industryCustom as string[],
      size: data.size as CompanySize,
      stage: data.stage as CompanyStage,
      location: data.location as Company['location'],
      status: data.status as CompanyStatus,
      tags: data.tags as string[],
      socialLinks: data.socialLinks as Company['socialLinks'],
      technologyStack: data.technologyStack as string[],
    };

    const outcome = await (
      operation === 'create'
        ? resolveCompanyCreateOutcome(createPayload)
        : selectedCompany
          ? resolveCompanyUpdateOutcome(selectedCompany, updatePayload)
          : Promise.reject(new Error('No company is selected for update'))
    ).catch((error: unknown) => {
      const verificationError = error instanceof Error ? error : new Error(String(error));
      log.error('Could not verify company save state', verificationError);
      toast({
        title: 'Save status unavailable',
        description: 'The workspace could not verify whether the save committed. Reload before trying again.',
        variant: 'destructive',
      });
      throw verificationError;
    });

    if (outcome.status === 'rejected') {
      log.error('Company write was rejected', outcome.error, { operation });
      toast({
        title: 'Company not saved',
        description: `The ${operation} was rejected before it could be confirmed. Please review the form and try again.`,
        variant: 'destructive',
      });
      throw outcome.error;
    }

    const status = applyCompanyMutationOutcome(outcome, {
      title: operation === 'create' ? 'Company Created' : 'Company Updated',
      description: `"${data.name}" has been ${operation === 'create' ? 'created' : 'updated'} successfully.`,
    });
    if (status === 'saved-locally') {
      closeCompanySheet();
      setIsAddingNew(false);
      return;
    }

    handleCompanySaved();
  };

  const retryGraphSync = async (entityId: string) => {
    const result = await retryGraphSyncRecovery(entityId);
    if (result.status === 'acknowledged') {
      toast({
        title: 'Graph sync acknowledged',
        description: `"${result.recovery.entity?.name ?? result.recovery.entityId}" is queued; the notice clears once the graph write is confirmed.`,
      });
      return;
    }
    if (result.status === 'failed') {
      log.warn('Company graph sync retry was not acknowledged', {
        companyId: result.recovery.entityId,
        operation: result.recovery.operation,
        attempt: result.recovery.retryAttempts,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
      toast({
        title: 'Graph sync still unavailable',
        description: 'The company remains saved locally. No company data was submitted again.',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = selectedCompany
    ? async () => {
        // F76: actually delete. The footer Delete used to only reload + close,
        // so nothing was removed. Route through the same deleteCompany flow the
        // table row uses (the sheet footer already confirms via AlertDialog).
        return handleDeleteCompany(selectedCompany);
      }
    : undefined;

  const handleAIResearch = selectedCompany
    ? async (entityName: string, context?: { website?: string; description?: string }) => {
        // The Research tab's own loading state belongs to whichever handler is
        // actually reachable. It used to be owned by an unrendered refresh
        // handler, so the tab never showed it at all.
        setIsResearchLoading(true);
        try {
          // Use comprehensive research that returns all company fields. This is
          // the button the operator actually presses (it reads "Refresh
          // Research" once a draft exists), so it carries the current draft.
          const research = await researchCompanyComprehensive(
            buildComprehensiveResearchInput(selectedCompany, {
              name: entityName,
              website: context?.website,
              description: context?.description,
            })
          );

          // Save research to company immediately
          const companyUpdate = applyResearchToUpdate(research);
          const outcome = await resolveCompanyUpdateOutcome(selectedCompany, companyUpdate);
          applyCompanyMutationOutcome(outcome, {
            title: 'Research draft saved',
            description: 'AI research draft saved — review the generated fields and sources.',
          });

          // Return in AIResearchResult format for form population
          return {
            description: research.executiveSummary?.overview,
            industry: [] as string[], // Will be mapped from research
            tags: research.executiveSummary?.suggestedTags?.slice(0, 10),
          };
        } catch (error) {
          log.error('AI Research failed', error instanceof Error ? error : new Error(String(error)));
          toast({
            title: 'Research Failed',
            description: 'Could not complete AI research. Please try again.',
            variant: 'destructive',
          });
          return null;
        } finally {
          setIsResearchLoading(false);
        }
      }
    : undefined;

  const handleApplyResearch = (_result: unknown) => {
    toast({
      title: 'Draft applied to form',
      description: 'Review the generated fields and sources before saving.',
    });
  };

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    // Data
    companies,
    filteredCompanies,
    isLoading,
    companyRelations,
    companyNotes,
    industries,

    // View state
    viewMode,
    setViewMode,

    // Pagination
    pagination,
    paginatedCompanies,
    handlePageChange,
    handlePageSizeChange,

    // Sorting
    sortState,
    toggleSort,

    // Filters
    searchQuery,
    setSearchQuery,
    selectedIndustry,
    setSelectedIndustry,

    // Selection
    selectedIds,
    selectedCount,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    isAllSelected,
    isSomeSelected,

    // Sheet state
    selectedCompany,
    isSheetOpen,
    isAddingNew,
    setIsAddingNew,
    handleSheetOpenChange,

    // Handlers
    handleAddCompany,
    handleEditCompany,
    handleDeleteCompany,
    handleResearchFromMenu,
    researchingCompanyIds,
    handleBulkDelete,

    // Bulk delete dialog
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,

    // Relation handlers
    handleAddRelation,
    handleRemoveRelation,

    // Sheet handlers
    handleAddNote,
    handleUpdateNote,
    handleDeleteNote,
    handleSave,
    handleDelete,
    handleAIResearch,
    handleApplyResearch,
    isResearchLoading,
    graphSyncRecoveries,
    retryGraphSync,
    maxGraphSyncRetries,

    // For mapCompanyNoteToSheetNote used to map notes prop
    mapCompanyNoteToSheetNote,
  };
}
