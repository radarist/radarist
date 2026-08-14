/**
 * @file GraphOverviewPanel.tsx
 * @description Overview panel showing graph statistics and legend
 *
 * Features:
 * - Node labels with counts and colors
 * - Relationship types with counts
 * - Click to focus by label or relationship type
 * - Collapse/expand sections
 * - Statistics summary
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, ArrowRight, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
// GRAPH-073 — the single canonical colour source. This component previously
// re-declared an inline `ENTITY_COLORS` literal instead of using this canonical
// palette, and it had already drifted (missing Chunk, Assertion,
// CommunityReport, RadarPlacement, Radar, Episode, Mission).
import { entityColorHex, isMappedEntityLabel, isMappedRelationType, relationColorHex } from '@/lib/entity-colors';

// ============================================================================
// TYPES
// ============================================================================

interface GraphStats {
  nodeCount: number;
  relationshipCount: number;
  labelCounts: Record<string, number>;
  typeCounts: Record<string, number>;
}

interface GraphOverviewPanelProps {
  /** Graph statistics */
  stats: GraphStats;
  /** Query execution time in milliseconds */
  executionTimeMs?: number;
  /** Callback when a label is clicked for contextual focus */
  onLabelClick?: (label: string) => void;
  /** Callback when a type is clicked for contextual focus */
  onTypeClick?: (type: string) => void;
  /** Currently active label focus */
  activeLabel?: string | null;
  /** Currently active relationship-type focus */
  activeType?: string | null;
  /** Whether the panel is loading */
  isLoading?: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function GraphOverviewPanel({
  stats,
  executionTimeMs,
  onLabelClick,
  onTypeClick,
  activeLabel,
  activeType,
  isLoading = false,
}: GraphOverviewPanelProps) {
  const [nodesOpen, setNodesOpen] = useState(true);
  const [relsOpen, setRelsOpen] = useState(true);

  // Sort labels by count
  const sortedLabels = Object.entries(stats.labelCounts).sort((a, b) => b[1] - a[1]);

  // Sort types by count
  const sortedTypes = Object.entries(stats.typeCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col h-full bg-background border-l" role="region" aria-label="Graph overview">
      {/* Header */}
      <div className="p-3 border-b">
        <h3 className="font-semibold text-sm">Overview</h3>
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-[10px]">
            {stats.nodeCount} nodes
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {stats.relationshipCount} rels
          </Badge>
          {executionTimeMs !== undefined && (
            <span className="flex items-center gap-0.5">
              <Timer className="h-3 w-3" />
              {executionTimeMs}ms
            </span>
          )}
        </div>
      </div>

      {/* Scrollable Content */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Node Labels Section */}
          <Collapsible open={nodesOpen} onOpenChange={setNodesOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between p-0 h-auto hover:bg-transparent">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {nodesOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Node Labels
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {sortedLabels.length}
                </Badge>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              {sortedLabels.length === 0 ? (
                <p className="text-xs text-muted-foreground pl-5">No nodes found</p>
              ) : (
                sortedLabels.map(([label, count]) => {
                  // GRAPH-073 — an unmapped label keeps the reserved neutral fill AND
                  // says so, so it reads as a gap in the encoding rather than merging
                  // silently into the grey mass.
                  const mapped = isMappedEntityLabel(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onLabelClick?.(label)}
                      disabled={isLoading || !onLabelClick}
                      aria-pressed={activeLabel === label}
                      aria-label={
                        mapped
                          ? `Focus ${label} nodes (${count})`
                          : `Focus ${label} nodes (${count}) — no assigned color`
                      }
                      title={mapped ? undefined : `${label} has no assigned color in the canonical palette`}
                      data-unmapped-label={mapped ? undefined : 'true'}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors',
                        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
                        activeLabel === label && 'bg-muted ring-1 ring-primary'
                      )}
                    >
                      <Circle
                        className={cn('h-3 w-3 shrink-0', !mapped && 'opacity-70')}
                        style={{
                          fill: mapped ? entityColorHex(label) : 'transparent',
                          color: entityColorHex(label),
                        }}
                      />
                      <span className="flex-1 text-left truncate">{label}</span>
                      {!mapped && <span className="text-[10px] text-muted-foreground shrink-0">unmapped</span>}
                      <Badge variant="secondary" className="text-[10px] h-4 px-1">
                        {count}
                      </Badge>
                    </button>
                  );
                })
              )}
            </CollapsibleContent>
          </Collapsible>

          <Separator />

          {/* Relationship Types Section */}
          <Collapsible open={relsOpen} onOpenChange={setRelsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-between p-0 h-auto hover:bg-transparent">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {relsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Relationship Types
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {sortedTypes.length}
                </Badge>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              {sortedTypes.length === 0 ? (
                <p className="text-xs text-muted-foreground pl-5">No relationships found</p>
              ) : (
                sortedTypes.map(([type, count]) => {
                  const mapped = isMappedRelationType(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onTypeClick?.(type)}
                      disabled={isLoading || !onTypeClick}
                      aria-pressed={activeType === type}
                      aria-label={
                        mapped
                          ? `Focus ${type} relationships (${count})`
                          : `Focus ${type} relationships (${count}) — no assigned color`
                      }
                      title={mapped ? undefined : `${type} has no assigned color in the canonical palette`}
                      data-unmapped-type={mapped ? undefined : 'true'}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors',
                        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
                        activeType === type && 'bg-muted ring-1 ring-primary'
                      )}
                    >
                      <ArrowRight
                        className={cn('h-3 w-3 shrink-0', !mapped && 'opacity-70')}
                        style={{ color: relationColorHex(type) }}
                      />
                      <span className="flex-1 text-left truncate font-mono">{type}</span>
                      {!mapped && <span className="text-[10px] text-muted-foreground shrink-0">unmapped</span>}
                      <Badge variant="secondary" className="text-[10px] h-4 px-1">
                        {count}
                      </Badge>
                    </button>
                  );
                })
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </ScrollArea>

      {/* Footer with Clear Focus */}
      {(activeLabel || activeType) && (
        <div className="p-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={() => {
              onLabelClick?.('');
              onTypeClick?.('');
            }}
          >
            Clear focus
          </Button>
        </div>
      )}
    </div>
  );
}
