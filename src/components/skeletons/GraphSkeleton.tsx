'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface GraphSkeletonProps {
  /** Additional class names */
  className?: string
}

/**
 * GraphSkeleton
 *
 * Skeleton loader that mimics the force-directed graph visualization.
 * Used as fallback when lazy-loading the heavy graph component.
 *
 * @example
 * ```tsx
 * const ForceGraph = dynamic(
 *   () => import('react-force-graph-2d'),
 *   { loading: () => <GraphSkeleton />, ssr: false }
 * )
 * ```
 */
export function GraphSkeleton({ className }: GraphSkeletonProps) {
  // Predefined node positions for a realistic graph skeleton
  const nodes = [
    { x: 50, y: 50, size: 'lg' },
    { x: 25, y: 30, size: 'md' },
    { x: 75, y: 35, size: 'md' },
    { x: 20, y: 60, size: 'sm' },
    { x: 40, y: 75, size: 'sm' },
    { x: 60, y: 70, size: 'md' },
    { x: 80, y: 55, size: 'sm' },
    { x: 35, y: 25, size: 'sm' },
    { x: 65, y: 20, size: 'sm' },
    { x: 15, y: 45, size: 'sm' },
    { x: 85, y: 75, size: 'sm' },
    { x: 55, y: 85, size: 'sm' },
  ] as const

  // Connections between nodes (indices)
  const edges = [
    [0, 1],
    [0, 2],
    [0, 5],
    [1, 3],
    [1, 7],
    [2, 6],
    [2, 8],
    [3, 9],
    [4, 0],
    [5, 4],
    [5, 10],
    [6, 10],
    [4, 11],
  ]

  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-10 w-10',
  }

  return (
    <div
      className={cn(
        'relative h-full min-h-[500px] w-full overflow-hidden rounded-lg border bg-card',
        className
      )}
    >
      {/* SVG for edges */}
      <svg className="absolute inset-0 h-full w-full">
        {edges.map(([from, to], i) => (
          <line
            key={i}
            x1={`${nodes[from].x}%`}
            y1={`${nodes[from].y}%`}
            x2={`${nodes[to].x}%`}
            y2={`${nodes[to].y}%`}
            className="stroke-muted-foreground/20"
            strokeWidth={1}
          />
        ))}
      </svg>

      {/* Nodes */}
      {nodes.map((node, i) => (
        <Skeleton
          key={i}
          className={cn(
            'absolute rounded-full',
            sizeClasses[node.size]
          )}
          style={{
            left: `${node.x}%`,
            top: `${node.y}%`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      ))}

      {/* Controls skeleton (bottom-left) */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-2">
        <Skeleton className="h-8 w-8 rounded" />
        <Skeleton className="h-8 w-8 rounded" />
        <Skeleton className="h-8 w-8 rounded" />
      </div>

      {/* Legend/filter skeleton (top-right) */}
      <div className="absolute right-4 top-4 space-y-2">
        <Skeleton className="h-8 w-[120px] rounded" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </div>
    </div>
  )
}
