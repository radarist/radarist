/**
 * @file RadarVisualization.tsx
 * @description Main radar visualization container with ring system selector in header
 *
 * Phase 4.1 Refactor: Aligned with shadcn Card patterns
 * - Card with header containing ring system selector
 * - Mobile sidebar trigger with filters sheet
 * - Search input for filtering entries
 * - Proper min-height and sizing for radar visibility
 * - Clean visual separation matching shadcn dashboard
 *
 * @author Radarist Team
 * @created 2025-11-29
 * @updated 2025-11-29 - Enhanced layout per design spec
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Radar, RadarLegend } from '@/components/Radar';
import type { RadarData, RadarEntry, QuadrantConfig, RingSystem } from '@/lib/types';
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ListFilter, Layers, Search, Tag } from 'lucide-react';
import { RadarSidebarPanel } from './RadarSidebarPanel';
import { RING_SYSTEMS } from '@/lib/constants';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface RadarVisualizationProps {
  selectedRadar: Omit<RadarData, 'entries'> | null;
  filteredEntries: RadarEntry[];
  quadrants: QuadrantConfig[];
  hoveredEntryId: number | null;
  setHoveredEntryId: (id: number | null) => void;
  handleEntryClick: (entry: RadarEntry) => void;
  allTags: string[];
  activeTags: string[];
  handleTagClick: (tag: string) => void;
  handleClearTags: () => void;
  onRingSystemChange: (system: RingSystem) => void;
  onEntryDragEnd: (id: number, position: { x: number; y: number }) => void;
  className?: string;
  // Filter Props (optional)
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  activeFilters?: { quadrants: string[]; rings: string[]; statuses: string[] };
  // Strategy Props (optional)
  isStrategyMode?: boolean;
  selectedStrategyId?: string;
}

// ============================================================================
// RING SYSTEM OPTIONS
// ============================================================================

const ringSystemOptions: { value: RingSystem; label: string }[] = [
  { value: 'Standard', label: 'Standard (HATA)' },
  { value: 'TRL', label: 'TRL (1-9)' },
  { value: 'Time-to-Impact', label: 'Time-to-Impact' },
];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * RadarVisualization
 *
 * Main visualization container for the radar.
 * - Header with ring system selector and search input
 * - Mobile filter trigger in header
 * - Radar component in content area with proper sizing
 * - Min-height enforced for visibility at all breakpoints
 */
export function RadarVisualization({
  selectedRadar,
  filteredEntries,
  quadrants,
  hoveredEntryId,
  setHoveredEntryId,
  handleEntryClick,
  allTags,
  activeTags,
  handleTagClick,
  handleClearTags,
  onRingSystemChange,
  onEntryDragEnd,
  className,
  searchQuery = '',
  onSearchQueryChange,
  activeFilters = { quadrants: [], rings: [], statuses: [] },
  isStrategyMode = false,
  selectedStrategyId,
}: RadarVisualizationProps) {
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const [showLabels, setShowLabels] = useState(false);
  const currentRingSystem = selectedRadar?.ringSystem || 'Standard';
  const rings = RING_SYSTEMS[currentRingSystem];

  // Handle search input change
  const handleSearchChange = (value: string) => {
    setLocalSearchQuery(value);
    onSearchQueryChange?.(value);
  };

  // Map entries to display ring based on ring system
  const displayEntries = filteredEntries.map((entry) => {
    let displayRing = entry.ring;

    if (currentRingSystem === 'TRL') {
      // TRL system: Use trl field or fallback
      displayRing = entry.trl || (entry.ring.startsWith('TRL') ? entry.ring : 'TRL 1');
    } else if (currentRingSystem === 'Time-to-Impact') {
      // Time-to-Impact system: Use timeToImpact field or fallback
      displayRing = entry.timeToImpact || 'H3 (18+mo)';
    } else {
      // Standard HATA system
      displayRing = entry.hata || (!entry.ring.startsWith('TRL') ? entry.ring : 'Assess');
    }

    return {
      ...entry,
      ring: displayRing,
    };
  });

  return (
    <Card
      className={cn(
        'flex flex-col h-full',
        // Enforce minimum sizes to prevent radar from being too small
        'min-h-[560px] sm:min-h-[640px] lg:min-h-[720px]',
        'lg:min-w-[640px]',
        className
      )}
    >
      {/* Card Header with Ring System Selector & Search */}
      <CardHeader className="py-3 px-4 border-b shrink-0">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Ring System Selector + Legend */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Layers className="h-4 w-4" />
              <span className="hidden sm:inline">Ring System</span>
            </div>
            <Select value={currentRingSystem} onValueChange={(value) => onRingSystemChange(value as RingSystem)}>
              <SelectTrigger className="w-[180px] h-8 text-sm" aria-label="Select ring system">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ringSystemOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Legend - positioned next to ring system */}
            <div className="hidden sm:block">
              <RadarLegend />
            </div>
            {/* Labels Toggle */}
            <Button
              variant={showLabels ? 'default' : 'outline'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowLabels(!showLabels)}
              title={showLabels ? 'Hide labels' : 'Show labels'}
            >
              <Tag className="h-4 w-4" />
            </Button>
          </div>

          {/* Right: Search + Mobile Filters */}
          <div className="flex items-center gap-2">
            {/* Search Input (hidden on small screens) */}
            <div className="relative hidden md:block">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search entries..."
                value={localSearchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-[220px] h-8 pl-8 text-sm"
                aria-label="Search radar entries"
              />
            </div>

            {/* Mobile Filter Trigger */}
            <div className="lg:hidden">
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8" aria-label="Open filters">
                    <ListFilter className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">Filters</span>
                    {activeTags.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-xs">
                        {activeTags.length}
                      </span>
                    )}
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[340px] sm:w-[400px] p-0">
                  <SheetHeader className="px-4 py-3 border-b">
                    <SheetTitle className="text-lg">Entries & Filters</SheetTitle>
                    <SheetDescription className="sr-only">
                      Browse the radar entries and filter them by tag.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="h-[calc(100vh-60px)] overflow-hidden">
                    <RadarSidebarPanel
                      filteredEntries={filteredEntries}
                      quadrants={quadrants}
                      hoveredEntryId={hoveredEntryId}
                      setHoveredEntryId={setHoveredEntryId}
                      handleEntryClick={handleEntryClick}
                      allTags={allTags}
                      activeTags={activeTags}
                      handleTagClick={handleTagClick}
                      handleClearTags={handleClearTags}
                      className="h-full p-4"
                    />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>
      </CardHeader>

      {/* Radar Content */}
      <CardContent className="flex-1 flex items-center justify-center p-2 lg:p-4 min-h-0 overflow-hidden">
        {/* Wrapper to ensure radar has proper spacing from edges */}
        <div className="relative w-full h-full flex items-center justify-center">
          <Radar
            entries={displayEntries}
            quadrants={quadrants}
            rings={rings as unknown as string[]}
            ringSystem={currentRingSystem}
            onRingSystemChange={onRingSystemChange}
            hoveredEntryId={hoveredEntryId}
            onEntryHover={setHoveredEntryId}
            onEntryClick={handleEntryClick}
            onEntryDragEnd={onEntryDragEnd}
            searchQuery={localSearchQuery}
            activeFilters={activeFilters}
            isStrategyMode={isStrategyMode}
            selectedStrategyId={selectedStrategyId}
            // Hide the internal ring system selector since we have one in the header
            hideRingSystemSelector
            showLabels={showLabels}
          />
        </div>
      </CardContent>
    </Card>
  );
}
