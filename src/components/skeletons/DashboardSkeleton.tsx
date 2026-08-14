'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * DashboardSkeleton
 *
 * Skeleton loader that mimics the dashboard layout.
 * Use this instead of spinners when loading dashboard data.
 */
export function DashboardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-6', className)}>
      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Needs Attention */}
        <div className="lg:col-span-2 space-y-4">
          <PanelSkeleton title rows={4} />
        </div>

        {/* Right Column - Agent Feed */}
        <div className="space-y-4">
          <PanelSkeleton title rows={5} />
        </div>
      </div>
    </div>
  )
}

/**
 * Stat Card Skeleton
 */
function StatCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-8 w-16" />
      <Skeleton className="mt-2 h-3 w-24" />
    </div>
  )
}

/**
 * Panel Skeleton (for feed/list panels)
 */
function PanelSkeleton({ title, rows = 3 }: { title?: boolean; rows?: number }) {
  return (
    <div className="rounded-lg border bg-card">
      {title && (
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-32" />
        </div>
      )}
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

export { StatCardSkeleton, PanelSkeleton }
