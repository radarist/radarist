'use client';

/**
 * @file app/artifacts/page.tsx
 * @description The Artifacts OUTPUTS catalog — what build missions produced
 * (apps / evaluation verdicts / documents), as a library-grade table (multi-
 * select, sort, bulk delete, per-kind ⋮ actions, rows-per-page). Output status
 * is independent of run status; the run lives on Agent Runs › Builds. Row click
 * opens the full detail page (/artifacts/[id]).
 */
import { useState } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { EmptyState } from '@/components/feedback/EmptyState';
import { NewArtifactDialog } from '@/components/missions/NewArtifactDialog';
import { DataTableSkeleton } from '@/components/skeletons';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArtifactsTable } from '@/components/artifacts/ArtifactsTable';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useArtifactsPage } from '@/hooks/useArtifactsPage';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { useDeleteBuildArtifact } from '@/hooks/queries/useBuildMissions';
import { missionTitle, runBulkArtifactDelete } from '@/lib/build-mission-ui';
import { Hammer } from 'lucide-react';
import type { Mission } from '@/lib/schemas/mission';
import type { ArtifactKind } from '@/lib/schemas/mission-build';

function ArtifactsCatalog() {
  const {
    rows,
    totalCount,
    isLoading,
    error,
    refetch,
    search,
    setSearch,
    kindFilter,
    setKindFilter,
    sortConfig,
    handleSort,
    pageIndex,
    pageSize,
    handlePageChange,
    handlePageSizeChange,
  } = useArtifactsPage();

  const sel = useTableSelection<Mission>({ getItemId: (m) => m.id });
  const { isAllSelected, isSomeSelected } = useSelectionState(sel.selectedIds, rows, (m) => m.id);
  const deleteArtifact = useDeleteBuildArtifact();

  const [deleteTarget, setDeleteTarget] = useState<Mission | null>(null);
  const [showBulkDelete, setShowBulkDelete] = useState(false);

  const handleBulkDelete = async () => {
    // BUILD-025: don't swallow failures or clear the whole selection. Delete
    // each artifact, then keep ONLY the failed rows selected so the operator can
    // see and retry exactly what didn't delete; report the partial outcome.
    const ids = sel.selectedIds;
    const { failedIds, succeeded } = await runBulkArtifactDelete(ids, (id) => deleteArtifact.mutateAsync(id));
    setShowBulkDelete(false);
    if (failedIds.length === 0) {
      sel.clearSelection();
      toast.success(`Deleted ${succeeded} artifact${succeeded === 1 ? '' : 's'}`);
      return;
    }
    sel.setSelection(failedIds);
    if (succeeded > 0) toast.success(`Deleted ${succeeded} artifact${succeeded === 1 ? '' : 's'}`);
    toast.error(
      `${failedIds.length} of ${ids.length} artifact${ids.length === 1 ? '' : 's'} could not be deleted — kept selected to retry.`
    );
  };

  return (
    <>
      {/* Header band — title + search + kind filter + "+" (library style). */}
      <div className="flex flex-col gap-4 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Artifacts</h1>
          <p className="text-sm text-muted-foreground">
            What build missions produced — the run lives on Agent Runs › Builds.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search artifacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full pl-10 sm:w-[200px]"
            />
          </div>
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as ArtifactKind | 'all')}>
            <SelectTrigger className="h-9 w-full sm:w-[150px]">
              <SelectValue placeholder="All kinds" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="solution">App</SelectItem>
              <SelectItem value="evaluation">Evaluation</SelectItem>
              <SelectItem value="architecture">Architecture</SelectItem>
              <SelectItem value="report">Report</SelectItem>
            </SelectContent>
          </Select>
          <NewArtifactDialog />
        </div>
      </div>

      {isLoading ? (
        <DataTableSkeleton rows={6} columns={6} />
      ) : error ? (
        <EmptyState
          icon={Hammer}
          title="Could not load artifacts"
          description={error instanceof Error ? error.message : 'Unknown error'}
          action={{ label: 'Retry', onClick: () => void refetch() }}
        />
      ) : totalCount === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No artifacts yet"
          description="A build mission produces an artifact — an app (Prototype), a technology-evaluation verdict, or a document. Requires IMPULSE_BUILD_ENABLED=true."
          action={{
            label: 'New Artifact',
            onClick: () => document.querySelector<HTMLButtonElement>('[data-testid="new-artifact-button"]')?.click(),
          }}
        />
      ) : (
        <>
          <ArtifactsTable
            rows={rows}
            sortConfig={sortConfig}
            onSort={handleSort}
            isSelected={sel.isSelected}
            onToggleSelection={sel.toggleSelection}
            isAllSelected={isAllSelected}
            isSomeSelected={isSomeSelected}
            onSelectAllChange={(c) => sel.handleSelectAllChange(c, rows)}
            onDelete={setDeleteTarget}
          />
          <DataPagination
            pageIndex={pageIndex}
            pageSize={pageSize}
            totalCount={totalCount}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            itemLabel="artifacts"
          />
        </>
      )}

      {/* Bulk + single delete */}
      <BulkActionToolbar
        selectedCount={sel.selectedCount}
        entityType="artifact"
        onDelete={() => setShowBulkDelete(true)}
        onClearSelection={sel.clearSelection}
        isDeleting={deleteArtifact.isPending}
      />
      <BulkDeleteDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        count={sel.selectedCount}
        entityType="artifact"
        onConfirm={handleBulkDelete}
        showCascadeWarning
      />
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this artifact?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget &&
                `"${missionTitle(deleteTarget)}" — its output entity is removed and the sandbox is destroyed. The run history is kept.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) deleteArtifact.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function ArtifactsPage() {
  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          <ErrorBoundary>
            <ArtifactsCatalog />
          </ErrorBoundary>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
