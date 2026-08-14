'use client';

import { Eye, Link2, Hash, Play, RefreshCw, Trash2, Download, Globe } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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

import { DocumentStatusBadge, DocumentTypeBadge } from './badges';
import { formatFileSize } from '@/hooks/useDocumentsPage';
import { resolveDocumentContentAvailability } from '@/lib/document-content-availability';
import { canRequestProcessing, hasReprocessableSource } from '@/lib/document-processing-policy';
import { isRefreshActive } from '@/lib/document-refresh-policy';
import type { Document } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('document');

interface DocumentsGridProps {
  documents: Document[];
  onSelectDocument: (doc: Document) => void;
  onProcessDocument: (doc: Document) => void;
  onRetryDocument: (doc: Document) => void;
  onDeleteDocument: (doc: Document) => void;
  onDownloadDocument: (doc: Document) => void;
  onRefreshDocument: (doc: Document) => void;
  onPreviewDocument: (doc: Document) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function DocumentsGridSkeleton() {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="h-[200px] flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[120px]" />
                    <Skeleton className="h-3 w-[80px]" />
                  </div>
                </div>
                <Skeleton className="h-5 w-[70px] rounded-full" />
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between pt-0">
              <div className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <div className="flex items-center gap-4 pt-3">
                <Skeleton className="h-3 w-[60px]" />
                <Skeleton className="h-3 w-[40px]" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// GRID
// ============================================================================

export function DocumentsGrid({
  documents,
  onSelectDocument,
  onProcessDocument,
  onRetryDocument,
  onDeleteDocument,
  onDownloadDocument,
  onRefreshDocument,
  onPreviewDocument,
}: DocumentsGridProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {documents.map((doc) => {
          // UX-060: one contract decides Preview/Download for this card, shared
          // with the table row, the detail sheet and the preview dialog.
          const availability = resolveDocumentContentAvailability(doc);
          return (
            <Card
              key={doc.id}
              role="button"
              tabIndex={0}
              aria-label={`View ${doc.title} details`}
              onClick={() => onSelectDocument(doc)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectDocument(doc);
                }
              }}
              className={cn(
                'h-full min-h-[180px] max-h-[220px] flex flex-col',
                'cursor-pointer transition-all duration-150',
                'hover:bg-accent/10 hover:border-accent/40',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'active:scale-[0.99]'
              )}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        ENTITY_COLORS.document.bg
                      )}
                    >
                      <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.document.text)} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-medium leading-none truncate" title={doc.title}>
                        {doc.title}
                      </div>
                      <DocumentTypeBadge type={doc.type} className="mt-1" />
                    </div>
                  </div>
                  <DocumentStatusBadge status={doc.status} document={doc} className="shrink-0" />
                </div>
              </CardHeader>

              <CardContent className="flex-1 flex flex-col justify-between pt-0">
                <div className="space-y-2">
                  {doc.description ? (
                    <p className="text-sm text-muted-foreground line-clamp-2" title={doc.description}>
                      {doc.description}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground/40 italic">No description</p>
                  )}
                </div>

                <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground mt-auto">
                  <div className="flex items-center gap-3">
                    {doc.chunkCount !== undefined && (
                      <span className="flex items-center gap-1" title={`${doc.chunkCount} chunks`}>
                        <Hash className="h-3 w-3" />
                        {doc.chunkCount}
                      </span>
                    )}
                    {doc.linkedEntityCount !== undefined && doc.linkedEntityCount > 0 && (
                      <span className="flex items-center gap-1" title={`${doc.linkedEntityCount} linked entities`}>
                        <Link2 className="h-3 w-3" />
                        {doc.linkedEntityCount}
                      </span>
                    )}
                    <span title={`File size: ${formatFileSize(doc.fileSize)}`}>{formatFileSize(doc.fileSize)}</span>
                  </div>

                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {/* UX-036: Process and Retry are the same acknowledged enqueue
                      behind two labels, so they need the SAME source
                      precondition. Offering Process for a document with neither
                      stored bytes nor a source URL could only ever be refused. */}
                    {doc.status === 'uploaded' && hasReprocessableSource(doc) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        data-testid="document-process"
                        onClick={() => onProcessDocument(doc)}
                        title="Process document"
                        aria-label={`Process ${doc.title}`}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {/* UX-036: retryable is a policy decision (terminal statuses plus a
                      stalled run), not a `status === 'failed'` string check. */}
                    {doc.status !== 'uploaded' && canRequestProcessing(doc) && hasReprocessableSource(doc) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        data-testid="document-retry"
                        onClick={() => onRetryDocument(doc)}
                        title="Retry processing"
                        aria-label={`Retry processing ${doc.title}`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {doc.type === 'url' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onRefreshDocument(doc)}
                        disabled={isRefreshActive(doc)}
                        title={isRefreshActive(doc) ? 'Refreshing URL content…' : 'Refresh URL content'}
                        aria-label={isRefreshActive(doc) ? `Refreshing ${doc.title}` : `Refresh ${doc.title}`}
                      >
                        {isRefreshActive(doc) ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Globe className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    {/* Preview renders the stored file or falls back to extracted chunk text —
                      only documents with neither disable it. Span keeps the tooltip while disabled. */}
                    <span title={availability.preview.hint}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        data-testid="document-preview"
                        onClick={() => onPreviewDocument(doc)}
                        disabled={!availability.preview.enabled}
                        aria-label={`Preview ${doc.title}`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                    {/* URL documents have no stored file — Download is disabled with an explanatory tooltip.
                      The span keeps the title tooltip working while the button is disabled. */}
                    <span title={availability.download.hint}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        data-testid="document-download"
                        onClick={() => onDownloadDocument(doc)}
                        disabled={!availability.download.enabled}
                        aria-label={`${availability.download.label}: ${doc.title}`}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title={`Delete ${doc.title}`}
                          aria-label={`Delete ${doc.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete &quot;{doc.title}&quot;?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This action cannot be undone. This will permanently delete the document and all extracted
                            chunks.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onDeleteDocument(doc)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
