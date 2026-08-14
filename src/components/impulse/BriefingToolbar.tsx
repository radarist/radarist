/**
 * @file BriefingToolbar.tsx
 * @description Filter + view-mode controls above the briefing feed.
 *
 * Four filters (per plan §5.2), all URL-synced via `useUrlArrayState` /
 * `useUrlState` so a reload or shared link reproduces the same view:
 *
 *   - Type (multi-select)        ?type=connection,discovery
 *   - Agent (multi-select)       ?agent=scout,linker
 *   - Min confidence (0-100)     ?minConfidence=50
 *   - Liked only (boolean flag)  ?liked=1
 *
 * Plus the view-mode toggle (Zustand-persisted, local preference).
 *
 * The toolbar emits the active filter set to its parent via the
 * `filters` prop's `onChange` so the feed can apply them client-side
 * over the already-fetched insights list (no second fetch needed —
 * `useBriefing` returns the full set).
 *
 * "Clear filters" lives here so the empty-state in `BriefingFeed` can
 * call back into this component's API without re-implementing the
 * URL-clear logic.
 */

'use client';

import { useMemo } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { ViewModeToggle } from './ViewModeToggle';
import { useUrlParams } from '@/hooks/useUrlState';
import { cn } from '@/lib/utils';
import { formatEnumLabel } from '@/lib/enum-label';

/**
 * Shape the feed consumes. Decoupled from the URL representation so the
 * feed doesn't need to know about query-string parsing — it just reads
 * a normalised filter object.
 */
export interface BriefingFilters {
  types: string[];
  agents: string[];
  /** 0-1 normalised. The UI displays 0-100; conversion lives in this file. */
  minConfidence: number;
  likedOnly: boolean;
}

const LIKED_FLAG = '1';

/**
 * Read the four filter values from the URL and assemble the
 * `BriefingFilters` shape. Also returns setters so the toolbar can
 * write back via the same hook references.
 */
export function useBriefingFilters(): {
  filters: BriefingFilters;
  setTypes: (next: string[]) => void;
  setAgents: (next: string[]) => void;
  setMinConfidence: (next: number) => void;
  setLikedOnly: (next: boolean) => void;
  clearAll: () => void;
  isActive: boolean;
} {
  // Single shared writer for all four filter params. Earlier
  // implementation used four `useUrlState` / `useUrlArrayState` hooks
  // and called their setters back-to-back from `clearAll` — each
  // setter read its own snapshot of `searchParams`, so successive
  // calls clobbered the previous URL update. `setParams({...})`
  // writes everything against a single snapshot in one
  // `router.replace`.
  const { params, setParams } = useUrlParams();

  // Read array params from the comma-joined query value used by
  // `useUrlArrayState` (so existing URL shapes stay compatible).
  const typeValues = (params.get('type')?.split(',').filter(Boolean) ?? []) as string[];
  const agentValues = (params.get('agent')?.split(',').filter(Boolean) ?? []) as string[];

  const minConfidenceRaw = parseInt(params.get('minConfidence') ?? '0', 10);
  const minConfidence = isNaN(minConfidenceRaw) ? 0 : Math.max(0, Math.min(100, minConfidenceRaw)) / 100;

  const likedOnly = params.get('liked') === LIKED_FLAG;

  const filters: BriefingFilters = {
    types: typeValues,
    agents: agentValues,
    minConfidence,
    likedOnly,
  };

  const isActive = typeValues.length > 0 || agentValues.length > 0 || minConfidence > 0 || likedOnly;

  return {
    filters,
    setTypes: (next: string[]) => setParams({ type: next.length === 0 ? null : next }),
    setAgents: (next: string[]) => setParams({ agent: next.length === 0 ? null : next }),
    setMinConfidence: (pct: number) => {
      // Drop the URL param entirely at 0% so empty-state filter counts
      // stay clean ("filters: 0 active" rather than "minConfidence=0").
      setParams({ minConfidence: pct <= 0 ? null : String(Math.round(pct * 100)) });
    },
    setLikedOnly: (on: boolean) => setParams({ liked: on ? LIKED_FLAG : null }),
    clearAll: () =>
      // Single batched write — clears every filter param against one
      // `searchParams` snapshot. Replaces the previous four-call chain
      // that raced and clobbered itself.
      setParams({
        type: null,
        agent: null,
        minConfidence: null,
        liked: null,
      }),
    isActive,
  };
}

interface BriefingToolbarProps {
  /**
   * Distinct values discovered in the currently-fetched insight list.
   * The toolbar uses them to populate the multi-select option lists,
   * so a filter on a non-existent agent never appears. The feed
   * computes this once per fetch and passes it in.
   */
  availableTypes: string[];
  availableAgents: string[];
  /**
   * Client-side title/summary search text — deliberately NOT URL-synced
   * (unlike the four filters above) since it's a plain substring match
   * applied by the feed, mirroring the Signals/Assessments search boxes.
   * Optional so existing call sites/tests that don't wire search keep
   * rendering a controlled-but-inert input.
   */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

export function BriefingToolbar({
  availableTypes,
  availableAgents,
  searchValue = '',
  onSearchChange = () => {},
}: BriefingToolbarProps) {
  const { filters, setTypes, setAgents, setMinConfidence, setLikedOnly, clearAll, isActive } = useBriefingFilters();

  const minConfidencePct = Math.round(filters.minConfidence * 100);

  // Memoise the labels so re-render doesn't re-sort the option lists.
  const sortedTypes = useMemo(() => [...availableTypes].sort(), [availableTypes]);
  const sortedAgents = useMemo(() => [...availableAgents].sort(), [availableAgents]);

  const showClear = isActive || searchValue.length > 0;
  const handleClear = () => {
    clearAll();
    onSearchChange('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="briefing-toolbar">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search insights..."
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 w-full pl-10 sm:w-[200px]"
          data-testid="briefing-filter-search"
        />
      </div>
      <MultiSelect
        label="Type"
        options={sortedTypes}
        selected={filters.types}
        onChange={setTypes}
        testId="briefing-filter-type"
      />
      <MultiSelect
        label="Agent"
        options={sortedAgents}
        selected={filters.agents}
        onChange={setAgents}
        testId="briefing-filter-agent"
      />
      <ConfidenceSlider value={minConfidencePct} onChange={(p) => setMinConfidence(p / 100)} />
      <LikedToggle on={filters.likedOnly} onChange={setLikedOnly} />

      {showClear && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClear}
          data-testid="briefing-filter-clear"
          className="h-8 text-muted-foreground"
        >
          <X className="h-3 w-3 mr-1" />
          Clear filters
        </Button>
      )}

      <div className="ml-auto">
        <ViewModeToggle />
      </div>
    </div>
  );
}

interface MultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  testId: string;
}

function MultiSelect({ label, options, selected, onChange, testId }: MultiSelectProps) {
  const toggle = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 border-dashed" data-testid={testId}>
          {label}
          {selected.length > 0 && (
            <Badge variant="secondary" className="ml-2 px-1 font-normal" data-testid={`${testId}-count`}>
              {selected.length}
            </Badge>
          )}
          <ChevronDown className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {options.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">No options</div>
        ) : (
          options.map((option) => {
            const checked = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggle(option)}
                className={cn(
                  'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent',
                  checked && 'bg-accent/50'
                )}
                data-testid={`${testId}-option-${option}`}
                aria-pressed={checked}
              >
                <span className="truncate">{formatEnumLabel(option)}</span>
                {checked && <Check className="h-3.5 w-3.5 text-foreground" />}
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}

function ConfidenceSlider({ value, onChange }: { value: number; onChange: (pct: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-dashed"
          data-testid="briefing-filter-confidence"
        >
          Confidence
          {value > 0 && (
            <Badge variant="secondary" className="ml-2 px-1 font-normal" data-testid="briefing-filter-confidence-value">
              ≥{value}%
            </Badge>
          )}
          <ChevronDown className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Minimum confidence</span>
            <span className="font-medium tabular-nums">{value}%</span>
          </div>
          <Slider
            value={[value]}
            onValueChange={([next]) => onChange(next ?? 0)}
            min={0}
            max={100}
            step={5}
            data-testid="briefing-filter-confidence-slider"
            aria-label="Minimum confidence percentage"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LikedToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      className="inline-flex h-8 items-center gap-2 rounded-md border border-dashed px-3 text-sm cursor-pointer"
      data-testid="briefing-filter-liked"
    >
      <span className="text-muted-foreground">Liked only</span>
      <Switch
        checked={on}
        onCheckedChange={onChange}
        aria-label="Show liked insights only"
        data-testid="briefing-filter-liked-switch"
      />
    </label>
  );
}
