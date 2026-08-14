'use client';

import * as React from 'react';
import type { RadarEntry, QuadrantConfig } from '@/lib/types';
import { EntryBlip } from './EntryBlip';
import {
  calculateRadarPositions,
  getRingRadii,
  getQuadrantLabelPosition,
  getSliceDividerSegment,
} from '@/lib/radar-utils';
import {
  LABEL_OFFSET_PX,
  splitLabelLines,
  estimateLabelBoxPct,
  resolveLabelCollisions,
  type LabelCollisionItem,
  type LabelSide,
} from '@/lib/radar-label-layout';
import { computeExportPadding, resolveEffectiveBackgroundColor } from '@/lib/radar-export';

import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  TrendingUp,
  Minus,
  TrendingDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toPng } from 'html-to-image';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { RingSystem } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/Radar');

interface RadarPosition {
  x: number;
  y: number;
}

interface DragStartSnapshot {
  id: number;
  position: RadarPosition | null;
}

function getClampedRadarPosition(rect: DOMRect, clientX: number, clientY: number): RadarPosition | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  const x = ((clientX - rect.left) / rect.width) * 100;
  const y = ((clientY - rect.top) / rect.height) * 100;

  return {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y)),
  };
}

/**
 * Popover legend showing radar visual encoding explanations.
 * Exported for use in the radar header bar.
 */
export function RadarLegend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="flex items-center gap-1.5 px-3 h-8 text-xs font-medium">
          Legend
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3 space-y-3 min-w-[180px]">
        {/* Ring Shapes */}
        <div className="space-y-1.5">
          <span className="text-[0.65rem] font-semibold text-muted-foreground uppercase tracking-wider">Rings</span>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="8" fill="hsl(var(--radar-adopt))" />
              </svg>
              <span>Adopt</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24">
                <polygon points="12,2 21.4,7 21.4,17 12,22 2.6,17 2.6,7" fill="hsl(var(--radar-trial))" />
              </svg>
              <span>Trial</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24">
                <polygon points="12,4 20,20 4,20" fill="hsl(var(--radar-assess))" />
              </svg>
              <span>Assess</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2" fill="hsl(var(--radar-hold))" />
              </svg>
              <span>Hold</span>
            </div>
          </div>
        </div>

        {/* Movement Indicators */}
        <div className="space-y-1.5">
          <span className="text-[0.65rem] font-semibold text-muted-foreground uppercase tracking-wider">
            Movement (30 days)
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <div className="flex items-center justify-center w-4 h-4 rounded-full bg-green-500">
                <ArrowUp className="h-2.5 w-2.5 text-white" strokeWidth={3} />
              </div>
              <span>Moved inward</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <div className="flex items-center justify-center w-4 h-4 rounded-full bg-red-500">
                <ArrowDown className="h-2.5 w-2.5 text-white" strokeWidth={3} />
              </div>
              <span>Moved outward</span>
            </div>
          </div>
        </div>

        {/* Status */}
        <div className="space-y-1.5">
          <span className="text-[0.65rem] font-semibold text-muted-foreground uppercase tracking-wider">Status</span>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <TrendingUp className="h-3.5 w-3.5 text-green-500" />
              <span>Trending</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Minus className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Stable</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <TrendingDown className="h-3.5 w-3.5 text-red-500" />
              <span>Fading</span>
            </div>
          </div>
        </div>

        {/* Time-to-Impact */}
        <div className="space-y-1.5">
          <span className="text-[0.65rem] font-semibold text-muted-foreground uppercase tracking-wider">
            Time-to-Impact
          </span>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 text-[0.6rem] font-bold">H1</span>
              <span>0-6 months</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600 text-[0.6rem] font-bold">H2</span>
              <span>6-18 months</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-600 text-[0.6rem] font-bold">H3</span>
              <span>18+ months</span>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface RadarProps {
  /** List of radar entries to display. */
  entries: RadarEntry[];
  /** Canonical quadrant configs for the radar (1..8 entries). */
  quadrants: QuadrantConfig[];
  /** List of rings to display (Standard or TRL). */
  rings: string[];
  /** The currently active ring system. */
  ringSystem: RingSystem;
  /** Callback to change the ring system. */
  onRingSystemChange: (system: RingSystem) => void;
  /** ID of the hovered entry. */
  hoveredEntryId: number | null;
  /** Callback to handle hover events. */
  onEntryHover: (id: number | null) => void;
  /** Callback to handle entry clicks. */
  onEntryClick: (entry: RadarEntry) => void;
  /** Callback when an entry is dragged to a new position. */
  onEntryDragEnd?: (id: number, position: { x: number; y: number }) => void;
  /** If true, disables editing/dragging. */
  readOnly?: boolean;
  // New Props
  /** Filter entries by search query. */
  searchQuery?: string;
  /** Active filters for quadrants, rings, and statuses. */
  activeFilters?: { quadrants: string[]; rings: string[]; statuses: string[] };
  /** Whether strategy mode is active. */
  isStrategyMode?: boolean;
  /** ID of the selected strategy for alignment visualization. */
  selectedStrategyId?: string;
  /** Hide the internal ring system selector (when controlled externally). */
  hideRingSystemSelector?: boolean;
  /** Show labels below each blip. */
  showLabels?: boolean;
}

/**
 * The core Radar visualization component.
 * - Renders the radar background (rings, quadrants).
 * - Positions entries using a force-directed layout or manual coordinates.
 * - Supports pan and zoom (react-zoom-pan-pinch).
 * - Allows dragging entries to manually reposition them (in edit mode).
 * - Exports the radar view to an image.
 *
 * @param props - Component props.
 * @returns The interactive radar visualization.
 */
export function Radar({
  entries,
  quadrants,
  rings,
  ringSystem,
  onRingSystemChange,
  hoveredEntryId,
  onEntryHover,
  onEntryClick,
  onEntryDragEnd,
  readOnly = false,
  searchQuery = '',
  activeFilters = { quadrants: [], rings: [], statuses: [] },
  isStrategyMode: _isStrategyMode = false,
  selectedStrategyId: _selectedStrategyId,
  hideRingSystemSelector = false,
  showLabels = false,
}: RadarProps) {
  const [editingBlipId, setEditingBlipId] = React.useState<number | null>(null);
  const [manualPositions, setManualPositions] = React.useState<Map<number, { x: number; y: number }>>(new Map());
  const [isDragging, setIsDragging] = React.useState(false);
  const radarRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const hasDraggedRef = React.useRef(false);
  const activeDragIdRef = React.useRef<number | null>(null);
  const dragStartPointerRef = React.useRef<{ clientX: number; clientY: number } | null>(null);
  const dragStartSnapshotRef = React.useRef<DragStartSnapshot | null>(null);
  const latestDragPositionRef = React.useRef<(RadarPosition & { id: number }) | null>(null);
  const suppressedClickIdRef = React.useRef<number | null>(null);
  const clickSuppressionTimerRef = React.useRef<number | null>(null);
  const onEntryDragEndRef = React.useRef(onEntryDragEnd);
  const readOnlyRef = React.useRef(readOnly);
  onEntryDragEndRef.current = onEntryDragEnd;
  readOnlyRef.current = readOnly;
  // Track previous entries to detect actual changes (not just re-renders)
  const prevEntriesRef = React.useRef<string>('');
  // Track radar size to ensure it stays square
  const [radarSize, setRadarSize] = React.useState<number | null>(null);

  // ResizeObserver to keep radar square based on available space
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const { width, height } = container.getBoundingClientRect();
      // Use the smaller dimension, capped at 800px, with 95% of available space
      const size = Math.min(width * 0.95, height * 0.95, 800);
      setRadarSize(size);
    };

    // Initial size calculation
    updateSize();

    // Observe container size changes
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Initialize manual positions from entries - only when entries actually change
  React.useEffect(() => {
    // Create a stable key from entry IDs and their stored positions
    const entriesKey = entries
      .map((e) => `${e.id}:${e.x ?? ''}:${e.y ?? ''}`)
      .sort()
      .join('|');

    // Only update if entries actually changed (not just re-render)
    if (entriesKey !== prevEntriesRef.current) {
      prevEntriesRef.current = entriesKey;

      setManualPositions((prev) => {
        const newPositions = new Map(prev);
        entries.forEach((entry) => {
          // Only set position from entry data if we don't have a local override
          // OR if the entry's stored position changed (saved to DB)
          if (entry.x !== undefined && entry.y !== undefined) {
            const existing = prev.get(entry.id);
            const entryPosChanged =
              !existing || Math.abs(existing.x - entry.x) > 0.1 || Math.abs(existing.y - entry.y) > 0.1;

            // If entry has stored position and it's different from what we have,
            // use the stored position (this handles DB saves)
            if (entryPosChanged) {
              newPositions.set(entry.id, { x: entry.x, y: entry.y });
            }
          }
        });
        return newPositions;
      });
    }
  }, [entries]);

  const positionedEntries = React.useMemo(() => {
    // 1. Filter entries first — `activeFilters.quadrants` carries display names
    // (for stable share URLs), so resolve each name to a stable `quadrantId`
    // against the current radar's config and compare by id.
    const activeQuadrantIdSet = new Set<string>();
    if (activeFilters.quadrants.length > 0) {
      const lowerNames = new Set(activeFilters.quadrants.map((n) => n.toLowerCase()));
      for (const q of quadrants) {
        if (lowerNames.has(q.name.toLowerCase())) {
          activeQuadrantIdSet.add(q.id);
        }
      }
    }

    // Race-window guard: if the user just saved a settings change that
    // removed a quadrant, the legacy data hook has already flipped
    // `quadrants` to the new configs but the decoupled hook's TanStack Query
    // cache may still hold placements whose `quadrantId` references the
    // removed quadrant. Those entries will resolve on the next refetch tick
    // — hide them NOW so we don't render them briefly at slice 0 and don't
    // trip the defensive-guard log inside `calculateRadarPositions`.
    const validQuadrantIdSet = new Set(quadrants.map((q) => q.id));

    const filtered = entries.filter((entry) => {
      // Skip stale entries whose quadrantId no longer matches any current
      // quadrant. This is a normal transient state during shrink-with-orphan
      // saves; the blip reappears on the next subscription tick.
      if (!validQuadrantIdSet.has(entry.quadrantId)) return false;
      if (activeQuadrantIdSet.size > 0 && !activeQuadrantIdSet.has(entry.quadrantId)) return false;
      if (activeFilters.rings.length > 0 && !activeFilters.rings.includes(entry.ring)) return false;
      if (activeFilters.statuses.length > 0 && !activeFilters.statuses.includes(entry.status)) return false;
      return true;
    });

    const positions = calculateRadarPositions(filtered, quadrants, rings, 'radar-seed');

    const placed = filtered.map((entry) => {
      const currentPosKey = `${entry.id}-${entry.quadrantId}-${entry.ring}`;
      // Fallback if position is missing (shouldn't happen with correct logic)
      const autoPos = positions.get(currentPosKey) || { top: '50%', left: '50%' };

      // Check for manual position override
      const manualPos = manualPositions.get(entry.id);

      let finalPos = autoPos;
      if (manualPos) {
        finalPos = { top: `${manualPos.y}%`, left: `${manualPos.x}%` };
      }

      return {
        ...entry,
        position: finalPos,
        labelLines: [] as string[],
        labelSide: 'below' as LabelSide,
      };
    });

    if (!showLabels) return placed;

    // Label collision pass — each label gets an approximate bounding box
    // (derived from its wrapped line lengths + font metrics) and overlapping
    // pairs are separated by deterministic radial/angular nudges of the BLIP
    // positions inside their (quadrant, ring) band, falling back to flipping
    // a label above its blip. Manually-dragged blips are treated as pinned.
    const layoutSizePx = radarSize && radarSize > 0 ? radarSize : 800;
    const orderByQuadrantId = new Map<string, number>();
    quadrants.forEach((q, i) => orderByQuadrantId.set(q.id, i));

    const labeled = placed.map((p) => ({ ...p, labelLines: splitLabelLines(p.name) }));

    const collisionItems: LabelCollisionItem[] = labeled.map((p) => {
      const box = estimateLabelBoxPct(p.labelLines, layoutSizePx);
      const radii = getRingRadii(p.ring, rings);
      return {
        id: p.id,
        xPct: Number.parseFloat(p.position.left),
        yPct: Number.parseFloat(p.position.top),
        labelWidthPct: box.widthPct,
        labelHeightPct: box.heightPct,
        fixed: manualPositions.has(p.id),
        quadrantOrder: orderByQuadrantId.get(p.quadrantId) ?? 0,
        ringMinRadius: radii.min,
        ringMaxRadius: radii.max,
      };
    });

    const resolved = resolveLabelCollisions(collisionItems, {
      quadrantCount: Math.max(1, quadrants.length),
      labelOffsetPct: (LABEL_OFFSET_PX / layoutSizePx) * 100,
    });

    return labeled.map((p) => {
      const r = resolved.get(String(p.id));
      if (!r) return p;
      return {
        ...p,
        position: { top: `${r.yPct}%`, left: `${r.xPct}%` },
        labelSide: r.labelSide,
      };
    });
  }, [entries, quadrants, manualPositions, rings, activeFilters, showLabels, radarSize]);

  const getRingLabelPosition = (index: number) => {
    const ringName = rings[index];
    const { min, max } = getRingRadii(ringName, rings);
    const radiusCenter = (min + max) / 2;
    return 50 - radiusCenter / 2;
  };

  const clearClickSuppression = React.useCallback(() => {
    suppressedClickIdRef.current = null;
    if (clickSuppressionTimerRef.current !== null) {
      window.clearTimeout(clickSuppressionTimerRef.current);
      clickSuppressionTimerRef.current = null;
    }
  }, []);

  const handleBlipContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    if (readOnly) return;

    clearClickSuppression();

    if (editingBlipId === id) {
      // Exit edit mode
      setEditingBlipId(null);
    } else {
      // Enter edit mode
      setEditingBlipId(id);
    }
  };

  const handleDragStart = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (readOnly || editingBlipId === null) return;

    clearClickSuppression();
    activeDragIdRef.current = editingBlipId;
    dragStartPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    dragStartSnapshotRef.current = {
      id: editingBlipId,
      position: manualPositions.get(editingBlipId) ?? null,
    };
    latestDragPositionRef.current = null;
    setIsDragging(true);
    hasDraggedRef.current = false;
  };

  const updateDragPosition = React.useCallback((e: MouseEvent) => {
    const activeId = activeDragIdRef.current;
    const startPointer = dragStartPointerRef.current;
    const radar = radarRef.current;
    if (readOnlyRef.current || activeId === null || !startPointer || !radar) return;

    if (!hasDraggedRef.current && e.clientX === startPointer.clientX && e.clientY === startPointer.clientY) {
      return;
    }

    const position = getClampedRadarPosition(radar.getBoundingClientRect(), e.clientX, e.clientY);
    if (!position) return;

    hasDraggedRef.current = true;
    latestDragPositionRef.current = { id: activeId, ...position };

    setManualPositions((prev) => {
      const newMap = new Map(prev);
      newMap.set(activeId, position);
      return newMap;
    });
  }, []);

  const clearActiveDrag = React.useCallback(() => {
    activeDragIdRef.current = null;
    dragStartPointerRef.current = null;
    dragStartSnapshotRef.current = null;
    latestDragPositionRef.current = null;
    hasDraggedRef.current = false;
    setIsDragging(false);
  }, []);

  const cancelActiveDrag = React.useCallback(() => {
    const activeId = activeDragIdRef.current;
    if (activeId === null) return;

    const snapshot = dragStartSnapshotRef.current;
    const moved = hasDraggedRef.current;
    clearActiveDrag();
    clearClickSuppression();

    if (moved && snapshot?.id === activeId) {
      setManualPositions((prev) => {
        const next = new Map(prev);
        if (snapshot.position) {
          next.set(activeId, snapshot.position);
        } else {
          next.delete(activeId);
        }
        return next;
      });
    }
  }, [clearActiveDrag, clearClickSuppression]);

  const handleWindowMouseUp = React.useCallback((e: MouseEvent) => {
    const activeId = activeDragIdRef.current;
    if (activeId === null) return;

    if (readOnlyRef.current) {
      cancelActiveDrag();
      return;
    }

    updateDragPosition(e);
    const moved = hasDraggedRef.current;
    const latestPosition = latestDragPositionRef.current;

    // Clear the active drag before notifying the caller so a repeated mouseup
    // or synchronous re-render cannot persist the same drag twice.
    clearActiveDrag();

    if (!moved || latestPosition?.id !== activeId) return;

    suppressedClickIdRef.current = activeId;
    clickSuppressionTimerRef.current = window.setTimeout(() => {
      suppressedClickIdRef.current = null;
      clickSuppressionTimerRef.current = null;
    }, 0);
    onEntryDragEndRef.current?.(activeId, { x: latestPosition.x, y: latestPosition.y });
  }, [cancelActiveDrag, clearActiveDrag, updateDragPosition]);

  const handleEntryClick = React.useCallback((entry: RadarEntry) => {
    const suppressClick = suppressedClickIdRef.current === entry.id;
    clearClickSuppression();
    if (suppressClick) return;

    onEntryClick(entry);
  }, [clearClickSuppression, onEntryClick]);

  const handleExport = React.useCallback(() => {
    const node = radarRef.current;
    if (node === null) {
      return;
    }

    try {
      // The radar square is transparent and inherits the page background.
      // Without an explicit fill the PNG exports with full transparency and
      // reads as a dark-mode image in most viewers. Resolve the ACTIVE
      // theme's effective background (computed → CSS vars already resolved)
      // so the export matches what the user sees.
      const backgroundColor = resolveEffectiveBackgroundColor(node);

      // Quadrant labels intentionally overflow the radar square (anchored
      // just outside the outer ring, growing outward). Measure their real
      // overflow and grow the export canvas so they render fully.
      const padding = computeExportPadding(node, '[data-radar-quadrant-label]');
      const width = node.offsetWidth + padding.left + padding.right;
      const height = node.offsetHeight + padding.top + padding.bottom;

      toPng(node, {
        cacheBust: true,
        pixelRatio: 2,
        skipFonts: true, // Skip font embedding to avoid CORS issues with external stylesheets
        backgroundColor,
        width,
        height,
        style: {
          // Recenter the radar inside the padded canvas; pin the clone's
          // size so the '95%' inline fallback can't collapse off-document.
          transform: `translate(${padding.left}px, ${padding.top}px)`,
          transformOrigin: 'top left',
          width: `${node.offsetWidth}px`,
          height: `${node.offsetHeight}px`,
        },
      })
        .then((dataUrl) => {
          const link = document.createElement('a');
          link.download = 'tech-radar.png';
          link.href = dataUrl;
          link.click();
        })
        .catch((err) => {
          log.error('Failed to export radar image', err instanceof Error ? err : undefined);
        });
    } catch (err) {
      log.error('Failed to prepare radar export', err instanceof Error ? err : undefined);
    }
  }, [radarRef]);

  // Native capture listeners keep an active drag alive outside the radar and
  // make release/cancellation independent from React event boundaries.
  React.useEffect(() => {
    if (!isDragging) return;

    window.addEventListener('mousemove', updateDragPosition, true);
    window.addEventListener('mouseup', handleWindowMouseUp, true);
    window.addEventListener('blur', cancelActiveDrag, true);

    return () => {
      window.removeEventListener('mousemove', updateDragPosition, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('blur', cancelActiveDrag, true);
    };
  }, [cancelActiveDrag, handleWindowMouseUp, isDragging, updateDragPosition]);

  React.useEffect(() => {
    return () => {
      activeDragIdRef.current = null;
      dragStartPointerRef.current = null;
      dragStartSnapshotRef.current = null;
      latestDragPositionRef.current = null;
      hasDraggedRef.current = false;
      clearClickSuppression();
    };
  }, [clearClickSuppression]);

  React.useEffect(() => {
    if (readOnly) cancelActiveDrag();
  }, [cancelActiveDrag, readOnly]);

  return (
    <div className="relative w-full h-full overflow-hidden">
      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={4}
        centerOnInit
        wheel={{ step: 0.1, disabled: isDragging }} // Disable zoom while dragging
        panning={{ disabled: isDragging }} // Disable pan while dragging
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            {/* Ring System Selector - Top Left (hidden when controlled externally) */}
            {!hideRingSystemSelector && (
              <div className="absolute top-4 left-4 z-50 w-[140px]">
                <Select value={ringSystem} onValueChange={(value) => onRingSystemChange(value as RingSystem)}>
                  <SelectTrigger className="h-8 bg-background/80 backdrop-blur-sm border shadow-sm hover:bg-background/90">
                    <SelectValue placeholder="System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Standard">HATA</SelectItem>
                    <SelectItem value="TRL">TRL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Controls Overlay - Vertical tool rail on the right, centered */}
            <div className="absolute right-4 top-1/2 -translate-y-1/2 z-50 flex flex-col gap-2 rounded-xl border border-border bg-card/80 backdrop-blur-sm p-1.5 shadow-sm">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-lg border-border/60 bg-background/40 hover:bg-accent/40"
                      onClick={() => zoomIn()}
                      aria-label="Zoom in"
                    >
                      <ZoomIn className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Zoom in</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-lg border-border/60 bg-background/40 hover:bg-accent/40"
                      onClick={() => zoomOut()}
                      aria-label="Zoom out"
                    >
                      <ZoomOut className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Zoom out</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-lg border-border/60 bg-background/40 hover:bg-accent/40"
                      onClick={() => resetTransform()}
                      aria-label="Reset view"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Reset view</TooltipContent>
                </Tooltip>

                <div className="h-px w-full bg-border my-0.5" />

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 rounded-lg border-border/60 bg-background/40 hover:bg-accent/40"
                      onClick={handleExport}
                      aria-label="Export to image"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Export to image</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <TransformComponent
              wrapperClass="!w-full !h-full"
              contentClass="!w-full !h-full flex items-center justify-center"
            >
              {/* Radar container - sized to fill 95% of available space with margin for zoom controls */}
              <div ref={containerRef} className="relative flex items-center justify-center w-full h-full">
                <div
                  ref={radarRef}
                  data-testid="radar-canvas"
                  className="relative p-6 lg:p-10"
                  style={{
                    width: radarSize ? `${radarSize}px` : '95%',
                    height: radarSize ? `${radarSize}px` : '95%',
                    maxWidth: '800px',
                    maxHeight: '800px',
                  }}
                >
                  {/* Background with subtle glow matching ring colors */}
                  <div className="absolute inset-0 rounded-full bg-gradient-radial from-background via-background to-foreground/5 opacity-30 pointer-events-none" />

                  <svg
                    viewBox="0 0 100 100"
                    className="absolute inset-0 w-full h-full overflow-visible"
                    aria-hidden="true"
                  >
                    {/* Slice dividers — one radial line per slice boundary.
                        The first divider sits at math 90° (screen top); the
                        rest advance clockwise by 360°/N. For N=4 this puts
                        dividers at the cardinal axes (top/right/bottom/left). */}
                    {quadrants.length >= 2 &&
                      Array.from({ length: quadrants.length }).map((_, i) => {
                        const seg = getSliceDividerSegment(i, quadrants.length);
                        if (!seg) return null;
                        return (
                          <line
                            key={`divider-${i}`}
                            x1={seg.x1}
                            y1={seg.y1}
                            x2={seg.x2}
                            y2={seg.y2}
                            stroke="hsl(var(--border))"
                            strokeWidth="0.2"
                            className="opacity-40"
                          />
                        );
                      })}

                    {/* Rings — neutral token strokes so the colored blips lead
                        (premium "analyst instrument" look). Re-themes via --radar-ring;
                        also removes the old fragile ringName.includes('9'/'6'/...) matching. */}
                    {rings.map((ringName, index) => {
                      const { max } = getRingRadii(ringName, rings);
                      return (
                        <circle
                          key={index}
                          cx="50"
                          cy="50"
                          r={max / 2}
                          fill="none"
                          stroke="hsl(var(--radar-ring))"
                          strokeWidth="0.3"
                          strokeOpacity="0.35"
                          className="transition-all duration-500"
                        />
                      );
                    })}

                    {/* Center Point */}
                    <circle cx="50" cy="50" r="0.3" fill="hsl(var(--radar-ring))" className="opacity-80" />
                  </svg>

                  {/* DO NOT CHANGE THIS PART A - BEGIN */}

                  {/* Labels Container */}
                  <div className="absolute inset-0 pointer-events-none p-4 lg:p-12">
                    {/* Ring Labels - Neon Pills - Positioned inside each ring band */}
                    {rings.map((ring, index) => {
                      const pos = getRingLabelPosition(index);

                      return (
                        <div
                          key={ring}
                          className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center pointer-events-none z-10"
                          style={{ top: `${pos}%`, transform: 'translate(-50%, -50%)' }}
                        >
                          <span className="text-[1.5rem] md:text-[1.5rem] font-black uppercase tracking-tighter px-3 py-1 opacity-[0.12] select-none whitespace-nowrap text-muted-foreground">
                            {ring}
                          </span>
                        </div>
                      );
                    })}
                    {/* DO NOT CHANGE THIS PART A - END */}
                  </div>
                  {/* Quadrant Labels — sit OUTSIDE the ring circle in their
                      own unpadded wrapper so the anchor percentage matches
                      the SVG coordinate space exactly. The label's inner
                      corner/edge is placed exactly on the anchor via the
                      octant-based transform from `getQuadrantLabelPosition`,
                      so a wide label at a diagonal (e.g. "Infrastructure &
                      Hardware") has its bottom-left corner touching the ring
                      and grows up-and-right into the padding zone. */}
                  <div className="pointer-events-none absolute inset-0 z-10">
                    {quadrants.length > 0 &&
                      quadrants.map((config, i) => {
                        const pos = getQuadrantLabelPosition(i, quadrants.length);
                        const align = pos.textAlign;
                        return (
                          <div
                            key={config.id}
                            data-radar-quadrant-label=""
                            className="absolute select-none"
                            style={{
                              top: pos.top,
                              left: pos.left,
                              transform: pos.transform,
                              maxWidth: '40%',
                              textAlign: align,
                            }}
                            role="img"
                            aria-label={`Quadrant ${config.name}, ${i + 1} of ${quadrants.length}`}
                          >
                            <span className="block text-sm md:text-base font-semibold text-foreground/80 tracking-tight px-1 leading-tight">
                              {config.name}
                            </span>
                          </div>
                        );
                      })}
                  </div>

                  {/* Blips Layer */}
                  <div className="absolute inset-0 p-4 lg:p-12 z-20">
                    {positionedEntries.map((entry, index) => (
                      <React.Fragment key={`${entry.id}-${index}`}>
                        <EntryBlip
                          entry={entry}
                          position={entry.position}
                          isHovered={hoveredEntryId === entry.id}
                          isEditing={editingBlipId === entry.id}
                          onHover={onEntryHover}
                          onClick={() => handleEntryClick(entry)}
                          onContextMenu={(e) => handleBlipContextMenu(e, entry.id)}
                          onDragStart={handleDragStart}
                          searchQuery={searchQuery}
                        />
                        {/* Label below (or above, post collision pass) the blip —
                            up to two centered lines, ellipsized only past line 2 */}
                        {showLabels && entry.labelLines.length > 0 && (
                          <div
                            className="absolute pointer-events-none select-none"
                            style={{
                              top: entry.position.top,
                              left: entry.position.left,
                              transform:
                                entry.labelSide === 'above'
                                  ? `translate(-50%, calc(-100% - ${LABEL_OFFSET_PX}px))`
                                  : `translate(-50%, ${LABEL_OFFSET_PX}px)`,
                            }}
                          >
                            <span className="block text-center text-[9px] leading-[1.4] font-medium text-foreground/70 bg-background/20 px-1 py-0.5 rounded">
                              {entry.labelLines.map((line, lineIndex) => (
                                <span key={lineIndex} className="block whitespace-nowrap">
                                  {line}
                                </span>
                              ))}
                            </span>
                          </div>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
