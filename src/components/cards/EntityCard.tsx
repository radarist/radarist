'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

// ============================================================================
// ENTITY CARD - Consistent card treatment for all entities
// ============================================================================

interface EntityCardProps {
  children: React.ReactNode
  className?: string
  /** Click handler - makes card interactive */
  onClick?: () => void
  /** Whether card is currently selected */
  selected?: boolean
  /** Accessible label for the card (required when onClick is provided) */
  ariaLabel?: string
}

/**
 * EntityCard
 *
 * Base card component for displaying entities (Companies, Technologies, etc.)
 * Provides consistent styling:
 * - Slightly lighter than background (bg-card)
 * - Crisp border
 * - Hover state with primary border
 * - Optional selection state
 *
 * Usage:
 * ```tsx
 * <EntityCard onClick={() => openDetails(company)}>
 *   <EntityCardHeader
 *     title={company.name}
 *     subtitle={company.industry}
 *     badge={<Badge variant="secondary">{company.type}</Badge>}
 *   />
 *   <EntityCardContent>
 *     <p>{company.description}</p>
 *   </EntityCardContent>
 * </EntityCard>
 * ```
 */
export function EntityCard({ children, className, onClick, selected, ariaLabel }: EntityCardProps) {
  // Handle keyboard activation (Enter or Space)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick()
    }
  }

  const isInteractive = !!onClick

  return (
    <Card
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-pressed={isInteractive ? selected : undefined}
      className={cn(
        'bg-card border border-border/80 transition-colors',
        isInteractive && 'cursor-pointer hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected && 'border-primary ring-1 ring-primary/20',
        className
      )}
      onClick={onClick}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
    >
      {children}
    </Card>
  )
}

// ============================================================================
// ENTITY CARD HEADER
// ============================================================================

interface EntityCardHeaderProps {
  title: string
  subtitle?: string
  badge?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

/**
 * EntityCardHeader
 *
 * Header section with title, optional subtitle, badge, and icon.
 */
export function EntityCardHeader({
  title,
  subtitle,
  badge,
  icon,
  className,
}: EntityCardHeaderProps) {
  return (
    <CardHeader className={cn('p-4 pb-2', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          {icon && (
            <div className="shrink-0 mt-0.5">{icon}</div>
          )}
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium leading-tight truncate">
              {title}
            </CardTitle>
            {subtitle && (
              <CardDescription className="text-xs text-muted-foreground mt-0.5 truncate">
                {subtitle}
              </CardDescription>
            )}
          </div>
        </div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
    </CardHeader>
  )
}

// ============================================================================
// ENTITY CARD CONTENT
// ============================================================================

interface EntityCardContentProps {
  children: React.ReactNode
  className?: string
}

/**
 * EntityCardContent
 *
 * Main content area of the card.
 */
export function EntityCardContent({ children, className }: EntityCardContentProps) {
  return (
    <CardContent className={cn('p-4 pt-0 space-y-2', className)}>
      {children}
    </CardContent>
  )
}

// ============================================================================
// ENTITY CARD META - Metadata row
// ============================================================================

interface EntityCardMetaProps {
  children: React.ReactNode
  className?: string
}

/**
 * EntityCardMeta
 *
 * Row for metadata like dates, counts, tags.
 * Uses smaller text and muted colors.
 */
export function EntityCardMeta({ children, className }: EntityCardMetaProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-xs text-muted-foreground flex-wrap',
        className
      )}
    >
      {children}
    </div>
  )
}

// ============================================================================
// ENTITY CARD TAGS
// ============================================================================

interface EntityCardTagsProps {
  tags: string[]
  max?: number
  className?: string
}

/**
 * EntityCardTags
 *
 * Display tags with overflow handling.
 */
export function EntityCardTags({ tags, max = 3, className }: EntityCardTagsProps) {
  const visibleTags = tags.slice(0, max)
  const hiddenCount = tags.length - max

  return (
    <div className={cn('flex items-center gap-1 flex-wrap', className)}>
      {visibleTags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="text-[10px] px-1.5 py-0 h-5"
        >
          {tag}
        </Badge>
      ))}
      {hiddenCount > 0 && (
        <span className="text-xs text-muted-foreground">+{hiddenCount}</span>
      )}
    </div>
  )
}

// ============================================================================
// ENTITY CARD GRID
// ============================================================================

interface EntityCardGridProps {
  children: React.ReactNode
  className?: string
  /** Number of columns at different breakpoints */
  columns?: {
    default?: number
    md?: number
    lg?: number
    xl?: number
  }
}

/**
 * EntityCardGrid
 *
 * Responsive grid layout for entity cards.
 *
 * Usage:
 * ```tsx
 * <EntityCardGrid columns={{ default: 1, md: 2, lg: 3 }}>
 *   {companies.map(c => <CompanyCard key={c.id} company={c} />)}
 * </EntityCardGrid>
 * ```
 */
export function EntityCardGrid({
  children,
  className,
  columns = { default: 1, md: 2, lg: 3, xl: 4 },
}: EntityCardGridProps) {
  const gridCols = cn(
    'grid gap-4',
    columns.default === 1 && 'grid-cols-1',
    columns.default === 2 && 'grid-cols-2',
    columns.md === 2 && 'md:grid-cols-2',
    columns.md === 3 && 'md:grid-cols-3',
    columns.lg === 3 && 'lg:grid-cols-3',
    columns.lg === 4 && 'lg:grid-cols-4',
    columns.xl === 4 && 'xl:grid-cols-4',
    columns.xl === 5 && 'xl:grid-cols-5',
    className
  )

  return <div className={gridCols}>{children}</div>
}

// ============================================================================
// EXPORTS
// ============================================================================

export type {
  EntityCardProps,
  EntityCardHeaderProps,
  EntityCardContentProps,
  EntityCardMetaProps,
  EntityCardTagsProps,
  EntityCardGridProps,
}
