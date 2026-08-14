'use client';

import { Eye, Link2, MoreHorizontal, Play, RefreshCw, Trash2, Download, Hash, Globe } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { DocumentStatusBadge, DocumentTypeBadge } from './badges';
import { formatFileSize, formatDate } from '@/hooks/useDocumentsPage';
import { resolveDocumentContentAvailability } from '@/lib/document-content-availability';
import { isRefreshActive } from '@/lib/document-refresh-policy';
import { canRequestProcessing, hasReprocessableSource, isProcessingActive } from '@/lib/document-processing-policy';
import type { Document } from '@/lib/types';
import type { DocumentSortState } from '@/hooks/useDocumentsPage';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('document');

interface DocumentsTableProps {
  documents: Document[];
  onSelectDocument: (doc: Document) => void;
  onProcessDocument: (doc: Document) => void;
  onRetryDocument: (doc: Document) => void;
  onDeleteDocument: (doc: Document) => void;
  onDownloadDocument: (doc: Document) => void;
  onRefreshDocument: (doc: Document) => void;
  onPreviewDocument: (doc: Document) => void;
  isSelected: (doc: Document) => boolean;
  onToggleSelection: (doc: Document) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
  sortState: DocumentSortState;
  onSort: (key: string) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function DocumentsTableSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {[...Array(6)].map((_, i) => (
        <Skeleton key={i} className="h-[68px] w-full" />
      ))}
    </div>
  );
}

// ============================================================================
// TABLE
// ============================================================================

export function DocumentsTable({
  documents,
  onSelectDocument,
  onProcessDocument,
  onRetryDocument,
  onDeleteDocument,
  onDownloadDocument,
  onRefreshDocument,
  onPreviewDocument,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
  sortState,
  onSort,
}: DocumentsTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(!!checked)}
                aria-label="Select all documents"
                className={cn(isSomeSelected && 'opacity-50')}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Title" sortKey="title" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3">
              <SortableHeader label="Type" sortKey="type" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3 font-medium">Status</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium text-center">Version</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium text-right">Chunks</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3">
              <SortableHeader
                label="Links"
                sortKey="linkedEntityCount"
                currentSort={sortState}
                onSort={onSort}
                className="justify-center w-full"
              />
            </TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3">
              <SortableHeader
                label="Size"
                sortKey="fileSize"
                currentSort={sortState}
                onSort={onSort}
                className="justify-end"
              />
            </TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3">
              <SortableHeader label="Uploaded" sortKey="createdAt" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => (
            <DocumentTableRow
              key={doc.id}
              document={doc}
              onSelect={() => onSelectDocument(doc)}
              onProcess={() => onProcessDocument(doc)}
              onRetry={() => onRetryDocument(doc)}
              onDelete={() => onDeleteDocument(doc)}
              onDownload={() => onDownloadDocument(doc)}
              onRefresh={() => onRefreshDocument(doc)}
              onPreview={() => onPreviewDocument(doc)}
              isSelected={isSelected(doc)}
              onToggleSelection={() => onToggleSelection(doc)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================================
// TABLE ROW
// ============================================================================

interface DocumentTableRowProps {
  document: Document;
  onSelect: () => void;
  onProcess: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onRefresh: () => void;
  onPreview: () => void;
  isSelected: boolean;
  onToggleSelection: () => void;
}

function DocumentTableRow({
  document,
  onSelect,
  onProcess,
  onRetry,
  onRefresh,
  onDelete,
  onDownload,
  onPreview,
  isSelected,
  onToggleSelection,
}: DocumentTableRowProps) {
  // UX-060: Preview and Download availability come from ONE contract shared
  // with the grid, the detail sheet and the preview dialog — three surfaces
  // used to answer the same question with three different predicates.
  const availability = resolveDocumentContentAvailability(document);
  // Time-bounded check (not the raw flag) so a stale flag left behind by a
  // crashed refresh run doesn't spin forever.
  const isRefreshing = isRefreshActive(document);
  // UX-036: the same time-bounded treatment for processing — a `processing`
  // status left behind by a dead worker must not hide the recovery action.
  const isProcessing = isProcessingActive(document);
  // Retry needs BOTH a retryable lifecycle state and something to reprocess
  // FROM. A document with neither stored bytes nor a source URL (a
  // deep-research artifact still being generated) has no path that could
  // succeed, so offering the action would only ever mislead.
  const canRetry = document.status !== 'uploaded' && canRequestProcessing(document) && hasReprocessableSource(document);
  // UX-036: "Process" and "Retry" are the same acknowledged enqueue behind two
  // labels, so they share the source precondition. Offering Process for a
  // document with neither stored bytes nor a source URL could only be refused.
  const canProcess = document.status === 'uploaded' && hasReprocessableSource(document);

  return (
    <TableRow
      data-testid="document-row"
      data-document-id={document.id}
      data-document-title={document.title}
      className="cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors"
      onClick={onSelect}
    >
      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          aria-label={`Select ${document.title}`}
        />
      </TableCell>

      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.document.bg)}
          >
            <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.document.text)} />
          </div>
          <div className="min-w-0 flex-1 max-w-[400px] space-y-0.5">
            <div className="font-medium leading-none truncate hover:underline" title={document.title}>
              {document.title}
            </div>
            {document.description && (
              <div className="text-xs text-muted-foreground truncate max-w-[200px]">{document.description}</div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden md:table-cell px-4 py-3">
        <DocumentTypeBadge type={document.type} />
      </TableCell>

      <TableCell className="hidden sm:table-cell px-4 py-3">
        <span className="inline-flex items-center gap-1.5">
          <DocumentStatusBadge status={document.status} document={document} />
          {isRefreshing && (
            <span title="Refreshing URL content…">
              <RefreshCw
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-label="Refreshing URL content"
              />
            </span>
          )}
        </span>
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3 text-center">
        <span className="text-sm text-muted-foreground">v{document.version || 1}</span>
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3 text-right">
        {document.chunkCount !== undefined ? (
          <span className="flex items-center justify-end gap-1 text-sm text-muted-foreground">
            <Hash className="h-3 w-3" />
            {document.chunkCount}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3 text-center">
        {document.linkedEntityCount !== undefined && document.linkedEntityCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Link2 className="h-3 w-3" />
            {document.linkedEntityCount}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      <TableCell className="hidden xl:table-cell px-4 py-3 text-right">
        <span className="text-sm text-muted-foreground">{formatFileSize(document.fileSize)}</span>
      </TableCell>

      <TableCell className="hidden xl:table-cell px-4 py-3">
        <span className="text-sm text-muted-foreground">{formatDate(document.createdAt)}</span>
      </TableCell>

      <TableCell className="px-4 py-3">
        <AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Open actions for ${document.title}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              {canProcess && (
                <DropdownMenuItem
                  data-testid="document-process"
                  onClick={(e) => {
                    e.stopPropagation();
                    onProcess();
                  }}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Process
                </DropdownMenuItem>
              )}
              {canRetry && (
                <DropdownMenuItem
                  data-testid="document-retry"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry
                </DropdownMenuItem>
              )}
              {isProcessing && (
                <DropdownMenuItem disabled>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Processing…
                </DropdownMenuItem>
              )}
              {document.type === 'url' && (
                <DropdownMenuItem
                  disabled={isRefreshing}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRefresh();
                  }}
                >
                  {isRefreshing ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Refreshing…
                    </>
                  ) : (
                    <>
                      <Globe className="mr-2 h-4 w-4" />
                      Refresh URL
                    </>
                  )}
                </DropdownMenuItem>
              )}
              {availability.preview.enabled ? (
                <DropdownMenuItem
                  data-testid="document-preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreview();
                  }}
                >
                  <Eye className="mr-2 h-4 w-4" />
                  Preview
                </DropdownMenuItem>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    {/* Disabled items get pointer-events:none — the span keeps hover events for the tooltip. */}
                    <TooltipTrigger asChild>
                      <span tabIndex={-1} onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem disabled data-testid="document-preview">
                          <Eye className="mr-2 h-4 w-4" />
                          Preview
                        </DropdownMenuItem>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left">{availability.preview.hint}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {availability.download.enabled ? (
                <DropdownMenuItem
                  data-testid="document-download"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload();
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {availability.download.label}
                </DropdownMenuItem>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    {/* Disabled items get pointer-events:none — the span keeps hover events for the tooltip. */}
                    <TooltipTrigger asChild>
                      <span tabIndex={-1} onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem disabled data-testid="document-download">
                          <Download className="mr-2 h-4 w-4" />
                          {availability.download.label}
                        </DropdownMenuItem>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left">{availability.download.hint}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <DropdownMenuSeparator />
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  onClick={(e) => e.stopPropagation()}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete &quot;{document.title}&quot;?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the document and all extracted chunks.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
