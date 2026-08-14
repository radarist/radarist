import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Users, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import { useBusinessUnitNames } from '@/hooks/queries/useOrgUnits';

import type { PrototypeFormValues } from './constants';
import { PROTOTYPE_STATUSES, STATUS_COLORS } from './constants';

// ============================================================================
// TYPES
// ============================================================================

export interface OverviewTabProps {
  form: UseFormReturn<PrototypeFormValues>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function OverviewTab({ form }: OverviewTabProps) {
  const [newTeamMember, setNewTeamMember] = React.useState('');
  const [newStakeholder, setNewStakeholder] = React.useState('');

  // Business Unit options come from live Org Units (type === 'business_unit').
  // The form keeps persisting the plain name string — no schema change.
  const {
    data: businessUnitData,
    isLoading: isLoadingBusinessUnits,
    isError: isBusinessUnitsError,
  } = useBusinessUnitNames();
  const businessUnits = businessUnitData ?? [];

  const handleAddTeamMember = () => {
    if (!newTeamMember.trim()) return;
    const current = form.getValues('team');
    if (!current.includes(newTeamMember.trim())) {
      form.setValue('team', [...current, newTeamMember.trim()], { shouldDirty: true });
    }
    setNewTeamMember('');
  };

  const handleRemoveTeamMember = (member: string) => {
    const current = form.getValues('team');
    form.setValue(
      'team',
      current.filter((m) => m !== member),
      { shouldDirty: true }
    );
  };

  const handleAddStakeholder = () => {
    if (!newStakeholder.trim()) return;
    const current = form.getValues('presentedTo');
    if (!current.includes(newStakeholder.trim())) {
      form.setValue('presentedTo', [...current, newStakeholder.trim()], { shouldDirty: true });
    }
    setNewStakeholder('');
  };

  const handleRemoveStakeholder = (stakeholder: string) => {
    const current = form.getValues('presentedTo');
    form.setValue(
      'presentedTo',
      current.filter((s) => s !== stakeholder),
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
                <FormLabel>Prototype Name *</FormLabel>
                <FormControl>
                  <Input placeholder="Enter prototype name" {...field} />
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
                  <Textarea placeholder="Describe what this prototype does and its goals..." rows={4} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROTOTYPE_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                'h-2 w-2 rounded-full',
                                STATUS_COLORS[status].replace('bg-', 'bg-').split(' ')[0]
                              )}
                            />
                            {status}
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
              name="targetBusinessUnit"
              render={({ field }) => {
                // A stored value that no longer matches a current Business Unit
                // org unit (renamed/deleted unit, or imported data) must stay
                // visible and selectable so editing never silently changes it.
                const isLegacyValue = !!field.value && !businessUnits.includes(field.value);

                if (isLoadingBusinessUnits) {
                  return (
                    <FormItem>
                      <FormLabel>Business Unit *</FormLabel>
                      <Select disabled value={field.value || undefined}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Loading business units..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {field.value ? <SelectItem value={field.value}>{field.value}</SelectItem> : null}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  );
                }

                if (businessUnits.length === 0) {
                  // No Business Unit org units (or the fetch failed): fall back
                  // to free entry so the required field never becomes a dead end.
                  return (
                    <FormItem>
                      <FormLabel>Business Unit *</FormLabel>
                      <FormControl>
                        <Input placeholder="Enter business unit" {...field} />
                      </FormControl>
                      <FormDescription>
                        {isBusinessUnitsError
                          ? 'Could not load Org Units — enter the business unit name manually.'
                          : 'No Business Unit org units defined yet — add them under Library → Org Units, or type a name.'}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  );
                }

                return (
                  <FormItem>
                    <FormLabel>Business Unit *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select business unit" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {isLegacyValue && (
                          <SelectItem value={field.value}>
                            <span className="flex items-center gap-1.5">
                              {field.value}
                              <span className="text-xs text-muted-foreground">(legacy)</span>
                            </span>
                          </SelectItem>
                        )}
                        {businessUnits.map((bu) => (
                          <SelectItem key={bu} value={bu}>
                            {bu}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
          </div>

          <FormField
            control={form.control}
            name="jiraEpic"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Jira Epic</FormLabel>
                <FormControl>
                  <Input placeholder="PROJ-123 or https://jira.company.com/..." {...field} />
                </FormControl>
                <FormDescription>Link to the Jira epic tracking this project</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Team */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Team</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('team').map((member) => (
              <Badge key={member} variant="secondary" className="gap-1">
                <Users className="h-3 w-3" />
                {member}
                <X
                  className="h-3 w-3 cursor-pointer hover:text-destructive"
                  onClick={() => handleRemoveTeamMember(member)}
                />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add team member..."
              value={newTeamMember}
              onChange={(e) => setNewTeamMember(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTeamMember();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddTeamMember}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Stakeholders */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Presented To</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('presentedTo').map((stakeholder) => (
              <Badge key={stakeholder} variant="secondary" className="gap-1">
                {stakeholder}
                <X
                  className="h-3 w-3 cursor-pointer hover:text-destructive"
                  onClick={() => handleRemoveStakeholder(stakeholder)}
                />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add stakeholder/VP name..."
              value={newStakeholder}
              onChange={(e) => setNewStakeholder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddStakeholder();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddStakeholder}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
