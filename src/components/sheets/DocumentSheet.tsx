'use client';

/**
 * @file components/sheets/DocumentSheet.tsx
 * @description Sheet component for viewing document details and chunks.
 * Part of the Evidence Layer (Phase 2).
 *
 * Features:
 * - Document metadata display
 * - Processing status with error handling
 * - Chunks viewer for processed documents
 * - Actions: process, retry, delete
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-09
 */

import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  FileType,
  Link,
  Link2,
  Calendar,
  HardDrive,
  Layers,
  AlertCircle,
  RefreshCw,
  Trash2,
  Play,
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  User,
  Copy,
  Building2,
  Cpu,
  Target,
  Lightbulb,
  Radio,
  Workflow,
  Plus,
  Download,
  Gauge,
} from 'lucide-react';
import { toast } from 'sonner';

import { EntitySheetShell } from './EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from './EntitySheetTabs';
import { EntityDetailSkeleton } from './EntitySheetSkeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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

import { getDocumentById, deleteDocument, retryDocumentProcessing } from '@/lib/document-service';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { getActiveChunksForDocument } from '@/lib/document-chunk-service';
import { resolveDocumentContentAvailability } from '@/lib/document-content-availability';
import { composeDocumentExport, documentExportFilename } from '@/lib/document-content-export';
import {
  canRequestProcessing,
  describeProcessingState,
  hasReprocessableSource,
  isProcessingStalled,
} from '@/lib/document-processing-policy';
import { describeDeepResearchProgress } from '@/lib/research/deep-research-progress';
import { getLinksForDocument, deleteEntityDocumentLink } from '@/lib/entity-document-link-service';
import { LinkEntityForm } from '@/components/knowledge/LinkEntityForm';
import { documentKeys, entityDocumentLinkKeys } from '@/lib/query-keys';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import type {
  Document,
  DocumentStatus,
  DocumentType,
  DocumentChunk,
  EntityDocumentLink,
  TransformationEntityType,
} from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface DocumentSheetProps {
  /** Document ID to display */
  documentId: string | null;
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Callback when document is deleted */
  onDelete?: () => void;
  /** Callback when processing starts */
  onProcess?: (documentId: string) => void;
  /** Callback after a reprocessing request was ACCEPTED by the queue. */
  onProcessingQueued?: () => void;
}

// ============================================================================
// STATUS CONFIGURATION
// ============================================================================

const statusConfig: Record<DocumentStatus, { label: string; icon: React.ElementType; color: string }> = {
  uploaded: {
    label: 'Pending',
    icon: Clock,
    color: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  },
  processing: {
    label: 'Processing',
    icon: Loader2,
    color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
  processed: {
    label: 'Processed',
    icon: CheckCircle2,
    color: 'bg-green-500/10 text-green-600 dark:text-green-400',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    color: 'bg-red-500/10 text-red-600 dark:text-red-400',
  },
  blocked: {
    label: 'Blocked',
    icon: AlertCircle,
    color: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  },
};

const typeConfig: Record<DocumentType, { label: string; color: string }> = {
  pdf: { label: 'PDF', color: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  docx: { label: 'DOCX', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  pptx: { label: 'PPTX', color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  url: { label: 'URL', color: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
  transcript: { label: 'Transcript', color: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' },
  markdown: { label: 'Markdown', color: 'bg-muted text-muted-foreground' },
  text: { label: 'Text', color: 'bg-slate-500/10 text-slate-600 dark:text-slate-400' },
  'deep-research': { label: 'Deep Research', color: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
};

// ============================================================================
// STATUS BADGE
// ============================================================================

function DocumentStatusBadge({ document, className }: { document: Document; className?: string }) {
  // UX-036: a `processing` status nothing has reported back on is STALLED, not
  // running — the shared policy owns that call so the sheet, the table and the
  // grid cannot disagree about the same document.
  const stalled = isProcessingStalled(document);
  const config = statusConfig[document.status];
  const Icon = stalled ? AlertCircle : config.icon;
  const { label } = describeProcessingState(document);

  return (
    <Badge
      variant="outline"
      data-testid="document-sheet-status"
      data-status={stalled ? 'stalled' : document.status}
      className={cn(
        'gap-1',
        stalled ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : config.color,
        className
      )}
    >
      <Icon className={cn('h-3 w-3', document.status === 'processing' && !stalled && 'animate-spin')} />
      {label}
    </Badge>
  );
}

function DocumentTypeBadge({ type, className }: { type: DocumentType; className?: string }) {
  const config = typeConfig[type];

  return (
    <Badge variant="outline" className={cn(config.color, className)}>
      {config.label}
    </Badge>
  );
}

// ============================================================================
// PROBLEM PANEL
// ============================================================================

/**
 * The single place the sheet explains why a document is not usable.
 *
 * UX-036/UX-060: the previous panel fired only on
 * `status === 'failed' && errorMessage`, and the processing pipeline never
 * wrote `errorMessage` — so it could not appear at all. `blocked` documents
 * (TDM opt-out, paywall) recorded their reason in `fetchError`, which nothing
 * rendered. A stalled run had no explanation anywhere.
 */
function DocumentProblemPanel({ document }: { document: Document }) {
  const stalled = isProcessingStalled(document);
  const reason = document.errorMessage?.trim() || document.fetchError?.trim();

  if (document.status === 'failed') {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4" data-testid="document-problem">
        <div className="flex gap-2">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          <div>
            <p className="font-medium text-destructive">Processing failed</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {reason || 'No reason was recorded for this failure. Retry to capture one.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (document.status === 'blocked') {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4" data-testid="document-problem">
        <div className="flex gap-2">
          <AlertCircle className="h-5 w-5 text-muted-foreground shrink-0" />
          <div>
            <p className="font-medium">Blocked at the source</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {reason || 'The source refused access to this content.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (stalled) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" data-testid="document-problem">
        <div className="flex gap-2">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div>
            <p className="font-medium">Processing stalled</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No progress has been reported for this run. It may have been interrupted — retry to queue it again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ============================================================================
// DEEP RESEARCH PROGRESS (PRODUCT-003)
// ============================================================================

const PROGRESS_TONE_CLASS: Record<string, string> = {
  running: 'border-border bg-muted/40',
  stalled: 'border-amber-500/40 bg-amber-500/10',
  unavailable: 'border-border bg-muted/40',
  done: 'border-border bg-muted/40',
  error: 'border-destructive/50 bg-destructive/10',
};

/**
 * PRODUCT-003 — what the Deep Research PROVIDER reported about this run.
 *
 * A visible deep-research run spent about nine minutes showing nothing but
 * "Processing" because the Interactions-API poll response — which carries the
 * raw interaction status and the agent's own `steps[]` — was read only to
 * branch on completed/failed and then discarded.
 *
 * Everything rendered here is either a provider fact or an explicitly labelled
 * measurement of our own polling. There is no progress bar, no percentage and
 * no ETA: the provider reports neither a total step count nor a duration, so
 * all three would be invented.
 */
function DeepResearchProgressPanel({ document }: { document: Document }) {
  const progress = document.deepResearchProgress;
  if (!progress) return null;
  const described = describeDeepResearchProgress(progress);

  return (
    <div
      className={cn('rounded-lg border p-4', PROGRESS_TONE_CLASS[described.tone] ?? 'border-border bg-muted/40')}
      data-testid="deep-research-progress"
    >
      <p className="font-medium" data-testid="deep-research-progress-headline">
        {described.headline}
      </p>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="deep-research-progress-detail">
        {described.detail}
      </p>
      {progress.steps.length > 0 && (
        <ol className="mt-3 space-y-1 text-xs text-muted-foreground" data-testid="deep-research-progress-steps">
          {progress.steps.map((step) => (
            <li key={step.index}>
              {/* The provider's own step type, verbatim. A step it did not type
                  stays untyped rather than being given an invented name. */}
              {step.index + 1}. {step.type ?? 'step type not reported'}
            </li>
          ))}
        </ol>
      )}
      {progress.resumable && progress.terminal?.state === 'timed-out' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="deep-research-progress-resumable">
          This research task can still be checked again — it was not cancelled.
        </p>
      )}
    </div>
  );
}

// ============================================================================
// METADATA ITEM
// ============================================================================

function MetadataItem({
  icon: Icon,
  label,
  value,
  copyable,
  link,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  copyable?: string;
  link?: string;
}) {
  const handleCopy = () => {
    if (copyable) {
      navigator.clipboard.writeText(copyable);
      toast.success('Copied to clipboard');
    }
  };

  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="flex items-center gap-2">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline truncate flex items-center gap-1"
            >
              {value}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <p className="text-sm truncate">{value || '—'}</p>
          )}
          {copyable && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={handleCopy}
              aria-label={`Copy ${label}`}
              title={`Copy ${label}`}
            >
              <Copy className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// OVERVIEW TAB
// ============================================================================

function OverviewTab({ document }: { document: Document }) {
  return (
    <div className="space-y-6">
      {/* Status and Type */}
      <div className="flex items-center gap-2">
        <DocumentStatusBadge document={document} />
        <DocumentTypeBadge type={document.type} />
      </div>

      {/* Why it is not processed. Covers `failed` AND `blocked` and reads
          `fetchError` as well as `errorMessage` — `fetchError` was written by
          four call sites and rendered by none, so a TDM-blocked document used
          to show a bare badge with the reason sitting unread in Firestore. */}
      <DocumentProblemPanel document={document} />
      <DeepResearchProgressPanel document={document} />

      {/* Description */}
      {document.description && (
        <div>
          <h3 className="text-sm font-medium mb-2">Description</h3>
          <p className="text-sm text-muted-foreground">{document.description}</p>
        </div>
      )}

      {/* Measured metrics (evaluation artifacts — mirrors verdict.json metrics) */}
      {document.structuredMetrics && document.structuredMetrics.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            Measured metrics
          </h3>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Command</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {document.structuredMetrics.map((metric, index) => (
                  <TableRow key={`${metric.name}-${index}`}>
                    <TableCell className="font-medium">{metric.name}</TableCell>
                    <TableCell>{metric.value}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{metric.command ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Separator />

      {/* Metadata */}
      <div>
        <h3 className="text-sm font-medium mb-2">Details</h3>
        <div className="space-y-1">
          <MetadataItem
            icon={FileType}
            label="File Type"
            value={document.mimeType || typeConfig[document.type].label}
          />
          {document.fileSize && (
            <MetadataItem icon={HardDrive} label="File Size" value={formatBytes(document.fileSize)} />
          )}
          {document.chunkCount !== undefined && document.chunkCount > 0 && (
            <MetadataItem icon={Layers} label="Chunks" value={`${document.chunkCount} chunks extracted`} />
          )}
          {document.originalUrl && (
            <MetadataItem
              icon={Link}
              label="Original URL"
              value={document.originalUrl}
              link={document.originalUrl}
              copyable={document.originalUrl}
            />
          )}
          <MetadataItem icon={User} label="Uploaded By" value={document.uploadedBy} />
        </div>
      </div>

      <Separator />

      {/* Timestamps */}
      <div>
        <h3 className="text-sm font-medium mb-2">Timeline</h3>
        <div className="space-y-1">
          <MetadataItem icon={Calendar} label="Created" value={formatRelativeTime(document.createdAt)} />
          {document.processedAt && (
            <MetadataItem icon={CheckCircle2} label="Processed" value={formatRelativeTime(document.processedAt)} />
          )}
          <MetadataItem icon={Clock} label="Last Updated" value={formatRelativeTime(document.updatedAt)} />
        </div>
      </div>

      {/* Tags */}
      {document.tags && document.tags.length > 0 && (
        <>
          <Separator />
          <div>
            <h3 className="text-sm font-medium mb-2">Tags</h3>
            <div className="flex flex-wrap gap-2">
              {document.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// CHUNKS TAB
// ============================================================================

function ChunkCard({ chunk, index }: { chunk: DocumentChunk; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const content = chunk.content;
  const isLong = content.length > 300;
  const displayContent = expanded || !isLong ? content : content.slice(0, 300) + '...';

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            Chunk {index + 1}
          </Badge>
          {chunk.metadata.page && (
            <Badge variant="secondary" className="text-xs">
              Page {chunk.metadata.page}
            </Badge>
          )}
        </div>
        {chunk.tokenCount && <span className="text-xs text-muted-foreground">~{chunk.tokenCount} tokens</span>}
      </div>
      <p className="text-sm whitespace-pre-wrap">{displayContent}</p>
      {isLong && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} className="text-xs">
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

/**
 * UX-060: this tab used `getChunksForDocument` (EVERY chunk, including
 * archived generations) while the Preview dialog used
 * `getActiveChunksForDocument` (current generation only). The same document
 * could therefore list 46 chunks here and render the text of 23 there. Both
 * now read the current generation through the same call.
 */
function ChunksTab({ documentId }: { documentId: string }) {
  const {
    data: chunks,
    isLoading,
    error,
  } = useQuery({
    queryKey: documentKeys.chunks(documentId),
    queryFn: () => getActiveChunksForDocument(documentId),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <div className="h-4 w-24 bg-muted animate-pulse rounded" />
            <div className="h-20 bg-muted animate-pulse rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <AlertCircle className="h-8 w-8 mx-auto mb-2" />
        <p>Failed to load chunks</p>
      </div>
    );
  }

  if (!chunks || chunks.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Layers className="h-8 w-8 mx-auto mb-2" />
        <p>No chunks extracted yet</p>
        <p className="text-xs mt-1">Process the document to extract chunks</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[400px]">
      <div className="space-y-4 pr-4">
        {chunks.map((chunk, index) => (
          <ChunkCard key={chunk.id} chunk={chunk} index={index} />
        ))}
      </div>
    </ScrollArea>
  );
}

// ============================================================================
// LINKS TAB
// ============================================================================

/** Configuration for entity type display */
const entityTypeConfig: Record<
  TransformationEntityType,
  {
    label: string;
    icon: React.ElementType;
    color: string;
  }
> = {
  technology: { label: 'Technology', icon: Cpu, color: 'text-emerald-500' },
  company: { label: 'Company', icon: Building2, color: 'text-blue-500' },
  useCase: { label: 'Use Case', icon: Target, color: 'text-yellow-500' },
  strategy: { label: 'Strategy', icon: Workflow, color: 'text-purple-500' },
  prototype: { label: 'Prototype', icon: Lightbulb, color: 'text-green-500' },
  signal: { label: 'Signal', icon: Radio, color: 'text-orange-500' },
  org_unit: { label: 'Org Unit', icon: Building2, color: 'text-slate-500' },
  initiative: { label: 'Initiative', icon: Target, color: 'text-cyan-500' },
  pain_point: { label: 'Pain Point', icon: AlertCircle, color: 'text-red-500' },
  document: { label: 'Document', icon: FileText, color: 'text-muted-foreground' },
};

/** Relationship type labels */
const relationshipTypeLabels: Record<string, string> = {
  documentation: 'Documentation',
  pitch_deck: 'Pitch Deck',
  technical_spec: 'Technical Spec',
  case_study: 'Case Study',
  research_paper: 'Research Paper',
  competitive_intel: 'Competitive Intel',
  contract: 'Contract',
  evidence: 'Evidence',
  other: 'Other',
};

/** Relevance badge styles */
const relevanceStyles: Record<string, string> = {
  high: 'bg-green-500/10 text-green-600 dark:text-green-400',
  medium: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  low: 'bg-muted text-muted-foreground',
};

function LinkCard({
  link,
  onDelete,
  isDeleting,
}: {
  link: EntityDocumentLink;
  onDelete?: (linkId: string) => void;
  isDeleting?: boolean;
}) {
  const config = entityTypeConfig[link.entityType] || entityTypeConfig.document;
  const Icon = config.icon;

  return (
    <div className="rounded-lg border p-4 space-y-3 hover:bg-accent/5 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn('shrink-0', config.color)}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {link.entityType.charAt(0).toUpperCase() + link.entityType.slice(1)}
            </p>
            <p className="text-xs text-muted-foreground truncate font-mono">{link.entityId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className={cn(relevanceStyles[link.relevance])}>
            {link.relevance}
          </Badge>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(link.id)}
              disabled={isDeleting}
              aria-label={`Remove ${config.label} link ${link.entityId}`}
              title={`Remove ${config.label} link ${link.entityId}`}
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary" className="text-xs">
          {relationshipTypeLabels[link.relationshipType] || link.relationshipType}
        </Badge>
        {link.aiSuggested && (
          <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600 dark:text-purple-400">
            AI Suggested
          </Badge>
        )}
      </div>

      {link.note && <p className="text-xs text-muted-foreground line-clamp-2">{link.note}</p>}

      {link.tags && link.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {link.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {link.tags.length > 3 && <span className="text-xs text-muted-foreground">+{link.tags.length - 3}</span>}
        </div>
      )}

      <div className="text-xs text-muted-foreground">Linked {formatRelativeTime(link.createdAt)}</div>
    </div>
  );
}

function LinksTab({ documentId, documentTitle }: { documentId: string; documentTitle: string }) {
  const queryClient = useQueryClient();
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);

  const {
    data: links,
    isLoading,
    error,
  } = useQuery({
    queryKey: entityDocumentLinkKeys.byDocument(documentId),
    queryFn: () => getLinksForDocument(documentId),
  });

  // Delete link mutation
  const deleteLinkMutation = useMutation({
    mutationFn: (linkId: string) => deleteEntityDocumentLink(linkId),
    onMutate: (linkId) => {
      setDeletingLinkId(linkId);
    },
    onSuccess: () => {
      toast.success('Link removed');
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byDocument(documentId),
      });
    },
    onError: (err) => {
      toast.error('Failed to remove link', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
    onSettled: () => {
      setDeletingLinkId(null);
    },
  });

  const handleDeleteLink = (linkId: string) => {
    deleteLinkMutation.mutate(linkId);
  };

  const handleLinkCreated = () => {
    queryClient.invalidateQueries({
      queryKey: entityDocumentLinkKeys.byDocument(documentId),
    });
  };

  // Header with link button
  const renderHeader = () => (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-sm font-medium">Linked Entities</h3>
      <Button variant="outline" size="sm" onClick={() => setShowLinkForm(true)} className="gap-2">
        <Plus className="h-4 w-4" />
        Link Entity
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div>
        {renderHeader()}
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 bg-muted animate-pulse rounded" />
                <div className="space-y-1.5">
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                </div>
              </div>
              <div className="h-5 w-20 bg-muted animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {renderHeader()}
        <div className="text-center py-8 text-muted-foreground">
          <AlertCircle className="h-8 w-8 mx-auto mb-2" />
          <p>Failed to load links</p>
        </div>
        <LinkEntityForm
          isOpen={showLinkForm}
          onOpenChange={setShowLinkForm}
          documentId={documentId}
          documentTitle={documentTitle}
          onLinkCreated={handleLinkCreated}
        />
      </div>
    );
  }

  if (!links || links.length === 0) {
    return (
      <div>
        {renderHeader()}
        <div className="text-center py-8 text-muted-foreground">
          <Link2 className="h-8 w-8 mx-auto mb-2" />
          <p>No linked entities</p>
          <p className="text-xs mt-1">Link this document to entities to see them here</p>
          <Button variant="outline" size="sm" onClick={() => setShowLinkForm(true)} className="mt-4 gap-2">
            <Plus className="h-4 w-4" />
            Link First Entity
          </Button>
        </div>
        <LinkEntityForm
          isOpen={showLinkForm}
          onOpenChange={setShowLinkForm}
          documentId={documentId}
          documentTitle={documentTitle}
          onLinkCreated={handleLinkCreated}
        />
      </div>
    );
  }

  // Group links by entity type
  const groupedLinks = links.reduce<Record<TransformationEntityType, EntityDocumentLink[]>>(
    (acc, link) => {
      if (!acc[link.entityType]) {
        acc[link.entityType] = [];
      }
      acc[link.entityType].push(link);
      return acc;
    },
    {} as Record<TransformationEntityType, EntityDocumentLink[]>
  );

  return (
    <div>
      {renderHeader()}
      <ScrollArea className="h-[400px]">
        <div className="space-y-6 pr-4">
          {Object.entries(groupedLinks).map(([entityType, entityLinks]) => {
            const config = entityTypeConfig[entityType as TransformationEntityType];
            return (
              <div key={entityType}>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <config.icon className={cn('h-4 w-4', config.color)} />
                  {config.label}s ({entityLinks.length})
                </h4>
                <div className="space-y-3">
                  {entityLinks.map((link) => (
                    <LinkCard
                      key={link.id}
                      link={link}
                      onDelete={handleDeleteLink}
                      isDeleting={deletingLinkId === link.id}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <LinkEntityForm
        isOpen={showLinkForm}
        onOpenChange={setShowLinkForm}
        documentId={documentId}
        documentTitle={documentTitle}
        onLinkCreated={handleLinkCreated}
      />
    </div>
  );
}

// ============================================================================
// DOWNLOAD HELPERS
// ============================================================================

/** Trigger a browser download for a Blob (window.document — `document` is the entity here). */
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// UX-060: the local `buildDocumentMarkdown` stub lived here and shipped a
// title/description/metrics file under a plain "Download" label — never the
// document's actual extracted text. Composition now lives in
// `document-content-export.ts`, includes the real chunk text, and is only
// offered under a label that says what the file contains.

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function DocumentSheet({
  documentId,
  open,
  onOpenChange,
  onDelete,
  onProcess,
  onProcessingQueued,
}: DocumentSheetProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another document
  // or create mode) — the mounted instance otherwise keeps the previous
  // session's tab, so reopening could land on a non-Overview tab.
  useEffect(() => {
    setActiveTab('overview');
  }, [documentId]);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const deleteTargetIdRef = useRef<string | null>(null);

  // Fetch document
  const {
    data: document,
    isLoading,
    error,
  } = useQuery({
    queryKey: documentKeys.detail(documentId ?? ''),
    queryFn: () => getDocumentById(documentId!),
    enabled: !!documentId && open,
  });

  // UX-060: ONE contract answers Preview/Download for this sheet — the same
  // one the table row, the grid card and the preview dialog consult.
  const availability = document ? resolveDocumentContentAvailability(document) : null;

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDocument(id),
    onSuccess: () => {
      deleteTargetIdRef.current = null;
      toast.success('Document deleted');
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      onOpenChange(false);
      onDelete?.();
    },
    onError: (err) => {
      deleteTargetIdRef.current = null;
      toast.error('Failed to delete document', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });

  // Retry mutation. UX-036: `retryDocumentProcessing` now posts to the
  // authenticated enqueue and RESOLVES ONLY once the queue acknowledged the
  // event, so this success toast finally corresponds to scheduled work.
  const retryMutation = useMutation({
    mutationFn: () => retryDocumentProcessing(documentId!),
    onSuccess: (acceptance) => {
      toast.success('Reprocessing queued', {
        description: `The background job queue accepted the request (event ${acceptance.eventIds[0]}).`,
      });
      queryClient.invalidateQueries({ queryKey: documentKeys.detail(documentId!) });
      queryClient.invalidateQueries({ queryKey: documentKeys.chunks(documentId!) });
      // The list behind the sheet showed the stale pre-retry status until a
      // manual reload, so the same retry could be fired repeatedly.
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      onProcessingQueued?.();
    },
    onError: (err) => {
      toast.error('Could not queue reprocessing', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });

  // Handle process action
  const handleProcess = () => {
    if (documentId) {
      onProcess?.(documentId);
    }
  };

  // Download follows the shared availability contract, so the bytes the user
  // receives always match the label on the button (UX-060):
  //   original       → stream the stored file through the authenticated API
  //   extracted-text → compose markdown from the CURRENT-generation chunks
  //   details        → compose markdown from the recorded structured detail
  //   unavailable    → the button is disabled and this never runs
  const handleDownload = async () => {
    if (!document || !availability?.download.enabled) return;
    try {
      if (availability.download.kind === 'original') {
        const response = await fetchWithAuth(`/api/documents/download?id=${document.id}`);
        if (!response.ok) {
          throw new Error(`Download failed: ${response.status}`);
        }
        const contentDisposition = response.headers.get('Content-Disposition');
        const filenameMatch = contentDisposition?.match(/filename="?([^";]+)"?/);
        const blob = await response.blob();
        triggerBlobDownload(blob, filenameMatch?.[1] ?? document.title);
        toast.success('Download started', { description: 'Downloading the stored original file.' });
        return;
      }

      const { filename, markdown } = await composeDocumentExport(document);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      triggerBlobDownload(blob, filename || documentExportFilename(document.title));
      toast.success('Download started', {
        description:
          availability.download.kind === 'extracted-text'
            ? 'This document has no stored file — downloading its extracted text.'
            : 'This document has no stored file or extracted text — downloading its recorded details.',
      });
    } catch (err) {
      toast.error('Failed to download document', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  // Handle delete confirmation
  const handleDelete = () => {
    const id = deleteTargetIdRef.current;
    if (!id) {
      toast.error('Failed to delete document', {
        description: 'The document is no longer selected.',
      });
      return;
    }

    setShowDeleteDialog(false);
    deleteMutation.mutate(id);
  };

  // Render content based on state
  const renderContent = () => {
    if (isLoading) {
      return <EntityDetailSkeleton />;
    }

    if (error || !document) {
      return (
        <div className="text-center py-12">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-lg font-medium">Document not found</p>
          <p className="text-sm text-muted-foreground mt-1">The document may have been deleted.</p>
        </div>
      );
    }

    // Define tabs with content
    const tabs: SheetTab[] = [
      {
        id: 'overview',
        label: 'Overview',
        icon: FileText,
        content: <OverviewTab document={document} />,
      },
      {
        id: 'chunks',
        label: 'Chunks',
        icon: Layers,
        badge: document.chunkCount,
        // UX-060: this was gated on `status === 'processed'` alone, so a
        // refreshed document whose chunks exist showed a disabled tab with a
        // non-zero badge while Preview rendered the same text. Gating purely
        // on `chunkCount` is not right either — the file-upload path
        // historically marked documents `processed` WITHOUT stamping it, so
        // every legacy PDF/DOCX would
        // lose access to chunks it really has. Enable when EITHER signal says
        // there is something to show; the tab's own empty state is honest.
        disabled: document.status !== 'processed' && !availability?.hasExtractedText,
        content: documentId ? <ChunksTab documentId={documentId} /> : null,
      },
      {
        id: 'links',
        label: 'Links',
        icon: Link2,
        badge: document.linkedEntityCount,
        content: documentId ? <LinksTab documentId={documentId} documentTitle={document.title} /> : null,
      },
    ];

    return <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />;
  };

  // Footer actions
  const renderFooter = () => {
    if (!document) return null;

    return (
      <div className="flex items-center justify-between w-full">
        {/* Left side - status actions */}
        <div className="flex gap-2">
          {/* UX-060: the label states what the file will contain, and the
              button is disabled (with the reason) when there is nothing to
              hand over — it used to be always enabled and silently shipped a
              metadata stub. */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={!availability?.download.enabled}
            title={availability?.download.hint}
            data-testid="document-sheet-download"
          >
            <Download className="h-4 w-4 mr-2" />
            {availability?.download.label ?? 'Download'}
          </Button>
          {document.status === 'uploaded' && (
            <Button variant="outline" size="sm" onClick={handleProcess} data-testid="document-sheet-process">
              <Play className="h-4 w-4 mr-2" />
              Process
            </Button>
          )}
          {/* UX-036: retryable is a policy call — every terminal status plus a
              stalled run, not the `failed` string alone. A blocked document
              previously had no action at all. */}
          {document.status !== 'uploaded' && canRequestProcessing(document) && hasReprocessableSource(document) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              data-testid="document-sheet-retry"
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', retryMutation.isPending && 'animate-spin')} />
              {retryMutation.isPending ? 'Queueing…' : 'Retry'}
            </Button>
          )}
        </div>

        {/* Right side - destructive actions */}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            deleteTargetIdRef.current = documentId;
            setShowDeleteDialog(true);
          }}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
      </div>
    );
  };

  return (
    <>
      <EntitySheetShell
        title={document?.title ?? 'Document'}
        entityType="document"
        entityId={document?.id}
        open={open}
        onOpenChange={onOpenChange}
        width="lg"
        footer={document && renderFooter()}
      >
        {renderContent()}
      </EntitySheetShell>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{document?.title}&quot;? This will also delete all extracted chunks.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
