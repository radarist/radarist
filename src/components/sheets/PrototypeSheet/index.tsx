/**
 * @file components/sheets/PrototypeSheet/index.tsx
 * @description Sheet for creating and editing Prototypes
 *
 * Decomposed from a single 1,315-line file into:
 * - index.tsx (this file) — main component, shared state, tab composition
 * - constants.ts — schema, form types, option constants
 * - OverviewTab.tsx — basic info, team, stakeholders
 * - ArtifactsTab.tsx — demo URLs, repo, video links
 * - ImpactTab.tsx — impact measurement and confidence
 * - CostsTab.tsx — cost tracking with breakdown items
 *
 * @author Radarist Team
 */

'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FlaskConical, Link2, MessageSquare, FileText, DollarSign, TrendingUp, Plus } from 'lucide-react';

import { EntitySheetShell } from '../EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from '../EntitySheetTabs';
import { EntitySheetFooter } from '../EntitySheetFooter';
import { EntitySheetSkeleton } from '../EntitySheetSkeleton';
import { NotesTab, RelationsTab, KnowledgeTab, type Note } from '../tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';

import type { Prototype, Relation, EntityType, RelationType } from '@/lib/types';

import { prototypeFormSchema, type PrototypeFormValues } from './constants';
import { OverviewTab } from './OverviewTab';
import { ArtifactsTab } from './ArtifactsTab';
import { ImpactTab } from './ImpactTab';
import { CostsTab } from './CostsTab';

// ============================================================================
// FORM DEFAULTS
// ============================================================================

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened prototype's data. Create mode must reset to this constant.
 */
const EMPTY_PROTOTYPE_FORM_VALUES: DefaultValues<PrototypeFormValues> = {
  name: '',
  description: '',
  status: 'Ideation',
  targetBusinessUnit: '',
  team: [],
  presentedTo: [],
  presentationDate: undefined,
  artifacts: {
    demoUrl: '',
    repoUrl: '',
    demoVideo: '',
  },
  impact: {
    type: 'Revenue Generation',
    estimatedValue: 0,
    actualValue: undefined,
    timeToImpact: '',
    confidence: 50,
    notes: '',
  },
  costs: {
    estimated: undefined,
    actual: undefined,
    currency: 'USD',
    breakdown: [],
  },
  jiraEpic: '',
};

// ============================================================================
// TYPES
// ============================================================================

interface PrototypeSheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Prototype data for edit mode (undefined for create mode) */
  prototype?: Prototype;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: PrototypeFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Relations for the prototype */
  relations?: Relation[];
  /** Notes for the prototype */
  notes?: Note[];
  /** Callback to add a note */
  onAddNote?: (content: string) => Promise<void>;
  /** Callback to update a note's content */
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  /** Callback to delete a note */
  onDeleteNote?: (id: string) => Promise<void>;
  /** Callback to add a relation */
  onAddRelation?: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Callback to remove a relation */
  onRemoveRelation?: (relationId: string) => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  // ========== Phase 4: Evidence Tab Props ==========
  /** Claims data for this prototype */
  claims?: import('@/lib/graph/types').EntityClaims;
  /** Loading state for claims */
  isLoadingClaims?: boolean;
  /** Error when fetching claims */
  claimsError?: string;
  /** Callback to refresh claims */
  onRefreshClaims?: () => Promise<void>;
  /** Callback to curate (approve/reject) a claim */
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
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
 * PrototypeSheet
 *
 * Sheet component for creating and editing prototypes.
 * Includes tabs for Overview, Artifacts, Impact, Costs, Relations, Notes, and Knowledge.
 *
 * @example
 * ```tsx
 * <PrototypeSheet
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   prototype={selectedPrototype}
 *   onSave={handleSave}
 *   relations={prototypeRelations}
 * />
 * ```
 */
export function PrototypeSheet({
  open,
  onOpenChange,
  prototype,
  isLoading = false,
  onSave,
  onDelete,
  relations = [],
  notes = [],
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onAddRelation,
  onRemoveRelation,
  onEntityClick,
  // Phase 4: Evidence props
  claims,
  isLoadingClaims,
  claimsError: _claimsError,
  onRefreshClaims,
  onCurateClaim,
}: PrototypeSheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Prototype" could open on a non-Overview tab.
  const subjectId = prototype?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!prototype;

  const form = useForm<PrototypeFormValues>({
    resolver: zodResolver(prototypeFormSchema),
    mode: 'onChange', // Validate on change so isValid updates in real-time
    defaultValues: EMPTY_PROTOTYPE_FORM_VALUES,
  });

  // Reset form when prototype changes
  React.useEffect(() => {
    if (prototype) {
      form.reset({
        name: prototype.name,
        description: prototype.description,
        status: prototype.status,
        targetBusinessUnit: prototype.targetBusinessUnit,
        team: prototype.team || [],
        presentedTo: prototype.presentedTo || [],
        presentationDate: prototype.presentationDate,
        artifacts: {
          demoUrl: prototype.artifacts?.demoUrl || '',
          repoUrl: prototype.artifacts?.repoUrl || '',
          demoVideo: prototype.artifacts?.demoVideo || '',
        },
        impact: prototype.impact || {
          type: 'Revenue Generation',
          estimatedValue: 0,
          timeToImpact: '',
          confidence: 50,
          notes: '',
        },
        costs: prototype.costs
          ? {
              estimated: prototype.costs.estimated,
              actual: prototype.costs.actual,
              currency: prototype.costs.currency || 'USD',
              breakdown: prototype.costs.breakdown || [],
            }
          : {
              estimated: undefined,
              actual: undefined,
              currency: 'USD',
              breakdown: [],
            },
        jiraEpic: prototype.jiraEpic || '',
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened prototype's data (see constant docs).
      form.reset(EMPTY_PROTOTYPE_FORM_VALUES);
    }
  }, [prototype, form]);

  const handleSave = async (data: PrototypeFormValues) => {
    setIsSaving(true);
    try {
      await onSave(data);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      await onDelete();
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: FlaskConical,
      content: <OverviewTab form={form} />,
    },
    {
      id: 'artifacts',
      label: 'Artifacts',
      icon: FileText,
      content: <ArtifactsTab form={form} />,
    },
    {
      id: 'impact',
      label: 'Impact',
      icon: TrendingUp,
      content: <ImpactTab form={form} />,
    },
    {
      id: 'costs',
      label: 'Costs',
      icon: DollarSign,
      content: <CostsTab form={form} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: prototype ? (
        <RelationsTab
          entityId={prototype.id}
          entityName={prototype.name}
          entityType="prototype"
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
      id: 'notes',
      label: 'Notes',
      icon: MessageSquare,
      badge: notes.length || undefined,
      content: prototype ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this prototype..."
          enableAutosave={true}
        />
      ) : (
        <CreateModeNotice feature="notes" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'knowledge',
      label: 'Knowledge',
      icon: FileText,
      badge: claims?.totalCount || undefined,
      content: prototype ? (
        <KnowledgeTab
          entityType="prototype"
          entityId={prototype.id}
          entityName={prototype.name}
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
  ];

  const _currentStatus = form.watch('status');

  return (
    <EntitySheetShell
      title={isEditMode ? prototype.name : 'New Prototype'}
      entityType="prototype"
      entityId={isEditMode ? prototype.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={isEditMode ? `${prototype.status} · ${prototype.targetBusinessUnit}` : 'Create a new prototype'}
      width="xl"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === prototype?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
        ),
      }}
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
          entityName={isEditMode ? prototype.name : 'prototype'}
        />
      }
    >
      {isLoading ? (
        <EntitySheetSkeleton showTabs tabCount={7} fieldCount={6} />
      ) : (
        <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      )}
    </EntitySheetShell>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { PrototypeSheetProps, PrototypeFormValues };
export { prototypeFormSchema } from './constants';
