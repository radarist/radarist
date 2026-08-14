'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building2, Link2, MessageSquare, Plus, Users, MapPin, DollarSign, FileText } from 'lucide-react';

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

import type { OrgUnit, OrgUnitType, OrgUnitLevel, Relation, EntityType, RelationType } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const ORG_UNIT_TYPES: OrgUnitType[] = ['business_unit', 'department', 'team', 'division', 'region', 'subsidiary'];

const ORG_UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  business_unit: 'Business Unit',
  department: 'Department',
  team: 'Team',
  division: 'Division',
  region: 'Region',
  subsidiary: 'Subsidiary',
};

const orgUnitFormSchema = z.object({
  name: z.string().min(1, 'Organization name is required'),
  description: z.string().optional(),
  type: z.enum(['business_unit', 'department', 'team', 'division', 'region', 'subsidiary']),
  parentId: z.string().optional(),
  level: z.number().min(1).max(5) as z.ZodType<OrgUnitLevel>,
  headUserId: z.string().optional(),
  headName: z.string().optional(),
  employeeCount: z.number().optional(),
  annualBudget: z.number().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()),
});

type OrgUnitFormValues = z.infer<typeof orgUnitFormSchema>;

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened org unit's data. Create mode must reset to this constant.
 */
const EMPTY_ORG_UNIT_FORM_VALUES: DefaultValues<OrgUnitFormValues> = {
  name: '',
  description: '',
  type: 'department',
  parentId: undefined,
  level: 1,
  headUserId: '',
  headName: '',
  employeeCount: undefined,
  annualBudget: undefined,
  location: '',
  tags: [],
};

// ============================================================================
// TYPES
// ============================================================================

interface OrgUnitSheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** OrgUnit data for edit mode (undefined for create mode) */
  orgUnit?: OrgUnit;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: OrgUnitFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Known direct children that make deletion invalid until reassigned */
  deleteChildCount?: number;
  /** Available parent org units for selection */
  parentOptions?: Array<{ id: string; name: string; level: OrgUnitLevel }>;
  /** Relations for the org unit */
  relations?: Relation[];
  /** Notes for the org unit */
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
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * OrgUnitSheet
 *
 * Sheet component for creating and editing organizational units.
 * Includes tabs for Overview, Team, Relations, and Notes.
 */
export function OrgUnitSheet({
  open,
  onOpenChange,
  orgUnit,
  isLoading = false,
  onSave,
  onDelete,
  deleteChildCount = 0,
  parentOptions = [],
  relations = [],
  notes = [],
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onAddRelation,
  onRemoveRelation,
  onEntityClick,
}: OrgUnitSheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Org Unit" could open on a non-Overview tab.
  const subjectId = orgUnit?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!orgUnit;

  const form = useForm<OrgUnitFormValues>({
    resolver: zodResolver(orgUnitFormSchema),
    defaultValues: EMPTY_ORG_UNIT_FORM_VALUES,
  });

  // Reset form when orgUnit changes
  React.useEffect(() => {
    if (orgUnit) {
      form.reset({
        name: orgUnit.name,
        description: orgUnit.description || '',
        type: orgUnit.type,
        parentId: orgUnit.parentId,
        level: orgUnit.level,
        headUserId: orgUnit.headUserId || '',
        headName: orgUnit.headName || '',
        employeeCount: orgUnit.employeeCount,
        annualBudget: orgUnit.annualBudget,
        location: orgUnit.location || '',
        tags: orgUnit.tags || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened org unit's data (see constant docs).
      form.reset(EMPTY_ORG_UNIT_FORM_VALUES);
    }
  }, [orgUnit, form]);

  const handleSave = async (data: OrgUnitFormValues) => {
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
    } catch {
      // The page owns error feedback; keep the sheet open so dependencies can be resolved.
    } finally {
      setIsDeleting(false);
    }
  };

  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: Building2,
      content: <OverviewTab form={form} parentOptions={parentOptions} />,
    },
    {
      id: 'team',
      label: 'Team',
      icon: Users,
      content: <TeamTab form={form} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: orgUnit ? (
        <RelationsTab
          entityId={orgUnit.id}
          entityName={orgUnit.name}
          entityType="orgUnit"
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
      content: orgUnit ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this organizational unit..."
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
      content: orgUnit ? (
        <KnowledgeTab
          entityType="org_unit"
          entityId={orgUnit.id}
          entityName={orgUnit.name}
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
      title={isEditMode ? orgUnit.name : 'New Organizational Unit'}
      entityType="orgUnit"
      entityId={isEditMode ? orgUnit.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={isEditMode ? ORG_UNIT_TYPE_LABELS[orgUnit.type] : 'Create a new org unit'}
      width="lg"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === orgUnit?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
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
          entityName={isEditMode ? orgUnit.name : 'organizational unit'}
          isDeleteBlocked={deleteChildCount > 0}
          deleteDescription={
            deleteChildCount > 0
              ? `This organizational unit cannot be deleted because it has ${deleteChildCount} ${
                  deleteChildCount === 1 ? 'child org unit' : 'child org units'
                }. Reassign its children and any initiatives it owns before trying again.`
              : 'This organizational unit will be permanently deleted. Deletion is blocked while it has child org units or owns initiatives, so reassign those records first.'
          }
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
  form: ReturnType<typeof useForm<OrgUnitFormValues>>;
  parentOptions?: Array<{ id: string; name: string; level: OrgUnitLevel }>;
}

function OverviewTab({ form, parentOptions = [] }: OverviewTabProps) {
  const [tagInput, setTagInput] = React.useState('');

  const handleAddTag = () => {
    if (!tagInput.trim()) return;
    const current = form.getValues('tags');
    if (!current.includes(tagInput.trim())) {
      form.setValue('tags', [...current, tagInput.trim()], { shouldDirty: true });
    }
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    const current = form.getValues('tags');
    form.setValue(
      'tags',
      current.filter((t) => t !== tag),
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
                <FormLabel>Unit Name *</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Engineering Department" {...field} />
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
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea placeholder="What is this organizational unit responsible for?" rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit Type *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ORG_UNIT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {ORG_UNIT_TYPE_LABELS[type]}
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
              name="level"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hierarchy Level *</FormLabel>
                  <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value?.toString()}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select level" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {[1, 2, 3, 4, 5].map((level) => (
                        <SelectItem key={level} value={level.toString()}>
                          Level {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>1 = Top level, 5 = Lowest level</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {parentOptions.length > 0 && (
            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Parent Unit</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || 'none'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select parent unit" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">No parent (root level)</SelectItem>
                      {parentOptions.map((parent) => (
                        <SelectItem key={parent.id} value={parent.id}>
                          {parent.name} (Level {parent.level})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <FormControl>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input placeholder="e.g., New York, USA" className="pl-9" {...field} />
                  </div>
                </FormControl>
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
              <Badge
                key={tag}
                variant="secondary"
                className="cursor-pointer hover:bg-destructive/20"
                onClick={() => handleRemoveTag(tag)}
              >
                {tag}
                <span className="ml-1">&times;</span>
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a tag..."
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={handleAddTag}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// TEAM TAB
// ============================================================================

function TeamTab({ form }: { form: ReturnType<typeof useForm<OrgUnitFormValues>> }) {
  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Leadership */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Leadership</h3>

          <FormField
            control={form.control}
            name="headName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Unit Head</FormLabel>
                <FormControl>
                  <Input placeholder="Name of the person leading this unit" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Size & Budget */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Size & Resources</h3>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="employeeCount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Employee Count</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Users className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="number"
                        placeholder="Number of employees"
                        className="pl-9"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)}
                        value={field.value ?? ''}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="annualBudget"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Annual Budget</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="number"
                        placeholder="Budget in USD"
                        className="pl-9"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : undefined)}
                        value={field.value ?? ''}
                      />
                    </div>
                  </FormControl>
                  <FormDescription>Annual budget in USD</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      </form>
    </Form>
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

export type { OrgUnitSheetProps, OrgUnitFormValues };
