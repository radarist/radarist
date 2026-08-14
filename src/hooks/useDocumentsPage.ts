'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getDocuments, deleteDocument, deleteDocuments, retryDocumentProcessing } from '@/lib/document-service';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useSheetUrl } from '@/hooks/useSheetUrl';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-labels';
import type { Document } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('hooks/useDocumentsPage');
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { resolveDocumentContentAvailability } from '@/lib/document-content-availability';
import { composeDocumentExport, documentExportFilename } from '@/lib/document-content-export';

// ============================================================================
// TYPES
// ============================================================================

type SortField = 'title' | 'type' | 'linkedEntityCount' | 'fileSize' | 'createdAt';
type SortDirection = 'asc' | 'desc';

export interface DocumentSortState {
  key: SortField;
  direction: SortDirection;
}

// ============================================================================
// UTILITIES
// ============================================================================

export function formatFileSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

/**
 * Compare two documents for a given sort state. Exported (pure) so the
 * column-sort semantics are unit-testable without rendering the hook.
 *
 * - `title`: locale-aware on title (missing coerced to '').
 * - `type`: locale-aware on the *display label* (e.g. 'Deep Research'),
 *   not the raw type key — matches what the Type column renders.
 * - `linkedEntityCount`: numeric; rows the Links column renders as '—'
 *   (undefined or 0) sort last in BOTH directions.
 * - `fileSize` / `createdAt`: numeric (missing coerced to 0).
 */
export function compareDocuments(a: Document, b: Document, sort: DocumentSortState): number {
  const direction = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'title':
      // Documents from failed uploads can land in Firestore without a
      // title (schema says required, but the write can abort mid-flight).
      // Coerce to '' so sort doesn't crash; those rows sort to the top.
      return direction * (a.title ?? '').localeCompare(b.title ?? '');
    case 'type': {
      const aLabel = DOCUMENT_TYPE_LABELS[a.type] ?? a.type ?? '';
      const bLabel = DOCUMENT_TYPE_LABELS[b.type] ?? b.type ?? '';
      return direction * aLabel.localeCompare(bLabel);
    }
    case 'linkedEntityCount': {
      // The Links cell renders '—' for undefined AND 0 — both count as
      // "missing" and always sort last, regardless of direction.
      const aMissing = !a.linkedEntityCount;
      const bMissing = !b.linkedEntityCount;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return direction * ((a.linkedEntityCount as number) - (b.linkedEntityCount as number));
    }
    case 'fileSize':
      return direction * ((a.fileSize || 0) - (b.fileSize || 0));
    case 'createdAt':
      return direction * ((a.createdAt || 0) - (b.createdAt || 0));
    default:
      return 0;
  }
}

// ============================================================================
// HOOK
// ============================================================================

export function useDocumentsPage() {
  const { toast } = useToast();

  // Data state
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Sorting
  const [sortState, setSortState] = useState<DocumentSortState>({ key: 'title', direction: 'asc' });

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [showOrphansOnly, setShowOrphansOnly] = useState(false);

  // Bulk delete
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Sheet state — URL-controlled (`?document=<id>`) so deep links from the
  // graph workbench / command palette open the sheet directly. DocumentSheet
  // fetches the document by id itself, so only the id round-trips the URL.
  // Param name must stay in sync with ENTITY_SHEET_PARAMS in entity-links.ts.
  const {
    openEntityId: selectedDocumentId,
    isOpen: isSheetOpen,
    openSheet: openDocumentSheet,
    closeSheet: closeDocumentSheet,
  } = useSheetUrl({ paramName: 'document' });

  const setIsSheetOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        closeDocumentSheet();
      }
    },
    [closeDocumentSheet]
  );

  // Preview dialog state — holds the full Document (the dialog picks its
  // renderer from type/storageUrl/chunkCount/fileSize without refetching).
  // `isPreviewOpen` is tracked separately so the document stays mounted
  // through the dialog's exit animation.
  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const handlePreviewDocument = useCallback((document: Document) => {
    // Defer past the row dropdown-menu teardown: opening a modal Dialog in
    // the same tick the triggering Radix menu closes corrupts the shared
    // body pointer-events lock, freezing the page after the dialog closes
    // (reproduced: table "…" → Preview a PDF → close via X). Same fix as
    // openRadarManagement on the radar page.
    setTimeout(() => {
      setPreviewDocument(document);
      setIsPreviewOpen(true);
    }, 0);
  }, []);

  const setPreviewOpen = useCallback((open: boolean) => {
    if (!open) {
      setIsPreviewOpen(false);
    }
  }, []);

  // Selection
  const { selectedIds, isSelected, toggleSelection, handleSelectAllChange, clearSelection, selectedCount } =
    useTableSelection<Document>({
      getItemId: (doc) => doc.id,
    });

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getDocuments();
      setDocuments(data);
    } catch (error) {
      log.error('Error loading documents', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to load documents',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useDataRefresh(['documents'], () => {
    loadDocuments();
  });

  // ============================================================================
  // FILTERING + SORTING + PAGINATION
  // ============================================================================

  const filteredDocuments = useMemo(() => {
    let filtered = [...documents];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (d) =>
          d.title?.toLowerCase().includes(query) ||
          d.description?.toLowerCase().includes(query) ||
          d.tags?.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    if (selectedType !== 'all') {
      filtered = filtered.filter((d) => d.type === selectedType);
    }

    if (selectedStatus !== 'all') {
      filtered = filtered.filter((d) => d.status === selectedStatus);
    }

    if (showOrphansOnly) {
      filtered = filtered.filter((d) => !d.linkedEntityCount || d.linkedEntityCount === 0);
    }

    // Sort
    filtered.sort((a, b) => compareDocuments(a, b, sortState));

    return filtered;
  }, [documents, searchQuery, selectedType, selectedStatus, showOrphansOnly, sortState]);

  const paginatedDocuments = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredDocuments.slice(start, start + pageSize);
  }, [filteredDocuments, pageIndex, pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(selectedIds, paginatedDocuments, (doc) => doc.id);

  // Reset page on filter change
  useEffect(() => {
    setPageIndex(0);
  }, [searchQuery, selectedType, selectedStatus, showOrphansOnly, sortState]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const toggleSort = useCallback((key: string) => {
    const sortKey = key as SortField;
    setSortState((prev) => ({
      key: sortKey,
      direction: prev.key === sortKey && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, []);

  const handleViewDocument = useCallback(
    (document: Document) => {
      openDocumentSheet(document.id);
    },
    [openDocumentSheet]
  );

  /**
   * Request (re)processing through the ONE acknowledged enqueue.
   *
   * UX-036: the row menu's two entry points used two different mechanisms.
   * "Retry" already went through `/api/documents/retry` — atomic claim, one
   * canonical `app/document.process.requested` event, 202 on acknowledgement.
   * "Process" (offered for an `uploaded` document) posted to
   * `/api/documents/process`, which runs the whole pipeline INLINE in the HTTP
   * request with no claim, no event and no acknowledgement. That second path
   * could run concurrently with a live claimed worker run — two writers
   * deleting and recreating the same document's chunks — and its
   * "Processing Complete … N chunks" toast was the client's own guess about a
   * request that may have been aborted mid-pipeline.
   *
   * Both labels now reach this one function, so accepted / running / terminal
   * state comes from the queue and the document, never from the caller.
   * `/api/documents/process` survives as a programmatic/batch endpoint and is
   * no longer reachable from the UI.
   *
   * @param document - The row the operator acted on.
   * @param intent - Which label was clicked; affects only the toast wording.
   */
  const enqueueProcessing = useCallback(
    async (document: Document, intent: 'process' | 'retry') => {
      const queuedTitle = intent === 'retry' ? 'Reprocessing Queued' : 'Processing Queued';
      const refusedTitle = intent === 'retry' ? 'Could not queue reprocessing' : 'Could not queue processing';
      try {
        const acceptance = await retryDocumentProcessing(document.id);
        toast({
          title: queuedTitle,
          description: `"${document.title}" was accepted by the background job queue (event ${acceptance.eventIds[0]}).`,
        });
        loadDocuments();
      } catch (error) {
        log.error('Error queueing document processing', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: refusedTitle,
          description: error instanceof Error ? error.message : 'Failed to queue document processing.',
          variant: 'destructive',
        });
        // The server may have moved the document (e.g. a concurrent run) —
        // resync so the row reflects reality rather than the stale local copy.
        loadDocuments();
      }
    },
    [toast, loadDocuments]
  );

  const handleProcessDocument = useCallback(
    async (document: Document) => {
      await enqueueProcessing(document, 'process');
    },
    [enqueueProcessing]
  );

  /**
   * UX-060: this always hit the authenticated download API, so it could only
   * ever work for documents with stored bytes — which is why the row control
   * was hard-disabled on `!storageUrl` while the detail sheet quietly shipped
   * a metadata stub instead. The shared availability contract now decides what
   * is offered, and the composed export carries the document's REAL extracted
   * text so the file matches the label.
   */
  const handleDownloadDocument = useCallback(
    async (document: Document) => {
      const availability = resolveDocumentContentAvailability(document);
      if (!availability.download.enabled) {
        toast({
          title: 'Nothing to download',
          description: availability.download.hint,
          variant: 'destructive',
        });
        return;
      }

      const saveBlob = (blob: Blob, filename: string) => {
        const url = window.URL.createObjectURL(blob);
        const a = window.document.createElement('a');
        a.href = url;
        a.download = filename;
        window.document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        window.document.body.removeChild(a);
      };

      try {
        if (availability.download.kind === 'original') {
          const response = await fetchWithAuth(`/api/documents/download?id=${document.id}`);

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Download failed');
          }

          const contentDisposition = response.headers.get('Content-Disposition');
          let filename = document.title;
          if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
            if (filenameMatch) {
              filename = filenameMatch[1];
            }
          }

          saveBlob(await response.blob(), filename);
          toast({
            title: 'Download Started',
            description: `Downloading the stored original of "${document.title}".`,
          });
          return;
        }

        const { filename, markdown } = await composeDocumentExport(document);
        saveBlob(
          new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
          filename || documentExportFilename(document.title)
        );
        toast({
          title: 'Download Started',
          description:
            availability.download.kind === 'extracted-text'
              ? `"${document.title}" has no stored file — downloading its extracted text.`
              : `"${document.title}" has no stored file or extracted text — downloading its recorded details.`,
        });
      } catch (error) {
        log.error('Error downloading document', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Download Failed',
          description: error instanceof Error ? error.message : 'Failed to download document.',
          variant: 'destructive',
        });
      }
    },
    [toast]
  );

  /**
   * UX-036: `retryDocumentProcessing` used to be a client-SDK status flip and
   * this toast claimed the work was queued regardless. It now resolves only
   * after the queue ACKNOWLEDGED the event, and rejects with the server's
   * reason otherwise — so both branches finally tell the truth. Shares
   * {@link enqueueProcessing} with the "Process" label so the two menu items
   * cannot drift back into two different mechanisms.
   */
  const handleRetryDocument = useCallback(
    async (document: Document) => {
      await enqueueProcessing(document, 'retry');
    },
    [enqueueProcessing]
  );

  const handleDeleteDocument = useCallback(
    async (document: Document) => {
      try {
        await deleteDocument(document.id);
        toast({
          title: 'Document Deleted',
          description: `"${document.title}" has been permanently deleted.`,
        });
        loadDocuments();
      } catch (error) {
        log.error('Error deleting document', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to delete document. Please try again.',
          variant: 'destructive',
        });
      }
    },
    [toast, loadDocuments]
  );

  const handleRefreshDocument = useCallback(
    async (document: Document) => {
      if (document.type !== 'url') {
        toast({
          title: 'Not Supported',
          description: 'Only URL documents can be refreshed.',
          variant: 'destructive',
        });
        return;
      }

      try {
        const response = await fetchWithAuth('/api/documents/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: document.id }),
        });

        const result = await response.json();

        if (result.success) {
          toast({
            title: 'Refresh Started',
            description: `"${document.title}" is being refreshed. Check back shortly for updates.`,
          });
          // Optimistically mirror the flag the refresh job is about to set so
          // the row shows its spinner immediately; loadDocuments/useDataRefresh
          // reconciles with the real Firestore state afterwards.
          setDocuments((prev) =>
            prev.map((d) => (d.id === document.id ? { ...d, refreshInProgress: true, updatedAt: Date.now() } : d))
          );
        } else {
          toast({
            title: 'Refresh Failed',
            description: result.error || 'Failed to trigger refresh',
            variant: 'destructive',
          });
        }
      } catch (error) {
        log.error('Error refreshing document', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to refresh document. Please try again.',
          variant: 'destructive',
        });
      }
    },
    [toast]
  );

  const handleBulkDelete = useCallback(async () => {
    try {
      await deleteDocuments(selectedIds);
      toast({
        title: 'Documents Deleted',
        description: `Successfully deleted ${selectedIds.length} document${selectedIds.length === 1 ? '' : 's'}.`,
      });
      clearSelection();
      loadDocuments();
    } catch (error) {
      log.error('Bulk delete failed', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete documents. Please try again.',
        variant: 'destructive',
      });
    }
  }, [selectedIds, toast, clearSelection, loadDocuments]);

  const hasActiveFilters = !!searchQuery || selectedType !== 'all' || selectedStatus !== 'all' || showOrphansOnly;

  return {
    // Data
    documents,
    filteredDocuments,
    paginatedDocuments,
    isLoading,
    loadDocuments,

    // View state
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    selectedType,
    setSelectedType,
    selectedStatus,
    setSelectedStatus,
    showOrphansOnly,
    setShowOrphansOnly,
    sortState,
    toggleSort,
    hasActiveFilters,

    // Pagination
    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    // Selection
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    selectedCount,
    isAllSelected,
    isSomeSelected,

    // Sheet
    selectedDocumentId,
    isSheetOpen,
    setIsSheetOpen,
    handleViewDocument,

    // Preview dialog
    previewDocument,
    isPreviewOpen,
    setPreviewOpen,
    handlePreviewDocument,

    // Document actions
    handleProcessDocument,
    handleDownloadDocument,
    handleRetryDocument,
    handleDeleteDocument,
    handleRefreshDocument,

    // Bulk
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  };
}
