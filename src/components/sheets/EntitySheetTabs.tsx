'use client'

import * as React from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

// ============================================================================
// TYPES
// ============================================================================

export interface SheetTab {
  /** Unique identifier for the tab */
  id: string
  /** Display label */
  label: string
  /** Optional icon */
  icon?: LucideIcon
  /** Tab content */
  content: React.ReactNode
  /** Whether tab is disabled */
  disabled?: boolean
  /** Badge count (e.g., for relations count) */
  badge?: number
}

interface EntitySheetTabsProps {
  /** Array of tabs to display */
  tabs: SheetTab[]
  /** Default active tab ID */
  defaultTab?: string
  /** Controlled active tab */
  activeTab?: string
  /** Callback when tab changes */
  onTabChange?: (tabId: string) => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * EntitySheetTabs
 *
 * Tab navigation component for entity sheets.
 * Provides a consistent tab interface with support for icons and badges.
 *
 * @example
 * ```tsx
 * <EntitySheetTabs
 *   tabs={[
 *     { id: 'overview', label: 'Overview', icon: Info, content: <OverviewTab /> },
 *     { id: 'relations', label: 'Relations', icon: Network, badge: 5, content: <RelationsTab /> },
 *     { id: 'notes', label: 'Notes', icon: FileText, content: <NotesTab /> },
 *   ]}
 *   defaultTab="overview"
 * />
 * ```
 */
export function EntitySheetTabs({
  tabs,
  defaultTab,
  activeTab,
  onTabChange,
  className,
}: EntitySheetTabsProps) {
  const defaultValue = defaultTab ?? tabs[0]?.id

  return (
    <Tabs
      defaultValue={defaultValue}
      value={activeTab}
      onValueChange={onTabChange}
      className={cn('flex flex-col', className)}
    >
      {/* Tab List */}
      <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b bg-transparent p-0 px-0">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              disabled={tab.disabled}
              className={cn(
                'relative rounded-none border-b-2 border-transparent px-4 py-2.5',
                'data-[state=active]:border-primary data-[state=active]:bg-transparent',
                'data-[state=active]:shadow-none',
                'hover:bg-muted/50 transition-colors'
              )}
            >
              <span className="flex items-center gap-2">
                {Icon && <Icon className="h-4 w-4" />}
                <span>{tab.label}</span>
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium">
                    {tab.badge}
                  </span>
                )}
              </span>
            </TabsTrigger>
          )
        })}
      </TabsList>

      {/* Tab Content */}
      {tabs.map((tab) => (
        <TabsContent
          key={tab.id}
          value={tab.id}
          className="mt-0 flex-1 focus-visible:outline-none focus-visible:ring-0"
        >
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { EntitySheetTabsProps }
