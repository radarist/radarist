'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * SettingsSkeleton
 *
 * Skeleton loader that mimics the settings page layout.
 * Use this instead of spinners when loading settings data.
 */
export function SettingsSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-6', className)}>
      {/* Tabs */}
      <div className="flex gap-2 border-b pb-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-md" />
        ))}
      </div>

      {/* Settings Content */}
      <div className="space-y-6">
        {/* Section */}
        <div className="space-y-4">
          <Skeleton className="h-6 w-32" />
          <div className="rounded-lg border p-4 space-y-4">
            <SettingRowSkeleton />
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </div>
        </div>

        {/* Another Section */}
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="rounded-lg border p-4 space-y-4">
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Single setting row skeleton
 */
function SettingRowSkeleton() {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="space-y-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
      </div>
      <Skeleton className="h-6 w-12 rounded-full" />
    </div>
  )
}

export { SettingRowSkeleton }
