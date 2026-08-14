'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AlertTriangle,
  Link2,
  MessageSquare,
  Target,
  DollarSign,
  Building2,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
  Circle,
  TrendingDown,
  FileText,
} from 'lucide-react';

import { EntitySheetShell } from './EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from './EntitySheetTabs';
import { EntitySheetFooter } from './EntitySheetFooter';
import { EntitySheetSkeleton } from './EntitySheetSkeleton';
import { NotesTab, type Note } from './tabs';
import { RelationsTab } from './tabs';
import { KnowledgeTab } from './tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

import type {
  PainPoint,
  PainPointSeverity,
  PainPointStatus,
  PainPointCategory,
  Relation,
  EntityType,
  RelationType,
} from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const PAIN_POINT_SEVERITIES: PainPointSeverity[] = ['critical', 'high', 'medium', 'low'];
const PAIN_POINT_STATUSES: PainPointStatus[] = ['identified', 'validated', 'being_addressed', 'resolved'];
const PAIN_POINT_CATEGORIES: PainPointCategory[] = [
  'operational',
  'customer',
  'regulatory',
  'technical',
  'market',
  'financial',
  'talent',
  'other',
];

const painPointFormSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  severity: z.enum(PAIN_POINT_SEVERITIES as [string, ...string[]]),
  category: z.enum(PAIN_POINT_CATEGORIES as [string, ...string[]]),
  status: z.enum(PAIN_POINT_STATUSES as [string, ...string[]]),
  affectedOrgUnitIds: z.array(z.string()),
  estimatedImpact: z.number().min(0).optional(),
  actualImpact: z.number().min(0).optional(),
  impactDescription: z.string().optional(),
  rootCauses: z.array(z.string()),
  tags: z.array(z.string()),
});

type PainPointFormValues = z.infer<typeof painPointFormSchema>;

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened pain point's data. Create mode must reset to this constant.
 */
const EMPTY_PAIN_POINT_FORM_VALUES: DefaultValues<PainPointFormValues> = {
  title: '',
  description: '',
  severity: 'medium',
  category: 'operational',
  status: 'identified',
  affectedOrgUnitIds: [],
  rootCauses: [],
  tags: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface PainPointSheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Pain point data for edit mode (undefined for create mode) */
  painPoint?: PainPoint;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: PainPointFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Relations for the pain point */
  relations?: Relation[];
  /** Notes for the pain point */
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
  /** Available org units for selection */
  orgUnits?: Array<{ id: string; name: string }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SEVERITY_CONFIG: Record<PainPointSeverity, { color: string; icon: typeof AlertTriangle; label: string }> = {
  critical: { color: 'bg-red-500/10 text-red-600 border-red-500/30', icon: AlertTriangle, label: 'Critical' },
  high: { color: 'bg-orange-500/10 text-orange-600 border-orange-500/30', icon: AlertCircle, label: 'High' },
  medium: { color: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30', icon: Circle, label: 'Medium' },
  low: { color: 'bg-muted text-muted-foreground border-border', icon: Circle, label: 'Low' },
};

const STATUS_CONFIG: Record<PainPointStatus, { color: string; label: string }> = {
  identified: { color: 'bg-muted text-muted-foreground border-border', label: 'Identified' },
  validated: { color: 'bg-blue-500/10 text-blue-600 border-blue-500/30', label: 'Validated' },
  being_addressed: { color: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30', label: 'Being Addressed' },
  resolved: { color: 'bg-green-500/10 text-green-600 border-green-500/30', label: 'Resolved' },
};

const CATEGORY_CONFIG: Record<PainPointCategory, { color: string; label: string }> = {
  operational: { color: 'bg-blue-500/10 text-blue-600 border-blue-500/30', label: 'Operational' },
  customer: { color: 'bg-purple-500/10 text-purple-600 border-purple-500/30', label: 'Customer' },
  regulatory: { color: 'bg-red-500/10 text-red-600 border-red-500/30', label: 'Regulatory' },
  technical: { color: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/30', label: 'Technical' },
  market: { color: 'bg-orange-500/10 text-orange-600 border-orange-500/30', label: 'Market' },
  financial: { color: 'bg-green-500/10 text-green-600 border-green-500/30', label: 'Financial' },
  talent: { color: 'bg-pink-500/10 text-pink-600 border-pink-500/30', label: 'Talent' },
  other: { color: 'bg-muted text-muted-foreground border-border', label: 'Other' },
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * PainPointSheet
 *
 * Sheet component for creating and editing pain points.
 * Includes tabs for Overview, Impact Analysis, Affected Units, Relations, and Notes.
 */
export function PainPointSheet({
  open,
  onOpenChange,
  painPoint,
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
  orgUnits = [],
}: PainPointSheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Pain Point" could open on a non-Overview tab.
  const subjectId = painPoint?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!painPoint;

  const form = useForm<PainPointFormValues>({
    resolver: zodResolver(painPointFormSchema),
    defaultValues: EMPTY_PAIN_POINT_FORM_VALUES,
  });

  // Reset form when pain point changes
  React.useEffect(() => {
    if (painPoint) {
      form.reset({
        title: painPoint.title,
        description: painPoint.description,
        severity: painPoint.severity,
        category: painPoint.category,
        status: painPoint.status,
        affectedOrgUnitIds: painPoint.affectedOrgUnitIds || [],
        estimatedImpact: painPoint.estimatedImpact,
        actualImpact: painPoint.actualImpact,
        impactDescription: painPoint.impactDescription || '',
        rootCauses: painPoint.rootCauses || [],
        tags: painPoint.tags || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened pain point's data (see constant docs).
      form.reset(EMPTY_PAIN_POINT_FORM_VALUES);
    }
  }, [painPoint, form]);

  const handleSave = async (data: PainPointFormValues) => {
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
      icon: AlertTriangle,
      content: <OverviewTab form={form} />,
    },
    {
      id: 'impact',
      label: 'Impact Analysis',
      icon: TrendingDown,
      content: <ImpactTab form={form} />,
    },
    {
      id: 'affected',
      label: 'Affected Units',
      icon: Building2,
      badge: form.watch('affectedOrgUnitIds').length || undefined,
      content: <AffectedUnitsTab form={form} orgUnits={orgUnits} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: painPoint ? (
        <RelationsTab
          entityId={painPoint.id}
          entityName={painPoint.title}
          entityType="painPoint"
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
      content: painPoint ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this pain point..."
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
      content: painPoint ? (
        <KnowledgeTab
          entityType="pain_point"
          entityId={painPoint.id}
          entityName={painPoint.title}
          onEntityClick={onEntityClick}
        />
      ) : (
        <CreateModeNotice feature="knowledge" />
      ),
      disabled: !isEditMode,
    },
  ];

  const severityConfig = SEVERITY_CONFIG[form.watch('severity') as PainPointSeverity];

  return (
    <EntitySheetShell
      title={isEditMode ? painPoint.title : 'New Pain Point'}
      entityType="painPoint"
      entityId={isEditMode ? painPoint.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={
        isEditMode
          ? `${severityConfig.label} · ${STATUS_CONFIG[painPoint.status].label}`
          : 'Document a business problem'
      }
      width="lg"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === painPoint?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
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
          entityName={isEditMode ? painPoint.title : 'pain point'}
        />
      }
    >
      {isLoading ? (
        <EntitySheetSkeleton showTabs tabCount={6} fieldCount={6} />
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
  form: ReturnType<typeof useForm<PainPointFormValues>>;
}

function OverviewTab({ form }: OverviewTabProps) {
  const [newTag, setNewTag] = React.useState('');

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    const currentTags = form.getValues('tags');
    if (!currentTags.includes(newTag.trim())) {
      form.setValue('tags', [...currentTags, newTag.trim()], { shouldDirty: true });
    }
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => {
    const currentTags = form.getValues('tags');
    form.setValue(
      'tags',
      currentTags.filter((t) => t !== tag),
      { shouldDirty: true }
    );
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Problem Details</h3>

          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Slow checkout process" {...field} />
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
                  <Textarea placeholder="Describe the problem in detail..." rows={4} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Classification */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Classification</h3>

          <div className="grid grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="severity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Severity *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select severity" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAIN_POINT_SEVERITIES.map((severity) => {
                        const config = SEVERITY_CONFIG[severity];
                        const Icon = config.icon;
                        return (
                          <SelectItem key={severity} value={severity}>
                            <div className="flex items-center gap-2">
                              <Icon
                                className={cn(
                                  'h-3 w-3',
                                  severity === 'critical'
                                    ? 'text-red-500'
                                    : severity === 'high'
                                      ? 'text-orange-500'
                                      : severity === 'medium'
                                        ? 'text-yellow-500'
                                        : 'text-muted-foreground'
                                )}
                              />
                              {config.label}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAIN_POINT_CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          <Badge variant="outline" className={cn('text-xs', CATEGORY_CONFIG[category].color)}>
                            {CATEGORY_CONFIG[category].label}
                          </Badge>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAIN_POINT_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          <Badge variant="outline" className={cn('text-xs', STATUS_CONFIG[status].color)}>
                            {STATUS_CONFIG[status].label}
                          </Badge>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Tags</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('tags').map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1">
                {tag}
                <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveTag(tag)} />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a tag..."
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
              className="flex-1"
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddTag}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// IMPACT TAB
// ============================================================================

interface ImpactTabProps {
  form: ReturnType<typeof useForm<PainPointFormValues>>;
}

function ImpactTab({ form }: ImpactTabProps) {
  const [newCause, setNewCause] = React.useState('');

  const handleAddCause = () => {
    if (!newCause.trim()) return;
    const current = form.getValues('rootCauses');
    form.setValue('rootCauses', [...current, newCause.trim()], { shouldDirty: true });
    setNewCause('');
  };

  const handleRemoveCause = (index: number) => {
    const current = form.getValues('rootCauses');
    form.setValue(
      'rootCauses',
      current.filter((_, i) => i !== index),
      { shouldDirty: true }
    );
  };

  const estimatedImpact = form.watch('estimatedImpact') || 0;
  const actualImpact = form.watch('actualImpact') || 0;

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Financial Impact */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Financial Impact
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="estimatedImpact"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated Annual Impact (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      placeholder="e.g., 500000"
                      value={field.value || ''}
                      onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormDescription>Cost of the problem if unaddressed</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="actualImpact"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Impact (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      placeholder="e.g., 450000"
                      value={field.value || ''}
                      onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormDescription>Measured after resolution</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Impact Comparison */}
          {estimatedImpact > 0 && actualImpact > 0 && (
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Impact Reduction</span>
                <span className={cn('font-medium', actualImpact < estimatedImpact ? 'text-green-500' : 'text-red-500')}>
                  {actualImpact < estimatedImpact ? '-' : '+'}$
                  {Math.abs(estimatedImpact - actualImpact).toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {actualImpact < estimatedImpact
                  ? `Resolution saved $${(estimatedImpact - actualImpact).toLocaleString()} annually`
                  : `Actual impact exceeded estimate by $${(actualImpact - estimatedImpact).toLocaleString()}`}
              </p>
            </div>
          )}

          <FormField
            control={form.control}
            name="impactDescription"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Impact Description</FormLabel>
                <FormControl>
                  <Textarea placeholder="Describe the business impact qualitatively..." rows={3} {...field} />
                </FormControl>
                <FormDescription>Qualitative description of how this affects the business</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Root Causes */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Target className="h-4 w-4" />
            Root Causes
          </h3>

          <div className="space-y-2">
            {form.watch('rootCauses').length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">No root causes documented yet.</div>
            ) : (
              form.watch('rootCauses').map((cause, index) => (
                <div key={index} className="group flex items-center gap-3 rounded-lg border p-3">
                  <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                    {index + 1}
                  </div>
                  <span className="flex-1 text-sm">{cause}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleRemoveCause(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a root cause..."
              value={newCause}
              onChange={(e) => setNewCause(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCause();
                }
              }}
              className="flex-1"
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddCause}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// AFFECTED UNITS TAB
// ============================================================================

interface AffectedUnitsTabProps {
  form: ReturnType<typeof useForm<PainPointFormValues>>;
  orgUnits: Array<{ id: string; name: string }>;
}

function AffectedUnitsTab({ form, orgUnits }: AffectedUnitsTabProps) {
  const selectedIds = form.watch('affectedOrgUnitIds');

  const handleToggle = (unitId: string) => {
    const current = form.getValues('affectedOrgUnitIds');
    if (current.includes(unitId)) {
      form.setValue(
        'affectedOrgUnitIds',
        current.filter((id) => id !== unitId),
        { shouldDirty: true }
      );
    } else {
      form.setValue('affectedOrgUnitIds', [...current, unitId], { shouldDirty: true });
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Affected Organizational Units
          </h3>
          <span className="text-xs text-muted-foreground">{selectedIds.length} selected</span>
        </div>

        <p className="text-[0.8rem] text-muted-foreground">
          Select all organizational units affected by this pain point.
        </p>

        {orgUnits.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No organizational units available.</p>
            <p className="text-xs">Create org units first to link them here.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {orgUnits.map((unit) => {
              const isSelected = selectedIds.includes(unit.id);
              return (
                <div
                  key={unit.id}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    isSelected && 'bg-primary/5 border-primary'
                  )}
                  onClick={() => handleToggle(unit.id)}
                >
                  <Checkbox checked={isSelected} onCheckedChange={() => handleToggle(unit.id)} />
                  <Building2 className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                  <span className={cn('font-medium text-sm', isSelected && 'text-primary')}>{unit.name}</span>
                  {isSelected && <CheckCircle2 className="h-4 w-4 ml-auto text-primary" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
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
// EXPORTS
// ============================================================================

export type { PainPointSheetProps, PainPointFormValues };
