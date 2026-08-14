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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { QuadrantConfig, RingSystem } from '@/lib/types';
import type { OrphanReport } from '@/lib/radars';
import { MIN_QUADRANTS, MAX_QUADRANTS, defaultQuadrantIdFromName } from '@/lib/constants';
import { Settings2, Plus, X, ChevronUp, ChevronDown, AlertTriangle, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getTechnologyById } from '@/lib/technology-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/SettingsDialog');

/**
 * Orphan-aware save options. Passed on the retry after the user picks a
 * resolution for each orphaned quadrant.
 */
export interface SettingsDialogSaveOptions {
  reassignments?: Record<string, string>;
  deleteOrphans?: boolean;
}

interface SettingsDialogProps {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** Callback to update the dialog's open state. */
  onOpenChange: (isOpen: boolean) => void;
  /** Current list of quadrant configs (1..8). */
  quadrants: QuadrantConfig[];
  /** Current ring system. */
  ringSystem?: RingSystem;
  /**
   * Callback to save changes. Returns a Promise so the dialog can await the
   * backend before closing. Can throw an `OrphanedPlacementsError` (shape:
   * `Error & { name: 'OrphanedPlacementsError', report: OrphanReport }`) when
   * shrinking a populated quadrant — the dialog catches it and opens the
   * inline orphan-resolution UI. Any other thrown error surfaces as a toast.
   *
   * The dialog guarantees that every item in `newQuadrants` carries a valid
   * stable `id`: existing quadrants keep their id (so placements are not
   * orphaned on rename) and brand-new quadrants get a minted id via
   * `defaultQuadrantIdFromName`.
   */
  onSave: (
    newQuadrants: QuadrantConfig[],
    newRingSystem: RingSystem,
    options?: SettingsDialogSaveOptions
  ) => Promise<void> | void;
}

/** Internal draft row state for the editor. Each row preserves its id across
 * reorders and renames so the form round-trips cleanly with the parent. */
interface DraftRow {
  /**
   * Stable id. If the row maps to an existing `QuadrantConfig`, this is its
   * original id; if the row is brand-new (created via the Add button), this
   * is `null` until save, at which point `defaultQuadrantIdFromName` mints one.
   */
  id: string | null;
  name: string;
  description?: string;
  /** Monotonic key so React's diffing stays stable across reorders. */
  key: string;
}

function buildDraftsFromConfigs(configs: QuadrantConfig[]): DraftRow[] {
  return configs.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    key: `draft-${c.id}`,
  }));
}

/**
 * Settings dialog for the radar's quadrant list.
 *
 * Variable-quadrants support (1..8):
 *   - Renders one editable row per quadrant, with name + optional description
 *   - Add / remove buttons (disabled at the 1/8 limits)
 *   - Reorder chevrons (up / down)
 *   - Async save: waits for the parent to resolve before closing
 *   - Validation: all names are non-empty, duplicates are flagged inline
 *   - Stable ids: existing quadrants keep their id; new quadrants get a
 *     fresh one minted via `defaultQuadrantIdFromName`
 *
 * When a service-side orphan check rejects a shrink, the dialog presents the
 * canonical placement report and retries only after every group is resolved.
 */
/**
 * Per-orphan-group resolution: either a reassignment target (one of the
 * surviving quadrant ids) or `__delete__` to delete the placements.
 */
type Resolution = string | '__delete__';

/** Type guard for `OrphanedPlacementsError` that avoids importing the
 * service-layer class (which would pull `firebase/firestore` into the client
 * bundle via transitive deps). */
function isOrphanedPlacementsError(error: unknown): error is Error & { report: OrphanReport } {
  return (
    error instanceof Error &&
    error.name === 'OrphanedPlacementsError' &&
    typeof (error as { report?: unknown }).report === 'object' &&
    Array.isArray((error as { report?: { orphans?: unknown } }).report?.orphans) &&
    typeof (error as { report?: { totalPlacements?: unknown } }).report?.totalPlacements === 'number'
  );
}

export function SettingsDialog({
  isOpen,
  onOpenChange,
  quadrants,
  ringSystem = 'Standard',
  onSave,
}: SettingsDialogProps) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Orphan-resolution modal state. When the save call throws an
  // `OrphanedPlacementsError`, we capture the report and the pending configs
  // so the user can pick a reassignment target for each orphan group. Once
  // all groups are resolved, we re-invoke `onSave` with the options and
  // proceed to close on success.
  const [orphanReport, setOrphanReport] = useState<OrphanReport | null>(null);
  const [pendingConfigs, setPendingConfigs] = useState<QuadrantConfig[] | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  // UX-044: display names for the previewed orphan placements. Keyed by
  // technologyId; a missing key falls back to rendering the raw id. Only the
  // previewed slice (≤5 rows per group) is resolved, so reads stay bounded.
  const [orphanTechNames, setOrphanTechNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!orphanReport) {
      setOrphanTechNames({});
      return;
    }
    let cancelled = false;
    const previewIds = Array.from(
      new Set(orphanReport.orphans.flatMap((g) => g.placements.slice(0, 5).map((p) => p.technologyId)))
    );
    (async () => {
      const resolved = await Promise.all(
        previewIds.map(async (id): Promise<[string, string] | null> => {
          try {
            const tech = await getTechnologyById(id);
            return tech?.name ? [id, tech.name] : null;
          } catch (error) {
            // Non-fatal: the preview falls back to the canonical id.
            log.warn('Failed to resolve technology name for orphan preview', { technologyId: id, error });
            return null;
          }
        })
      );
      if (!cancelled) {
        setOrphanTechNames(Object.fromEntries(resolved.filter((e): e is [string, string] => e !== null)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orphanReport]);

  // Seed drafts from the current radar config every time the dialog opens,
  // so stale edits from a previous open don't leak across radar switches.
  useEffect(() => {
    if (isOpen) {
      setDrafts(buildDraftsFromConfigs(quadrants));
    }
  }, [isOpen, quadrants]);

  const nextKeyCounter = useState({ value: 0 })[0];

  const handleAddQuadrant = () => {
    if (drafts.length >= MAX_QUADRANTS) return;
    nextKeyCounter.value += 1;
    setDrafts([
      ...drafts,
      {
        id: null,
        name: '',
        description: undefined,
        key: `draft-new-${Date.now()}-${nextKeyCounter.value}`,
      },
    ]);
  };

  const handleRemoveQuadrant = (index: number) => {
    if (drafts.length <= MIN_QUADRANTS) return;
    setDrafts(drafts.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const next = [...drafts];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setDrafts(next);
  };

  const handleMoveDown = (index: number) => {
    if (index === drafts.length - 1) return;
    const next = [...drafts];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setDrafts(next);
  };

  const handleNameChange = (index: number, name: string) => {
    const next = [...drafts];
    next[index] = { ...next[index], name };
    setDrafts(next);
  };

  // Validation — runs on every render so the save button state is always live.
  const trimmedNames = drafts.map((d) => d.name.trim());
  const emptyNames = trimmedNames.some((n) => n.length === 0);
  const duplicateNames = new Set(trimmedNames).size !== trimmedNames.length;
  const outOfRange = drafts.length < MIN_QUADRANTS || drafts.length > MAX_QUADRANTS;
  const isValid = !emptyNames && !duplicateNames && !outOfRange;
  const validationMessage = emptyNames
    ? 'Every quadrant must have a name.'
    : duplicateNames
      ? 'Quadrant names must be unique.'
      : outOfRange
        ? `Quadrant count must be between ${MIN_QUADRANTS} and ${MAX_QUADRANTS}.`
        : null;

  /**
   * Build the canonical `QuadrantConfig[]` from the current drafts. Existing
   * quadrants keep their stable id; new quadrants get a minted one.
   *
   * GRAPH-068 — this dialog edits names only, so every `description` it emits is
   * stored data being passed straight back. Omit the key only when it is ABSENT,
   * matching `prepareQuadrantConfigsForWrite` in `@/lib/radars-shared`, which is
   * the single authority for what Firestore may receive. Dropping a falsy
   * description here instead would silently delete a stored empty string on an
   * unrelated rename.
   */
  const buildConfigsFromDrafts = (): QuadrantConfig[] =>
    drafts.map((d, i) => ({
      id: d.id ?? defaultQuadrantIdFromName(trimmedNames[i], i),
      name: trimmedNames[i],
      order: i,
      ...(d.description !== undefined ? { description: d.description } : {}),
    }));

  /** Attempt the save with optional orphan-resolution options. */
  const attemptSave = async (configs: QuadrantConfig[], options?: SettingsDialogSaveOptions) => {
    try {
      setIsSaving(true);
      await Promise.resolve(onSave(configs, ringSystem, options));
      // Success — close both the orphan modal and the main dialog.
      setOrphanReport(null);
      setPendingConfigs(null);
      setResolutions({});
      onOpenChange(false);
    } catch (error) {
      if (isOrphanedPlacementsError(error)) {
        // Capture the orphan report so the user can resolve each group.
        // Seed the resolution map with the first surviving quadrant id as
        // a sensible default for each orphan row — the user can change any
        // of them to `__delete__` before confirming.
        const defaultTargetId = configs[0]?.id ?? '';
        const initialResolutions: Record<string, Resolution> = {};
        for (const group of error.report.orphans) {
          initialResolutions[group.quadrantId] = defaultTargetId;
        }
        setPendingConfigs(configs);
        setOrphanReport(error.report);
        setResolutions(initialResolutions);
        return;
      }
      // Any other error: keep the dialog open and surface a toast.
      const message = error instanceof Error ? error.message : 'Failed to save settings';
      toast({
        title: 'Could not save settings',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!isValid || isSaving) return;
    await attemptSave(buildConfigsFromDrafts());
  };

  /** Retry the save with the user's orphan-resolution plan. */
  const handleConfirmOrphanResolution = async () => {
    if (!pendingConfigs || !orphanReport) return;
    const reassignments: Record<string, string> = {};
    let hasDelete = false;
    for (const group of orphanReport.orphans) {
      const choice = resolutions[group.quadrantId];
      if (choice === '__delete__') {
        hasDelete = true;
      } else if (typeof choice === 'string' && choice.length > 0) {
        reassignments[group.quadrantId] = choice;
      }
    }
    await attemptSave(pendingConfigs, {
      reassignments: Object.keys(reassignments).length > 0 ? reassignments : undefined,
      deleteOrphans: hasDelete || undefined,
    });
  };

  const handleCancelOrphanResolution = () => {
    setOrphanReport(null);
    setPendingConfigs(null);
    setResolutions({});
  };

  /** A resolution is complete when every orphan group has a non-empty choice. */
  const allOrphansResolved =
    orphanReport !== null &&
    orphanReport.orphans.every((g) => {
      const choice = resolutions[g.quadrantId];
      return typeof choice === 'string' && choice.length > 0;
    });

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      {/*
        Layout notes:
        - `flex flex-col` + `max-h-[90vh]` makes the dialog content a flex column
          that never exceeds 90% of the viewport height
        - The quadrant list section gets `flex-1 min-h-0 overflow-y-auto` so it
          takes the remaining space and scrolls internally when 8 rows exceed
          the available height. `min-h-0` is the key — without it, flex children
          refuse to shrink below their content size and the overflow never kicks
          in.
        - Header and footer stay pinned via `flex-shrink-0`.
      */}
      <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh] p-0 gap-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" /> Radar Settings
          </DialogTitle>
          <DialogDescription>
            Configure the quadrants for the current radar. Between {MIN_QUADRANTS} and {MAX_QUADRANTS} quadrants
            supported. Renaming preserves existing technology placements; removing a quadrant requires resolving any
            orphaned placements first.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-shrink-0 px-6 pt-2 pb-2 flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
            Quadrants ({drafts.length} of {MAX_QUADRANTS})
          </Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAddQuadrant}
            disabled={drafts.length >= MAX_QUADRANTS || isSaving}
            className="h-8"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Quadrant
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6">
          <div className="space-y-2 pb-2">
            {drafts.map((row, index) => {
              const isDuplicate =
                row.name.trim().length > 0 && trimmedNames.filter((n) => n === row.name.trim()).length > 1;
              const isEmpty = row.name.trim().length === 0;

              return (
                <div key={row.key} className="flex items-start gap-2 rounded-md border bg-muted/20 p-2">
                  <div className="flex flex-col pt-1">
                    <span className="text-[10px] text-muted-foreground tabular-nums font-semibold text-center">
                      #{index + 1}
                    </span>
                    <div className="flex flex-col items-center">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => handleMoveUp(index)}
                        disabled={index === 0 || isSaving}
                        aria-label={`Move quadrant ${index + 1} up`}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => handleMoveDown(index)}
                        disabled={index === drafts.length - 1 || isSaving}
                        aria-label={`Move quadrant ${index + 1} down`}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex-1 space-y-1">
                    <Input
                      value={row.name}
                      onChange={(e) => handleNameChange(index, e.target.value)}
                      placeholder="Quadrant name"
                      disabled={isSaving}
                      aria-label={`Quadrant ${index + 1} name`}
                      className={
                        isDuplicate || isEmpty ? 'border-destructive focus-visible:ring-destructive' : undefined
                      }
                    />
                    {row.id && <p className="text-[10px] text-muted-foreground/70 font-mono pl-1">id: {row.id}</p>}
                  </div>

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => handleRemoveQuadrant(index)}
                    disabled={drafts.length <= MIN_QUADRANTS || isSaving}
                    aria-label={`Remove quadrant ${index + 1}`}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        {validationMessage && (
          <p className="flex-shrink-0 px-6 pt-1 text-xs text-destructive" role="alert">
            {validationMessage}
          </p>
        )}

        <DialogFooter className="flex-shrink-0 px-6 pb-6 pt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={!isValid || isSaving} className="w-full sm:w-auto">
            {isSaving ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* ==================================================================
           Orphan resolution modal
           ==================================================================
           Shown when `attemptSave` catches an `OrphanedPlacementsError`. The
           user picks a target for each orphaned quadrant group — either a
           surviving quadrant id (reassign all placements) or the
           sentinel `__delete__` to drop them entirely. Confirming retries
           the save with the resolution plan attached. Both the orphan modal
           and the parent SettingsDialog stay open until the retry resolves
           successfully. */}
      {orphanReport && pendingConfigs && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) handleCancelOrphanResolution();
          }}
        >
          <DialogContent className="sm:max-w-xl flex flex-col max-h-[85vh] p-0 gap-0">
            <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-3">
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Resolve orphaned placements
              </DialogTitle>
              <DialogDescription>
                Removing {orphanReport.orphans.length} quadrant
                {orphanReport.orphans.length === 1 ? '' : 's'} will orphan {orphanReport.totalPlacements} placement
                {orphanReport.totalPlacements === 1 ? '' : 's'}. Choose a surviving quadrant to move them to — or delete
                them permanently.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 space-y-4">
              {orphanReport.orphans.map((group) => {
                const displayName = group.quadrantName ?? group.quadrantId;
                const totalRows = group.placements.length;
                return (
                  <div key={group.quadrantId} className="rounded-md border bg-muted/20 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm truncate">{displayName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {totalRows} row{totalRows === 1 ? '' : 's'} will be affected
                        </p>
                      </div>
                      <Select
                        value={resolutions[group.quadrantId] ?? ''}
                        onValueChange={(value) =>
                          setResolutions((prev) => ({ ...prev, [group.quadrantId]: value as Resolution }))
                        }
                      >
                        <SelectTrigger className="w-[220px] h-9" aria-label={`Resolution for ${displayName}`}>
                          <SelectValue placeholder="Choose action…" />
                        </SelectTrigger>
                        <SelectContent>
                          {pendingConfigs.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              Move to: {c.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="__delete__">
                            <span className="flex items-center gap-2 text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete permanently
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Preview placements — show up to 5 items so the user can see
                        what's being affected without overwhelming the modal. */}
                    {totalRows > 0 && (
                      <ul className="text-xs text-muted-foreground space-y-0.5 pl-1">
                        {group.placements.slice(0, 5).map((p) => {
                          const techName = orphanTechNames[p.technologyId];
                          return (
                            <li key={`p-${p.id}`} className="truncate" title={p.technologyId}>
                              • Placement{' '}
                              <span className={techName ? 'font-medium' : 'font-mono'}>
                                {techName ?? p.technologyId}
                              </span>{' '}
                              ({p.ring})
                            </li>
                          );
                        })}
                        {totalRows > 5 && <li>…and {totalRows - 5} more</li>}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>

            <DialogFooter className="flex-shrink-0 px-6 pb-6 pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelOrphanResolution}
                disabled={isSaving}
                className="w-full sm:w-auto"
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={handleConfirmOrphanResolution}
                disabled={!allOrphansResolved || isSaving}
                className="w-full sm:w-auto"
              >
                {isSaving ? 'Applying…' : 'Continue Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
