/**
 * @file RadarSidebarPanel.tsx
 * @description Left sidebar panel for the Radar page - Entries list and Tags filter
 *
 * Phase 4.1 Refactor: Clean shadcn "list panel" design
 * - Single card container with subtle styling
 * - ScrollArea for smooth scrolling without visible scrollbars
 * - Proper entry row layout with ring indicators
 * - Tag chips with toggle behavior
 * - Keyboard navigation (↑/↓ arrows, Enter to select)
 *
 * @author Radarist Team
 * @created 2025-11-29
 * @updated 2025-11-29 - Added keyboard navigation support
 */

import { useEffect, useCallback, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Kbd } from '@/components/ui/kbd';
import { X, List, Tags, Check, Gauge, Clock } from 'lucide-react';
import type { QuadrantConfig, RadarEntry } from '@/lib/types';
import { resolveEntryQuadrantLabel } from '@/lib/radar-quadrants';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface RadarSidebarPanelProps {
  filteredEntries: RadarEntry[];
  /**
   * The selected radar's CURRENT quadrant configuration (same source the
   * canvas renders from). Entry quadrant labels resolve against this by
   * stable ID so canvas and sidebar always agree (UX-043).
   */
  quadrants: QuadrantConfig[];
  hoveredEntryId: number | null;
  setHoveredEntryId: (id: number | null) => void;
  handleEntryClick: (entry: RadarEntry) => void;
  allTags: string[];
  activeTags: string[];
  handleTagClick: (tag: string) => void;
  handleClearTags: () => void;
  className?: string;
}

// ============================================================================
// ENTRY LIST ITEM
// ============================================================================

interface EntryListItemProps {
  entry: RadarEntry;
  quadrantLabel: string;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
}

function EntryListItem({ entry, quadrantLabel, isHovered, onHover, onLeave, onClick }: EntryListItemProps) {
  // Format ring label to ALL CAPS for display
  const ringLabel = entry.ring?.toUpperCase() || '';
  // Trim long names to 30 characters
  const displayName = entry.name.length > 30 ? `${entry.name.slice(0, 30)}...` : entry.name;

  // Extract TRL number for compact display (e.g., "TRL 5" -> "5")
  const trlNumber = entry.trl?.replace(/\D/g, '') || null;
  // Extract Time-to-Impact horizon (e.g., "H1 (0-6mo)" -> "H1")
  const horizonShort = entry.timeToImpact?.split(' ')[0] || null;

  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      className="w-full text-left focus:outline-none"
    >
      <div
        className={cn(
          'flex flex-col gap-0.5 rounded-lg px-3 py-2 transition-colors',
          isHovered ? 'ring-1 ring-primary ring-offset-0 bg-sidebar-accent/40' : 'bg-transparent'
        )}
      >
        {/* Title + Type container - min-w-0 enables truncation in flex */}
        <div className="flex flex-col min-w-0 gap-0.5">
          {/* Line 1: Name - text-xs to match type line size, trimmed to 30 chars */}
          <div className="text-xs font-medium" title={entry.name}>
            {displayName}
          </div>

          {/* Line 2: Quadrant — resolved from the radar's CURRENT config by
              stable ID so it always matches the canvas (UX-043) */}
          <span className="text-xs text-muted-foreground truncate min-w-0">{quadrantLabel}</span>

          {/* Line 3: Three-Dimensional Assessment */}
          <div className="flex items-center gap-1.5 mt-0.5">
            {/* Ring pill */}
            {entry.ring && (
              <span className="inline-flex items-center shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {ringLabel}
              </span>
            )}

            {/* TRL indicator */}
            {trlNumber && (
              <span
                className="inline-flex items-center gap-0.5 shrink-0 text-[10px] text-muted-foreground"
                title={`Technology Readiness Level: ${entry.trl}`}
              >
                <Gauge className="h-3 w-3" />
                <span>{trlNumber}</span>
              </span>
            )}

            {/* Time-to-Impact indicator */}
            {horizonShort && horizonShort !== 'Unknown' && (
              <span
                className="inline-flex items-center gap-0.5 shrink-0 text-[10px] text-muted-foreground"
                title={`Time-to-Impact: ${entry.timeToImpact}`}
              >
                <Clock className="h-3 w-3" />
                <span>{horizonShort}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// ENTRIES CARD
// ============================================================================

interface EntriesCardProps {
  entries: RadarEntry[];
  quadrants: QuadrantConfig[];
  hoveredEntryId: number | null;
  setHoveredEntryId: (id: number | null) => void;
  handleEntryClick: (entry: RadarEntry) => void;
}

function EntriesCard({ entries, quadrants, hoveredEntryId, setHoveredEntryId, handleEntryClick }: EntriesCardProps) {
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only handle if no input is focused
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        return;
      }

      if (sortedEntries.length === 0) return;

      const currentIndex = hoveredEntryId ? sortedEntries.findIndex((entry) => entry.id === hoveredEntryId) : -1;

      switch (e.key) {
        case 'ArrowDown':
        case 'j': // Vim-style navigation
          e.preventDefault();
          if (currentIndex < sortedEntries.length - 1) {
            setHoveredEntryId(sortedEntries[currentIndex + 1].id);
          } else if (currentIndex === -1 && sortedEntries.length > 0) {
            // No selection, start at first
            setHoveredEntryId(sortedEntries[0].id);
          }
          break;

        case 'ArrowUp':
        case 'k': // Vim-style navigation
          e.preventDefault();
          if (currentIndex > 0) {
            setHoveredEntryId(sortedEntries[currentIndex - 1].id);
          } else if (currentIndex === -1 && sortedEntries.length > 0) {
            // No selection, start at last
            setHoveredEntryId(sortedEntries[sortedEntries.length - 1].id);
          }
          break;

        case 'Enter':
          e.preventDefault();
          if (hoveredEntryId !== null) {
            const entry = sortedEntries.find((e) => e.id === hoveredEntryId);
            if (entry) {
              handleEntryClick(entry);
            }
          }
          break;

        case 'Escape':
          e.preventDefault();
          setHoveredEntryId(null);
          break;
      }
    },
    [sortedEntries, hoveredEntryId, setHoveredEntryId, handleEntryClick]
  );

  // Add keyboard event listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    if (hoveredEntryId !== null && containerRef.current) {
      const selectedElement = containerRef.current.querySelector(`[data-entry-id="${hoveredEntryId}"]`);
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [hoveredEntryId]);

  return (
    <div className="rounded-xl border border-border bg-card/60 p-3 md:p-4 flex flex-col gap-3 flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <List className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Entries</h3>
          <Badge variant="secondary" className="text-xs font-normal">
            {entries.length}
          </Badge>
        </div>
        {/* Keyboard hint */}
        <div className="hidden xl:flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>navigate</span>
        </div>
      </div>

      {/* Scrollable List - padding ensures selected ring isn't clipped */}
      <ScrollArea className="flex-1">
        <div className="pl-1 pr-2 py-1" ref={containerRef}>
          {sortedEntries.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">No entries match your filters</div>
          ) : (
            <div className="space-y-0.5">
              {sortedEntries.map((entry, index) => (
                <div key={`${entry.id}-${index}`} data-entry-id={entry.id}>
                  <EntryListItem
                    entry={entry}
                    quadrantLabel={resolveEntryQuadrantLabel(quadrants, entry)}
                    isHovered={hoveredEntryId === entry.id}
                    onHover={() => setHoveredEntryId(entry.id)}
                    onLeave={() => setHoveredEntryId(null)}
                    onClick={() => handleEntryClick(entry)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// TAGS FILTER CARD
// ============================================================================

interface TagsFilterCardProps {
  allTags: string[];
  activeTags: string[];
  handleTagClick: (tag: string) => void;
  handleClearTags: () => void;
}

function TagsFilterCard({ allTags, activeTags, handleTagClick, handleClearTags }: TagsFilterCardProps) {
  if (allTags.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-card/60 p-3 md:p-4 flex flex-col gap-3 mt-3 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tags className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Filter by Tags</h3>
        </div>
        {activeTags.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleClearTags}
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Active filters summary */}
      {activeTags.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Active: {activeTags.slice(0, 3).join(', ')}
          {activeTags.length > 3 && ` (+${activeTags.length - 3})`}
        </p>
      )}

      {/* Tag Chips */}
      <ScrollArea className="max-h-[120px]">
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => {
            const isActive = activeTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => handleTagClick(tag)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {isActive && <Check className="h-3 w-3" />}
                {tag}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * RadarSidebarPanel
 *
 * Left sidebar for the Radar page containing:
 * 1. Entries panel - Scrollable list of radar entries
 * 2. Tags filter - Toggle chips for filtering
 *
 * Uses clean shadcn card styling with smooth ScrollArea scrolling.
 */
export function RadarSidebarPanel({
  filteredEntries,
  quadrants,
  hoveredEntryId,
  setHoveredEntryId,
  handleEntryClick,
  allTags,
  activeTags,
  handleTagClick,
  handleClearTags,
  className,
}: RadarSidebarPanelProps) {
  return (
    <div className={cn('flex flex-col h-full', className)}>
      <EntriesCard
        entries={filteredEntries}
        quadrants={quadrants}
        hoveredEntryId={hoveredEntryId}
        setHoveredEntryId={setHoveredEntryId}
        handleEntryClick={handleEntryClick}
      />
      <TagsFilterCard
        allTags={allTags}
        activeTags={activeTags}
        handleTagClick={handleTagClick}
        handleClearTags={handleClearTags}
      />
    </div>
  );
}
