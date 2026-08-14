'use client'

import { LucideIcon, FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Action configuration for EmptyState
 */
interface EmptyStateAction {
  /** Button label */
  label: string
  /** Click handler */
  onClick: () => void
  /** Optional icon to show before label */
  icon?: LucideIcon
  /** Button variant (defaults to "default") */
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
}

/**
 * EmptyState Props
 *
 * IMPORTANT: The `action` prop is REQUIRED.
 * Every empty state must guide the user to a next action.
 */
interface EmptyStateProps {
  /** Main title (e.g., "No signals detected") */
  title: string
  /** Descriptive text explaining what to do */
  description?: string
  /** Icon to display (defaults to FileQuestion) */
  icon?: LucideIcon
  /**
   * Primary action button - REQUIRED
   * Empty states without actions are dead ends!
   */
  action: EmptyStateAction
  /** Optional secondary action */
  secondaryAction?: EmptyStateAction
  /** Additional class names */
  className?: string
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
}

/**
 * EmptyState Component
 *
 * Displays a user-friendly message when there's no data to show.
 * ALWAYS includes an action button to guide users to the next step.
 *
 * @example
 * ```tsx
 * <EmptyState
 *   icon={Radio}
 *   title="No signals detected"
 *   description="Import signals or run an agent to discover new information."
 *   action={{
 *     label: "Run Scout Agent",
 *     onClick: () => runScoutAgent(),
 *     icon: Bot,
 *   }}
 * />
 * ```
 */
export function EmptyState({
  title,
  description,
  icon: Icon = FileQuestion,
  action,
  secondaryAction,
  className,
  size = 'md',
}: EmptyStateProps) {
  const sizeClasses = {
    sm: {
      container: 'py-8 px-4',
      icon: 'h-8 w-8',
      title: 'text-base',
      description: 'text-sm',
    },
    md: {
      container: 'py-12 px-6',
      icon: 'h-12 w-12',
      title: 'text-lg',
      description: 'text-sm',
    },
    lg: {
      container: 'py-16 px-8',
      icon: 'h-16 w-16',
      title: 'text-xl',
      description: 'text-base',
    },
  }

  const sizes = sizeClasses[size]

  return (
    <div
      data-testid="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        sizes.container,
        className
      )}
    >
      {/* Icon */}
      <div className="mb-4 rounded-full bg-muted p-3">
        <Icon className={cn('text-muted-foreground', sizes.icon)} />
      </div>

      {/* Title */}
      <h3 className={cn('font-semibold text-foreground', sizes.title)}>
        {title}
      </h3>

      {/* Description */}
      {description && (
        <p
          className={cn(
            'mt-2 max-w-md text-muted-foreground',
            sizes.description
          )}
        >
          {description}
        </p>
      )}

      {/* Actions */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {/* Primary Action (Required) */}
        <Button
          variant={action.variant || 'default'}
          onClick={action.onClick}
          className="gap-2"
        >
          {action.icon && <action.icon className="h-4 w-4" />}
          {action.label}
        </Button>

        {/* Secondary Action (Optional) */}
        {secondaryAction && (
          <Button
            variant={secondaryAction.variant || 'outline'}
            onClick={secondaryAction.onClick}
            className="gap-2"
          >
            {secondaryAction.icon && (
              <secondaryAction.icon className="h-4 w-4" />
            )}
            {secondaryAction.label}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * EmptyStateCard - EmptyState wrapped in a card for standalone use
 */
export function EmptyStateCard(props: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed bg-card">
      <EmptyState {...props} />
    </div>
  )
}
