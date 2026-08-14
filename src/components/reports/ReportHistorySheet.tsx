'use client';

/**
 * @file components/reports/ReportHistorySheet.tsx
 * @description DISC-014 — the report version-history sheet: a timeline of every
 * saved version with point-in-time preview + restore. Reads metadata only (no
 * html bodies) via useReportVersions; a version's html is fetched on demand for
 * preview.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { History, Eye, RotateCcw, AlertTriangle } from 'lucide-react';
import { formatDate } from '@/hooks/useReportsPage';
import { useReportVersions } from '@/hooks/useReports';
import type { ReportVersionSummary } from '@/lib/schemas/report';

/** Human-readable label for a version's `savedBy` actor (never leaks a raw uid). */
export function describeSaver(savedBy: string): string {
  if (savedBy.startsWith('user:')) return 'Manual edit';
  if (savedBy.startsWith('agent:')) {
    const name = savedBy.slice('agent:'.length);
    const labels: Record<string, string> = {
      creator: 'Creator agent',
      curator: 'Curator agent',
      'artifact-recommender': 'Recommendation engine',
    };
    return labels[name] ?? `${name} agent`;
  }
  return 'Earlier version';
}

/** Compact byte-size label for a version's html length. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface ReportHistorySheetProps {
  reportId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version currently being previewed in the main viewer, if any. */
  previewVersionId: string | null;
  onPreview: (versionId: string) => void;
  onRestore: (versionId: string) => void;
  isRestoring: boolean;
}

function VersionRow({
  version,
  isPreviewing,
  onPreview,
  onRestore,
  isRestoring,
}: {
  version: ReportVersionSummary;
  isPreviewing: boolean;
  onPreview: () => void;
  onRestore: () => void;
  isRestoring: boolean;
}) {
  return (
    <li
      className={`rounded-lg border p-3 transition-colors ${isPreviewing ? 'border-primary bg-primary/5' : 'bg-card'}`}
      data-testid={`version-row-${version.versionNumber}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="shrink-0">
              v{version.versionNumber}
            </Badge>
            <span className="text-sm font-medium">{describeSaver(version.savedBy)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatDate(version.createdAt)} · {formatSize(version.htmlLength)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={isPreviewing ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onPreview}
            aria-label={`Preview version ${version.versionNumber}`}
            aria-pressed={isPreviewing}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={isRestoring}
                aria-label={`Restore version ${version.versionNumber}`}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restore version {version.versionNumber}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The report will revert to this version. The current version is first saved to history, so no version
                  is ever lost — you can restore it again later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onRestore}>Restore this version</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </li>
  );
}

export function ReportHistorySheet({
  reportId,
  open,
  onOpenChange,
  previewVersionId,
  onPreview,
  onRestore,
  isRestoring,
}: ReportHistorySheetProps) {
  // Only fetch history while the sheet is open.
  const { data: versions, isLoading, isError, refetch } = useReportVersions(reportId, open);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:w-[420px] md:w-[460px]">
        <SheetHeader className="shrink-0 border-b px-6 py-5">
          <SheetTitle className="flex items-center gap-2">
            <History className="h-5 w-5" /> Version history
          </SheetTitle>
          <SheetDescription>
            Every saved version of this report. Preview any point in time, then restore it — nothing is ever lost.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="space-y-3" data-testid="history-loading">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="history-error">
              <AlertTriangle className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                We couldn&rsquo;t load the version history. This is usually temporary.
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          ) : !versions || versions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center" data-testid="history-empty">
              <History className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No earlier versions yet</p>
              <p className="text-xs text-muted-foreground">
                Every edit, revision, or restore is saved here so you can roll back to any point in time.
              </p>
            </div>
          ) : (
            <ul className="space-y-2" data-testid="history-list">
              {versions.map((version) => (
                <VersionRow
                  key={version.versionId}
                  version={version}
                  isPreviewing={previewVersionId === version.versionId}
                  onPreview={() => onPreview(version.versionId)}
                  onRestore={() => onRestore(version.versionId)}
                  isRestoring={isRestoring}
                />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
