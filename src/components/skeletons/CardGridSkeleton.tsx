'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface CardGridSkeletonProps {
  /** Number of cards to display */
  cards?: number
  /** Grid columns configuration */
  columns?: 1 | 2 | 3 | 4
  /** Card height variant */
  cardSize?: 'sm' | 'md' | 'lg'
  /** Additional class names */
  className?: string
}

/**
 * CardGridSkeleton
 *
 * Skeleton loader that mimics a grid of cards.
 * Use this instead of spinners when loading card-based layouts.
 *
 * @example
 * ```tsx
 * const { data, isLoading } = usePrototypes()
 * if (isLoading) return <CardGridSkeleton cards={6} columns={3} />
 * return <PrototypeCards data={data} />
 * ```
 */
export function CardGridSkeleton({
  cards = 6,
  columns = 3,
  cardSize = 'md',
  className,
}: CardGridSkeletonProps) {
  const columnClasses = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  }

  const cardHeights = {
    sm: 'h-[120px]',
    md: 'h-[180px]',
    lg: 'h-[240px]',
  }

  return (
    <div className={cn('grid gap-4', columnClasses[columns], className)}>
      {Array.from({ length: cards }).map((_, i) => (
        <CardSkeleton key={i} height={cardHeights[cardSize]} />
      ))}
    </div>
  )
}

/**
 * Single Card Skeleton
 */
function CardSkeleton({ height }: { height: string }) {
  return (
    <div className={cn('rounded-lg border bg-card p-4', height)}>
      {/* Header row */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-[140px]" />
            <Skeleton className="h-3 w-[100px]" />
          </div>
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>

      {/* Content */}
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[80%]" />
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center gap-2">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
    </div>
  )
}

/**
 * Export single card skeleton for individual use
 */
export { CardSkeleton }
