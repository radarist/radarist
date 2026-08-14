/**
 * @file components/knowledge/LinkedDocumentCard.tsx
 * @description Card component for displaying a linked document in the Knowledge Tab.
 *
 * Features:
 * - Document type icon and title
 * - Relationship type and relevance badges
 * - Tags display
 * - External link and delete actions
 * - AI suggestion indicator
 *
 * @phase Knowledge Tab Sprint - Phase 3
 * @author Radarist Team
 * @created 2026-01-14
 */

'use client';

import { memo, useState, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  FileText,
  Globe,
  ExternalLink,
  Trash2,
  Loader2,
  Sparkles,
  Check,
  X,
  FileIcon,
  FileSpreadsheet,
  Presentation,
  FileImage,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
import { cn } from '@/lib/utils';
import { getSafeExternalUrl } from '@/lib/utils/url-normalize';
import {
  DOCUMENT_RELATIONSHIP_TYPE_LABELS,
  DOCUMENT_RELEVANCE_LABELS,
  DOCUMENT_RELEVANCE_COLORS,
} from '@/lib/schemas/entity-document-link';
import type { EntityDocumentLinkWithDocument, DocumentRelationshipType, DocumentRelevance } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface LinkedDocumentCardProps {
  /** The entity-document link with document info */
  link: EntityDocumentLinkWithDocument;
  /** Callback to delete the link */
  onDelete?: (linkId: string) => Promise<void>;
  /** Callback to approve AI suggestion */
  onApprove?: (linkId: string) => Promise<void>;
  /** Callback to reject AI suggestion */
  onReject?: (linkId: string) => Promise<void>;
  /** Whether the card is in read-only mode */
  readOnly?: boolean;
  /** Additional class names */
  className?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DOCUMENT_TYPE_ICONS: Record<string, typeof FileText> = {
  pdf: FileIcon,
  docx: FileText,
  doc: FileText,
  pptx: Presentation,
  ppt: Presentation,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  url: Globe,
  transcript: FileText,
  markdown: FileText,
  md: FileText,
  text: FileText,
  txt: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
};

function getDocumentIcon(type: string): typeof FileText {
  return DOCUMENT_TYPE_ICONS[type.toLowerCase()] || FileText;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const LinkedDocumentCard = memo(function LinkedDocumentCard({
  link,
  onDelete,
  onApprove,
  onReject,
  readOnly = false,
  className,
}: LinkedDocumentCardProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const Icon = getDocumentIcon(link.document.type);
  const relationshipLabel =
    DOCUMENT_RELATIONSHIP_TYPE_LABELS[link.relationshipType as DocumentRelationshipType] || link.relationshipType;
  const relevanceLabel = DOCUMENT_RELEVANCE_LABELS[link.relevance as DocumentRelevance] || link.relevance;
  const relevanceColor = DOCUMENT_RELEVANCE_COLORS[link.relevance as DocumentRelevance] || 'text-muted-foreground';
  const sourceUrl = getSafeExternalUrl(link.document.originalUrl);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      await onDelete(link.id);
    } finally {
      setIsDeleting(false);
    }
  }, [onDelete, link.id]);

  // Handle approve AI suggestion
  const handleApprove = useCallback(async () => {
    if (!onApprove) return;
    setIsApproving(true);
    try {
      await onApprove(link.id);
    } finally {
      setIsApproving(false);
    }
  }, [onApprove, link.id]);

  // Handle reject AI suggestion
  const handleReject = useCallback(async () => {
    if (!onReject) return;
    setIsRejecting(true);
    try {
      await onReject(link.id);
    } finally {
      setIsRejecting(false);
    }
  }, [onReject, link.id]);

  return (
    <TooltipProvider>
      <div
        className={cn(
          'group flex items-start gap-3 rounded-lg border bg-card p-3 hover:bg-muted/50 transition-colors',
          link.aiSuggested && 'border-dashed border-purple-300 bg-purple-50/30 dark:bg-purple-950/20',
          className
        )}
      >
        {/* Document Icon */}
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0',
            link.aiSuggested && 'bg-purple-100 dark:bg-purple-900/50'
          )}
        >
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title Row */}
          <div className="flex items-start gap-2">
            <span className="font-medium text-sm truncate flex-1">{link.document.title}</span>
            {link.aiSuggested && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="shrink-0 bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900 dark:text-purple-300 dark:border-purple-700"
                  >
                    <Sparkles className="mr-1 h-3 w-3" />
                    AI Suggested
                    {link.aiConfidence !== undefined && ` (${link.aiConfidence}%)`}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">This link was suggested by AI</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Metadata Row */}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* Relationship Type */}
            <Badge variant="secondary" className="text-xs">
              {relationshipLabel}
            </Badge>

            {/* Relevance */}
            <span className={cn('font-medium', relevanceColor)}>{relevanceLabel}</span>

            {/* Document Type */}
            <span className="uppercase">{link.document.type}</span>

            {/* Domain */}
            {link.document.domain && (
              <>
                <span>·</span>
                <span className="truncate max-w-[150px]">{link.document.domain}</span>
              </>
            )}

            {/* Created timestamp */}
            {link.createdAt && (
              <>
                <span>·</span>
                <span>{formatDistanceToNow(link.createdAt, { addSuffix: true })}</span>
              </>
            )}
          </div>

          {/* Tags */}
          {link.tags && link.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {link.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] h-5">
                  <Tag className="mr-1 h-2.5 w-2.5" />
                  {tag}
                </Badge>
              ))}
              {link.tags.length > 4 && (
                <Badge variant="outline" className="text-[10px] h-5">
                  +{link.tags.length - 4} more
                </Badge>
              )}
            </div>
          )}

          {/* Note */}
          {link.note && <p className="mt-2 text-xs text-muted-foreground italic line-clamp-2">{link.note}</p>}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* AI Suggestion Actions */}
          {link.aiSuggested && !readOnly && onApprove && onReject && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-100"
                    onClick={handleApprove}
                    disabled={isApproving || isRejecting}
                    aria-label={`Approve suggested link to ${link.document.title}`}
                  >
                    {isApproving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Approve suggestion</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-100"
                    onClick={handleReject}
                    disabled={isApproving || isRejecting}
                    aria-label={`Reject suggested link to ${link.document.title}`}
                  >
                    {isRejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reject suggestion</TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Exact source URL; unsafe or unavailable URLs intentionally have no action. */}
          {sourceUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="Open source">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open source</TooltipContent>
            </Tooltip>
          )}

          {/* Delete Button */}
          {!readOnly && onDelete && !link.aiSuggested && (
            <AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={isDeleting}
                      aria-label={`Remove link to ${link.document.title}`}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent>Remove link</TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove document link?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove the link between this entity and &quot;{link.document.title}&quot;. The document
                    itself will not be deleted.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
});

export type { LinkedDocumentCardProps };
