'use client';

/**
 * @file AddEntrySheet.tsx
 * @description Side sheet for adding or editing radar entries
 *
 * Phase 4.2 Refactor: Technology Decoupling Support
 * - Technology search with autocomplete
 * - Time-to-Impact field (H1/H2/H3)
 * - Removed Cost to Prototype (moved to Prototypes)
 *
 * @author Radarist Team
 * @updated 2025-01-11
 */

import { useState, useTransition, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Lightbulb, Loader2, X, Sparkles, Search, Cpu, Plus } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { RINGS, STATUSES, RING_SYSTEMS } from '@/lib/constants';
import {
  resolveQuadrantReference,
  type RadarEntry,
  type RadarEntrySaveInput,
  type QuadrantConfig,
  type Status,
  type Technology,
} from '@/lib/types';
import { suggestTagsAction, autoFillEntryAction } from '@/app/actions';
import { searchTechnologies, getTechnologyBySlug } from '@/lib/technology-service';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { AlertCircle } from 'lucide-react';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/AddEntrySheet');

interface AddEntrySheetProps {
  /** Whether the sheet is currently open. */
  isOpen: boolean;
  /** Callback to toggle the sheet's open state. */
  onOpenChange: (isOpen: boolean) => void;
  /** Callback when an entry is successfully saved. */
  onSaveEntry: (entry: RadarEntrySaveInput) => void | Promise<unknown>;
  /** Initial data for the form, used when editing an existing entry. */
  initialData?: Partial<RadarEntry> | null;
  /** List of available quadrant configs to select from. */
  quadrants: QuadrantConfig[];
  /** List of available rings for the current system. */
  rings: string[];
  /** Existing entries on the radar (to check for duplicates). */
  existingEntries?: RadarEntry[];
}

// Time-to-Impact options from constants
const TIME_TO_IMPACT_OPTIONS = RING_SYSTEMS['Time-to-Impact'];

const formSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters.'),
  existingTechnologyId: z.string().optional(), // ID of existing technology if selected
  quadrant: z.string().min(1, 'Please select a quadrant.'),
  hata: z.string().min(1, 'Please select a Standard ring.'),
  trl: z.string().min(1, 'Please select a TRL ring.'),
  timeToImpact: z.string().optional(), // H1, H2, H3
  description: z.string().min(10, 'Description must be at least 10 characters.'),
  tags: z.array(z.string()).min(1, 'At least one tag is required.'),
  status: z.enum(STATUSES as unknown as [string, ...string[]]),
});

type FormData = z.infer<typeof formSchema>;

/**
 * A side sheet component for adding or editing a radar entry.
 * Features:
 * - Form validation using Zod.
 * - Auto-fill capabilities using AI.
 * - Tag suggestions using AI.
 * - Dynamic form fields for HATA and TRL rings.
 *
 * @param props - The component props.
 * @returns The rendered sheet component.
 */
export function AddEntrySheet({
  isOpen,
  onOpenChange,
  onSaveEntry,
  initialData,
  quadrants,
  rings,
  existingEntries = [],
}: AddEntrySheetProps) {
  const [tagInput, setTagInput] = useState('');
  const [isSuggesting, startSuggestionTransition] = useTransition();
  const [isAutoFilling, startAutoFillTransition] = useTransition();
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);

  // Technology search state
  const [techSearchOpen, setTechSearchOpen] = useState(false);
  const [techSearchQuery, setTechSearchQuery] = useState('');
  const [techSearchResults, setTechSearchResults] = useState<Technology[]>([]);
  const [isSearchingTech, setIsSearchingTech] = useState(false);
  const [selectedTechnology, setSelectedTechnology] = useState<Technology | null>(null);

  // Duplicate check state
  const [isAlreadyOnRadar, setIsAlreadyOnRadar] = useState(false);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      existingTechnologyId: '',
      quadrant: '',
      hata: 'Assess',
      trl: 'TRL 5',
      timeToImpact: '',
      description: '',
      tags: [],
      status: 'Stable',
    },
  });

  const isEditing = initialData && initialData.id;

  // Helper to generate slug for comparison
  const generateSlug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  // Check if technology name is already on radar
  const checkDuplicate = async (name: string) => {
    if (!name || name.length < 2 || isEditing) {
      setIsAlreadyOnRadar(false);
      return;
    }

    // First check against existing entries by name (case-insensitive)
    const nameMatch = existingEntries.some((entry) => entry.name.toLowerCase() === name.toLowerCase());

    if (nameMatch) {
      setIsAlreadyOnRadar(true);
      return;
    }

    // Also check by slug in case the technology exists in the database
    setIsCheckingDuplicate(true);
    try {
      const slug = generateSlug(name);
      const existingTech = await getTechnologyBySlug(slug);
      if (existingTech) {
        // Check if this technology is already placed on the current radar
        const isOnRadar = existingEntries.some((entry) => entry.name.toLowerCase() === existingTech.name.toLowerCase());
        setIsAlreadyOnRadar(isOnRadar);
      } else {
        setIsAlreadyOnRadar(false);
      }
    } catch {
      setIsAlreadyOnRadar(false);
    } finally {
      setIsCheckingDuplicate(false);
    }
  };

  // Search technologies debounced
  useEffect(() => {
    if (!techSearchQuery.trim() || techSearchQuery.length < 2) {
      setTechSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearchingTech(true);
      try {
        const results = await searchTechnologies(techSearchQuery, 10);
        setTechSearchResults(results);
      } catch (error) {
        log.error('Failed to search technologies', error instanceof Error ? error : undefined);
        setTechSearchResults([]);
      } finally {
        setIsSearchingTech(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [techSearchQuery]);

  // Check for duplicates when name changes
  useEffect(() => {
    const name = form.watch('name');
    const timer = setTimeout(() => {
      checkDuplicate(name);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.watch('name'), existingEntries, isEditing]);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        form.reset({
          name: initialData.name || '',
          existingTechnologyId: '',
          description: initialData.description || '',
          // Form's `quadrant` field still holds the quadrantId string; the
          // Select options below resolve to stable ids. This keeps the form
          // shape compatible during the transition window.
          quadrant: initialData.quadrantId || '',
          // Only use hata if it's a valid HATA ring (not a TRL value)
          hata:
            initialData.hata && !initialData.hata.startsWith('TRL')
              ? initialData.hata
              : initialData.ring && !initialData.ring.startsWith('TRL')
                ? initialData.ring
                : 'Assess',
          // Get TRL from trl field, or from ring if it's a TRL value
          trl: initialData.trl || (initialData.ring && initialData.ring.startsWith('TRL') ? initialData.ring : 'TRL 5'),
          timeToImpact: initialData.timeToImpact || '',
          tags: initialData.tags || [],
          status: initialData?.status || 'Stable',
        });
        setSelectedTechnology(null);
      } else {
        form.reset({
          name: '',
          existingTechnologyId: '',
          description: '',
          tags: [],
          quadrant: '',
          hata: 'Assess',
          trl: 'TRL 5',
          timeToImpact: '',
          status: 'Stable',
        });
        setSelectedTechnology(null);
      }

      // Reset search states
      setTechSearchQuery('');
      setTechSearchResults([]);
      setIsAlreadyOnRadar(false);
      setIsCheckingDuplicate(false);
    }
  }, [initialData, form, isOpen]);

  const watchDescription = form.watch('description');
  const watchQuadrant = form.watch('quadrant');
  const currentTags = form.watch('tags');

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ',' || e.key === 'Enter') {
      e.preventDefault();
      const newTag = tagInput.trim();
      if (newTag && !currentTags.includes(newTag)) {
        form.setValue('tags', [...currentTags, newTag]);
      }
      setTagInput('');
    }
  };

  const removeTag = (tagToRemove: string) => {
    form.setValue(
      'tags',
      currentTags.filter((tag) => tag !== tagToRemove)
    );
  };

  const handleSuggestTags = () => {
    if (!watchQuadrant || !watchDescription) return;

    startSuggestionTransition(async () => {
      try {
        const result = await suggestTagsAction({
          quadrant: watchQuadrant,
          content: watchDescription,
        });
        if (result.tags.length > 0) {
          const newTags = Array.from(new Set([...currentTags, ...result.tags]));
          form.setValue('tags', newTags);
          toast({ title: 'Tags suggested!', description: "We've added some AI-powered tag suggestions for you." });
        } else {
          toast({
            title: 'No new tags found',
            description: "The AI couldn't find any new relevant tags.",
            variant: 'destructive',
          });
        }
      } catch {
        toast({
          title: 'Suggestion failed',
          description: 'Could not get tag suggestions at this time.',
          variant: 'destructive',
        });
      }
    });
  };

  const handleAutoFill = () => {
    const name = form.getValues('name');
    if (!name || name.length < 2) {
      toast({ title: 'Name required', description: 'Please enter a technology name first.', variant: 'destructive' });
      return;
    }

    startAutoFillTransition(async () => {
      try {
        const result = await autoFillEntryAction({
          name,
          description: form.getValues('description'),
          // Pass the full quadrant configs so the model can return a stable `quadrantId`
          // from the list, with `name`/`description` available as context.
          quadrantConfigs: quadrants.map((q) => ({
            id: q.id,
            name: q.name,
            description: q.description,
          })),
        });

        if (result) {
          form.setValue('description', result.description);
          // Prefer the stable id returned by the model; fall back to resolving by
          // legacy display name if the model is still on the old surface.
          const byId = resolveQuadrantReference({ quadrants }, result.quadrantId, { matchBy: 'id' });
          const byName = result.quadrant
            ? resolveQuadrantReference({ quadrants }, result.quadrant, { matchBy: 'name' })
            : undefined;
          form.setValue('quadrant', byId?.id ?? byName?.id ?? quadrants[0]?.id ?? '');
          form.setValue('hata', result.hata);
          form.setValue('trl', result.trl);
          form.setValue('status', result.status as Status);
          form.setValue('tags', result.tags);
          // Note: costToPrototype removed - belongs on Prototypes, not Technologies
          toast({ title: 'Auto-filled!', description: 'AI has populated the details for you.' });
        } else {
          toast({ title: 'Auto-fill failed', description: 'Could not generate details.', variant: 'destructive' });
        }
      } catch {
        toast({ title: 'Error', description: 'Something went wrong during auto-fill.', variant: 'destructive' });
      }
    });
  };

  // Handle selecting an existing technology
  const handleSelectTechnology = (tech: Technology) => {
    setSelectedTechnology(tech);
    form.setValue('name', tech.name);
    form.setValue('existingTechnologyId', tech.id);
    if (tech.description) form.setValue('description', tech.description);
    if (tech.tags?.length) form.setValue('tags', tech.tags);
    if (tech.category) {
      // Map category to a quadrant NAME, then resolve to a stable quadrantId
      // against the current radar's config. If no match, leave the form field
      // unchanged so the user picks manually.
      const nameByCategory: Record<string, string> = {
        framework: 'Languages & Frameworks',
        language: 'Languages & Frameworks',
        platform: 'Platforms',
        tool: 'Tools',
        methodology: 'Techniques',
        infrastructure: 'Platforms',
      };
      const mappedName = nameByCategory[tech.category];
      if (mappedName) {
        const hit = resolveQuadrantReference({ quadrants }, mappedName, { matchBy: 'name' });
        if (hit) {
          form.setValue('quadrant', hit.id);
        }
      }
    }
    setTechSearchOpen(false);
    setTechSearchQuery('');
    toast({
      title: 'Technology selected',
      description: `${tech.name} loaded. You can modify the placement details below.`,
    });
  };

  // Clear selected technology
  const handleClearTechnology = () => {
    setSelectedTechnology(null);
    form.setValue('existingTechnologyId', '');
  };

  async function onSubmit(values: FormData) {
    // Implicit form submission (Enter in a text input) bypasses the disabled
    // footer button entirely — guard re-entrancy here (adversarial #3).
    if (isSaving) return;
    const isTRLSystem = rings[0].startsWith('TRL');

    // Build entry object with only RadarEntry fields.
    // `values.quadrant` is a stable quadrantId (the Select below uses id as value).
    const entryToSave: RadarEntrySaveInput = {
      name: values.name,
      technologyId: values.existingTechnologyId || undefined,
      description: values.description,
      quadrantId: values.quadrant,
      status: values.status as Status,
      id: initialData?.id,
      hata: values.hata,
      trl: values.trl,
      ring: isTRLSystem ? values.trl : values.hata,
      timeToImpact: values.timeToImpact || undefined,
      tags: values.tags,
      costToPrototype: initialData?.costToPrototype ?? 50,
    };
    // AUDIT-009: await the save — the old fire-and-forget reset the form and
    // closed the sheet while the write could still fail (the handler chain
    // rethrows), losing the user's input with a success-looking UX. Sibling
    // entity sheets all await and only close on success.
    setIsSaving(true);
    try {
      await onSaveEntry(entryToSave);
      form.reset();
      setSelectedTechnology(null);
      onOpenChange(false);
    } catch (error) {
      const staleSelectionMessage =
        error instanceof Error && error.message.startsWith('The selected technology') ? error.message : null;
      toast({
        title: 'Failed to save entry',
        description: staleSelectionMessage ?? 'Your input is preserved — try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:w-[420px] md:w-[460px] lg:w-[480px] flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-6 py-5 border-b shrink-0">
          <SheetTitle className="text-xl font-semibold">{isEditing ? 'Edit Entry' : 'Add New Entry'}</SheetTitle>
          <SheetDescription>
            {isEditing ? 'Update technology details below.' : 'Capture a new technology for the radar.'}
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable Content */}
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="px-6 py-5 space-y-5 max-w-full overflow-hidden">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 overflow-hidden">
                {/* Name Field with Technology Search */}
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Technology Name</FormLabel>
                      <div className="flex gap-2">
                        {selectedTechnology ? (
                          // Show selected technology
                          <div className="flex-1 flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/50 min-w-0 overflow-hidden">
                            <Cpu className="h-4 w-4 text-purple-500 shrink-0" />
                            <span className="flex-1 truncate font-medium min-w-0">{selectedTechnology.name}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={handleClearTechnology}
                              aria-label={`Clear selected technology ${selectedTechnology.name}`}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          // Technology search input with dropdown
                          <div className="flex-1 relative">
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                              <Input
                                placeholder="Search existing or type new..."
                                value={techSearchQuery || field.value || ''}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setTechSearchQuery(value);
                                  field.onChange(value);
                                  if (value.length >= 2) {
                                    setTechSearchOpen(true);
                                  }
                                }}
                                onFocus={() => {
                                  if ((techSearchQuery || field.value || '').length >= 2) {
                                    setTechSearchOpen(true);
                                  }
                                }}
                                className="pl-9 h-10"
                              />
                            </div>
                            {/* Search Results Dropdown */}
                            {techSearchOpen && (techSearchQuery || '').length >= 2 && (
                              <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-[200px] overflow-y-auto">
                                {isSearchingTech ? (
                                  <div className="flex items-center justify-center py-4">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  </div>
                                ) : techSearchResults.length > 0 ? (
                                  <div className="p-1">
                                    <p className="px-2 py-1 text-xs text-muted-foreground font-medium">
                                      Existing Technologies
                                    </p>
                                    {techSearchResults.map((tech) => (
                                      <button
                                        key={tech.id}
                                        type="button"
                                        onClick={() => handleSelectTechnology(tech)}
                                        className="w-full flex items-center gap-2 px-2 py-2 text-left rounded hover:bg-muted transition-colors"
                                      >
                                        <Cpu className="h-4 w-4 text-purple-500 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                          <p className="font-medium truncate text-sm">{tech.name}</p>
                                          {tech.category && (
                                            <p className="text-xs text-muted-foreground">{tech.category}</p>
                                          )}
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="p-3 text-center">
                                    <p className="text-sm text-muted-foreground">No existing technology found</p>
                                  </div>
                                )}
                                <div className="border-t p-1">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      field.onChange(techSearchQuery);
                                      setTechSearchOpen(false);
                                    }}
                                    className="w-full flex items-center gap-2 px-2 py-2 text-left rounded hover:bg-muted transition-colors min-w-0 overflow-hidden"
                                  >
                                    <Plus className="h-4 w-4 shrink-0" />
                                    <span className="text-sm truncate min-w-0">
                                      Create &quot;{techSearchQuery}&quot; as new
                                    </span>
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={handleAutoFill}
                          disabled={isAutoFilling || !field.value}
                          title="Auto-Fill with AI"
                        >
                          {isAutoFilling ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4 text-purple-500" />
                          )}
                        </Button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Classification Section */}
                <div className={cn('space-y-3 p-4 rounded-lg border bg-muted/30', !form.watch('name') && 'opacity-60')}>
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                      Classification
                    </h4>
                    {!form.watch('name') && (
                      <span className="text-[10px] text-muted-foreground">Enter technology name first</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="quadrant"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Quadrant</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!form.watch('name')}>
                            <FormControl>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {quadrants.map((q) => (
                                <SelectItem key={q.id} value={q.id}>
                                  {q.name}
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
                          <FormLabel className="text-xs">Status</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!form.watch('name')}>
                            <FormControl>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
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
                      name="hata"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">HATA Ring</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!form.watch('name')}>
                            <FormControl>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {RINGS.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r}
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
                      name="trl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">TRL Ring</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={!form.watch('name')}>
                            <FormControl>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {['TRL 9', 'TRL 8', 'TRL 7', 'TRL 6', 'TRL 5', 'TRL 4', 'TRL 3', 'TRL 2', 'TRL 1'].map(
                                (r) => (
                                  <SelectItem key={r} value={r}>
                                    {r}
                                  </SelectItem>
                                )
                              )}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Time-to-Impact Field */}
                  <FormField
                    control={form.control}
                    name="timeToImpact"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Time to Impact</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === 'none' ? '' : value)}
                          value={field.value || 'none'}
                          disabled={!form.watch('name')}
                        >
                          <FormControl>
                            <SelectTrigger className="h-9">
                              <SelectValue placeholder="Select horizon..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">Not specified</SelectItem>
                            {TIME_TO_IMPACT_OPTIONS.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground mt-1 break-words">
                          When is business impact expected? H1=near-term, H2=mid-term, H3=long-term
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Description */}
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Describe the technology, its primary use case, and why it belongs on the radar."
                          {...field}
                          rows={4}
                          className="resize-none"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Tags */}
                <FormItem>
                  <div className="flex justify-between items-center">
                    <FormLabel>Tags</FormLabel>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleSuggestTags}
                      disabled={isSuggesting || !watchQuadrant || !watchDescription}
                      className="h-7 text-xs hover:bg-primary/10 hover:text-primary"
                    >
                      {isSuggesting ? (
                        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      ) : (
                        <Lightbulb className="mr-1.5 h-3 w-3" />
                      )}
                      Auto-Suggest
                    </Button>
                  </div>
                  <FormControl>
                    <div className="flex flex-wrap gap-2 p-3 border rounded-lg min-h-[56px] bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                      {currentTags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="pl-2.5 pr-1 py-1 h-7 flex items-center gap-1">
                          {tag}
                          <button
                            type="button"
                            onClick={() => removeTag(tag)}
                            className="rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                      <Input
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={handleTagInputKeyDown}
                        placeholder={currentTags.length === 0 ? 'Type a tag and press Enter...' : 'Add more...'}
                        className="border-none focus-visible:ring-0 focus-visible:ring-offset-0 flex-1 min-w-[100px] h-7 p-0 bg-transparent placeholder:text-muted-foreground/60"
                      />
                    </div>
                  </FormControl>
                  <FormMessage>{form.formState.errors.tags?.message}</FormMessage>
                </FormItem>
              </form>
            </Form>
          </div>
        </ScrollArea>

        {/* Sticky Footer */}
        <SheetFooter className="border-t px-6 py-4 shrink-0 bg-background">
          <div className="w-full space-y-3">
            {/* Duplicate Warning */}
            {isAlreadyOnRadar && !isEditing && (
              <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>This technology is already on the radar</span>
              </div>
            )}
            <Button
              type="submit"
              onClick={form.handleSubmit(onSubmit)}
              className="w-full sm:w-auto h-10 px-8 font-medium"
              disabled={(isAlreadyOnRadar && !isEditing) || isSaving}
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : isCheckingDuplicate ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking...
                </>
              ) : isEditing ? (
                'Save Changes'
              ) : (
                'Add to Radar'
              )}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
