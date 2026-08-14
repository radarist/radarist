'use client';

/**
 * @file ArtifactsTable.tsx
 * @description The /artifacts OUTPUTS catalog table — built to match the library
 * tables (PrototypesTable/TechnologiesTable): select-all + per-row checkbox,
 * SortableHeader columns, tinted kind-icon box, OUTPUT status (not run status),
 * a contextual source-run pill, and a per-kind ⋮ menu (App → Start/Stop/Open/
 * Delete; others → View/Delete). Row click → the detail page.
 */
import { useRouter } from 'next/navigation';
import {
  Hammer,
  FlaskConical,
  Workflow,
  FileText,
  MoreHorizontal,
  Play,
  Square,
  ExternalLink,
  Eye,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import {
  ARTIFACT_KIND_BADGE,
  artifactKindOf,
  outputStatus,
  OUTPUT_STATUS_TINT,
  outputRef,
  runStatusBadge,
  sourceRunHref,
} from '@/lib/artifact-output-ui';
import { missionTitle } from '@/lib/build-mission-ui';
import { useStartBuildArtifact, useStopBuildArtifact } from '@/hooks/queries/useBuildMissions';
import { toast } from 'sonner';
import type { Mission } from '@/lib/schemas/mission';
import type { SortConfig } from '@/components/library/shared/types';
import { cn } from '@/lib/utils';

const KIND_ICON = { solution: Hammer, evaluation: FlaskConical, architecture: Workflow, report: FileText };
const KIND_BG = {
  solution: 'bg-teal-500/10',
  evaluation: 'bg-emerald-500/10',
  architecture: 'bg-slate-500/10',
  report: 'bg-slate-500/10',
};
const KIND_FG = {
  solution: 'text-teal-500',
  evaluation: 'text-emerald-500',
  architecture: 'text-slate-500',
  report: 'text-slate-500',
};

function formatDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface Props {
  rows: Mission[];
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
  isSelected: (m: Mission) => boolean;
  onToggleSelection: (m: Mission) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
  onDelete: (m: Mission) => void;
}

export function ArtifactsTable({
  rows,
  sortConfig,
  onSort,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
  onDelete,
}: Props) {
  const router = useRouter();
  const start = useStartBuildArtifact();
  const stop = useStopBuildArtifact();
  const open = (m: Mission) => router.push(`/artifacts/${m.id}`);
  // BUILD-026 — Start/Stop now fail honestly when the sandbox won't come up or
  // won't stop. In a dropdown there's no inline room, so surface the outcome as
  // a toast; the menu item stays enabled to retry.
  const startArtifact = (id: string) =>
    start.mutate(id, {
      onSuccess: () => toast.success('Preview started'),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not start the preview. Please retry.'),
    });
  const stopArtifact = (id: string) =>
    stop.mutate(id, {
      onSuccess: () => toast.success('Preview stopped'),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not stop the preview. Please retry.'),
    });

  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="border-b border-border hover:bg-transparent">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                data-state={
                  isSomeSelected && !isAllSelected ? 'indeterminate' : isAllSelected ? 'checked' : 'unchecked'
                }
                onCheckedChange={(c) => onSelectAllChange(c === true)}
                aria-label="Select all"
                onClick={(e) => e.stopPropagation()}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Artifact" sortKey="name" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden px-4 py-3 sm:table-cell">
              <SortableHeader label="Kind" sortKey="kind" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden px-4 py-3 md:table-cell font-medium">Source run</TableHead>
            <TableHead className="hidden px-4 py-3 lg:table-cell">
              <SortableHeader label="Updated" sortKey="updated" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => {
            const kind = artifactKindOf(m);
            const badge = ARTIFACT_KIND_BADGE[kind];
            const Icon = KIND_ICON[kind];
            const status = outputStatus(m);
            const ref = outputRef(m);
            const run = runStatusBadge(m);
            const isApp = kind === 'solution';
            return (
              <TableRow
                key={m.id}
                className={cn(
                  'cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/30',
                  isSelected(m) && 'bg-accent/20'
                )}
                onClick={() => open(m)}
              >
                <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected(m)}
                    onCheckedChange={() => onToggleSelection(m)}
                    aria-label={`Select ${missionTitle(m)}`}
                  />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', KIND_BG[kind])}
                    >
                      <Icon className={cn('h-5 w-5', KIND_FG[kind])} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium leading-none hover:underline" title={missionTitle(m)}>
                        {missionTitle(m)}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden px-4 py-3 sm:table-cell">
                  <Badge
                    variant="outline"
                    className={cn('gap-1 px-2 py-0.5 text-xs font-normal', badge.className, badge.tint)}
                  >
                    {badge.label}
                  </Badge>
                </TableCell>
                <TableCell className="px-4 py-3">
                  <Badge
                    variant="outline"
                    className={cn('gap-1 px-2 py-0.5 text-xs font-normal', OUTPUT_STATUS_TINT[status.status])}
                  >
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="hidden px-4 py-3 md:table-cell" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => router.push(sourceRunHref(m))} className="cursor-pointer">
                    <Badge variant="outline" className={cn('gap-1 px-2 py-0.5 text-xs font-normal', run.className)}>
                      {run.label}
                    </Badge>
                  </button>
                </TableCell>
                <TableCell className="hidden px-4 py-3 text-sm text-muted-foreground lg:table-cell">
                  {formatDate(m.artifact?.publishedAt ?? m.completedAt ?? m.createdAt)}
                </TableCell>
                <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Open menu</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[160px]">
                      {isApp ? (
                        <>
                          <DropdownMenuItem disabled={start.isPending} onClick={() => startArtifact(m.id)}>
                            <Play className="mr-2 h-4 w-4" /> Start
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={stop.isPending} onClick={() => stopArtifact(m.id)}>
                            <Square className="mr-2 h-4 w-4" /> Stop
                          </DropdownMenuItem>
                          {ref.previewUrl && (
                            <DropdownMenuItem onClick={() => window.open(ref.previewUrl, '_blank')}>
                              <ExternalLink className="mr-2 h-4 w-4" /> Open
                            </DropdownMenuItem>
                          )}
                        </>
                      ) : (
                        <DropdownMenuItem onClick={() => open(m)}>
                          <Eye className="mr-2 h-4 w-4" /> View
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onDelete(m)} className="text-destructive focus:text-destructive">
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
