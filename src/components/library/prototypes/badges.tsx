'use client';

import { Sparkles, Code, Presentation, CheckCircle2, Archive, DollarSign, Network, Users, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Prototype, PrototypeStatus, Relation } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// STATUS BADGE
// ============================================================================

const STATUS_CONFIG: Record<PrototypeStatus, { icon: React.ElementType; className: string }> = {
  Ideation: {
    icon: Sparkles,
    className: 'bg-muted text-muted-foreground border-border',
  },
  'In Development': {
    icon: Code,
    className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  },
  'Demo Ready': {
    icon: Presentation,
    className: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  },
  Delivered: {
    icon: CheckCircle2,
    className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  },
  Archived: {
    icon: Archive,
    className: 'bg-muted/50 text-muted-foreground border-muted-foreground/20',
  },
};

interface PrototypeStatusBadgeProps {
  status: PrototypeStatus;
  className?: string;
}

export function PrototypeStatusBadge({ status, className }: PrototypeStatusBadgeProps) {
  const { icon: Icon, className: statusClassName } = STATUS_CONFIG[status] || STATUS_CONFIG.Ideation;

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
// IMPACT DISPLAY
// ============================================================================

interface ImpactDisplayProps {
  impact: Prototype['impact'];
  compact?: boolean;
  className?: string;
}

function getImpactColor(type: string) {
  switch (type) {
    case 'Revenue Generation':
      return 'text-green-600 dark:text-green-400';
    case 'Cost Saving':
      return 'text-blue-600 dark:text-blue-400';
    case 'Business Transformation':
      return 'text-purple-600 dark:text-purple-400';
    case 'Risk Mitigation':
      return 'text-orange-600 dark:text-orange-400';
    default:
      return 'text-muted-foreground';
  }
}

export function ImpactDisplay({ impact, compact = false, className }: ImpactDisplayProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 0,
      notation: compact ? 'compact' : 'standard',
    }).format(value);
  };

  return (
    <div className={cn('flex items-center gap-1.5 text-xs', className)}>
      <DollarSign className={cn('h-3 w-3', getImpactColor(impact.type))} />
      <span className="font-medium">{formatCurrency(impact.estimatedValue)}</span>
      {!compact && <span className="text-muted-foreground">({impact.confidence}%)</span>}
    </div>
  );
}

// ============================================================================
// RELATIONS SUMMARY
// ============================================================================

interface RelationsSummaryProps {
  prototype: Prototype;
  relations: Relation[];
  className?: string;
}

export function RelationsSummary({ prototype, relations, className }: RelationsSummaryProps) {
  const techCount = prototype.linkedTechnologies?.length || 0;
  const teamCount = prototype.team?.length || 0;
  const relationsCount = relations.length;

  if (techCount === 0 && teamCount === 0 && relationsCount === 0) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  return (
    <div className={cn('flex items-center justify-end gap-2 text-xs text-muted-foreground', className)}>
      {techCount > 0 && (
        <span className="flex items-center gap-1">
          <Network className="h-3 w-3" />
          {techCount}
        </span>
      )}
      {teamCount > 0 && (
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {teamCount}
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
