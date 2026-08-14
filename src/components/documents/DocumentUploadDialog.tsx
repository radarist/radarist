/**
 * @file DocumentUploadDialog.tsx
 * @description Dialog for uploading documents and extracting entities
 *
 * Features:
 * - Drag-and-drop file upload
 * - Progress indicator during processing
 * - Display extracted entities with confidence scores
 * - One-click import to create relations
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
  Link2,
  FileUp,
  Sparkles,
  Globe,
  AlertCircle,
} from 'lucide-react';
import { ENTITY_ICONS } from '@/lib/entity-icons';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { cn } from '@/lib/utils';
import { useDocumentIngest, SUPPORTED_EXTENSIONS, MAX_FILE_SIZE } from '@/hooks/useDocumentIngest';
import { createRelation } from '@/lib/relations';
import { createSnapshotFromSuggestion, type SuggestedRelation } from '@/lib/auto-linker-utils';
import type { EntityType, EntitySnapshot } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/DocumentUploadDialog');

interface DocumentUploadDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional source entity to link from */
  sourceEntity?: {
    type: EntityType;
    id: string;
    name: string;
    description?: string;
  };
  /** Callback when entities are imported */
  onEntitiesImported?: (count: number) => void;
}

export function DocumentUploadDialog({
  isOpen,
  onOpenChange,
  sourceEntity,
  onEntitiesImported,
}: DocumentUploadDialogProps) {
  const { isProcessing, progress, status, error, result, processDocument, reset } = useDocumentIngest();

  const [isDragging, setIsDragging] = useState(false);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'file' | 'url'>('file');

  // URL input state
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isProcessingUrl, setIsProcessingUrl] = useState(false);
  const [urlSuccess, setUrlSuccess] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  /**
   * Handle file selection
   */
  const handleFileSelect = useCallback(
    (file: File) => {
      processDocument(file);
    },
    [processDocument]
  );

  /**
   * Handle drag events
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  /**
   * Handle file input change
   */
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  /**
   * Validate URL input
   */
  const validateUrl = useCallback((url: string): string | null => {
    if (!url.trim()) {
      return 'Please enter a URL';
    }

    // Add protocol if missing
    let normalizedUrl = url.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    try {
      const parsed = new URL(normalizedUrl);

      // Block dangerous schemes
      const dangerousSchemes = ['javascript:', 'data:', 'file:', 'vbscript:'];
      if (dangerousSchemes.some((s) => parsed.protocol.toLowerCase() === s)) {
        return 'This URL scheme is not allowed';
      }

      // Only allow http/https
      if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
        return 'Only HTTP and HTTPS URLs are supported';
      }

      return null;
    } catch {
      return 'Please enter a valid URL';
    }
  }, []);

  /**
   * Handle URL submission
   */
  const handleUrlSubmit = useCallback(async () => {
    // Validate URL
    const validationError = validateUrl(urlInput);
    if (validationError) {
      setUrlError(validationError);
      return;
    }

    setUrlError(null);
    setIsProcessingUrl(true);

    try {
      // Normalize URL (add protocol if missing)
      let normalizedUrl = urlInput.trim();
      if (!normalizedUrl.match(/^https?:\/\//i)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      const response = await fetchWithAuth('/api/documents/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: normalizedUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409) {
          setUrlError('A document with this URL already exists');
        } else {
          setUrlError(data.error || 'Failed to process URL');
        }
        return;
      }

      setUrlSuccess(true);
      toast({
        title: 'URL added successfully',
        description: 'The document is being processed. You can view it in your library.',
      });

      // Close dialog after short delay
      setTimeout(() => {
        handleClose(false);
      }, 1500);
    } catch (error) {
      log.error('Failed to process URL', error instanceof Error ? error : undefined);
      setUrlError('Failed to process URL. Please try again.');
    } finally {
      setIsProcessingUrl(false);
    }
  }, [urlInput, validateUrl, toast]);

  /**
   * Reset URL state
   */
  const resetUrlState = useCallback(() => {
    setUrlInput('');
    setUrlError(null);
    setIsProcessingUrl(false);
    setUrlSuccess(false);
  }, []);

  /**
   * Import a single entity as a relation
   */
  const handleImport = useCallback(
    async (suggestion: SuggestedRelation) => {
      if (!sourceEntity) {
        toast({
          title: 'No source entity',
          description: 'Please open this dialog from an entity page to create relations.',
          variant: 'destructive',
        });
        return;
      }

      setIsImporting(suggestion.entityId);

      try {
        const sourceSnapshot: EntitySnapshot = {
          type: sourceEntity.type,
          id: sourceEntity.id,
          name: sourceEntity.name,
          description: sourceEntity.description,
          snapshotAt: Date.now(),
        };

        const targetSnapshot = createSnapshotFromSuggestion(suggestion);

        await createRelation({
          relationType: suggestion.relationType,
          sourceSnapshot,
          targetSnapshot,
          confidence: suggestion.confidence,
          aiSuggested: true,
        });

        setImportedIds((prev) => new Set([...prev, suggestion.entityId]));

        toast({
          title: 'Entity linked',
          description: `Created relation to ${suggestion.entityName}`,
        });
      } catch (err) {
        log.error('Failed to create relation', err instanceof Error ? err : undefined);
        toast({
          title: 'Import failed',
          description: 'Failed to create relation. Please try again.',
          variant: 'destructive',
        });
      } finally {
        setIsImporting(null);
      }
    },
    [sourceEntity, toast]
  );

  /**
   * Import all suggestions
   */
  const handleImportAll = useCallback(async () => {
    if (!result?.suggestions || !sourceEntity) return;

    const unimported = result.suggestions.filter((s) => !importedIds.has(s.entityId));

    for (const suggestion of unimported) {
      await handleImport(suggestion);
    }

    onEntitiesImported?.(unimported.length);
  }, [result, sourceEntity, importedIds, handleImport, onEntitiesImported]);

  /**
   * Reset and close dialog
   */
  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) {
        reset();
        setImportedIds(new Set());
        resetUrlState();
        setActiveTab('file');
      }
      onOpenChange(open);
    },
    [reset, onOpenChange, resetUrlState]
  );

  const suggestionsCount = result?.suggestions?.length || 0;
  const importedCount = importedIds.size;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5" />
            Import Document
          </DialogTitle>
          <DialogDescription>
            Upload a file or add a web page URL. AI will extract entities and knowledge.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs for File/URL - only show when not processing/showing results */}
        {!result && !isProcessing && !urlSuccess && (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'file' | 'url')} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="file" className="gap-2">
                <Upload className="h-4 w-4" />
                Upload File
              </TabsTrigger>
              <TabsTrigger value="url" className="gap-2">
                <Globe className="h-4 w-4" />
                From URL
              </TabsTrigger>
            </TabsList>

            {/* File Upload Tab */}
            <TabsContent value="file" className="mt-4">
              <div
                className={cn(
                  'border-2 border-dashed rounded-lg p-8 transition-colors cursor-pointer',
                  'hover:border-primary/50 hover:bg-muted/50',
                  isDragging && 'border-primary bg-primary/5',
                  error && 'border-destructive'
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={SUPPORTED_EXTENSIONS.join(',')}
                  onChange={handleInputChange}
                  className="hidden"
                />

                <div className="flex flex-col items-center text-center">
                  <Upload className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium mb-1">Drag & drop a document here</p>
                  <p className="text-sm text-muted-foreground mb-4">or click to browse</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">PDF</Badge>
                    <Badge variant="outline">DOCX</Badge>
                    <Badge variant="outline">PPTX</Badge>
                    <span>• Max {MAX_FILE_SIZE / 1024 / 1024}MB</span>
                  </div>
                </div>
              </div>

              {/* File Error Message */}
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mt-4">
                  <XCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
            </TabsContent>

            {/* URL Input Tab */}
            <TabsContent value="url" className="mt-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="url-input">Web Page URL</Label>
                  <Input
                    id="url-input"
                    type="url"
                    placeholder="https://example.com/article"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      setUrlError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isProcessingUrl) {
                        handleUrlSubmit();
                      }
                    }}
                    disabled={isProcessingUrl}
                    className={cn(urlError && 'border-destructive')}
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter a URL to import content from a web page. The page content will be extracted and processed.
                  </p>
                </div>

                {/* URL Error Message */}
                {urlError && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {urlError}
                  </div>
                )}

                {/* Submit Button */}
                <Button onClick={handleUrlSubmit} disabled={isProcessingUrl || !urlInput.trim()} className="w-full">
                  {isProcessingUrl ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Globe className="h-4 w-4 mr-2" />
                      Import from URL
                    </>
                  )}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        )}

        {/* URL Success State */}
        {urlSuccess && (
          <div className="py-8 flex flex-col items-center text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
            <p className="text-lg font-medium">URL Added Successfully</p>
            <p className="text-sm text-muted-foreground mt-2">
              The document is being processed and will appear in your library shortly.
            </p>
          </div>
        )}

        {/* File Error Message (outside tabs, for processing errors) */}
        {error && isProcessing && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <XCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Processing State */}
        {isProcessing && (
          <div className="py-8">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm font-medium">{status}</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* File Info */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 mb-4">
              <FileText className="h-8 w-8 text-primary" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{result.fileName}</p>
                <p className="text-xs text-muted-foreground">
                  {result.pageCount ? `${result.pageCount} pages • ` : ''}
                  {(result.fileSize / 1024).toFixed(1)} KB • {result.textLength.toLocaleString()} characters extracted
                </p>
              </div>
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>

            {/* Suggestions Header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="font-medium">{suggestionsCount} Entities Found</span>
                {importedCount > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {importedCount} imported
                  </Badge>
                )}
              </div>
              {suggestionsCount > 0 && importedCount < suggestionsCount && sourceEntity && (
                <Button variant="outline" size="sm" onClick={handleImportAll} className="gap-1">
                  <Link2 className="h-3 w-3" />
                  Import All
                </Button>
              )}
            </div>

            {/* Suggestions List */}
            <ScrollArea className="flex-1 -mx-6 px-6">
              {suggestionsCount === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  <p>No matching entities found in this document.</p>
                  <p className="text-sm mt-1">Try a document with more technology or company mentions.</p>
                </div>
              ) : (
                <div className="space-y-2 pb-4">
                  {result.suggestions.map((suggestion) => {
                    const Icon = ENTITY_ICONS[suggestion.entityType];
                    const colors = ENTITY_COLORS[suggestion.entityType];
                    const isImported = importedIds.has(suggestion.entityId);
                    const isCurrentlyImporting = isImporting === suggestion.entityId;

                    return (
                      <div
                        key={suggestion.entityId}
                        className={cn(
                          'flex items-center gap-3 p-3 rounded-lg border',
                          colors.text,
                          colors.bg,
                          colors.border,
                          isImported && 'opacity-60'
                        )}
                      >
                        <Icon className="h-5 w-5 shrink-0" />

                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{suggestion.entityName}</div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="capitalize">{suggestion.entityType}</span>
                            <span>•</span>
                            <span
                              className={cn(
                                suggestion.confidence >= 80
                                  ? 'text-green-600'
                                  : suggestion.confidence >= 60
                                    ? 'text-amber-600'
                                    : ''
                              )}
                            >
                              {suggestion.confidence}% match
                            </span>
                            {suggestion.context && (
                              <>
                                <span>•</span>
                                <span className="truncate italic">"{suggestion.context}"</span>
                              </>
                            )}
                          </div>
                        </div>

                        {isImported ? (
                          <Badge variant="secondary" className="shrink-0">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Imported
                          </Badge>
                        ) : sourceEntity ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1"
                            onClick={() => handleImport(suggestion)}
                            disabled={isCurrentlyImporting}
                          >
                            {isCurrentlyImporting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Link2 className="h-3 w-3" />
                            )}
                            Link
                          </Button>
                        ) : (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            Found
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            {/* Upload Another */}
            <div className="pt-4 border-t mt-auto">
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  setImportedIds(new Set());
                }}
                className="w-full"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Another Document
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
