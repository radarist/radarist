/**
 * @file RadarPageHeader.tsx
 * @description Header for the Tech Radar page — title plus the radar
 * selector/action toolbar (radar select, manage dropdown, share, settings, add
 * entry). Extracted from app/radar/page.tsx (ARCH-008) so the page owns
 * composition and layout while this component owns the toolbar's markup and its
 * per-control enable/disable rules. All labels, tooltips, aria-labels and the
 * `__create__`-is-an-action behaviour are preserved from the inline version.
 */

import { Plus, Settings, Share2, MoreHorizontal, PencilLine, Trash2 } from 'lucide-react';
import type { RadarData } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface RadarPageHeaderProps {
  /** Radars to list in the selector (only id + name are read). */
  radars: Array<Pick<RadarData, 'id' | 'name'>>;
  /** Currently selected radar id ('' when none). */
  selectedRadarId: string;
  /** Select an existing radar. */
  onSelectRadar: (id: string) => void;
  /** Open the create-radar dialog. */
  onCreateRadar: () => void;
  /** Open the rename-radar dialog. */
  onRenameRadar: () => void;
  /** Open the delete-radar confirmation. */
  onDeleteRadar: () => void;
  /** Open the share dialog. */
  onShareRadar: () => void;
  /** Open the radar settings dialog. */
  onOpenSettings: () => void;
  /** Start adding a new entry. */
  onAddEntry: () => void;
}

/**
 * Tech Radar page header + action toolbar. Pure presentation: every action is
 * delegated to a callback prop; enable/disable state is derived from `radars`
 * and `selectedRadarId` exactly as the page did inline.
 */
export function RadarPageHeader({
  radars,
  selectedRadarId,
  onSelectRadar,
  onCreateRadar,
  onRenameRadar,
  onDeleteRadar,
  onShareRadar,
  onOpenSettings,
  onAddEntry,
}: RadarPageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 pb-4 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between shrink-0">
      {/* Left: Title and subtitle */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tech Radar</h1>
        <p className="text-sm text-muted-foreground">
          Visualize adoption, maturity, and focus areas for key technologies.
        </p>
      </div>

      {/* Right: Actions — single non-wrapping cluster so the controls stay
          mutually aligned; when width tightens the whole cluster drops
          below the title instead of shedding its last button to a ragged
          second line. */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Radar Selector */}
        <Select
          value={selectedRadarId}
          onValueChange={(value) => {
            // "__create__" is an action, not a selection: keep the current
            // radar selected and open the create dialog instead.
            if (value === '__create__') {
              onCreateRadar();
            } else {
              onSelectRadar(value);
            }
          }}
        >
          <SelectTrigger className="w-[200px] h-9" aria-label="Select radar">
            <SelectValue placeholder="Select radar" />
          </SelectTrigger>
          <SelectContent>
            {radars.map((radar) => (
              <SelectItem key={radar.id} value={radar.id}>
                {radar.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value="__create__" className="text-primary">
              + Create New Radar
            </SelectItem>
          </SelectContent>
        </Select>

        {/* Radar Management Dropdown */}
        <TooltipProvider>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Manage radars">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Manage Radar</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onCreateRadar()}>
                <Plus className="mr-2 h-4 w-4" />
                Create New Radar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRenameRadar()} disabled={!selectedRadarId}>
                <PencilLine className="mr-2 h-4 w-4" />
                Rename Radar
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* LOCAL-010: the final radar is deletable — zero radars is a
                  valid workspace state with its own actionable empty state. */}
              <DropdownMenuItem
                onClick={() => onDeleteRadar()}
                disabled={!selectedRadarId}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Radar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Share Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => onShareRadar()}
                disabled={!selectedRadarId}
                aria-label="Share radar"
              >
                <Share2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share Radar</TooltipContent>
          </Tooltip>

          {/* Settings Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => onOpenSettings()}
                aria-label="Radar settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Radar Settings</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Add Entry Button (Primary) — icon-only "+" square matching the
            library pages' add buttons, with tooltip + aria-label like the
            rest of this toolbar's icon buttons. */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" className="h-9 w-9" onClick={() => onAddEntry()} aria-label="Add entry">
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add Entry</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
