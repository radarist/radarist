'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { safeResolve } from '@/lib/migration';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Trash2, Pencil, Network } from 'lucide-react';
import type { RadarEntry, Company, UseCase } from '@/lib/types';

import { Badge } from './ui/badge';
import { ChartContainer, ChartTooltipContent } from '@/components/ui/chart';
import { LineChart, CartesianGrid, XAxis, YAxis, Line, Tooltip as RechartsTooltip } from 'recharts';
import { format } from 'date-fns';

import ReactMarkdown from 'react-markdown';
import { BlipCompanyLinks } from './radar-page/BlipCompanyLinks';
import { BlipUseCaseLinks } from './radar-page/BlipUseCaseLinks';
import { TrendChart } from './TrendChart';
import { EntityRelationshipPanel } from '@/components/graphs/EntityRelationshipPanel';
import { TechnologyResearchTab } from './sheets/tabs/TechnologyResearchTab';
import { useDataRefresh } from '@/hooks/useDataRefresh';

interface ResearchDialogProps {
  /** Whether the dialog is open. */
  isOpen: boolean;
  /** Callback to update the dialog's open state. */
  onOpenChange: (isOpen: boolean) => void;
  /** The radar entry to research. */
  entry: RadarEntry;
  /** Callback to delete the entry. */
  onDelete: (id: number) => void;
  /** Callback to edit the entry. */
  onEdit: (entry: RadarEntry) => void;
  /** Callback to save the generated analysis. */
  onSaveAnalysis: (entryId: number, analysis: string) => void;
  /** List of available rings (for chart mapping). */
  rings: string[];
  /** If true, disables edit and delete actions. */
  readOnly?: boolean;
  /** The ID of the radar this entry belongs to. */
  radarId: string;
  /** Callback when a linked company is clicked. */
  onCompanyClick?: (company: Company) => void;
  /** Callback when a linked use case is clicked. */
  onUseCaseClick?: (useCase: UseCase) => void;
  /** Callback to refresh data when background research completes. */
  onRefresh?: () => void;
}

/**
 * A detailed view dialog for a specific radar entry.
 * Features:
 * - Displays full metadata (Quadrant, Ring, Tags, Cost).
 * - Shows a movement history chart (Ring changes over time).
 * - Provides AI-powered "Deep Research" analysis.
 * - Allows editing or deleting the entry.
 *
 * @param props - Component props.
 * @returns The rendered dialog.
 */
export function ResearchDialog({
  isOpen,
  onOpenChange,
  entry,
  onDelete,
  onEdit,
  onSaveAnalysis: _onSaveAnalysis,
  rings,
  readOnly,
  radarId,
  onCompanyClick,
  onUseCaseClick,
  onRefresh,
}: ResearchDialogProps) {
  const ringToNumber = useCallback((ring: string): number => {
    return rings.length - 1 - rings.indexOf(ring);
  }, [rings]);

  const numberToRing = (num: number): string => {
    return rings[rings.length - 1 - num];
  };

  // Listen for data refresh events (e.g. when background research completes)
  useDataRefresh(['technologies'], onRefresh ?? (() => {}));

  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [resolvedEntityId, setResolvedEntityId] = useState<string>('');

  // Phase 3: Resolve the technology entity ID for ContextualGraph
  // Handles both new (tech-xxx) and legacy (radarId:techId) formats
  const getTechnologyEntityId = useCallback(async (): Promise<string> => {
    const compositeId = `${radarId}:${entry.id}`;

    // Try to resolve to new format
    const resolved = await safeResolve(compositeId);
    return resolved || compositeId;
  }, [radarId, entry?.id]);

  // Resolve entity ID when entry changes
  useEffect(() => {
    if (entry) {
      getTechnologyEntityId().then(setResolvedEntityId);
    }
  }, [entry, getTechnologyEntityId]);

  const chartData = useMemo(() => {
    if (!entry) return [];

    const history = entry.history || [];
    const data = history.map((h) => ({
      date: new Date(h.date),
      ring: ringToNumber(h.ring),
      status: h.status,
    }));

    // Add current state as the last point in history
    data.push({
      date: new Date(), // Use current date for the latest point
      ring: ringToNumber(entry.ring),
      status: entry.status,
    });

    return data.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [entry, ringToNumber]);

  // UX-044: deletion is confirmed through an accessible AlertDialog (not the
  // native `window.confirm`). Cancel never mutates; Confirm deletes exactly
  // once via the parent-owned `onDelete` callback.
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  const hasHistory = chartData.length > 1;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl h-[90vh] flex flex-col p-0 gap-0 overflow-hidden border-none shadow-2xl bg-background/95 backdrop-blur-xl">
        <DialogHeader className="px-6 py-6 border-b bg-muted/30">
          <DialogTitle className="text-3xl font-bold tracking-tight mb-2 flex items-center gap-3">
            {entry?.name}
            <Badge
              variant={
                entry.status === 'Trending' ? 'default' : entry.status === 'Stable' ? 'secondary' : 'destructive'
              }
              className="text-sm font-medium py-0.5"
            >
              {entry.status}
            </Badge>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-base leading-relaxed max-w-2xl prose prose-sm dark:prose-invert">
              <ReactMarkdown>{entry?.description}</ReactMarkdown>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 bg-muted/10 border-b text-sm space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-muted-foreground block mb-1">Quadrant</span>
              <span className="font-semibold">
                {entry.quadrantName ||
                  entry.quadrantId ||
                  // Defensive: pre-migration entries may still carry a legacy
                  // `quadrant: <name>` string. Hide the raw id prefix by
                  // falling back to it last.
                  ((entry as unknown as { quadrant?: string }).quadrant ?? '—')}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-1">HATA Ring</span>
              <span className="font-semibold text-primary">
                {entry.hata && !entry.hata.startsWith('TRL')
                  ? entry.hata
                  : entry.ring && !entry.ring.startsWith('TRL')
                    ? entry.ring
                    : '-'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-1">TRL</span>
              <span className="font-semibold text-primary">
                {entry.trl || (entry.ring && entry.ring.startsWith('TRL') ? entry.ring : '-')}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block mb-1">Time to Impact</span>
              <span className="font-semibold text-primary">{entry.timeToImpact || '-'}</span>
            </div>
          </div>
          {entry.tags.length > 0 && (
            <div>
              <span className="text-muted-foreground block mb-1.5">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-5 font-normal bg-background/50"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 px-6 py-6">
          <div className="space-y-8 pb-8">
            {hasHistory && (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold flex items-center gap-2">Movement History</h3>
                <div className="rounded-xl border bg-card/50 p-4 shadow-sm">
                  <ChartContainer config={{}} className="h-[200px] w-full">
                    <LineChart data={chartData} margin={{ top: 5, right: 20, left: -10, bottom: 0 }}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(tick) => format(tick, 'MMM yy')}
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickLine={{ stroke: 'hsl(var(--border))' }}
                        minTickGap={30}
                      />
                      <YAxis
                        dataKey="ring"
                        domain={[0, rings.length - 1]}
                        ticks={Array.from({ length: rings.length }, (_, i) => i)}
                        tickFormatter={(tick) => numberToRing(tick)}
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickLine={{ stroke: 'hsl(var(--border))' }}
                      />
                      <RechartsTooltip
                        cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }}
                        content={
                          <ChartTooltipContent
                            className="w-48"
                            formatter={(value, name, props) => (
                              <div className="text-sm space-y-1">
                                <p>
                                  Ring:{' '}
                                  <span className="font-semibold text-primary">{numberToRing(props.payload.ring)}</span>
                                </p>
                                <p>
                                  Status:{' '}
                                  <span className="font-medium text-muted-foreground">{props.payload.status}</span>
                                </p>
                              </div>
                            )}
                            labelFormatter={(label, payload) => {
                              const date = payload?.[0]?.payload?.date;
                              if (date) {
                                return format(new Date(date), 'PPP');
                              }
                              return label;
                            }}
                          />
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="ring"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        dot={{ r: 4, fill: 'hsl(var(--background))', stroke: 'hsl(var(--primary))', strokeWidth: 2 }}
                        activeDot={{ r: 6, fill: 'hsl(var(--primary))' }}
                      />
                    </LineChart>
                  </ChartContainer>
                </div>
              </div>
            )}

            {/* Authenticated-only sections are omitted in read-only / public mode
                (UX-061): TrendChart calls /api/trends, and the blip link panels read
                auth-gated collections, which surface 401s and console errors to a
                signed-out viewer. The radar's own data (history chart, tags, research)
                is already in hand and needs no extra request. */}
            {!readOnly && (
              <div className="space-y-3">
                <TrendChart keyword={entry.name} className="w-full" />
              </div>
            )}

            {!readOnly && (
              <div className="space-y-3">
                <BlipCompanyLinks radarId={radarId} radarEntryId={entry.id} onCompanyClick={onCompanyClick} />
                <BlipUseCaseLinks radarId={radarId} radarEntryId={entry.id} onUseCaseClick={onUseCaseClick} />
              </div>
            )}

            {/* Technology Research - reuses the same component as the Technology sheet */}
            <TechnologyResearchTab research={entry.comprehensiveResearch} />
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex w-full justify-between">
            <div>
              {!readOnly && (
                <Button
                  variant="ghost"
                  onClick={() => setIsDeleteConfirmOpen(true)}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Entry
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {!readOnly && (
                <Button variant="outline" onClick={() => setIsGraphOpen(true)}>
                  <Network className="mr-2 h-4 w-4" />
                  Graph
                </Button>
              )}
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {!readOnly && (
                <Button onClick={() => onEdit(entry)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit Entry
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>

      {/* Delete confirmation (UX-044) — accessible replacement for window.confirm */}
      <AlertDialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete radar entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes “{entry.name}” from this radar, including its placement history. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onDelete(entry.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Contextual Graph Modal — auth-gated, so never mounted in read-only /
          public mode (UX-061). With the Graph button hidden below, isGraphOpen
          can never toggle true here, but this guard keeps the contract explicit. */}
      {!readOnly && (
        <EntityRelationshipPanel
          isOpen={isGraphOpen}
          onOpenChange={setIsGraphOpen}
          entityId={resolvedEntityId || `${radarId}:${entry.id}`}
          entityName={entry.name}
          entityType="technology"
          mode="dialog"
        />
      )}
    </Dialog>
  );
}
