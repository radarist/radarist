'use client';

/**
 * @file DocumentUploadButton/index.tsx
 * @description Button and dialog for uploading documents to the Evidence Layer.
 *
 * Features:
 * - Multi-file upload (up to 5 files at once)
 * - Drag-and-drop file upload
 * - Progress indicator during upload
 * - AI autocomplete for title and description
 * - Automatic processing trigger via Inngest
 * - Support for PDF, DOCX, PPTX, TXT, MD files
 * - URL import for web pages
 *
 * NOTE: This component has its own upload logic separate from useDocumentIngest.
 * useDocumentIngest handles single-file ingestion with text extraction (via /api/documents/ingest),
 * while this component handles batch upload to the Evidence Layer (via /api/documents/upload)
 * with metadata editing and entity linking.
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-09
 * @updated 2026-03-24 - Decomposed into sub-components
 */

import React, { useState, useCallback } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, FileUp, Globe, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { documentKeys, entityDocumentLinkKeys } from '@/lib/query-keys';
import { createEntityDocumentLink } from '@/lib/entity-document-link-service';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

import type { DocumentUploadButtonProps, FileUploadItem, EntitySelection } from './types';
import { SUPPORTED_EXTENSIONS, SUPPORTED_MIME_TYPES, MAX_FILE_SIZE, MAX_FILES, ENTITY_TYPE_MAP } from './types';
import { generateId, generateAIMetadata } from './utils';
import { DropZone } from './DropZone';
import { FileItemCard } from './FileItemCard';
import { UrlImportTab } from './UrlImportTab';
import { UploadFooter } from './UploadFooter';

export type { DocumentUploadButtonProps };

const log = createLogger('ui/DocumentUploadButton');

export function DocumentUploadButton({
  variant = 'default',
  size = 'default',
  label = 'Upload Document',
  showIcon = true,
  className,
  onUploadComplete,
}: DocumentUploadButtonProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<FileUploadItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [completedCount, setCompletedCount] = useState(0);
  const [activeTab, setActiveTab] = useState<'file' | 'url'>('file');

  // Reset state when dialog opens/closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isUploading) {
        setFiles([]);
        setGlobalError(null);
        setCompletedCount(0);
        setActiveTab('file');
      }
      setIsOpen(open);
    },
    [isUploading]
  );

  // Validate file
  const validateFile = useCallback((file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) {
      return `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`;
    }

    // Firestore-fallback size cap. When NEXT_PUBLIC_USE_FIRESTORE_STORAGE is
    // 'true' (i.e. Firebase Storage isn't configured and the upload would
    // fall back to base64-in-Firestore), files >900 KB get rejected
    // server-side after a wasted round-trip and base64 conversion. Fail fast
    // here so the user gets an immediate, actionable message. See
    // src/lib/document-storage-service.ts (uploadToFirestoreFallback).
    if (process.env.NEXT_PUBLIC_USE_FIRESTORE_STORAGE === 'true' && file.size > 900 * 1024) {
      return `File too large for Firestore-fallback storage (${(file.size / 1024).toFixed(0)} KB > 900 KB cap). Configure Firebase Storage in the Firebase Console to upload larger files, or unset NEXT_PUBLIC_USE_FIRESTORE_STORAGE.`;
    }

    const extension = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
      return `Unsupported file type. Supported types: ${SUPPORTED_EXTENSIONS.join(', ')}`;
    }

    if (!SUPPORTED_MIME_TYPES.includes(file.type) && !file.type.startsWith('text/')) {
      return `Unsupported file type: ${file.type}`;
    }

    return null;
  }, []);

  // Generate AI metadata for a specific file
  const generateAIMetadataForFile = useCallback(async (fileId: string, fileName: string) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, aiGenerating: true } : f)));

    try {
      const metadata = await generateAIMetadata(fileName);
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                title: metadata.title || f.title,
                description: metadata.description || f.description,
                tags: metadata.tags || f.tags,
                aiGenerating: false,
              }
            : f
        )
      );
    } catch {
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, aiGenerating: false } : f)));
    }
  }, []);

  // Handle file selection (supports multiple files)
  const handleFilesSelect = useCallback(
    async (selectedFiles: FileList | File[]) => {
      const fileArray = Array.from(selectedFiles);
      const currentCount = files.length;
      const availableSlots = MAX_FILES - currentCount;

      if (fileArray.length > availableSlots) {
        setGlobalError(`Can only upload ${MAX_FILES} files at once. ${availableSlots} slot(s) remaining.`);
        return;
      }

      setGlobalError(null);

      const newFiles: FileUploadItem[] = [];
      const errors: string[] = [];

      for (const file of fileArray) {
        const error = validateFile(file);
        if (error) {
          errors.push(`${file.name}: ${error}`);
          continue;
        }

        // Check for duplicates
        if (files.some((f) => f.file.name === file.name && f.file.size === file.size)) {
          errors.push(`${file.name}: Already added`);
          continue;
        }

        newFiles.push({
          id: generateId(),
          file,
          title: file.name.replace(/\.[^/.]+$/, ''),
          description: '',
          tags: '',
          status: 'pending',
          progress: 0,
          entitySelection: { companies: [], technologies: [], useCases: [] },
        });
      }

      if (errors.length > 0) {
        setGlobalError(errors.join('\n'));
      }

      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);

        // Trigger AI autocomplete for each new file
        for (const fileItem of newFiles) {
          generateAIMetadataForFile(fileItem.id, fileItem.file.name);
        }
      }
    },
    [files, validateFile, generateAIMetadataForFile]
  );

  // Update file metadata
  const updateFileMetadata = useCallback((fileId: string, field: 'title' | 'description' | 'tags', value: string) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, [field]: value } : f)));
  }, []);

  // Update entity selection for a file
  const updateEntitySelection = useCallback(
    (fileId: string, entityType: keyof EntitySelection, selectedIds: string[]) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                entitySelection: { ...f.entitySelection, [entityType]: selectedIds },
              }
            : f
        )
      );
    },
    []
  );

  // Remove file from list
  const removeFile = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  // Upload all documents
  const handleUploadAll = useCallback(async () => {
    const pendingFiles = files.filter((f) => f.status === 'pending');
    if (pendingFiles.length === 0) return;

    setIsUploading(true);
    setCompletedCount(0);

    for (let i = 0; i < pendingFiles.length; i++) {
      const fileItem = pendingFiles[i];

      // Update status to uploading
      setFiles((prev) => prev.map((f) => (f.id === fileItem.id ? { ...f, status: 'uploading', progress: 10 } : f)));

      try {
        const formData = new FormData();
        formData.append('file', fileItem.file);
        formData.append('title', fileItem.title || fileItem.file.name);
        if (fileItem.description) formData.append('description', fileItem.description);
        if (fileItem.tags) formData.append('tags', fileItem.tags);
        formData.append('userId', user?.uid || 'anonymous');
        formData.append('processAsync', 'true');

        setFiles((prev) => prev.map((f) => (f.id === fileItem.id ? { ...f, progress: 30 } : f)));

        const response = await fetchWithAuth('/api/documents/upload', {
          method: 'POST',
          body: formData,
        });

        setFiles((prev) => prev.map((f) => (f.id === fileItem.id ? { ...f, progress: 70 } : f)));

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to upload document');
        }

        const uploadedDocId = data.document.id;

        // Create entity links if any were selected
        const allLinks = (Object.keys(ENTITY_TYPE_MAP) as Array<keyof EntitySelection>).flatMap((key) =>
          fileItem.entitySelection[key].map((id) => ({
            entityType: ENTITY_TYPE_MAP[key],
            entityId: id,
          }))
        );

        // Create links in parallel
        if (allLinks.length > 0) {
          setFiles((prev) => prev.map((f) => (f.id === fileItem.id ? { ...f, progress: 85 } : f)));

          const linkResults = await Promise.all(
            allLinks.map(({ entityType, entityId }) =>
              createEntityDocumentLink({
                entityType,
                entityId,
                documentId: uploadedDocId,
                relationshipType: 'documentation',
                relevance: 'medium',
                tags: [],
                createdBy: user?.uid || 'anonymous',
                workspaceId: 'default',
              }).catch((err) => {
                log.warn('Failed to create entity-document link', {
                  entityType,
                  entityId,
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              })
            )
          );

          // GRAPH-069: a committed link whose graph handoff was not
          // acknowledged is recoverable, not silent. Reconciliation converges
          // it, but the upload log must still say it happened.
          const pendingGraphLinks = linkResults.filter(
            (result) => result !== null && result.graphHandoff.status !== 'acknowledged'
          ).length;
          if (pendingGraphLinks > 0) {
            log.warn('Uploaded document has links whose graph projection is pending reconciliation', {
              documentId: uploadedDocId,
              pendingGraphLinks,
              totalLinks: allLinks.length,
            });
          }

          // Invalidate entity-document link queries
          queryClient.invalidateQueries({ queryKey: entityDocumentLinkKeys.all });
        }

        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileItem.id
              ? {
                  ...f,
                  status: 'success',
                  progress: 100,
                  uploadedDocumentId: uploadedDocId,
                }
              : f
          )
        );
        setCompletedCount((c) => c + 1);

        // Notify parent
        onUploadComplete?.({
          id: data.document.id,
          title: data.document.title,
          type: data.document.type,
          status: data.document.status,
        });
      } catch (error) {
        // Inline the error message in the log string. Next.js Turbopack's
        // error overlay collapses object args to `{}`, so the second + third
        // args (error, data) only appear if the developer opens the real
        // browser DevTools console. The string survives the overlay's
        // collapsing and surfaces the actual reason (e.g. "File too large
        // for Firestore fallback (max ~900KB)").
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Upload error: ${errMsg}`, error, {
          fileName: fileItem.file.name,
          fileSize: fileItem.file.size,
          fileType: fileItem.file.type,
        });
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileItem.id
              ? {
                  ...f,
                  status: 'error',
                  progress: 0,
                  error: error instanceof Error ? error.message : 'Failed to upload',
                }
              : f
          )
        );
      }
    }

    setIsUploading(false);

    // Invalidate queries to refresh the list
    queryClient.invalidateQueries({ queryKey: documentKeys.all });

    const successCount =
      files.filter((f) => f.status === 'success').length +
      pendingFiles.length -
      files.filter((f) => f.status === 'error').length;
    if (successCount > 0) {
      toast.success(`${successCount} document${successCount > 1 ? 's' : ''} uploaded`, {
        description: 'Processing will begin shortly.',
      });
    }

    // Close dialog after a short delay if all succeeded
    const allSucceeded = files.every((f) => f.status === 'success' || f.status === 'pending');
    if (allSucceeded) {
      setTimeout(() => {
        handleOpenChange(false);
      }, 1500);
    }
  }, [files, user, queryClient, onUploadComplete, handleOpenChange]);

  const pendingCount = files.filter((f) => f.status === 'pending').length;
  const successCount = files.filter((f) => f.status === 'success').length;
  const errorCount = files.filter((f) => f.status === 'error').length;
  const canAddMore = files.length < MAX_FILES;
  const hasFiles = files.length > 0;
  // Icon-only usage (e.g. the Documents library header) has no visible text
  // naming the action — give it a real Tooltip instead of relying on the
  // native `title` attribute, matching the rest of the redesigned header
  // (e.g. the Orphans filter button).
  const isIconOnly = showIcon && !label;

  return (
    <>
      {isIconOnly ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={variant}
                size={size}
                onClick={() => setIsOpen(true)}
                className={className}
                aria-label="Upload documents"
              >
                <Upload className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Upload documents</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Button
          variant={variant}
          size={size}
          onClick={() => setIsOpen(true)}
          className={className}
          title="Upload Documents"
        >
          {showIcon && <Upload className={cn('h-4 w-4', label && 'mr-2')} />}
          {label}
        </Button>
      )}

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="h-5 w-5" />
              Upload Documents
            </DialogTitle>
            <DialogDescription>Upload files or add a web page URL. AI will help fill in metadata.</DialogDescription>
          </DialogHeader>

          {/* Tabs for File/URL - only show when not uploading and no files yet */}
          {!hasFiles && !isUploading && (
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'file' | 'url')} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="file" className="gap-2">
                  <Upload className="h-4 w-4" />
                  Upload Files
                </TabsTrigger>
                <TabsTrigger value="url" className="gap-2">
                  <Globe className="h-4 w-4" />
                  From URL
                </TabsTrigger>
              </TabsList>

              {/* File Upload Tab */}
              <TabsContent value="file" className="mt-4">
                <DropZone
                  isDragging={isDragging}
                  onDragStateChange={setIsDragging}
                  onFilesSelect={handleFilesSelect}
                  currentFileCount={files.length}
                />
              </TabsContent>

              {/* URL Input Tab */}
              <TabsContent value="url" className="mt-4">
                <UrlImportTab onUploadComplete={onUploadComplete} onCloseDialog={() => handleOpenChange(false)} />
              </TabsContent>
            </Tabs>
          )}

          {/* File Upload Area (when files are already added, to add more) */}
          {hasFiles && canAddMore && !isUploading && (
            <DropZone
              isDragging={isDragging}
              onDragStateChange={setIsDragging}
              onFilesSelect={handleFilesSelect}
              currentFileCount={files.length}
              compact
            />
          )}

          {/* Global Error */}
          {globalError && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <pre className="whitespace-pre-wrap text-xs">{globalError}</pre>
            </div>
          )}

          {/* Files List */}
          {hasFiles && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-2" style={{ maxHeight: 'calc(85vh - 280px)' }}>
              <div className="space-y-3 py-2 pr-2">
                {files.map((fileItem) => (
                  <FileItemCard
                    key={fileItem.id}
                    fileItem={fileItem}
                    isUploading={isUploading}
                    onRemove={removeFile}
                    onMetadataChange={updateFileMetadata}
                    onEntitySelectionChange={updateEntitySelection}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          {hasFiles && (
            <UploadFooter
              isUploading={isUploading}
              pendingCount={pendingCount}
              successCount={successCount}
              errorCount={errorCount}
              totalCount={files.length}
              completedCount={completedCount}
              onUpload={handleUploadAll}
              onClose={() => handleOpenChange(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
