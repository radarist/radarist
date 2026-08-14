'use client';

import {
  FileText,
  FileType2,
  FileCode,
  Presentation,
  Link2,
  Clock,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Ban,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-labels';
import {
  describeProcessingState,
  isProcessingStalled,
  type ProcessingPolicyInput,
} from '@/lib/document-processing-policy';
import type { DocumentStatus, DocumentType } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// STATUS BADGE
// ============================================================================

const STATUS_CONFIG: Record<DocumentStatus, { icon: React.ElementType; className: string; label: string }> = {
  uploaded: {
    icon: Clock,
    className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    label: 'Pending',
  },
  processing: {
    icon: Loader2,
    className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    label: 'Processing',
  },
  processed: {
    icon: CheckCircle2,
    className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    label: 'Processed',
  },
  failed: {
    icon: AlertCircle,
    className: 'bg-destructive/10 text-destructive border-destructive/30',
    label: 'Failed',
  },
  blocked: {
    icon: Ban,
    className: 'bg-muted text-muted-foreground border-border',
    label: 'Blocked',
  },
};

/**
 * UX-036: a `processing` status whose run stopped reporting is NOT "still
 * running" and is NOT "failed" — we only know nothing has come back. Saying
 * "Stalled" is the honest third answer, and it is what tells the operator the
 * Retry action is available again.
 *
 * Only the ICON and colours live here; the LABEL comes from
 * `describeProcessingState` so this badge and the detail sheet cannot drift
 * into describing the same row differently.
 */
const STALLED_STYLE = {
  icon: AlertCircle,
  className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40',
} as const;

interface DocumentStatusBadgeProps {
  status: DocumentStatus;
  /**
   * Liveness fields. Optional so callers that genuinely have only a status
   * (legacy call sites, storybook) keep working — without them a `processing`
   * document is reported as running, the previous behavior.
   */
  document?: ProcessingPolicyInput;
  className?: string;
}

export function DocumentStatusBadge({ status, document, className }: DocumentStatusBadgeProps) {
  const stalled = !!document && isProcessingStalled(document);
  const { icon: Icon, className: statusClassName } = stalled ? STALLED_STYLE : STATUS_CONFIG[status];
  // One label source for every surface (see describeProcessingState).
  const { label } = describeProcessingState(document ?? { status });

  return (
    <Badge
      variant="outline"
      data-testid="document-status-badge"
      data-status={stalled ? 'stalled' : status}
      className={cn('gap-1 text-xs font-normal px-2 py-0.5', statusClassName, className)}
    >
      <Icon className={cn('h-3 w-3', status === 'processing' && !stalled && 'animate-spin')} />
      {label}
    </Badge>
  );
}

// ============================================================================
// TYPE BADGE
// ============================================================================

const TYPE_CONFIG: Record<DocumentType, { icon: React.ElementType; label: string }> = {
  pdf: { icon: FileText, label: DOCUMENT_TYPE_LABELS.pdf },
  docx: { icon: FileType2, label: DOCUMENT_TYPE_LABELS.docx },
  pptx: { icon: Presentation, label: DOCUMENT_TYPE_LABELS.pptx },
  url: { icon: Link2, label: DOCUMENT_TYPE_LABELS.url },
  transcript: { icon: FileText, label: DOCUMENT_TYPE_LABELS.transcript },
  markdown: { icon: FileCode, label: DOCUMENT_TYPE_LABELS.markdown },
  text: { icon: FileText, label: DOCUMENT_TYPE_LABELS.text },
  'deep-research': { icon: FileText, label: DOCUMENT_TYPE_LABELS['deep-research'] },
};

interface DocumentTypeBadgeProps {
  type: DocumentType;
  className?: string;
}

export function DocumentTypeBadge({ type, className }: DocumentTypeBadgeProps) {
  const { icon: Icon, label } = TYPE_CONFIG[type] || { icon: FileText, label: type };

  // Classification pill = neutral outline (CONV-BADGE) — was a filled `secondary`
  // pill, inconsistent with every other classification pill in the catalog.
  return (
    <Badge variant="outline" className={cn('gap-1 text-xs font-normal px-2 py-0.5 whitespace-nowrap', className)}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}
