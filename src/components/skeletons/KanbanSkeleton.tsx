'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * KanbanSkeleton
 *
 * Skeleton loader that mimics a kanban board layout.
 * Use this instead of spinners when loading kanban data.
 */
export function KanbanSkeleton({
  columns = 4,
  cardsPerColumn = 3,
  className
}: {
  columns?: number
  cardsPerColumn?: number
  className?: string
}) {
  return (
    <div className={cn('flex gap-4 overflow-x-auto pb-4', className)}>
      {Array.from({ length: columns }).map((_, colIndex) => (
        <KanbanColumnSkeleton key={colIndex} cards={cardsPerColumn} />
      ))}
    </div>
  )
}

/**
 * Single Kanban Column Skeleton
 */
function KanbanColumnSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="flex-shrink-0 w-[280px] rounded-lg bg-muted/30 p-3">
      {/* Column Header */}
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-6 rounded-full" />
      </div>

      {/* Cards */}
      <div className="space-y-2">
        {Array.from({ length: cards }).map((_, i) => (
          <KanbanCardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

/**
 * Single Kanban Card Skeleton
 */
function KanbanCardSkeleton() {
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-5 w-12 rounded-full" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>
    </div>
  )
}

export { KanbanColumnSkeleton, KanbanCardSkeleton }
