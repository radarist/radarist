/**
 * @file UseCaseDialog.tsx
 * @description Dialog for viewing and editing a single use case.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Target } from 'lucide-react';
import type { UseCase } from '@/lib/types';
import { resolveUseCaseCreateOutcome, resolveUseCaseUpdateOutcome } from '@/lib/mutation-outcome/use-case';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/UseCaseDialog');

interface UseCaseDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  useCase: UseCase | null;
  isNew?: boolean;
  onSaved?: () => void;
  readOnly?: boolean;
}

export function UseCaseDialog({
  isOpen,
  onOpenChange,
  useCase,
  isNew = false,
  onSaved,
  readOnly = false,
}: UseCaseDialogProps) {
  const [formData, setFormData] = useState<Partial<UseCase>>({});
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (useCase) {
      setFormData(useCase);
    }
  }, [useCase]);

  const graphSync = useLibraryEntityGraphSync<UseCase>({
    entityType: 'useCase',
    entityTypeLabel: 'use case',
    getName: (candidate) => candidate.title,
  });

  const handleSave = async () => {
    if (!formData.title) return;

    setIsSaving(true);
    try {
      // GRAPH-058: an unacknowledged graph handoff leaves a committed document.
      // Report that as saved-locally, not as "Failed to create/update use case".
      if (isNew) {
        // Create new use case
        const outcome = await resolveUseCaseCreateOutcome(
          formData as Omit<UseCase, 'id' | 'createdAt' | 'updatedAt'>
        );
        graphSync.applyOutcome(outcome, {
          applyCommitted: () => undefined,
          success: {
            title: 'Use Case Created',
            description: 'The use case has been successfully created.',
          },
        });
      } else if (useCase) {
        // Update via the service so the Neo4j entity sync fires and undefined
        // fields are stripped (a raw updateDoc skipped both: edits never
        // reached the graph and any undefined field made updateDoc throw).
        const { id: _id, createdAt: _createdAt, ...updates } = formData;
        const outcome = await resolveUseCaseUpdateOutcome(useCase, updates);
        graphSync.applyOutcome(outcome, {
          applyCommitted: () => undefined,
          success: {
            title: 'Use Case Updated',
            description: 'The use case has been successfully updated.',
          },
        });
      }

      onSaved?.();
      onOpenChange(false);
    } catch (error) {
      log.error('Failed to save use case', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: `Failed to ${isNew ? 'create' : 'update'} use case.`,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (!useCase && !isNew) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="w-5 h-5 text-green-500" />
            {readOnly ? useCase?.title : isNew ? 'Create New Use Case' : 'Edit Use Case'}
          </DialogTitle>
          <DialogDescription>
            {isNew ? 'Create a new use case to track' : 'Details about this specific use case.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label>Title</Label>
            {readOnly ? (
              <div className="font-medium">{useCase?.title}</div>
            ) : (
              <Input
                value={formData.title || ''}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Category</Label>
              {readOnly ? (
                <Badge variant="outline">{useCase?.category}</Badge>
              ) : (
                <Select
                  value={formData.category || ''}
                  onValueChange={(value) => setFormData({ ...formData, category: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Process Optimization">Process Optimization</SelectItem>
                    <SelectItem value="Customer Experience">Customer Experience</SelectItem>
                    <SelectItem value="Product Innovation">Product Innovation</SelectItem>
                    <SelectItem value="Data & Analytics">Data & Analytics</SelectItem>
                    <SelectItem value="Security & Compliance">Security & Compliance</SelectItem>
                    <SelectItem value="Cost Reduction">Cost Reduction</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              {readOnly ? (
                <Badge>{useCase?.status}</Badge>
              ) : (
                <Select
                  value={formData.status || ''}
                  onValueChange={(value) => setFormData({ ...formData, status: value as UseCase['status'] })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Proposed">Proposed</SelectItem>
                    <SelectItem value="In Progress">In Progress</SelectItem>
                    <SelectItem value="Implemented">Implemented</SelectItem>
                    <SelectItem value="Archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            {readOnly ? (
              <p className="text-sm text-muted-foreground">{useCase?.description}</p>
            ) : (
              <Textarea
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Problem Statement</Label>
            {readOnly ? (
              <p className="text-sm text-muted-foreground">{useCase?.problem}</p>
            ) : (
              <Textarea
                value={formData.problem || ''}
                onChange={(e) => setFormData({ ...formData, problem: e.target.value })}
                rows={3}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Proposed Solution</Label>
            {readOnly ? (
              <p className="text-sm text-muted-foreground">{useCase?.solution}</p>
            ) : (
              <Textarea
                value={formData.solution || ''}
                onChange={(e) => setFormData({ ...formData, solution: e.target.value })}
                rows={3}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Expected Outcomes</Label>
            {readOnly ? (
              <p className="text-sm text-muted-foreground">{useCase?.outcomes}</p>
            ) : (
              <Textarea
                value={Array.isArray(formData.outcomes) ? formData.outcomes.join('\n') : formData.outcomes || ''}
                onChange={(e) => setFormData({ ...formData, outcomes: e.target.value.split('\n') })}
                rows={3}
                placeholder="One outcome per line"
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!readOnly && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
