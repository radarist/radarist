'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Target, Link2, MessageSquare, FileText, Plus, X, CheckCircle2, ExternalLink } from 'lucide-react';

import { EntitySheetShell } from './EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from './EntitySheetTabs';
import { EntitySheetFooter } from './EntitySheetFooter';
import { EntitySheetSkeleton } from './EntitySheetSkeleton';
import { NotesTab, RelationsTab, KnowledgeTab, type Note } from './tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { cn } from '@/lib/utils';

import type { Strategy, Relation, EntityType, RelationType } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const DIRECTIVE_CATEGORIES = ['Growth', 'Sustainability', 'Innovation', 'Efficiency', 'Risk', 'Custom'] as const;

const strategyFormSchema = z.object({
  name: z.string().min(1, 'Strategy name is required'),
  description: z.string().min(1, 'Description is required'),
  content: z.string(),
  mainDirectives: z.array(
    z.object({
      id: z.string(),
      directive: z.string(),
      category: z.enum(DIRECTIVE_CATEGORIES),
      metrics: z
        .object({
          target: z.string(),
          timeline: z.string(),
          baseline: z.string().optional(),
        })
        .optional(),
      priority: z.number().min(1).max(10),
    })
  ),
  links: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
    })
  ),
});

type StrategyFormValues = z.infer<typeof strategyFormSchema>;

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened strategy's data. Create mode must reset to this constant.
 */
const EMPTY_STRATEGY_FORM_VALUES: DefaultValues<StrategyFormValues> = {
  name: '',
  description: '',
  content: '',
  mainDirectives: [],
  links: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface StrategySheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Strategy data for edit mode (undefined for create mode) */
  strategy?: Strategy;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: StrategyFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Relations for the strategy */
  relations?: Relation[];
  /** Notes for the strategy */
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
  /** Claims data for this strategy */
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
// MAIN COMPONENT
// ============================================================================

/**
 * StrategySheet
 *
 * Sheet component for creating and editing strategies.
 * Includes tabs for Overview, Directives, Relations, and Notes.
 */
export function StrategySheet({
  open,
  onOpenChange,
  strategy,
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
}: StrategySheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Strategy" could open on a non-Overview tab.
  const subjectId = strategy?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!strategy;

  const form = useForm<StrategyFormValues>({
    resolver: zodResolver(strategyFormSchema),
    defaultValues: EMPTY_STRATEGY_FORM_VALUES,
  });

  // Reset form when strategy changes
  React.useEffect(() => {
    if (strategy) {
      form.reset({
        name: strategy.name,
        description: strategy.description,
        content: strategy.content || '',
        mainDirectives: strategy.mainDirectives || [],
        links: strategy.links || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened strategy's data (see constant docs).
      form.reset(EMPTY_STRATEGY_FORM_VALUES);
    }
  }, [strategy, form]);

  const handleSave = async (data: StrategyFormValues) => {
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
      icon: Target,
      content: <OverviewTab form={form} />,
    },
    {
      id: 'directives',
      label: 'Directives',
      icon: CheckCircle2,
      badge: form.watch('mainDirectives').length || undefined,
      content: <DirectivesTab form={form} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: strategy ? (
        <RelationsTab
          entityId={strategy.id}
          entityName={strategy.name}
          entityType="strategy"
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
      content: strategy ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this strategy..."
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
      content: strategy ? (
        <KnowledgeTab
          entityType="strategy"
          entityId={strategy.id}
          entityName={strategy.name}
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

  return (
    <EntitySheetShell
      title={isEditMode ? strategy.name : 'New Strategy'}
      entityType="strategy"
      entityId={isEditMode ? strategy.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={isEditMode ? `${strategy.mainDirectives?.length || 0} directives` : 'Create a new strategy'}
      width="lg"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === strategy?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
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
          entityName={isEditMode ? strategy.name : 'strategy'}
        />
      }
    >
      {isLoading ? (
        <EntitySheetSkeleton showTabs tabCount={5} fieldCount={5} />
      ) : (
        <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      )}
    </EntitySheetShell>
  );
}

// ============================================================================
// OVERVIEW TAB
// ============================================================================

interface OverviewTabProps {
  form: ReturnType<typeof useForm<StrategyFormValues>>;
}

function OverviewTab({ form }: OverviewTabProps) {
  const [newLinkTitle, setNewLinkTitle] = React.useState('');
  const [newLinkUrl, setNewLinkUrl] = React.useState('');

  const handleAddLink = () => {
    if (!newLinkTitle.trim() || !newLinkUrl.trim()) return;
    const current = form.getValues('links');
    form.setValue('links', [...current, { title: newLinkTitle.trim(), url: newLinkUrl.trim() }], { shouldDirty: true });
    setNewLinkTitle('');
    setNewLinkUrl('');
  };

  const handleRemoveLink = (index: number) => {
    const current = form.getValues('links');
    form.setValue(
      'links',
      current.filter((_, i) => i !== index),
      { shouldDirty: true }
    );
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Strategy Name *</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., AI-First Innovation" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description *</FormLabel>
                <FormControl>
                  <Textarea placeholder="Brief summary of this strategy..." rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="content"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full Content</FormLabel>
                <FormControl>
                  <Textarea placeholder="Detailed strategy content (supports markdown)..." rows={8} {...field} />
                </FormControl>
                <FormDescription>Supports markdown formatting</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Reference Links */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Reference Links</h3>

          <div className="space-y-2">
            {form.watch('links').map((link, index) => (
              <div key={index} className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{link.title}</p>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {link.url}
                  </a>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleRemoveLink(index)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Link title"
              value={newLinkTitle}
              onChange={(e) => setNewLinkTitle(e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder="URL"
              value={newLinkUrl}
              onChange={(e) => setNewLinkUrl(e.target.value)}
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddLink();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddLink}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// DIRECTIVES TAB
// ============================================================================

const CATEGORY_COLORS: Record<(typeof DIRECTIVE_CATEGORIES)[number], string> = {
  Growth: 'bg-green-500/10 text-green-600 border-green-500/30',
  Sustainability: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  Innovation: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  Efficiency: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  Risk: 'bg-red-500/10 text-red-600 border-red-500/30',
  Custom: 'bg-muted text-muted-foreground border-border',
};

function DirectivesTab({ form }: OverviewTabProps) {
  const [newDirective, setNewDirective] = React.useState({
    directive: '',
    category: 'Innovation' as (typeof DIRECTIVE_CATEGORIES)[number],
    priority: 5,
  });

  const handleAddDirective = () => {
    if (!newDirective.directive.trim()) return;
    const current = form.getValues('mainDirectives');
    form.setValue(
      'mainDirectives',
      [
        ...current,
        {
          id: `directive-${Date.now()}`,
          directive: newDirective.directive.trim(),
          category: newDirective.category,
          priority: newDirective.priority,
        },
      ],
      { shouldDirty: true }
    );
    setNewDirective({ directive: '', category: 'Innovation', priority: 5 });
  };

  const handleRemoveDirective = (id: string) => {
    const current = form.getValues('mainDirectives');
    form.setValue(
      'mainDirectives',
      current.filter((d) => d.id !== id),
      { shouldDirty: true }
    );
  };

  const directives = form.watch('mainDirectives');

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">Strategic Directives</h3>
          <span className="text-xs text-muted-foreground">{directives.length} directive(s)</span>
        </div>

        {/* Existing Directives */}
        <div className="space-y-3">
          {directives.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No directives yet. Add strategic goals below.
            </div>
          ) : (
            directives.map((directive) => (
              <div key={directive.id} className="group flex items-start gap-3 rounded-lg border p-4">
                <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{directive.directive}</span>
                    <Badge variant="outline" className={cn('text-xs', CATEGORY_COLORS[directive.category])}>
                      {directive.category}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      Priority: {directive.priority}/10
                    </Badge>
                  </div>
                  {directive.metrics && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Target: {directive.metrics.target} ({directive.metrics.timeline})
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleRemoveDirective(directive.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add New Directive */}
      <div className="space-y-4 rounded-lg border border-dashed p-4">
        <h4 className="text-sm font-medium">Add Directive</h4>

        <Textarea
          placeholder="Directive statement (e.g., Increase AI adoption by 50% within 18 months)"
          value={newDirective.directive}
          onChange={(e) => setNewDirective({ ...newDirective, directive: e.target.value })}
          rows={2}
        />

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Category:</span>
          {DIRECTIVE_CATEGORIES.map((category) => (
            <Badge
              key={category}
              variant={newDirective.category === category ? 'default' : 'outline'}
              className={cn('cursor-pointer', newDirective.category === category && CATEGORY_COLORS[category])}
              onClick={() => setNewDirective({ ...newDirective, category })}
            >
              {category}
            </Badge>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Priority (1-10):</span>
          <Input
            type="number"
            min={1}
            max={10}
            value={newDirective.priority}
            onChange={(e) => setNewDirective({ ...newDirective, priority: parseInt(e.target.value) || 5 })}
            className="w-20"
          />
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddDirective}
          disabled={!newDirective.directive.trim()}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Directive
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// CREATE MODE NOTICE
// ============================================================================

/**
 * CreateModeNotice - Friendly notice shown in tabs during entity creation mode.
 * Displayed when features like relations/notes require the entity to be saved first.
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
// EXPORTS
// ============================================================================

export type { StrategySheetProps, StrategyFormValues };
