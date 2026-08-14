'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface DataTableSkeletonProps {
  /** Number of rows to display */
  rows?: number
  /** Number of columns to display */
  columns?: number
  /** Show header row */
  showHeader?: boolean
  /** Additional class names */
  className?: string
}

/**
 * DataTableSkeleton
 *
 * Skeleton loader that mimics a data table layout.
 * Use this instead of spinners when loading table data.
 *
 * @example
 * ```tsx
 * const { data, isLoading } = useCompanies()
 * if (isLoading) return <DataTableSkeleton rows={10} columns={5} />
 * return <CompaniesTable data={data} />
 * ```
 */
export function DataTableSkeleton({
  rows = 5,
  columns = 4,
  showHeader = true,
  className,
}: DataTableSkeletonProps) {
  return (
    <div className={cn('w-full', className)}>
      {/* Table container */}
      <div className="rounded-lg border">
        {/* Header */}
        {showHeader && (
          <div className="flex items-center gap-4 border-b bg-muted/50 px-4 py-3">
            {Array.from({ length: columns }).map((_, i) => (
              <Skeleton
                key={`header-${i}`}
                className={cn(
                  'h-4',
                  i === 0 ? 'w-[200px]' : 'w-[100px]',
                  i === columns - 1 && 'ml-auto w-[80px]'
                )}
              />
            ))}
          </div>
        )}

        {/* Rows */}
        <div className="divide-y">
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <div
              key={`row-${rowIndex}`}
              className="flex items-center gap-4 px-4 py-4"
            >
              {Array.from({ length: columns }).map((_, colIndex) => (
                <Skeleton
                  key={`cell-${rowIndex}-${colIndex}`}
                  className={cn(
                    'h-4',
                    colIndex === 0 ? 'w-[180px]' : 'w-[90px]',
                    colIndex === columns - 1 && 'ml-auto w-[70px]'
                  )}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Pagination skeleton */}
      <div className="mt-4 flex items-center justify-between">
        <Skeleton className="h-4 w-[100px]" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
    </div>
  )
}
