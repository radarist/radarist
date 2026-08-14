'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface RadarSkeletonProps {
  /** Additional class names */
  className?: string
}

/**
 * RadarSkeleton
 *
 * Skeleton loader that mimics the radar visualization.
 * Used as fallback when lazy-loading the heavy radar component.
 *
 * @example
 * ```tsx
 * const Radar = dynamic(
 *   () => import('@/components/radar/RadarVisualization'),
 *   { loading: () => <RadarSkeleton />, ssr: false }
 * )
 * ```
 */
export function RadarSkeleton({ className }: RadarSkeletonProps) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[600px] w-full flex-col items-center justify-center',
        className
      )}
    >
      {/* Radar circles */}
      <div className="relative aspect-square w-full max-w-[600px]">
        {/* Outer ring */}
        <Skeleton className="absolute inset-0 rounded-full opacity-30" />

        {/* Middle ring */}
        <div className="absolute inset-[15%]">
          <Skeleton className="h-full w-full rounded-full opacity-40" />
        </div>

        {/* Inner ring */}
        <div className="absolute inset-[30%]">
          <Skeleton className="h-full w-full rounded-full opacity-50" />
        </div>

        {/* Center */}
        <div className="absolute inset-[45%]">
          <Skeleton className="h-full w-full rounded-full opacity-60" />
        </div>

        {/* Quadrant lines */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border/50" />
        <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-border/50" />

        {/* Simulated blips */}
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i * 30 * Math.PI) / 180
          // Use deterministic value instead of Math.random() to avoid hydration mismatch
          const pseudoRandom = (Math.sin(i * 999) + 1) / 2
          const radius = 30 + pseudoRandom * 40 // 30-70% from center
          // Round to 2 decimal places to ensure server/client produce identical strings
          const x = Math.round((50 + radius * Math.cos(angle)) * 100) / 100
          const y = Math.round((50 + radius * Math.sin(angle)) * 100) / 100

          return (
            <Skeleton
              key={i}
              className="absolute h-3 w-3 rounded-full"
              style={{
                left: `${x}%`,
                top: `${y}%`,
                transform: 'translate(-50%, -50%)',
              }}
            />
          )
        })}
      </div>

      {/* Legend skeleton */}
      <div className="mt-8 flex flex-wrap justify-center gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3 w-3 rounded-full" />
            <Skeleton className="h-4 w-[80px]" />
          </div>
        ))}
      </div>
    </div>
  )
}
