/**
 * @file UseCaseManager.tsx
 * @description Component for managing use cases linked to a company.
 *
 * This component allows viewing, adding, and removing use cases for a company.
 * Use cases represent specific problems or opportunities that the company addresses.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Trash2, Lightbulb, Tag, X, Edit } from 'lucide-react';
import type { UseCase } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/UseCaseManager');
import {
  getUseCasesByCompanyId,
  linkUseCaseToCompany,
  unlinkUseCaseFromCompany,
  getUseCases,
} from '@/lib/use-cases';
import { useToast } from '@/hooks/use-toast';
import { resolveUseCaseCreateOutcome } from '@/lib/mutation-outcome/use-case';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UseCaseDialog } from './UseCaseDialog';

interface UseCaseManagerProps {
  /** Company ID */
  companyId: string;
}

/**
 * UseCaseManager component.
 * Displays and manages use cases for a company.
 *
 * @param props - Component props
 * @returns The rendered use case manager
 */
export function UseCaseManager({ companyId }: UseCaseManagerProps) {
  const [linkedUseCases, setLinkedUseCases] = useState<UseCase[]>([]);
  const [allUseCases, setAllUseCases] = useState<UseCase[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [_isCreateOpen, _setIsCreateOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [selectedUseCaseForEdit, setSelectedUseCaseForEdit] = useState<UseCase | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const handleAddTag = () => {
    if (!tagInput.trim()) return;
    const currentTags = newUseCase.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!currentTags.includes(tagInput.trim())) {
      const newTags = [...currentTags, tagInput.trim()].join(',');
      setNewUseCase({ ...newUseCase, tags: newTags });
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const currentTags = newUseCase.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const newTags = currentTags.filter((tag) => tag !== tagToRemove).join(',');
    setNewUseCase({ ...newUseCase, tags: newTags });
  };
  const [mode, setMode] = useState<'select' | 'create'>('select');

  // Form state
  const [selectedUseCaseId, setSelectedUseCaseId] = useState<string>('');
  const [newUseCase, setNewUseCase] = useState({
    title: '',
    description: '',
    problem: '',
    solution: '',
    outcomes: '',
    status: 'Proposed' as UseCase['status'],
    category: 'General',
    tags: '',
  });

  const { toast } = useToast();
  const graphSync = useLibraryEntityGraphSync<UseCase>({
    entityType: 'useCase',
    entityTypeLabel: 'use case',
    getName: (candidate) => candidate.title,
  });

  /**
   * Loads data from Firestore.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [linked, all] = await Promise.all([getUseCasesByCompanyId(companyId), getUseCases()]);
      setLinkedUseCases(linked);
      setAllUseCases(all);
    } catch (error) {
      log.error('Failed to load use cases', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to load use cases.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [companyId]);

  /**
   * Handles linking an existing use case.
   */
  const handleLinkExisting = async () => {
    if (!selectedUseCaseId) return;

    try {
      await linkUseCaseToCompany(selectedUseCaseId, companyId);
      toast({ title: 'Use Case Linked', description: 'Use case has been linked successfully.' });
      setIsDialogOpen(false);
      loadData();
    } catch (error) {
      log.error('Failed to link use case', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to link use case.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles creating and linking a new use case.
   */
  const handleCreateNew = async () => {
    if (!newUseCase.title) {
      toast({
        title: 'Validation Error',
        description: 'Title is required.',
        variant: 'destructive',
      });
      return;
    }

    try {
      // GRAPH-058: a lost graph handoff must not read as a failed create.
      const outcome = await resolveUseCaseCreateOutcome({
        title: newUseCase.title,
        description: newUseCase.description,
        problem: newUseCase.problem,
        solution: newUseCase.solution,
        outcomes: newUseCase.outcomes.split('\n').filter(Boolean),
        status: newUseCase.status,
        category: newUseCase.category,
        tags: newUseCase.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        radarTechnologyIds: [],
        companyIds: [companyId], // Link immediately
      });

      graphSync.applyOutcome(outcome, {
        applyCommitted: () => undefined,
        success: { title: 'Use Case Created', description: 'New use case created and linked.' },
      });
      setIsDialogOpen(false);
      loadData();
      // Reset form
      setNewUseCase({
        title: '',
        description: '',
        problem: '',
        solution: '',
        outcomes: '',
        status: 'Proposed',
        category: 'General',
        tags: '',
      });
    } catch (error) {
      log.error('Failed to create use case', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to create use case.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles unlinking a use case.
   */
  const handleUnlink = async (useCaseId: string) => {
    if (!confirm('Are you sure you want to remove this use case?')) return;

    try {
      await unlinkUseCaseFromCompany(useCaseId, companyId);
      toast({ title: 'Use Case Removed', description: 'Use case has been unlinked.' });
      loadData();
    } catch (error) {
      log.error('Failed to unlink use case', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to unlink use case.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles opening a use case for editing.
   */
  const handleEditUseCase = (useCase: UseCase) => {
    setSelectedUseCaseForEdit(useCase);
    setIsEditDialogOpen(true);
  };

  /**
   * Handles saving edits to a use case.
   */
  const handleUseCaseSaved = () => {
    setIsEditDialogOpen(false);
    setSelectedUseCaseForEdit(null);
    loadData();
  };

  // Filter out already linked use cases from the selection list
  const availableUseCases = allUseCases.filter((uc) => !linkedUseCases.some((linked) => linked.id === uc.id));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {linkedUseCases.length} {linkedUseCases.length === 1 ? 'use case' : 'use cases'}
        </p>
        <Button onClick={() => setIsDialogOpen(true)} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Use Case
        </Button>
      </div>

      {linkedUseCases.length === 0 ? (
        <Card className="p-8 text-center">
          <Lightbulb className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground mb-4">No use cases linked yet</p>
          <Button onClick={() => setIsDialogOpen(true)} variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add First Use Case
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {linkedUseCases.map((useCase) => (
            <Card key={useCase.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-2 w-full">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold">{useCase.title}</h4>
                      <Badge variant="secondary">{useCase.category}</Badge>
                      <Badge
                        variant={
                          useCase.status === 'Implemented'
                            ? 'default'
                            : useCase.status === 'In Progress'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {useCase.status}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{useCase.description || 'No description provided.'}</p>

                  {(useCase.problem || useCase.solution) && (
                    <div className="grid grid-cols-2 gap-4 text-sm mt-2 bg-muted/30 p-2 rounded">
                      {useCase.problem && (
                        <div>
                          <span className="font-semibold text-xs uppercase text-muted-foreground">Problem</span>
                          <p className="line-clamp-2">{useCase.problem}</p>
                        </div>
                      )}
                      {useCase.solution && (
                        <div>
                          <span className="font-semibold text-xs uppercase text-muted-foreground">Solution</span>
                          <p className="line-clamp-2">{useCase.solution}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {useCase.tags && useCase.tags.length > 0 && (
                    <div className="flex items-center gap-2 mt-2">
                      <Tag className="h-3 w-3 text-muted-foreground" />
                      <div className="flex gap-1 flex-wrap">
                        {useCase.tags.map((tag) => (
                          <span key={tag} className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="icon" onClick={() => handleEditUseCase(useCase)} title="Edit use case">
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleUnlink(useCase.id)} title="Unlink use case">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add Use Case Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Use Case</DialogTitle>
            <DialogDescription>Link an existing use case or create a new one.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex gap-2 p-1 bg-muted rounded-lg">
              <Button
                variant={mode === 'select' ? 'default' : 'ghost'}
                className="flex-1 h-8"
                onClick={() => setMode('select')}
              >
                Select Existing
              </Button>
              <Button
                variant={mode === 'create' ? 'default' : 'ghost'}
                className="flex-1 h-8"
                onClick={() => setMode('create')}
              >
                Create New
              </Button>
            </div>

            {mode === 'select' ? (
              <div className="space-y-4 py-4">
                {availableUseCases.length === 0 ? (
                  <div className="text-center text-muted-foreground">
                    No available use cases to link. Create a new one!
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Select Use Case</Label>
                    <Select value={selectedUseCaseId} onValueChange={setSelectedUseCaseId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a use case..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availableUseCases.map((uc) => (
                          <SelectItem key={uc.id} value={uc.id}>
                            {uc.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="uc-name">Title *</Label>
                  <Input
                    id="uc-name"
                    value={newUseCase.title}
                    onChange={(e) => setNewUseCase({ ...newUseCase, title: e.target.value })}
                    placeholder="e.g., Real-time Fraud Detection"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="uc-status">Status</Label>
                    <Select
                      value={newUseCase.status}
                      onValueChange={(val: string) =>
                        setNewUseCase({ ...newUseCase, status: val as UseCase['status'] })
                      }
                    >
                      <SelectTrigger id="uc-status">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Proposed">Proposed</SelectItem>
                        <SelectItem value="In Progress">In Progress</SelectItem>
                        <SelectItem value="Implemented">Implemented</SelectItem>
                        <SelectItem value="Archived">Archived</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="uc-category">Category</Label>
                    <Select
                      value={newUseCase.category}
                      onValueChange={(val) => setNewUseCase({ ...newUseCase, category: val })}
                    >
                      <SelectTrigger id="uc-category">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="General">General</SelectItem>
                        <SelectItem value="Operational Efficiency">Operational Efficiency</SelectItem>
                        <SelectItem value="Revenue Growth">Revenue Growth</SelectItem>
                        <SelectItem value="Cost Reduction">Cost Reduction</SelectItem>
                        <SelectItem value="Risk Mitigation">Risk Mitigation</SelectItem>
                        <SelectItem value="Innovation">Innovation</SelectItem>
                        <SelectItem value="Customer Experience">Customer Experience</SelectItem>
                        <SelectItem value="Security">Security</SelectItem>
                        <SelectItem value="Data & Analytics">Data & Analytics</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="uc-desc">Description</Label>
                  <Textarea
                    id="uc-desc"
                    value={newUseCase.description}
                    onChange={(e) => setNewUseCase({ ...newUseCase, description: e.target.value })}
                    placeholder="Brief overview..."
                    className="h-20"
                  />
                </div>
                <div>
                  <Label htmlFor="uc-problem">Problem Statement</Label>
                  <Textarea
                    id="uc-problem"
                    value={newUseCase.problem}
                    onChange={(e) => setNewUseCase({ ...newUseCase, problem: e.target.value })}
                    placeholder="What problem are we solving?"
                    className="h-20"
                  />
                </div>
                <div>
                  <Label htmlFor="uc-solution">Proposed Solution</Label>
                  <Textarea
                    id="uc-solution"
                    value={newUseCase.solution}
                    onChange={(e) => setNewUseCase({ ...newUseCase, solution: e.target.value })}
                    placeholder="How will we solve it?"
                    className="h-20"
                  />
                </div>
                <div>
                  <Label htmlFor="uc-outcomes">Expected Outcomes (one per line)</Label>
                  <Textarea
                    id="uc-outcomes"
                    value={newUseCase.outcomes}
                    onChange={(e) => setNewUseCase({ ...newUseCase, outcomes: e.target.value })}
                    placeholder="- Reduced costs&#10;- Improved latency"
                    className="h-20"
                  />
                </div>
                <div>
                  <Label>Tags</Label>
                  <div className="flex gap-2 mb-2">
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add a tag and press Enter..."
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                    />
                    <Button type="button" variant="outline" onClick={handleAddTag} size="icon" aria-label="Add tag">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {newUseCase.tags
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean)
                      .map((tag) => (
                        <Badge key={tag} variant="secondary" className="gap-1">
                          {tag}
                          <button
                            type="button"
                            aria-label={`Remove tag ${tag}`}
                            onClick={() => handleRemoveTag(tag)}
                            className="inline-flex items-center"
                          >
                            <X className="h-3 w-3 cursor-pointer" />
                          </button>
                        </Badge>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={mode === 'select' ? handleLinkExisting : handleCreateNew}
              disabled={mode === 'select' && !selectedUseCaseId}
            >
              {mode === 'select' ? 'Link Selected' : 'Create & Link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Use Case Dialog */}
      <UseCaseDialog
        isOpen={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        useCase={selectedUseCaseForEdit}
        isNew={false}
        onSaved={handleUseCaseSaved}
      />
    </div>
  );
}
