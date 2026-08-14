/**
 * @file components/sheets/TechnologySheet/index.tsx
 * @description Sheet for creating and editing Technologies (Phase 1 decoupled model)
 *
 * Decomposed from a single 1,733-line file into:
 * - index.tsx (this file) — main component, shared state, tab composition
 * - constants.ts — schema, form types, option constants
 * - OverviewTab.tsx — overview form with fields, tags, market interest display
 * - PlacementsTab.tsx — radar placement cards
 * - ResearchTab.tsx — internal research tab with polling + deep research display
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Cpu,
  Link2,
  Radio,
  Plus,
  Loader2,
  Sparkles,
  FileText,
  FlaskConical,
  MoreVertical,
  StickyNote,
  Network,
} from 'lucide-react';

import { EntitySheetShell } from '../EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from '../EntitySheetTabs';
import { EntitySheetFooter } from '../EntitySheetFooter';
import { EntitySheetSkeleton } from '../EntitySheetSkeleton';
import { RelationsTab, KnowledgeTab, NotesTab, TechnologyResearchTab, type Note } from '../tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';
import { useToast } from '@/hooks/use-toast';
import { useDispatchEvaluation } from '@/hooks/queries/useBuildMissions';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityRelationshipPanel } from '@/components/graphs/EntityRelationshipPanel';
import { createLogger } from '@/lib/logger';
import { generateSlug } from '@/lib/technology-service';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

import type {
  Technology,
  TechnologyCategory,
  RadarPlacement,
  Relation,
  EntityType,
  RelationType,
  CreateTechnologyInput,
} from '@/lib/types';

import { technologyFormSchema, type TechnologyFormValues } from './constants';
import { OverviewTab } from './OverviewTab';
import { PlacementsTab } from './PlacementsTab';

const log = createLogger('ui/TechnologySheet');

const RESEARCH_REFRESH_INTERVAL_MS = 10_000;

// ============================================================================
// FORM DEFAULTS
// ============================================================================

/**
 * Create-mode form defaults.
 *
 * react-hook-form's `reset(values)` (used when opening an existing
 * technology) replaces the stored defaultValues, so a bare `form.reset()`
 * would restore the last-opened technology's data. Create mode must always
 * reset to this constant explicitly.
 */
const EMPTY_TECHNOLOGY_FORM_VALUES: DefaultValues<TechnologyFormValues> = {
  name: '',
  description: '',
  category: undefined,
  trl: undefined,
  timeToImpact: undefined,
  tags: [],
  websiteUrl: '',
  githubUrl: '',
  documentationUrl: '',
  linkedCompanies: [],
  linkedUseCases: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface TechnologySheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Technology data for edit mode (undefined for create mode) */
  technology?: Technology;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: CreateTechnologyInput) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void | boolean>;
  /** Radar placements for this technology */
  placements?: RadarPlacement[];
  /** Relations for the technology */
  relations?: Relation[];
  /** Callback to add a relation */
  onAddRelation?: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Callback to remove a relation */
  onRemoveRelation?: (relationId: string) => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  /** Callback when clicking on a placement to navigate to that radar */
  onPlacementClick?: (placement: RadarPlacement) => void;
  // ========== Phase 4: Evidence Tab Props ==========
  /** Claims data for this technology */
  claims?: import('@/lib/graph/types').EntityClaims;
  /** Loading state for claims */
  isLoadingClaims?: boolean;
  /** Error when fetching claims */
  claimsError?: string;
  /** Callback to refresh claims */
  onRefreshClaims?: () => Promise<void>;
  /** Callback to curate (approve/reject) a claim */
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
  /** Current user ID for createdBy field (optional for edit mode) */
  userId?: string;
  /** Callback for AI comprehensive research (triggers Inngest background job) */
  onAIResearch?: () => Promise<void>;
  // ========== Notes Management Props ==========
  /** Notes for this technology */
  notes?: Note[];
  /** Callback to add a note */
  onAddNote?: (content: string) => Promise<void>;
  /** Callback to update a note */
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  /** Callback to delete a note */
  onDeleteNote?: (id: string) => Promise<void>;
}

// ============================================================================
// CREATE MODE NOTICE
// ============================================================================

function CreateModeNotice({ feature }: { feature: string }) {
  return (
    <div className="py-8 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Plus className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">
        {feature.charAt(0).toUpperCase() + feature.slice(1)} will be available after you save.
      </p>
      <p className="text-xs text-muted-foreground/70 mt-1">Fill in the overview details and click Save to continue.</p>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * TechnologySheet
 *
 * Sheet component for creating and editing technologies (Phase 1 decoupled model).
 * Uses EntitySheetShell for consistent layout.
 *
 * @example
 * ```tsx
 * <TechnologySheet
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   technology={selectedTech}
 *   onSave={handleSave}
 *   placements={techPlacements}
 *   userId="user-123"
 * />
 * ```
 */
export function TechnologySheet({
  open,
  onOpenChange,
  technology,
  isLoading = false,
  onSave,
  onDelete,
  placements = [],
  relations = [],
  onAddRelation,
  onRemoveRelation,
  onEntityClick,
  onPlacementClick,
  // Phase 4: Evidence props
  claims,
  isLoadingClaims,
  claimsError: _claimsError,
  onRefreshClaims,
  onCurateClaim,
  userId,
  onAIResearch,
  notes: technologyNotes = [],
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}: TechnologySheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Technology" could open on a non-Overview tab.
  const subjectId = technology?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isGraphOpen, setIsGraphOpen] = React.useState(false);
  const [isResearching, setIsResearching] = React.useState(false);
  const { searchEntities } = useEntitySearch();
  const { toast } = useToast();
  const dispatchEval = useDispatchEvaluation();

  const isEditMode = !!technology;
  const hasResearchData = !!technology?.comprehensiveResearch;
  // Research is in progress if: local state says so OR technology status is pending
  const isResearchInProgress = isResearching || technology?.researchStatus === 'pending';
  const researchRefreshRef = React.useRef(onAIResearch);
  const researchRefreshInFlightRef = React.useRef(false);
  const canRefreshResearch = !!onAIResearch;

  React.useEffect(() => {
    researchRefreshRef.current = onAIResearch;
  }, [onAIResearch]);

  // A research dispatch completes in Inngest, outside this component's data
  // flow. Refresh conservatively while the selected technology remains
  // pending so the open sheet can show the terminal result without a reload.
  // Recursive timeouts ensure a slow refresh never overlaps the next request.
  React.useEffect(() => {
    if (!open || !subjectId || technology?.researchStatus !== 'pending' || !canRefreshResearch) return;

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRefresh = () => {
      if (cancelled) return;
      refreshTimer = setTimeout(refreshResearch, RESEARCH_REFRESH_INTERVAL_MS);
    };

    const refreshResearch = async () => {
      if (cancelled) return;

      if (researchRefreshInFlightRef.current) {
        scheduleRefresh();
        return;
      }

      researchRefreshInFlightRef.current = true;
      try {
        await researchRefreshRef.current?.();
      } catch (error) {
        log.warn('Failed to refresh pending technology research', {
          technologyId: subjectId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        researchRefreshInFlightRef.current = false;
        scheduleRefresh();
      }
    };

    scheduleRefresh();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [canRefreshResearch, open, subjectId, technology?.researchStatus]);

  const form = useForm<TechnologyFormValues>({
    resolver: zodResolver(technologyFormSchema),
    mode: 'onChange', // Validate on change so isValid updates in real-time
    defaultValues: EMPTY_TECHNOLOGY_FORM_VALUES,
  });

  // Parent live-data hooks rebuild the Technology object as placements,
  // relations, and sync metadata arrive. Keep the latest object available for
  // the next subject/open reset without treating object identity as a reason
  // to discard a user's dirty draft.
  const technologyRef = React.useRef(technology);
  technologyRef.current = technology;
  const resetSubjectRef = React.useRef<string | null>(null);

  // Reset only when opening the sheet or switching subjects. Re-renders for
  // the same entity must preserve in-progress edits.
  React.useEffect(() => {
    if (!open) {
      resetSubjectRef.current = null;
      return;
    }
    const resetSubject = subjectId ?? '__create__';
    if (resetSubjectRef.current === resetSubject) return;
    resetSubjectRef.current = resetSubject;

    const currentTechnology = technologyRef.current;
    if (currentTechnology) {
      // Ensure category is valid enum value or undefined (not empty string)
      // Empty string from database/adapter would fail Zod enum validation
      const validCategory =
        currentTechnology.category && currentTechnology.category.trim() !== ''
          ? (currentTechnology.category as TechnologyCategory)
          : undefined;

      log.debug('Resetting form with technology', {
        id: currentTechnology.id,
        name: currentTechnology.name,
        rawCategory: currentTechnology.category,
        validCategory,
        trl: currentTechnology.trl,
        timeToImpact: currentTechnology.timeToImpact,
      });

      form.reset({
        name: currentTechnology.name,
        description: currentTechnology.description,
        category: validCategory,
        trl: currentTechnology.trl,
        timeToImpact: currentTechnology.timeToImpact,
        tags: currentTechnology.tags || [],
        websiteUrl: currentTechnology.websiteUrl || '',
        githubUrl: currentTechnology.githubUrl || '',
        documentationUrl: currentTechnology.documentationUrl || '',
        linkedCompanies: currentTechnology.linkedCompanies || [],
        linkedUseCases: currentTechnology.linkedUseCases || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened technology's data (see constant docs).
      form.reset(EMPTY_TECHNOLOGY_FORM_VALUES);
    }
  }, [form, open, subjectId]);

  const handleSave = async (data: TechnologyFormValues) => {
    setIsSaving(true);
    try {
      await onSave({
        name: data.name,
        slug: generateSlug(data.name),
        description: data.description,
        category: data.category,
        trl: data.trl,
        timeToImpact: data.timeToImpact,
        tags: data.tags,
        websiteUrl: data.websiteUrl || undefined,
        githubUrl: data.githubUrl || undefined,
        documentationUrl: data.documentationUrl || undefined,
        linkedCompanies: data.linkedCompanies,
        linkedUseCases: data.linkedUseCases,
        createdBy: userId || technology?.createdBy || '',
      });
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      const shouldClose = await onDelete();
      if (shouldClose !== false) {
        onOpenChange(false);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  // E1 — dispatch a hands-on Technology Evaluation (build a real proof of
  // this technology; the brief is composed from the graph server-side).
  const handleEvaluate = () => {
    if (!technology) return;
    dispatchEval.mutate(
      { technologyId: technology.id, useCaseIds: technology.linkedUseCases },
      {
        onSuccess: () =>
          toast({ title: 'Evaluation dispatched', description: 'Building a real proof — track it in Artifacts.' }),
        onError: (error) =>
          toast({
            title: 'Could not start evaluation',
            description: error instanceof Error ? error.message : 'Unknown error',
            variant: 'destructive',
          }),
      }
    );
  };

  const handleAIResearch = async () => {
    if (!technology) return;
    setIsResearching(true);
    try {
      // Trigger comprehensive research via API (Inngest background job)
      const response = await fetchWithAuth('/api/technologies/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          technologyId: technology.id,
          technologyName: technology.name,
          technologyDescription: technology.description,
          comprehensive: true,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast({
          title: 'Research started',
          description:
            'Comprehensive research is running in the background. You can navigate away - the results will appear when complete.',
        });
        // Call parent callback if provided
        if (onAIResearch) {
          await onAIResearch();
        }
      } else if (response.status === 409) {
        toast({
          title: 'Research in progress',
          description: 'Research is already running. Please wait for it to complete.',
        });
      } else {
        toast({
          title: 'Research failed',
          description: data.error || 'Could not start research.',
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: 'Research failed',
        description: 'Could not start research at this time.',
        variant: 'destructive',
      });
    } finally {
      setIsResearching(false);
    }
  };

  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: Cpu,
      content: <OverviewTab form={form} isLoading={isLoading} technology={technology} />,
    },
    {
      id: 'placements',
      label: 'Radar Placements',
      icon: Radio,
      badge: placements.length || undefined,
      content: technology ? (
        <PlacementsTab placements={placements} onPlacementClick={onPlacementClick} />
      ) : (
        <CreateModeNotice feature="radar placements" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: technology ? (
        <RelationsTab
          entityId={technology.id}
          entityName={technology.name}
          entityType="technology"
          relations={relations}
          isLoading={isLoading}
          onAddRelation={onAddRelation}
          onRemoveRelation={onRemoveRelation}
          onEntityClick={onEntityClick}
          onSearchEntities={searchEntities}
        />
      ) : (
        <CreateModeNotice feature="relations" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'knowledge',
      label: 'Knowledge',
      icon: FileText,
      badge: claims?.totalCount || undefined,
      content: technology ? (
        <KnowledgeTab
          entityType="technology"
          entityId={technology.id}
          entityName={technology.name}
          claims={claims}
          claimsLoading={isLoadingClaims}
          onRefreshClaims={onRefreshClaims}
          onEntityClick={onEntityClick}
          onCurateClaim={onCurateClaim}
        />
      ) : (
        <CreateModeNotice feature="knowledge" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'research',
      label: 'Research',
      icon: FlaskConical,
      content: technology ? (
        <TechnologyResearchTab
          research={technology.comprehensiveResearch}
          isLoading={isLoading}
          researchStatus={technology.researchStatus}
        />
      ) : (
        <CreateModeNotice feature="research" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'notes',
      label: 'Notes',
      icon: StickyNote,
      badge: technologyNotes.length || undefined,
      content: technology ? (
        <NotesTab
          notes={technologyNotes}
          isLoading={isLoading}
          onAddNote={async (content) => {
            if (onAddNote) await onAddNote(content);
          }}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this technology..."
        />
      ) : (
        <CreateModeNotice feature="notes" />
      ),
      disabled: !isEditMode,
    },
  ];

  return (
    <>
      <EntitySheetShell
        title={isEditMode ? technology.name : 'New Technology'}
        entityType="technology"
        entityId={isEditMode ? technology.id : undefined}
        open={open}
        onOpenChange={onOpenChange}
        subtitle={
          isEditMode
            ? `${technology.category || 'Uncategorized'} · ${placements.length} radar${placements.length !== 1 ? 's' : ''}`
            : 'Add a new technology to your knowledge base'
        }
        width="lg"
        headerActions={
          isEditMode && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsGraphOpen(true)}>
                <Network className="h-4 w-4 mr-2" />
                Graph
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                    <span className="sr-only">More actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleAIResearch} disabled={isResearchInProgress}>
                    {isResearchInProgress ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    {isResearchInProgress ? 'Researching...' : hasResearchData ? 'Refresh Research' : 'Research'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleEvaluate} disabled={dispatchEval.isPending}>
                    {dispatchEval.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <FlaskConical className="h-4 w-4 mr-2" />
                    )}
                    {dispatchEval.isPending ? 'Dispatching…' : 'Evaluate (build a proof)'}
                  </DropdownMenuItem>
                  {/* P-C3b: Delete lives footer-left (EntitySheetFooter) on
                      both Company and Technology drawers — no longer
                      duplicated here in the ⋮ menu. */}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        }
        footer={
          <EntitySheetFooter
            mode={isEditMode ? 'edit' : 'create'}
            onCancel={() => onOpenChange(false)}
            onSave={form.handleSubmit(handleSave)}
            onDelete={isEditMode && onDelete ? handleDelete : undefined}
            isSaving={isSaving}
            isDeleting={isDeleting}
            isDirty={form.formState.isDirty}
            isValid={form.formState.isValid}
            entityName={isEditMode ? technology.name : 'technology'}
            deleteDescription={
              isEditMode
                ? `This action cannot be undone. "${technology.name}" and all connected relations and radar placements will be permanently deleted.`
                : undefined
            }
            extraActions={
              isEditMode ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAIResearch}
                  disabled={isResearchInProgress || !form.getValues('name') || isSaving}
                  className="gap-2"
                >
                  {isResearchInProgress ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {isResearchInProgress ? 'Researching...' : hasResearchData ? 'Refresh Research' : 'AI Research'}
                </Button>
              ) : undefined
            }
          />
        }
      >
        {isLoading ? (
          <EntitySheetSkeleton showTabs tabCount={4} fieldCount={6} />
        ) : (
          <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
        )}
      </EntitySheetShell>

      {/* Relations Map Dialog */}
      {isEditMode && technology && (
        <EntityRelationshipPanel
          isOpen={isGraphOpen}
          onOpenChange={setIsGraphOpen}
          entityId={technology.id}
          entityName={technology.name}
          entityType="technology"
          mode="dialog"
        />
      )}
    </>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { TechnologySheetProps, TechnologyFormValues };
export { technologyFormSchema } from './constants';
