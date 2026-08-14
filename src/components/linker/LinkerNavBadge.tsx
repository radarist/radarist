/**
 * @file LinkerNavBadge.tsx
 * @description Badge component showing pending proposed relations count for sidebar navigation
 */

"use client"

import { usePendingProposedRelationsCount } from "@/hooks/useProposedRelations"
import { Badge } from "@/components/ui/badge"

/**
 * Navigation badge showing the count of pending proposed relations
 * Used in the sidebar to indicate items needing review
 */
export function LinkerNavBadge() {
  const { data: count, isLoading } = usePendingProposedRelationsCount()

  // Don't show badge if loading or no pending items
  if (isLoading || !count || count === 0) {
    return null
  }

  return (
    <Badge
      variant="secondary"
      className="ml-auto h-5 min-w-5 px-1.5 text-xs font-medium"
    >
      {count > 99 ? "99+" : count}
    </Badge>
  )
}
