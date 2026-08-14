'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TrendingUp, Sparkles, Clock, AlertTriangle, Minus, Beaker, BookOpen, Loader2 } from 'lucide-react';
import type { Ring, Status } from '@/lib/types';

// ============================================================================
// RING BADGE
// ============================================================================

interface RingBadgeProps {
  ring: Ring;
  className?: string;
}

/**
 * Ring badge with color coding
 * Adopt = green (mature), Trial = blue, Assess = amber, Hold = gray
 */
export function RingBadge({ ring, className }: RingBadgeProps) {
  const config: Record<Ring, string> = {
    Adopt: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    Trial: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    Assess: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    Hold: 'bg-muted/50 text-muted-foreground border-muted-foreground/20',
  };

  return (
    <Badge variant="outline" className={cn('gap-1 text-xs font-normal px-2 py-0.5', config[ring], className)}>
      {ring}
    </Badge>
  );
}

// ============================================================================
// STATUS BADGE
// ============================================================================

interface TechStatusBadgeProps {
  status: Status | string;
  className?: string;
}

/**
 * Technology status badge with icon and color coding
 */
export function TechStatusBadge({ status, className }: TechStatusBadgeProps) {
  const config: Record<string, { icon: React.ElementType; className: string }> = {
    Trending: {
      icon: TrendingUp,
      className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    },
    Stable: {
      icon: Minus,
      className: 'bg-muted/50 text-muted-foreground border-muted-foreground/20',
    },
    Fading: {
      icon: Clock,
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    },
    New: {
      icon: Sparkles,
      className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    },
    Warning: {
      icon: AlertTriangle,
      className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
    },
  };

  const { icon: Icon, className: statusClassName } = config[status] || config.Stable;

  return (
    <Badge variant="outline" className={cn('gap-1 text-xs font-normal px-2 py-0.5', statusClassName, className)}>
      <Icon className="h-3 w-3" />
      {status}
    </Badge>
  );
}

// ============================================================================
// TRL BADGE
// ============================================================================

interface TRLBadgeProps {
  trl?: number;
  className?: string;
}

/**
 * Technology Readiness Level badge (1-9 scale)
 */
export function TRLBadge({ trl, className }: TRLBadgeProps) {
  if (!trl || trl < 1 || trl > 9) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  const config =
    trl <= 3
      ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30'
      : trl <= 6
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
        : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30';

  return (
    <Badge
      variant="outline"
      className={cn('gap-1 text-xs font-normal px-2 py-0.5 whitespace-nowrap', config, className)}
    >
      <Beaker className="h-3 w-3 shrink-0" />
      TRL {trl}
    </Badge>
  );
}

// ============================================================================
// RESEARCH INDICATOR
// ============================================================================

interface ResearchIndicatorProps {
  hasDeepResearch: boolean;
  isResearching?: boolean;
  /**
   * TEST-022: true when the last research attempt failed. Without it a failed
   * run rendered identically to never-researched, so the operator was told
   * nothing had been tried when in fact something had been tried and lost.
   */
  hasFailed?: boolean;
  /**
   * ARUN-028: true when research is COMPLETE but its graph/radar snapshot
   * refresh has not yet been delivered. Distinct from `hasFailed` — research
   * succeeded; only the downstream refresh is pending (and retried automatically).
   */
  refreshPending?: boolean;
  onResearch?: () => void;
  className?: string;
}

/**
 * Indicator showing if technology has deep research completed.
 * When research is not done, shows a clickable button to trigger research.
 */
export function ResearchIndicator({
  hasDeepResearch,
  isResearching,
  hasFailed,
  refreshPending,
  onResearch,
  className,
}: ResearchIndicatorProps) {
  if (isResearching) {
    return (
      <Badge
        variant="outline"
        className={cn(
          'gap-1 text-xs font-normal px-2 py-0.5',
          'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
          className
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Researching...
      </Badge>
    );
  }

  if (hasDeepResearch) {
    // ARUN-028 — research succeeded; the downstream snapshot refresh is pending.
    // Informational (not an error) and never rendered as "failed".
    if (refreshPending) {
      return (
        <Badge
          variant="outline"
          data-testid="research-refresh-pending"
          title="Research is complete. Its graph/radar snapshot refresh is pending and will be retried automatically."
          className={cn(
            'gap-1 text-xs font-normal px-2 py-0.5',
            'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
            className
          )}
        >
          <Clock className="h-3 w-3" />
          Refresh pending
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className={cn(
          'gap-1 text-xs font-normal px-2 py-0.5',
          'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
          className
        )}
      >
        <BookOpen className="h-3 w-3" />
        Researched
      </Badge>
    );
  }

  // Failed is reported BEFORE the untried state: the two are different facts,
  // and collapsing them hides a real outcome behind "not researched yet".
  if (hasFailed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={!onResearch}
        onClick={
          onResearch
            ? (event) => {
                event.stopPropagation();
                onResearch();
              }
            : undefined
        }
        data-testid="research-failed"
        title="The last research attempt failed. Select to try again."
        className={cn(
          'h-auto px-2 py-0.5 gap-1 text-xs font-normal',
          'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300',
          className
        )}
      >
        <AlertTriangle className="h-3 w-3" />
        Research failed
      </Button>
    );
  }

  if (onResearch) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-auto px-2 py-0.5 gap-1 text-xs font-normal',
          'text-muted-foreground hover:text-purple-600 dark:hover:text-purple-400',
          className
        )}
        onClick={(e) => {
          e.stopPropagation();
          onResearch();
        }}
      >
        <Sparkles className="h-3 w-3" />
        Research
      </Button>
    );
  }

  return <span className={cn('text-muted-foreground/40', className)}>—</span>;
}

// ============================================================================
// CATEGORY BADGE
// ============================================================================

interface CategoryBadgeProps {
  category: string;
  className?: string;
}

/**
 * Badge displaying technology category with consistent styling
 */
export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  const categoryConfig: Record<string, string> = {
    framework: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    language: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
    platform: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    tool: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    library: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
    service: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
    methodology: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
    infrastructure: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  };

  const config = categoryConfig[category] || 'bg-muted text-muted-foreground border-border';
  const label = category.charAt(0).toUpperCase() + category.slice(1);

  return (
    <Badge variant="outline" className={cn('text-xs font-normal px-2 py-0.5', config, className)}>
      {label}
    </Badge>
  );
}

// ============================================================================
// TAGS INLINE
// ============================================================================

interface TagsInlineProps {
  tags: string[];
  maxWidth?: number;
  className?: string;
}

/**
 * Single-line tags display with overflow handling
 */
export function TagsInline({ tags, maxWidth = 180, className }: TagsInlineProps) {
  if (!tags || tags.length === 0) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  return (
    <div
      className={cn('flex items-center gap-1 overflow-hidden', className)}
      style={{ maxWidth }}
      title={tags.join(', ')}
    >
      {tags.slice(0, 3).map((tag, index) => (
        <Badge
          key={`${tag}-${index}`}
          variant="outline"
          className="text-xs px-1.5 py-0 h-5 font-normal shrink-0 max-w-[80px] truncate"
        >
          {tag}
        </Badge>
      ))}
      {tags.length > 3 && <span className="text-xs text-muted-foreground shrink-0">+{tags.length - 3}</span>}
    </div>
  );
}
