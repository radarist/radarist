/**
 * @file ShareableRadarLayout.tsx
 * @description Read-only layout for displaying a shared radar
 *
 * Phase 4.1 Refactor: Consistent with main radar layout
 * - Uses same Card patterns and sizing
 * - Includes tag filter at bottom
 * - Same zoom control positioning
 * - Read-only badge in header
 *
 * @author Radarist Team
 * @updated 2025-11-29
 */

import { useState } from 'react';
import { Radar } from '@/components/Radar';
import type { RadarData, RadarEntry, QuadrantConfig, RingSystem } from '@/lib/types';
import { RING_SYSTEMS } from '@/lib/constants';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ResearchDialog } from '@/components/ResearchDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Layers, Eye, Check, X, Tag, Search } from 'lucide-react';
import { RadarLegend } from '@/components/Radar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ShareableRadarLayoutProps {
  radar: RadarData;
  quadrants: QuadrantConfig[];
}

// Ring system options
const ringSystemOptions: { value: RingSystem; label: string }[] = [
  { value: 'Standard', label: 'Standard (HATA)' },
  { value: 'TRL', label: 'TRL (1-9)' },
  { value: 'Time-to-Impact', label: 'Time-to-Impact' },
];

/**
 * A read-only layout for displaying a shared radar.
 * Renders the radar visualization and entry details without editing capabilities.
 * Intended for public or unauthenticated access.
 *
 * @param props - The radar data to display.
 * @returns The rendered shareable layout.
 */
export function ShareableRadarLayout({ radar, quadrants }: ShareableRadarLayoutProps) {
  const [hoveredEntryId, setHoveredEntryId] = useState<number | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<RadarEntry | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [currentRingSystem, setCurrentRingSystem] = useState<RingSystem>(radar.ringSystem || 'Standard');
  const [showLabels, setShowLabels] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const rings = RING_SYSTEMS[currentRingSystem];

  // Get entries from radar
  const entries = Array.isArray(radar.entries) ? radar.entries : [];

  // Filter by tags if active
  const filteredEntries =
    activeTags.length > 0 ? entries.filter((e) => e.tags.some((t) => activeTags.includes(t))) : entries;

  // Map entries to display ring based on ring system
  const displayEntries = filteredEntries.map((entry) => {
    let displayRing = entry.ring;
    if (currentRingSystem === 'TRL') {
      displayRing = entry.trl || (entry.ring.startsWith('TRL') ? entry.ring : 'TRL 1');
    } else if (currentRingSystem === 'Time-to-Impact') {
      displayRing = entry.timeToImpact || 'H3 (18+mo)';
    } else {
      displayRing = entry.hata || (!entry.ring.startsWith('TRL') ? entry.ring : 'Assess');
    }
    return { ...entry, ring: displayRing };
  });

  // Get all unique tags
  const allTags = Array.from(new Set(entries.flatMap((e) => e.tags)));

  const handleTagClick = (tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const handleClearTags = () => {
    setActiveTags([]);
  };

  return (
    <div className="w-full h-screen bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b flex items-center px-4 sm:px-6 justify-between bg-card shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-lg truncate">{radar.name}</h1>
          <Badge variant="secondary" className="gap-1 shrink-0">
            <Eye className="h-3 w-3" />
            Read-Only
          </Badge>
        </div>
        <div className="text-sm text-muted-foreground hidden sm:block">Shared via Radarist</div>
      </header>

      {/* Main Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-hidden">
        <Card className="h-full flex flex-col min-h-[560px] sm:min-h-[640px]">
          {/* Card Header with Ring System Selector, Legend, Labels, Search */}
          <CardHeader className="py-3 px-4 border-b shrink-0">
            <div className="flex items-center justify-between gap-4">
              {/* Left: Ring System Selector + Legend + Labels */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Layers className="h-4 w-4" />
                  <span className="hidden sm:inline">Ring System</span>
                </div>
                <Select value={currentRingSystem} onValueChange={(value) => setCurrentRingSystem(value as RingSystem)}>
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
                {/* Legend */}
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

              {/* Right: Search + Entry count */}
              <div className="flex items-center gap-3">
                {/* Search Input */}
                <div className="relative hidden md:block">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search entries..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-[180px] h-8 pl-8 text-sm"
                    aria-label="Search radar entries"
                  />
                </div>
                <div className="text-sm text-muted-foreground">
                  {filteredEntries.length} {filteredEntries.length === 1 ? 'entry' : 'entries'}
                </div>
              </div>
            </div>
          </CardHeader>

          {/* Radar Content */}
          <CardContent className="flex-1 flex items-center justify-center p-2 lg:p-4 min-h-0 overflow-hidden">
            <div className="relative w-full h-full flex items-center justify-center">
              <Radar
                entries={displayEntries}
                quadrants={quadrants}
                rings={rings as unknown as string[]}
                onEntryClick={setSelectedEntry}
                ringSystem={currentRingSystem}
                onRingSystemChange={setCurrentRingSystem}
                hoveredEntryId={hoveredEntryId}
                onEntryHover={setHoveredEntryId}
                readOnly={true}
                hideRingSystemSelector
                showLabels={showLabels}
                searchQuery={searchQuery}
              />
            </div>
          </CardContent>

          {/* Tags Filter Bar */}
          {allTags.length > 0 && (
            <div className="border-t px-4 py-3 shrink-0">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-medium text-muted-foreground shrink-0">Filter by Tags:</span>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.slice(0, 10).map((tag) => {
                    const isActive = activeTags.includes(tag);
                    return (
                      <Badge
                        key={tag}
                        variant={isActive ? 'default' : 'outline'}
                        className={cn(
                          'cursor-pointer text-xs font-normal transition-colors',
                          isActive
                            ? 'bg-primary hover:bg-primary/90 gap-1'
                            : 'hover:bg-accent hover:text-accent-foreground'
                        )}
                        onClick={() => handleTagClick(tag)}
                      >
                        {isActive && <Check className="h-3 w-3" />}
                        {tag}
                      </Badge>
                    );
                  })}
                  {allTags.length > 10 && (
                    <span className="text-xs text-muted-foreground">+{allTags.length - 10} more</span>
                  )}
                </div>
                {activeTags.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground ml-auto"
                    onClick={handleClearTags}
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Entry Detail Dialog (Read-Only) */}
      {selectedEntry && (
        <ResearchDialog
          entry={selectedEntry}
          isOpen={!!selectedEntry}
          onOpenChange={(open) => !open && setSelectedEntry(null)}
          onEdit={() => {}} // No-op for read-only
          rings={rings as unknown as string[]}
          onDelete={() => {}} // No-op
          onSaveAnalysis={() => {}} // No-op
          readOnly={true}
          radarId={radar.id}
        />
      )}
    </div>
  );
}
