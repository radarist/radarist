'use client';

import { FileQuestion, Clock, CheckCircle2, Archive, Tag, Cpu, Building2, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { UseCase, Relation } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// STATUS BADGE
// ============================================================================

const STATUS_CONFIG: Record<string, { icon: React.ElementType; className: string }> = {
  Proposed: {
    icon: FileQuestion,
    className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  },
  'In Progress': {
    icon: Clock,
    className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  },
  Implemented: {
    icon: CheckCircle2,
    className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  },
  Archived: {
    icon: Archive,
    className: 'bg-muted/50 text-muted-foreground border-muted-foreground/20',
  },
};

interface UseCaseStatusBadgeProps {
  status: string;
  className?: string;
}

export function UseCaseStatusBadge({ status, className }: UseCaseStatusBadgeProps) {
  const { icon: Icon, className: statusClassName } = STATUS_CONFIG[status] || STATUS_CONFIG.Proposed;

  return (
    <Badge
      variant="outline"
      className={cn('gap-1 text-xs font-normal px-2 py-0.5 whitespace-nowrap', statusClassName, className)}
    >
      <Icon className="h-3 w-3" />
      {status}
    </Badge>
  );
}

// ============================================================================
// TAGS DISPLAY
// ============================================================================

interface TagsDisplayProps {
  tags: string[] | undefined;
  maxShow?: number;
  className?: string;
}

export function TagsDisplay({ tags, maxShow = 2, className }: TagsDisplayProps) {
  if (!tags || tags.length === 0) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  const visibleTags = tags.slice(0, maxShow);
  const remainingCount = tags.length - maxShow;

  return (
    <div className={cn('flex items-center gap-1 flex-wrap', className)}>
      {visibleTags.map((tag, index) => (
        <Badge key={`${tag}-${index}`} variant="outline" className="text-xs font-normal px-1.5 py-0 h-5">
          {tag}
        </Badge>
      ))}
      {remainingCount > 0 && (
        <Badge variant="outline" className="text-xs font-normal px-1.5 py-0 h-5 text-muted-foreground">
          +{remainingCount}
        </Badge>
      )}
    </div>
  );
}

// ============================================================================
// RELATIONS SUMMARY
// ============================================================================

interface RelationsSummaryProps {
  useCase: UseCase;
  relations: Relation[];
  className?: string;
}

export function RelationsSummary({ useCase, relations, className }: RelationsSummaryProps) {
  const techCount = useCase.radarTechnologyIds?.length || 0;
  const companyCount = useCase.companyIds?.length || 0;
  const relationsCount = relations.length;

  if (techCount === 0 && companyCount === 0 && relationsCount === 0) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  return (
    <div className={cn('flex items-center justify-end gap-2 text-xs text-muted-foreground', className)}>
      {techCount > 0 && (
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3" />
          {techCount}
        </span>
      )}
      {companyCount > 0 && (
        <span className="flex items-center gap-1">
          <Building2 className="h-3 w-3" />
          {companyCount}
        </span>
      )}
      {relationsCount > 0 && (
        <span className="flex items-center gap-1">
          <Link2 className="h-3 w-3" />
          {relationsCount}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// CARD TAGS (with icons)
// ============================================================================

interface CardTagsDisplayProps {
  tags: string[] | undefined;
  maxShow?: number;
}

export function CardTagsDisplay({ tags, maxShow = 2 }: CardTagsDisplayProps) {
  if (!tags || tags.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {tags.slice(0, maxShow).map((tag, index) => (
        <Badge key={`${tag}-${index}`} variant="outline" className="text-xs font-normal px-1.5 py-0 h-5">
          <Tag className="h-2 w-2 mr-1" />
          {tag}
        </Badge>
      ))}
      {tags.length > maxShow && (
        <Badge variant="outline" className="text-xs font-normal px-1.5 py-0 h-5 text-muted-foreground">
          +{tags.length - maxShow}
        </Badge>
      )}
    </div>
  );
}
