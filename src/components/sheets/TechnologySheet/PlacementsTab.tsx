'use client';

import { Radio } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TechnologyRingBadge } from '@/components/cards/TechnologyCard';
import { cn } from '@/lib/utils';

import type { RadarPlacement } from '@/lib/types';

// ============================================================================
// PLACEMENTS TAB
// ============================================================================

interface PlacementsTabProps {
  placements: RadarPlacement[];
  onPlacementClick?: (placement: RadarPlacement) => void;
}

function PlacementsTab({ placements, onPlacementClick }: PlacementsTabProps) {
  if (placements.length === 0) {
    return (
      <div className="py-12 text-center">
        <Radio className="mx-auto h-12 w-12 text-muted-foreground/50" />
        <h3 className="mt-4 text-sm font-medium">Not on any radars yet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This technology hasn&apos;t been placed on any radar yet. Use the radar visualization to place it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        This technology appears on {placements.length} radar{placements.length !== 1 ? 's' : ''}.
      </p>

      <div className="space-y-2">
        {placements.map((placement) => (
          <Card
            key={placement.id}
            className={cn(
              'cursor-pointer hover:border-primary/60 transition-colors',
              onPlacementClick && 'cursor-pointer'
            )}
            onClick={() => onPlacementClick?.(placement)}
          >
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">{placement.radarId}</CardTitle>
                <TechnologyRingBadge ring={placement.ring} />
              </div>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Quadrant: {placement.quadrantName ?? placement.quadrantId}</span>
                {placement.status && <span>Status: {placement.status}</span>}
                {placement.movedFrom && <span className="text-amber-600">Moved from {placement.movedFrom}</span>}
              </div>
              {placement.rationale && (
                <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{placement.rationale}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export { PlacementsTab };
export type { PlacementsTabProps };
