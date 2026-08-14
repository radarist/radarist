/**
 * @file ViewModeToggle.tsx
 * @description Compact icon toggle between table and card views for the
 * briefing surface. State lives in the Zustand store
 * (`useBriefingUIStore`) so a flip here persists across reloads.
 *
 * Visual grammar mirrors the agents/signals page's view-mode toggle —
 * two adjacent icon buttons inside a bordered shell, the active mode
 * highlighted via the shadcn `default` variant.
 */

'use client';

import { List, LayoutGrid } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useBriefingUIStore, type BriefingViewMode } from '@/stores/briefing-ui-store';

export function ViewModeToggle({ className }: { className?: string }) {
  const viewMode = useBriefingUIStore((s) => s.viewMode);
  const setViewMode = useBriefingUIStore((s) => s.setViewMode);

  return (
    <div
      className={cn('inline-flex items-center rounded-md border bg-background', className)}
      role="group"
      aria-label="Briefing view mode"
      data-testid="briefing-view-mode-toggle"
    >
      <ModeButton mode="table" label="Table view" active={viewMode === 'table'} onSelect={setViewMode} Icon={List} />
      <ModeButton mode="card" label="Card view" active={viewMode === 'card'} onSelect={setViewMode} Icon={LayoutGrid} />
    </div>
  );
}

function ModeButton({
  mode,
  label,
  active,
  onSelect,
  Icon,
}: {
  mode: BriefingViewMode;
  label: string;
  active: boolean;
  onSelect: (mode: BriefingViewMode) => void;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'ghost'}
      size="sm"
      className={cn('h-8 px-2.5 rounded-md', !active && 'text-muted-foreground hover:text-foreground')}
      onClick={() => onSelect(mode)}
      aria-pressed={active}
      aria-label={label}
      data-testid={`briefing-view-mode-${mode}`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
