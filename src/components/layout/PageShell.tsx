'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

// ============================================================================
// PAGE SHELL - Main content wrapper
// ============================================================================

interface PageShellProps {
  children: React.ReactNode
  className?: string
}

/**
 * PageShell
 *
 * Consistent page wrapper with proper spacing and rhythm.
 * Use this as the outer wrapper for all page content.
 *
 * Provides:
 * - Consistent padding (p-4 md:p-6)
 * - Vertical spacing rhythm (space-y-4 md:space-y-6)
 * - Proper background
 */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <div className={cn('flex-1 space-y-4 p-4 md:space-y-6 md:p-6', className)}>
      {children}
    </div>
  )
}

// ============================================================================
// PAGE HEADER - Title and actions row
// ============================================================================

interface PageHeaderProps {
  title: string
  description?: string
  children?: React.ReactNode // Actions slot
  className?: string
}

/**
 * PageHeader
 *
 * Consistent page header with title, description, and actions.
 *
 * Usage:
 * ```tsx
 * <PageHeader
 *   title="Companies"
 *   description="Partners, vendors, and startups in your ecosystem."
 * >
 *   <Button>Add Company</Button>
 * </PageHeader>
 * ```
 */
export function PageHeader({ title, description, children, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-start justify-between gap-4', className)}>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2 shrink-0">
          {children}
        </div>
      )}
    </header>
  )
}

// ============================================================================
// PAGE CONTENT - Inner container with border
// ============================================================================

interface PageContentProps {
  children: React.ReactNode
  className?: string
  /** Remove padding - useful when content handles its own padding */
  noPadding?: boolean
}

/**
 * PageContent
 *
 * Inner container that creates visual separation from the background.
 * This is the "slab" that makes content feel elevated.
 * Has bolder styling - rounded-xl, visible border, subtle shadow.
 *
 * Usage:
 * ```tsx
 * <PageContent>
 *   <DataTable />
 * </PageContent>
 * ```
 */
export function PageContent({ children, className, noPadding }: PageContentProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card',
        'shadow-[0_2px_10px_rgba(0,0,0,0.2)]',
        !noPadding && 'p-4',
        className
      )}
    >
      {children}
    </div>
  )
}

// ============================================================================
// PAGE TOOLBAR - Filters and controls row
// ============================================================================

interface PageToolbarProps {
  children: React.ReactNode
  className?: string
}

/**
 * PageToolbar
 *
 * Row for search, filters, and view controls.
 * Sits between PageHeader and PageContent.
 */
export function PageToolbar({ children, className }: PageToolbarProps) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      {children}
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { PageShellProps, PageHeaderProps, PageContentProps, PageToolbarProps }
