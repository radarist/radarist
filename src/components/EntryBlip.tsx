'use client';

import * as React from 'react';
import type { RadarEntry } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { ArrowDown, ArrowUp, Clock, Gauge, Target } from 'lucide-react';

// Map TRL to ring equivalents for shape/color
const mapTRLToRing = (ring: string): string => {
  // If it's already a standard ring name, return it
  if (['Adopt', 'Trial', 'Assess', 'Hold'].includes(ring)) {
    return ring;
  }

  // Check if it's a TRL value
  if (ring.includes('TRL') || ring.includes('9') || ring.includes('8') || ring.includes('7')) {
    // TRL 7-9 = Adopt (most mature)
    if (ring.includes('9') || ring.includes('8') || ring.includes('7')) {
      return 'Adopt';
    }
  }
  if (ring.includes('6') || ring.includes('5') || ring.includes('4')) {
    // TRL 4-6 = Trial
    return 'Trial';
  }
  if (ring.includes('3') || ring.includes('2')) {
    // TRL 2-3 = Assess
    return 'Assess';
  }
  if (ring.includes('1')) {
    // TRL 1 = Hold (least mature)
    return 'Hold';
  }

  // Default fallback
  return 'Assess';
};

// Ring order: center (most mature) to outer (least mature)
const RING_ORDER = ['Adopt', 'Trial', 'Assess', 'Hold'];

/**
 * Get the ring index for ordering comparison.
 * Lower index = more mature (closer to center).
 */
const getRingIndex = (ring: string): number => {
  const mapped = mapTRLToRing(ring);
  const index = RING_ORDER.indexOf(mapped);
  return index >= 0 ? index : 2; // Default to Assess position
};

/**
 * Determine movement direction between two rings.
 * Returns 'inward' (toward center), 'outward' (away from center), or null.
 */
const getMovementDirection = (fromRing: string, toRing: string): 'inward' | 'outward' | null => {
  const fromIndex = getRingIndex(fromRing);
  const toIndex = getRingIndex(toRing);
  if (fromIndex === toIndex) return null;
  return toIndex < fromIndex ? 'inward' : 'outward';
};

/**
 * Check if an entry has moved recently (within 30 days).
 * Returns movement info or null if no recent movement.
 */
const getRecentMovement = (entry: RadarEntry): { direction: 'inward' | 'outward'; fromRing: string } | null => {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Check history array for recent ring changes
  if (entry.history && entry.history.length >= 2) {
    // Sort by date descending to get most recent first
    const sortedHistory = [...entry.history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const current = sortedHistory[0];
    const previous = sortedHistory[1];

    if (new Date(current.date).getTime() > thirtyDaysAgo) {
      const direction = getMovementDirection(previous.ring, current.ring);
      if (direction) {
        return { direction, fromRing: previous.ring };
      }
    }
  }

  return null;
};

// Movement indicator arrow component
const MovementIndicator = ({ direction }: { direction: 'inward' | 'outward' }) => {
  const isInward = direction === 'inward';
  const Icon = isInward ? ArrowUp : ArrowDown;
  const color = isInward ? 'hsl(var(--radar-adopt))' : 'hsl(var(--radar-hold))'; // inward=adopt, outward=hold

  return (
    <div className="absolute -top-2 -right-2 z-10 animate-pulse" title={isInward ? 'Moved inward' : 'Moved outward'}>
      <div
        className="flex items-center justify-center w-4 h-4 rounded-full shadow-md"
        style={{ backgroundColor: color }}
      >
        <Icon className="h-2.5 w-2.5 text-white" strokeWidth={3} />
      </div>
    </div>
  );
};

interface EntryBlipProps {
  /** The radar entry data. */
  entry: RadarEntry;
  /** The position (top, left in %) for the blip. */
  position: { top: string; left: string };
  /** Whether the blip is currently hovered. */
  isHovered: boolean;
  /** Whether the blip is in drag/edit mode. */
  isEditing?: boolean;
  /** Callback when hovered. */
  onHover: (id: number | null) => void;
  /** Callback when clicked. */
  onClick: () => void;
  /** Callback for context menu (right-click). */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Callback when drag starts (if editing). */
  onDragStart?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Search query to filter visibility/opacity. */
  searchQuery?: string;
}

// Ring color mapping - uses HATA value for consistent, theme-aware blip colors
// (sourced from the --radar-* tokens in globals.css so blips re-theme in dark).
const getRingColor = (hataValue: string) => {
  switch (hataValue) {
    case 'Adopt':
      return 'hsl(var(--radar-adopt))'; // emerald
    case 'Trial':
      return 'hsl(var(--radar-trial))'; // blue
    case 'Assess':
      return 'hsl(var(--radar-assess))'; // amber
    case 'Hold':
      return 'hsl(var(--radar-hold))'; // red
    default:
      return 'hsl(var(--radar-ring))'; // neutral
  }
};

// Render the appropriate shape based on HATA value (not current ring system)
const BlipShape = ({ hataValue, color }: { hataValue: string; color: string }) => {
  const size = 17; // Size in pixels (reduced 30% from 24)
  const strokeWidth = 2;

  // Use HATA value directly for shape determination
  const mappedRing = hataValue;

  // Common SVG properties
  const shapeProps = {
    fill: color,
    stroke: 'hsl(var(--background))',
    strokeWidth: strokeWidth,
  };

  if (mappedRing === 'Adopt') {
    // Circle
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="drop-shadow-lg">
        <circle cx="12" cy="12" r="10" {...shapeProps} />
      </svg>
    );
  } else if (mappedRing === 'Trial') {
    // Hexagon
    const points = '12,2 21.4,7 21.4,17 12,22 2.6,17 2.6,7';
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="drop-shadow-lg">
        <polygon points={points} {...shapeProps} />
      </svg>
    );
  } else if (mappedRing === 'Assess') {
    // Triangle (pointing up)
    const points = '12,3 22,21 2,21';
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="drop-shadow-lg">
        <polygon points={points} {...shapeProps} />
      </svg>
    );
  } else if (mappedRing === 'Hold') {
    // Square with rounded corners
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="drop-shadow-lg">
        <rect x="3" y="3" width="18" height="18" rx="2" {...shapeProps} />
      </svg>
    );
  }

  // Default: Circle
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="drop-shadow-lg">
      <circle cx="12" cy="12" r="10" {...shapeProps} />
    </svg>
  );
};

/**
 * Renders a single technology "blip" on the radar.
 * - Shape and color are determined by the ring/status.
 * - Displays a tooltip with detailed info on hover.
 * - Supports drag-and-drop positioning in edit mode.
 * - Highlights when hovered or matching a search query.
 *
 * @param props - Component props.
 * @returns The rendered blip.
 */
export function EntryBlip({
  entry,
  position,
  isHovered,
  isEditing = false,
  onHover,
  onClick,
  onContextMenu,
  onDragStart,
  searchQuery = '',
}: EntryBlipProps) {
  const isSearchMatch = searchQuery
    ? entry.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()))
    : true;

  // Use HATA value for consistent shape/color, fallback to mapping from ring if not set
  const hataValue = entry.hata || mapTRLToRing(entry.ring);
  const color = getRingColor(hataValue);
  const recentMovement = getRecentMovement(entry);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              'absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-200 focus:outline-none',
              isEditing && 'cursor-move z-50 animate-pulse',
              isHovered && !isEditing && 'scale-125 z-40'
            )}
            style={{
              top: position.top,
              left: position.left,
              opacity: isSearchMatch ? 1 : 0.2,
            }}
            onMouseEnter={() => onHover(entry.id)}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu?.(e);
            }}
            onMouseDown={(e) => {
              if (e.button === 0 && isEditing && onDragStart) {
                e.stopPropagation();
                onDragStart(e);
              }
            }}
            aria-label={entry.name}
            aria-pressed={isEditing}
          >
            <div className="relative">
              {/* Movement indicator */}
              {recentMovement && <MovementIndicator direction={recentMovement.direction} />}
              {/* Glow effect */}
              <div
                className={cn('absolute inset-0 blur-md opacity-60 transition-opacity', isHovered && 'opacity-100')}
                style={{
                  filter: `drop-shadow(0 0 8px ${color})`,
                }}
              >
                <BlipShape hataValue={hataValue} color={color} />
              </div>
              {/* Main shape */}
              <div className="relative">
                <BlipShape hataValue={hataValue} color={color} />
              </div>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs bg-popover border-border text-popover-foreground shadow-2xl p-0 overflow-hidden z-50"
          sideOffset={12}
        >
          <div className="h-1 w-full" style={{ backgroundColor: color }} />
          <div className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-bold text-base leading-tight">{entry.name}</p>
              <Badge variant="outline" className="shrink-0 text-[0.6rem] px-1.5 py-0 h-4 uppercase">
                {entry.status}
              </Badge>
            </div>

            {entry.description && (
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{entry.description}</p>
            )}

            {/* Three-Dimensional Assessment Display */}
            <div className="space-y-1.5 pt-1">
              {/* Primary Ring (current view) */}
              <div className="flex items-center gap-2">
                <Target className="h-3 w-3 text-muted-foreground shrink-0" />
                <div
                  className="px-2 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-wider border"
                  style={{
                    color: color,
                    borderColor: `${color}40`,
                    backgroundColor: `${color}15`,
                  }}
                >
                  {entry.ring}
                </div>
                {/* Movement info */}
                {recentMovement && (
                  <div
                    className={cn(
                      'flex items-center gap-1 text-[0.6rem] font-medium',
                      recentMovement.direction === 'inward' ? 'text-green-500' : 'text-red-500'
                    )}
                  >
                    {recentMovement.direction === 'inward' ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : (
                      <ArrowDown className="h-3 w-3" />
                    )}
                    <span>from {recentMovement.fromRing}</span>
                  </div>
                )}
              </div>

              {/* Additional Dimensions Row */}
              <div className="flex items-center gap-3 text-[0.6rem]">
                {/* TRL Score */}
                {entry.trl && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Gauge className="h-3 w-3 shrink-0" />
                    <span>{entry.trl}</span>
                  </div>
                )}
                {/* Time-to-Impact */}
                {entry.timeToImpact && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    <span>{entry.timeToImpact}</span>
                  </div>
                )}
              </div>
            </div>

            {entry.tags && entry.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {entry.tags.slice(0, 4).map((tag, idx) => (
                  <span key={idx} className="text-[0.6rem] px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {isEditing && (
              <p className="text-xs text-primary mt-2 pt-2 border-t border-border">Right-click to exit edit mode</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
