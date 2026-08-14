'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Target,
  Link2,
  MessageSquare,
  Calendar,
  DollarSign,
  Plus,
  X,
  CheckCircle2,
  Clock,
  Flag,
  Milestone,
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
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

import type { Initiative, InitiativeStatus, InitiativePriority, Relation, EntityType, RelationType } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const INITIATIVE_STATUSES: InitiativeStatus[] = ['proposed', 'approved', 'active', 'on_hold', 'completed', 'cancelled'];
const INITIATIVE_PRIORITIES: InitiativePriority[] = ['critical', 'high', 'medium', 'low'];

const initiativeFormSchema = z.object({
  name: z.string().min(1, 'Initiative name is required'),
  description: z.string().min(1, 'Description is required'),
  ownerOrgUnitId: z.string().min(1, 'Owner org unit is required'),
  ownerOrgUnitName: z.string().optional(),
  sponsorName: z.string().optional(),
  status: z.enum(INITIATIVE_STATUSES as [string, ...string[]]),
  priority: z.enum(INITIATIVE_PRIORITIES as [string, ...string[]]),
  startDate: z.number().optional(),
  targetEndDate: z.number().optional(),
  actualEndDate: z.number().optional(),
  budget: z.number().min(0).optional(),
  actualSpend: z.number().min(0).optional(),
  tags: z.array(z.string()),
  milestones: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        targetDate: z.number().optional(),
        completedDate: z.number().optional(),
      })
    )
    .optional(),
});

type InitiativeFormValues = z.infer<typeof initiativeFormSchema>;

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened initiative's data. Create mode must reset to this constant.
 */
const EMPTY_INITIATIVE_FORM_VALUES: DefaultValues<InitiativeFormValues> = {
  name: '',
  description: '',
  ownerOrgUnitId: '',
  ownerOrgUnitName: '',
  sponsorName: '',
  status: 'proposed',
  priority: 'medium',
  tags: [],
  milestones: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface InitiativeSheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Initiative data for edit mode (undefined for create mode) */
  initiative?: Initiative;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: InitiativeFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Relations for the initiative */
  relations?: Relation[];
  /** Notes for the initiative */
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
  /** Available org units for owner selection */
  orgUnits?: Array<{ id: string; name: string }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STATUS_COLORS: Record<InitiativeStatus, string> = {
  proposed: 'bg-muted text-muted-foreground border-border',
  approved: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  active: 'bg-green-500/10 text-green-600 border-green-500/30',
  on_hold: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  cancelled: 'bg-red-500/10 text-red-600 border-red-500/30',
};

const PRIORITY_COLORS: Record<InitiativePriority, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/30',
  high: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  medium: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  low: 'bg-muted text-muted-foreground border-border',
};

const STATUS_LABELS: Record<InitiativeStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  active: 'Active',
  on_hold: 'On Hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PRIORITY_LABELS: Record<InitiativePriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * InitiativeSheet
 *
 * Sheet component for creating and editing initiatives.
 * Includes tabs for Overview, Timeline & Budget, Milestones, Relations, and Notes.
 */
export function InitiativeSheet({
  open,
  onOpenChange,
  initiative,
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
}: InitiativeSheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Initiative" could open on a non-Overview tab.
  const subjectId = initiative?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!initiative;

  const form = useForm<InitiativeFormValues>({
    resolver: zodResolver(initiativeFormSchema),
    defaultValues: EMPTY_INITIATIVE_FORM_VALUES,
  });

  // Reset form when initiative changes
  React.useEffect(() => {
    if (initiative) {
      form.reset({
        name: initiative.name,
        description: initiative.description,
        ownerOrgUnitId: initiative.ownerOrgUnitId,
        ownerOrgUnitName: initiative.ownerOrgUnitName || '',
        sponsorName: initiative.sponsorName || '',
        status: initiative.status,
        priority: initiative.priority,
        startDate: initiative.startDate,
        targetEndDate: initiative.targetEndDate,
        actualEndDate: initiative.actualEndDate,
        budget: initiative.budget,
        actualSpend: initiative.actualSpend,
        tags: initiative.tags || [],
        milestones: initiative.milestones || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened initiative's data (see constant docs).
      form.reset(EMPTY_INITIATIVE_FORM_VALUES);
    }
  }, [initiative, form]);

  const handleSave = async (data: InitiativeFormValues) => {
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
      content: <OverviewTab form={form} orgUnits={orgUnits} />,
    },
    {
      id: 'timeline',
      label: 'Timeline & Budget',
      icon: Calendar,
      content: <TimelineBudgetTab form={form} />,
    },
    {
      id: 'milestones',
      label: 'Milestones',
      icon: Milestone,
      badge: form.watch('milestones')?.length || undefined,
      content: <MilestonesTab form={form} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: initiative ? (
        <RelationsTab
          entityId={initiative.id}
          entityName={initiative.name}
          entityType="initiative"
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
      content: initiative ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this initiative..."
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
      content: initiative ? (
        <KnowledgeTab
          entityType="initiative"
          entityId={initiative.id}
          entityName={initiative.name}
          onEntityClick={onEntityClick}
        />
      ) : (
        <CreateModeNotice feature="knowledge" />
      ),
      disabled: !isEditMode,
    },
  ];

  return (
    <EntitySheetShell
      title={isEditMode ? initiative.name : 'New Initiative'}
      entityType="initiative"
      entityId={isEditMode ? initiative.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={
        isEditMode
          ? `${STATUS_LABELS[initiative.status]} · ${PRIORITY_LABELS[initiative.priority]} Priority`
          : 'Create a new initiative'
      }
      width="lg"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === initiative?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
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
          entityName={isEditMode ? initiative.name : 'initiative'}
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
  form: ReturnType<typeof useForm<InitiativeFormValues>>;
  orgUnits: Array<{ id: string; name: string }>;
}

function OverviewTab({ form, orgUnits }: OverviewTabProps) {
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
          <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Initiative Name *</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Digital Transformation Q1" {...field} />
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
                  <Textarea placeholder="Brief summary of this initiative..." rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Status & Priority */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Status & Priority</h3>

          <div className="grid grid-cols-2 gap-4">
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
                      {INITIATIVE_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={cn('text-xs', STATUS_COLORS[status])}>
                              {STATUS_LABELS[status]}
                            </Badge>
                          </div>
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
              name="priority"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select priority" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {INITIATIVE_PRIORITIES.map((priority) => (
                        <SelectItem key={priority} value={priority}>
                          <div className="flex items-center gap-2">
                            <Flag
                              className={cn(
                                'h-3 w-3',
                                PRIORITY_COLORS[priority].includes('red')
                                  ? 'text-red-500'
                                  : PRIORITY_COLORS[priority].includes('orange')
                                    ? 'text-orange-500'
                                    : PRIORITY_COLORS[priority].includes('yellow')
                                      ? 'text-yellow-500'
                                      : 'text-muted-foreground'
                              )}
                            />
                            {PRIORITY_LABELS[priority]}
                          </div>
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

        {/* Ownership */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Ownership</h3>

          <FormField
            control={form.control}
            name="ownerOrgUnitId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Owner Org Unit *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select org unit" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {orgUnits.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>The department or team responsible for this initiative</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="sponsorName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Executive Sponsor</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Jane Smith (VP Engineering)" {...field} />
                </FormControl>
                <FormDescription>Senior leader championing this initiative</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
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
// TIMELINE & BUDGET TAB
// ============================================================================

interface TimelineBudgetTabProps {
  form: ReturnType<typeof useForm<InitiativeFormValues>>;
}

function TimelineBudgetTab({ form }: TimelineBudgetTabProps) {
  const formatDateForInput = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp).toISOString().split('T')[0];
  };

  const parseInputDate = (dateString: string) => {
    if (!dateString) return undefined;
    return new Date(dateString).getTime();
  };

  const budget = form.watch('budget') || 0;
  const actualSpend = form.watch('actualSpend') || 0;
  const spendPercentage = budget > 0 ? Math.round((actualSpend / budget) * 100) : 0;

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Timeline */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Timeline
          </h3>

          <div className="grid grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={formatDateForInput(field.value)}
                      onChange={(e) => field.onChange(parseInputDate(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="targetEndDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Target End Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={formatDateForInput(field.value)}
                      onChange={(e) => field.onChange(parseInputDate(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="actualEndDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual End Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={formatDateForInput(field.value)}
                      onChange={(e) => field.onChange(parseInputDate(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription>Set when completed</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Budget */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Budget
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="budget"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Allocated Budget (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      placeholder="e.g., 500000"
                      value={field.value || ''}
                      onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="actualSpend"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Spend (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      placeholder="e.g., 125000"
                      value={field.value || ''}
                      onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Budget Progress */}
          {budget > 0 && (
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Budget Utilization</span>
                <span
                  className={cn(
                    'font-medium',
                    spendPercentage > 100 ? 'text-red-500' : spendPercentage > 80 ? 'text-yellow-500' : 'text-green-500'
                  )}
                >
                  {spendPercentage}%
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all',
                    spendPercentage > 100 ? 'bg-red-500' : spendPercentage > 80 ? 'bg-yellow-500' : 'bg-green-500'
                  )}
                  style={{ width: `${Math.min(spendPercentage, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>${actualSpend.toLocaleString()} spent</span>
                <span>${(budget - actualSpend).toLocaleString()} remaining</span>
              </div>
            </div>
          )}
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// MILESTONES TAB
// ============================================================================

interface MilestonesTabProps {
  form: ReturnType<typeof useForm<InitiativeFormValues>>;
}

function MilestonesTab({ form }: MilestonesTabProps) {
  const [newMilestone, setNewMilestone] = React.useState({
    title: '',
    targetDate: '',
  });

  const handleAddMilestone = () => {
    if (!newMilestone.title.trim()) return;
    const current = form.getValues('milestones') || [];
    form.setValue(
      'milestones',
      [
        ...current,
        {
          id: `milestone-${Date.now()}`,
          title: newMilestone.title.trim(),
          targetDate: newMilestone.targetDate ? new Date(newMilestone.targetDate).getTime() : undefined,
        },
      ],
      { shouldDirty: true }
    );
    setNewMilestone({ title: '', targetDate: '' });
  };

  const handleRemoveMilestone = (id: string) => {
    const current = form.getValues('milestones') || [];
    form.setValue(
      'milestones',
      current.filter((m) => m.id !== id),
      { shouldDirty: true }
    );
  };

  const handleToggleComplete = (id: string) => {
    const current = form.getValues('milestones') || [];
    form.setValue(
      'milestones',
      current.map((m) => {
        if (m.id === id) {
          return {
            ...m,
            completedDate: m.completedDate ? undefined : Date.now(),
          };
        }
        return m;
      }),
      { shouldDirty: true }
    );
  };

  const milestones = form.watch('milestones') || [];
  const completedCount = milestones.filter((m) => m.completedDate).length;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Milestone className="h-4 w-4" />
            Project Milestones
          </h3>
          <span className="text-xs text-muted-foreground">
            {completedCount}/{milestones.length} completed
          </span>
        </div>

        {/* Progress Bar */}
        {milestones.length > 0 && (
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round((completedCount / milestones.length) * 100)}%` }}
            />
          </div>
        )}

        {/* Existing Milestones */}
        <div className="space-y-2">
          {milestones.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No milestones yet. Add key deliverables below.
            </div>
          ) : (
            milestones.map((milestone, index) => (
              <div
                key={milestone.id || `milestone-${index}`}
                className={cn(
                  'group flex items-center gap-3 rounded-lg border p-3',
                  milestone.completedDate && 'bg-muted/30'
                )}
              >
                <button
                  type="button"
                  onClick={() => handleToggleComplete(milestone.id)}
                  className={cn(
                    'h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors',
                    milestone.completedDate
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground hover:border-primary'
                  )}
                >
                  {milestone.completedDate && <CheckCircle2 className="h-3 w-3" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'font-medium text-sm',
                      milestone.completedDate && 'line-through text-muted-foreground'
                    )}
                  >
                    {milestone.title}
                  </p>
                  {milestone.targetDate && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(milestone.targetDate).toLocaleDateString()}
                      {milestone.completedDate && (
                        <span className="text-green-500 ml-2">
                          Completed {new Date(milestone.completedDate).toLocaleDateString()}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => handleRemoveMilestone(milestone.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add New Milestone */}
      <div className="space-y-4 rounded-lg border border-dashed p-4">
        <h4 className="text-sm font-medium">Add Milestone</h4>

        <div className="grid grid-cols-2 gap-4">
          <Input
            placeholder="Milestone title..."
            value={newMilestone.title}
            onChange={(e) => setNewMilestone({ ...newMilestone, title: e.target.value })}
          />
          <Input
            type="date"
            value={newMilestone.targetDate}
            onChange={(e) => setNewMilestone({ ...newMilestone, targetDate: e.target.value })}
          />
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddMilestone}
          disabled={!newMilestone.title.trim()}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Milestone
        </Button>
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

export type { InitiativeSheetProps, InitiativeFormValues };
