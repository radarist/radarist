/**
 * @file components/cards/TechnologyCard.tsx
 * @description Technology card component for the decoupled Technology model (Phase 1)
 *
 * Displays technology information (facts) with optional placement info.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  EntityCard,
  EntityCardHeader,
  EntityCardContent,
  EntityCardMeta,
  EntityCardTags,
} from '@/components/cards/EntityCard';
import { Cpu, MoreHorizontal, Eye, Pencil, Trash2, Radio, Link2, Globe, Github, BookOpen } from 'lucide-react';
import type { Technology, TechnologyCategory, TechnologyWithPlacement } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface TechnologyCardProps {
  /** The technology to display */
  technology: Technology;
  /** Optional placement info (if showing in radar context) */
  placement?: TechnologyWithPlacement['placement'];
  /** Number of radar placements (for list view) */
  placementsCount?: number;
  /** Click handler for the card */
  onClick?: () => void;
  /** View/details handler */
  onView?: () => void;
  /** Edit handler */
  onEdit?: () => void;
  /** Delete handler */
  onDelete?: () => void;
  /** Whether the card is selected */
  selected?: boolean;
  /** Show compact mode (less details) */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// CATEGORY BADGE COLORS
// ============================================================================

const CATEGORY_COLORS: Record<TechnologyCategory, string> = {
  framework: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  language: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  platform: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  tool: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  library: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
  service: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  methodology: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  infrastructure: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  hardware: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30',
  standard: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  protocol: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30',
  api: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30',
  architecture: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
  other: 'bg-neutral-500/10 text-neutral-600 dark:text-neutral-400 border-neutral-500/30',
};

// ============================================================================
// CATEGORY BADGE COMPONENT
// ============================================================================

interface CategoryBadgeProps {
  category: TechnologyCategory | undefined;
  className?: string;
}

/**
 * Colored badge for technology category
 */
export function TechnologyCategoryBadge({ category, className }: CategoryBadgeProps) {
  if (!category) return null;

  const colorClass = CATEGORY_COLORS[category] || 'bg-muted text-muted-foreground';

  return (
    <Badge variant="outline" className={cn('text-[10px] font-normal capitalize border', colorClass, className)}>
      {category}
    </Badge>
  );
}

// ============================================================================
// RING BADGE COMPONENT (for placement context)
// ============================================================================

const RING_COLORS: Record<string, string> = {
  Adopt: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  Trial: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  Assess: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  Hold: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
};

interface RingBadgeProps {
  ring: string;
  className?: string;
}

/**
 * Colored badge for radar ring
 */
export function TechnologyRingBadge({ ring, className }: RingBadgeProps) {
  const colorClass = RING_COLORS[ring] || 'bg-muted text-muted-foreground';

  return (
    <Badge variant="outline" className={cn('text-[10px] font-normal border', colorClass, className)}>
      {ring}
    </Badge>
  );
}

// ============================================================================
// TECHNOLOGY CARD COMPONENT
// ============================================================================

/**
 * TechnologyCard
 *
 * Displays a technology from the decoupled model.
 * Shows factual information with optional radar placement context.
 *
 * @example
 * ```tsx
 * <TechnologyCard
 *   technology={tech}
 *   onClick={() => openSheet(tech.id)}
 *   onEdit={() => editTech(tech.id)}
 *   onDelete={() => deleteTech(tech.id)}
 * />
 * ```
 */
export function TechnologyCard({
  technology,
  placement,
  placementsCount,
  onClick,
  onView,
  onEdit,
  onDelete,
  selected,
  compact,
  className,
}: TechnologyCardProps) {
  // Build subtitle from category and URL
  const subtitle = technology.category
    ? technology.category.charAt(0).toUpperCase() + technology.category.slice(1)
    : undefined;

  // Build badge for category
  const categoryBadge = technology.category ? <TechnologyCategoryBadge category={technology.category} /> : null;

  // Actions dropdown
  const hasActions = onView || onEdit || onDelete;
  const actionsMenu = hasActions ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onView && (
          <DropdownMenuItem onClick={onView}>
            <Eye className="mr-2 h-4 w-4" />
            View Details
          </DropdownMenuItem>
        )}
        {onEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
        )}
        {(onView || onEdit) && onDelete && <DropdownMenuSeparator />}
        {onDelete && (
          <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <EntityCard
      onClick={onClick}
      selected={selected}
      ariaLabel={`Technology: ${technology.name}`}
      className={className}
    >
      <EntityCardHeader
        title={technology.name}
        subtitle={subtitle}
        badge={
          <div className="flex items-center gap-1">
            {categoryBadge}
            {actionsMenu}
          </div>
        }
        icon={<Cpu className="h-4 w-4 text-emerald-500" />}
      />

      <EntityCardContent>
        {/* Description */}
        {!compact && technology.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{technology.description}</p>
        )}

        {/* Placement context (if in radar view) */}
        {placement && (
          <div className="flex items-center gap-2">
            <TechnologyRingBadge ring={placement.ring} />
            <span className="text-xs text-muted-foreground">in {placement.quadrantName ?? placement.quadrantId}</span>
          </div>
        )}

        {/* Tags */}
        {technology.tags && technology.tags.length > 0 && (
          <EntityCardTags tags={technology.tags} max={compact ? 2 : 3} />
        )}

        {/* Metadata row */}
        <EntityCardMeta>
          {/* Placements count */}
          {placementsCount !== undefined && placementsCount > 0 && (
            <span className="flex items-center gap-1">
              <Radio className="h-3 w-3" />
              {placementsCount} radar{placementsCount !== 1 ? 's' : ''}
            </span>
          )}

          {/* Links */}
          {technology.linkedCompanies && technology.linkedCompanies.length > 0 && (
            <span className="flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              {technology.linkedCompanies.length} companies
            </span>
          )}

          {/* External links */}
          {!compact && (
            <div className="flex items-center gap-2 ml-auto">
              {technology.websiteUrl && (
                <a
                  href={technology.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Visit website"
                >
                  <Globe className="h-3 w-3" />
                </a>
              )}
              {technology.githubUrl && (
                <a
                  href={technology.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="View on GitHub"
                >
                  <Github className="h-3 w-3" />
                </a>
              )}
              {technology.documentationUrl && (
                <a
                  href={technology.documentationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="View documentation"
                >
                  <BookOpen className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </EntityCardMeta>
      </EntityCardContent>
    </EntityCard>
  );
}

// ============================================================================
// TECHNOLOGY CARD SKELETON
// ============================================================================

/**
 * Loading skeleton for TechnologyCard
 */
export function TechnologyCardSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="bg-card border border-border/80 rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="h-4 w-4 bg-muted rounded animate-pulse" />
          <div className="space-y-1.5">
            <div className="h-4 w-32 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
          </div>
        </div>
        <div className="h-5 w-16 bg-muted rounded-full animate-pulse" />
      </div>

      {/* Description */}
      {!compact && (
        <div className="space-y-1.5">
          <div className="h-3 w-full bg-muted rounded animate-pulse" />
          <div className="h-3 w-3/4 bg-muted rounded animate-pulse" />
        </div>
      )}

      {/* Tags */}
      <div className="flex gap-1">
        <div className="h-5 w-12 bg-muted rounded animate-pulse" />
        <div className="h-5 w-16 bg-muted rounded animate-pulse" />
        <div className="h-5 w-10 bg-muted rounded animate-pulse" />
      </div>

      {/* Meta */}
      <div className="flex items-center gap-3">
        <div className="h-3 w-16 bg-muted rounded animate-pulse" />
        <div className="h-3 w-20 bg-muted rounded animate-pulse" />
      </div>
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { TechnologyCardProps };
