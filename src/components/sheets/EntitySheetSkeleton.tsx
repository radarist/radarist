'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface EntitySheetSkeletonProps {
  /** Show tabs skeleton */
  showTabs?: boolean
  /** Number of tab placeholders */
  tabCount?: number
  /** Show form fields skeleton */
  showForm?: boolean
  /** Number of form field rows */
  fieldCount?: number
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * EntitySheetSkeleton
 *
 * Loading skeleton for entity sheets.
 * Matches the layout of actual sheet content for smooth perceived loading.
 *
 * @example
 * ```tsx
 * if (isLoading) return <EntitySheetSkeleton showTabs tabCount={4} fieldCount={6} />
 * ```
 */
export function EntitySheetSkeleton({
  showTabs = true,
  tabCount = 4,
  showForm = true,
  fieldCount = 5,
  className,
}: EntitySheetSkeletonProps) {
  return (
    <div className={cn('space-y-6', className)}>
      {/* Tabs Skeleton */}
      {showTabs && (
        <div className="flex gap-4 border-b pb-2">
          {Array.from({ length: tabCount }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24" />
          ))}
        </div>
      )}

      {/* Form Fields Skeleton */}
      {showForm && (
        <div className="space-y-6">
          {Array.from({ length: fieldCount }).map((_, i) => (
            <div key={i} className="space-y-2">
              {/* Label */}
              <Skeleton className="h-4 w-24" />
              {/* Input - vary heights for visual interest */}
              <Skeleton
                className={cn(
                  'w-full',
                  i % 3 === 2 ? 'h-24' : 'h-10' // Every 3rd field is a textarea
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * EntityDetailSkeleton
 *
 * Loading skeleton for entity detail views (read-only).
 */
export function EntityDetailSkeleton({
  className,
}: {
  className?: string
}) {
  return (
    <div className={cn('space-y-6', className)}>
      {/* Header section */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>

      {/* Stats row */}
      <div className="flex gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex-1 space-y-2 rounded-lg border p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-12" />
          </div>
        ))}
      </div>

      {/* Content sections */}
      <div className="space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>

      <div className="space-y-4">
        <Skeleton className="h-5 w-28" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-20" />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * RelationsTabSkeleton
 *
 * Loading skeleton for the relations tab.
 */
export function RelationsTabSkeleton({
  className,
}: {
  className?: string
}) {
  return (
    <div className={cn('space-y-4', className)}>
      {/* Search bar */}
      <Skeleton className="h-10 w-full" />

      {/* Relations list */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * NotesTabSkeleton
 *
 * Loading skeleton for the notes tab.
 */
export function NotesTabSkeleton({
  className,
}: {
  className?: string
}) {
  return (
    <div className={cn('space-y-4', className)}>
      {/* Notes list */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * ResearchTabSkeleton
 *
 * Loading skeleton for the research tab with collapsible sections.
 */
export function ResearchTabSkeleton({
  className,
}: {
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Research sections */}
      <div className="space-y-3">
        {/* Executive Summary Section */}
        <div className="rounded-lg border">
          <div className="flex items-center gap-2 p-3 border-b">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="p-4 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </div>
        </div>

        {/* Products Section */}
        <div className="rounded-lg border">
          <div className="flex items-center gap-2 p-3 border-b">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="p-4 space-y-3">
            <div className="grid gap-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="p-2 rounded-lg bg-muted/50 border">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-5 w-16" />
                  </div>
                  <Skeleton className="h-3 w-full mt-2" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Financials Section */}
        <div className="rounded-lg border">
          <div className="flex items-center gap-2 p-3 border-b">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-44" />
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="p-2 rounded-lg bg-muted/50">
                  <Skeleton className="h-3 w-16 mb-1" />
                  <Skeleton className="h-5 w-20" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Team Section */}
        <div className="rounded-lg border">
          <div className="flex items-center gap-2 p-3 border-b">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="p-4 space-y-3">
            <div className="flex gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-28" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-start justify-between p-2 rounded-lg bg-muted/50">
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-4 w-4" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { EntitySheetSkeletonProps }
