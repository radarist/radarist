/**
 * @file components/sheets/CompanySheet/index.tsx
 * @description Sheet for creating and editing Companies
 *
 * Decomposed from a single 1,138-line file into:
 * - index.tsx (this file) — main component, shared state, tab composition
 * - constants.ts — schema, form types, option constants, AI research mappings
 * - OverviewTab.tsx — overview form with fields, tags, technology stack
 *
 * @author Radarist Team
 */

'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Building2,
  Users,
  FileText,
  Link2,
  MessageSquare,
  Loader2,
  Plus,
  Swords,
  Sparkles,
  Search,
  Network,
} from 'lucide-react';

import { EntitySheetShell } from '../EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from '../EntitySheetTabs';
import { EntitySheetFooter } from '../EntitySheetFooter';
import { EntitySheetSkeleton } from '../EntitySheetSkeleton';
import { NotesTab, type Note } from '../tabs';
import { RelationsTab } from '../tabs';
import { KnowledgeTab } from '../tabs';
import { ResearchTab } from '../tabs';
import { type AIResearchResult } from '../tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';
import { normalizeIndustries } from '@/lib/normalize-industries';
import { deriveCompanyResearchPresentation } from '@/lib/company-research-presentation';

// Reuse existing components from scouting
import { ContactManager } from '@/components/scouting/ContactManager';
import { CompanyCompetitors } from '@/components/scouting/CompanyCompetitors';
import { EntityRelationshipPanel } from '@/components/graphs/EntityRelationshipPanel';

import { Button } from '@/components/ui/button';

import type { Company, CompanyType, Relation, EntityType, RelationType } from '@/lib/types';

import type { CompanyIndustryValue } from '@/lib/schemas/company';

import {
  companyFormSchema,
  mapIndustryStringToEnum,
  SIZE_MAP,
  STAGE_MAP,
  TYPE_MAP,
  type CompanyFormValues,
} from './constants';
import { OverviewTab } from './OverviewTab';

// ============================================================================
// FORM DEFAULTS
// ============================================================================

/**
 * Create-mode form defaults.
 *
 * Kept as a named constant because react-hook-form's `reset(values)` (used
 * when opening an existing company) REPLACES the form's stored defaultValues.
 * A bare `form.reset()` afterwards would therefore restore the last-opened
 * company's data instead of an empty form. Create mode must always reset to
 * this constant explicitly.
 */
const EMPTY_COMPANY_FORM_VALUES: DefaultValues<CompanyFormValues> = {
  name: '',
  description: '',
  website: '',
  type: [],
  industry: [],
  industryCustom: [],
  size: 'small',
  stage: 'seed',
  status: 'Watching',
  location: { city: '', country: '' },
  tags: [],
  socialLinks: { linkedin: '', twitter: '', github: '' },
  technologyStack: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface CompanySheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** AI-043 — tab to open on when the subject changes (default 'overview'); the
   *  review queue opens the sheet directly on 'research'. */
  initialTab?: string;
  /** Company data for edit mode (undefined for create mode) */
  company?: Company;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: CompanyFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void | boolean>;
  /** Relations for the company */
  relations?: Relation[];
  /** Notes for the company */
  notes?: Note[];
  /** Callback to add a note */
  onAddNote?: (content: string) => Promise<void>;
  /** Callback to update a note */
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  /** Callback to delete a note */
  onDeleteNote?: (id: string) => Promise<void>;
  /** Callback to add a relation */
  onAddRelation?: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Callback to remove a relation */
  onRemoveRelation?: (relationId: string) => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  /** Callback for AI research */
  onAIResearch?: (entityName: string, context?: Record<string, string>) => Promise<AIResearchResult | null>;
  /** Callback to apply AI research results */
  onApplyResearch?: (result: AIResearchResult) => void;
  /**
   * Whether research data is loading. Refresh itself has ONE entry point —
   * the footer research button, which calls `onAIResearch` and relabels itself
   * "Refresh Research" once a draft exists. A second, never-rendered refresh
   * prop used to sit here; it was where an AI-043 fix landed while the button
   * the operator actually presses kept the old behaviour.
   */
  isResearchLoading?: boolean;
  // ========== Phase 4: Evidence Tab Props ==========
  /** Claims data for the entity (from graph service) */
  claims?: import('@/lib/graph/types').EntityClaims;
  /** Whether claims are loading */
  isLoadingClaims?: boolean;
  /** Error loading claims */
  claimsError?: string;
  /** Callback to refresh claims */
  onRefreshClaims?: () => Promise<void>;
  /** Callback to curate a claim */
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
}

// ============================================================================
// CREATE MODE NOTICE
// ============================================================================

/**
 * CreateModeNotice
 *
 * Friendly notice shown in tabs during entity creation mode.
 * Explains that certain features become available after saving.
 * Less friction than the previous "Save first to..." message.
 */
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
 * CompanySheet
 *
 * Sheet component for creating and editing companies.
 * Uses EntitySheetShell for consistent layout and includes tabs for
 * Overview, Relations, Notes, and SWOT analysis.
 *
 * @example
 * ```tsx
 * <CompanySheet
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   company={selectedCompany}
 *   onSave={handleSave}
 *   onDelete={handleDelete}
 *   relations={companyRelations}
 *   notes={companyNotes}
 * />
 * ```
 */
export function CompanySheet({
  open,
  onOpenChange,
  initialTab,
  company,
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
  onAIResearch,
  onApplyResearch,
  isResearchLoading,
  // Phase 4: Evidence tab props
  claims,
  isLoadingClaims,
  claimsError: _claimsError,
  onRefreshClaims,
  onCurateClaim,
}: CompanySheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');
  const [contactsCount, setContactsCount] = React.useState(0);
  const [isGraphOpen, setIsGraphOpen] = React.useState(false);

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Company" could open on a non-Overview tab.
  const subjectId = company?.id;
  React.useEffect(() => {
    setActiveTab(initialTab ?? 'overview');
    setContactsCount(0);
  }, [subjectId, initialTab]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isResearching, setIsResearching] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!company;

  const form = useForm<CompanyFormValues>({
    resolver: zodResolver(companyFormSchema),
    mode: 'onChange', // Validate on change so isValid updates in real-time
    defaultValues: EMPTY_COMPANY_FORM_VALUES,
  });

  // Reset form when company changes
  // Provides defaults for legacy companies that may be missing required fields
  React.useEffect(() => {
    if (company) {
      // Ensure type array has at least one valid value (required field)
      const companyType: CompanyType[] = company.type && company.type.length > 0 ? company.type : ['sme'];
      // Ensure size has a valid value
      const companySize = company.size || 'small';
      // Ensure stage has a valid value
      const companyStage = company.stage || 'seed';
      // Normalize industry: legacy/AI-imported docs persist a plain string —
      // dropping it here would silently erase the value on the next save.
      const companyIndustry = normalizeIndustries(company.industry) as CompanyIndustryValue[];

      form.reset({
        name: company.name,
        description: company.description || '',
        website: company.website || '',
        type: companyType,
        industry: companyIndustry,
        industryCustom: company.industryCustom || [],
        size: companySize,
        stage: companyStage,
        status: company.status || 'Watching',
        location: company.location || { city: '', country: '' },
        tags: company.tags || [],
        socialLinks: {
          linkedin: company.socialLinks?.linkedin || '',
          twitter: company.socialLinks?.twitter || '',
          github: company.socialLinks?.github || '',
        },
        technologyStack: company.technologyStack || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults. A bare `reset()`
      // would restore the defaultValues captured by the last `reset(company)`
      // call — i.e. the previously opened company's data would leak into the
      // "New Company" form.
      form.reset(EMPTY_COMPANY_FORM_VALUES);
    }
  }, [company, form]);

  const handleSave = async (data: CompanyFormValues) => {
    setIsSaving(true);
    try {
      await onSave(data);
      onOpenChange(false);
    } catch {
      // The owner surfaces the actionable error. Keep the sheet open so the
      // user's form state is not discarded after a rejected or unknown save.
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      const deleted = await onDelete();
      if (deleted !== false) {
        onOpenChange(false);
      }
    } catch {
      // The owner reports delete failures. Keep the sheet open for retry.
    } finally {
      setIsDeleting(false);
    }
  };

  // Handler for AI research button in footer
  const handleAIResearch = async () => {
    const name = form.getValues('name');
    if (!name || !onAIResearch) return;

    setIsResearching(true);
    try {
      const result = await onAIResearch(name, {
        website: form.getValues('website') || '',
        description: form.getValues('description') || '',
      });
      if (result) {
        handleApplyResearch(result);
      }
    } finally {
      setIsResearching(false);
    }
  };

  // AI-028 — one shared derivation drives BOTH the Research tab and the footer
  // button label, so "Refresh Research" vs "AI Research" can never disagree with
  // the tab about whether research exists (no duplicated section-presence logic).
  const researchPresentation = deriveCompanyResearchPresentation(company);
  const hasResearchData = researchPresentation.kind !== 'none';

  // Handler to apply AI research results to form
  const handleApplyResearch = React.useCallback(
    (result: AIResearchResult) => {
      // Apply description (always overwrite if provided, even if existing)
      if (result.description) {
        form.setValue('description', result.description, { shouldDirty: true });
      }

      // Apply industry with mapping to enum values
      if (result.industry && result.industry.length > 0) {
        // Map AI industry strings to valid enum values, filtering out unmapped ones
        const mappedIndustries = result.industry
          .map(mapIndustryStringToEnum)
          .filter((v): v is CompanyIndustryValue => v !== null);
        const uniqueIndustries = [...new Set(mappedIndustries)];
        if (uniqueIndustries.length > 0) {
          form.setValue('industry', uniqueIndustries, { shouldDirty: true });
        }
        // Store unmapped industries in industryCustom for manual review
        const unmappedIndustries = result.industry.filter((ind) => mapIndustryStringToEnum(ind) === null);
        if (unmappedIndustries.length > 0) {
          const currentCustom = form.getValues('industryCustom') || [];
          const newCustom = [...new Set([...currentCustom, ...unmappedIndustries])];
          form.setValue('industryCustom', newCustom, { shouldDirty: true });
        }
      }

      // Apply location
      if (result.location) {
        if (result.location.city) {
          form.setValue('location.city', result.location.city, { shouldDirty: true });
        }
        if (result.location.country) {
          form.setValue('location.country', result.location.country, { shouldDirty: true });
        }
      }

      // Apply tags (merge with existing)
      if (result.tags && result.tags.length > 0) {
        const currentTags = form.getValues('tags');
        const newTags = [...new Set([...currentTags, ...result.tags])];
        form.setValue('tags', newTags, { shouldDirty: true });
      }

      // Apply technologies (support both 'technologies' and 'technologyStack' field names)
      const techs = result.technologies || result.technologyStack;
      if (techs && techs.length > 0) {
        const currentTech = form.getValues('technologyStack');
        const newTech = [...new Set([...currentTech, ...techs])];
        form.setValue('technologyStack', newTech, { shouldDirty: true });
      }

      // Apply social links
      if (result.socialLinks) {
        if (result.socialLinks.linkedin) {
          form.setValue('socialLinks.linkedin', result.socialLinks.linkedin, { shouldDirty: true });
        }
        if (result.socialLinks.twitter) {
          form.setValue('socialLinks.twitter', result.socialLinks.twitter, { shouldDirty: true });
        }
        if (result.socialLinks.github) {
          form.setValue('socialLinks.github', result.socialLinks.github, { shouldDirty: true });
        }
      }

      // Apply size (map to form enum values)
      // Valid size values: micro, small, medium, large, enterprise
      if (result.size) {
        const normalizedSize = result.size.toLowerCase().trim();
        const mappedSize = SIZE_MAP[normalizedSize];
        if (mappedSize) {
          form.setValue('size', mappedSize, { shouldDirty: true });
        }
      }

      // Apply stage (map to form enum values)
      // Valid stage values: pre_seed, seed, series_a, series_b, series_c_plus, bootstrapped, private, public, ipo, nonprofit
      if (result.stage) {
        const normalizedStage = result.stage.toLowerCase().trim();
        const mappedStage = STAGE_MAP[normalizedStage];
        if (mappedStage) {
          form.setValue('stage', mappedStage, { shouldDirty: true });
        }
      }

      // Apply company types from AI research
      if (result.type && result.type.length > 0) {
        const mappedTypes = result.type
          .map((t) => TYPE_MAP[t.toLowerCase().trim()])
          .filter((t): t is CompanyType => t !== undefined);
        const uniqueTypes = [...new Set(mappedTypes)];
        if (uniqueTypes.length > 0) {
          form.setValue('type', uniqueTypes, { shouldDirty: true, shouldValidate: true });
        }
      }

      // Trigger form validation after all changes
      form.trigger();

      onApplyResearch?.(result);
    },
    [form, onApplyResearch]
  );

  // Competitors are a subset of the same `relations` prop (relationType ===
  // 'competes_with') — CompanyCompetitors derives its own list the same way
  // via getRelationsForEntity, so this stays in sync without a second fetch.
  const competitorsCount = React.useMemo(
    () => relations.filter((r) => r.relationType === 'competes_with').length,
    [relations]
  );

  // Tab order mirrors TechnologySheet: Overview, [entity-specific], Relations,
  // Knowledge, Research, Notes.
  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: Building2,
      content: <OverviewTab form={form} isLoading={isLoading} hasResearchDraft={hasResearchData} />,
    },
    {
      id: 'contacts',
      label: 'Contacts',
      icon: Users,
      badge: contactsCount || undefined,
      content: company ? (
        <ContactManager companyId={company.id} onCountChange={setContactsCount} />
      ) : (
        <CreateModeNotice feature="contacts" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'competitors',
      label: 'Competitors',
      icon: Swords,
      badge: competitorsCount || undefined,
      content: company ? (
        <CompanyCompetitors companyId={company.id} companyName={company.name} />
      ) : (
        <CreateModeNotice feature="competitors" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: company ? (
        <RelationsTab
          entityId={company.id}
          entityName={company.name}
          entityType="company"
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
      content: company ? (
        <KnowledgeTab
          entityType="company"
          entityId={company.id}
          entityName={company.name}
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
      icon: Search,
      content: company ? (
        // AI-028 — the single presentation state (shared with the footer label
        // above) so the sheet and the companies list agree, and a legacy
        // aiResearch-only company shows an honest draft state instead of
        // "No research data available".
        <ResearchTab presentation={researchPresentation} companyId={company.id} isLoading={isResearchLoading} />
      ) : (
        <CreateModeNotice feature="research" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'notes',
      label: 'Notes',
      icon: MessageSquare,
      content: company ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote || (async () => {})}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this company..."
          enableAutosave={true}
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
        title={isEditMode ? company.name : 'New Company'}
        entityType="company"
        entityId={isEditMode ? company.id : undefined}
        open={open}
        onOpenChange={onOpenChange}
        subtitle={
          isEditMode ? `${company.status} · ${company.location?.city || 'Unknown location'}` : 'Create a new company'
        }
        width="lg"
        headerActions={
          isEditMode && (
            <Button variant="outline" size="sm" onClick={() => setIsGraphOpen(true)}>
              <Network className="h-4 w-4 mr-2" />
              Graph
            </Button>
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
            entityName={isEditMode ? company.name : 'company'}
            extraActions={
              onAIResearch ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAIResearch}
                  disabled={isResearching || !form.getValues('name') || isSaving}
                  className="gap-2"
                >
                  {isResearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {isResearching ? 'Researching...' : hasResearchData ? 'Refresh Research' : 'AI Research'}
                </Button>
              ) : undefined
            }
          />
        }
      >
        {isLoading ? (
          <EntitySheetSkeleton showTabs tabCount={8} fieldCount={6} />
        ) : (
          <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
        )}
      </EntitySheetShell>

      {/* Relations Map Dialog — EntityRelationshipPanel is entity-generic (see
        P-C3c: entityId/entityType props, company back-compat already built in). */}
      {isEditMode && company && (
        <EntityRelationshipPanel
          isOpen={isGraphOpen}
          onOpenChange={setIsGraphOpen}
          entityId={company.id}
          entityName={company.name}
          entityType="company"
          mode="dialog"
        />
      )}
    </>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { CompanySheetProps, CompanyFormValues };
export { companyFormSchema } from './constants';
