'use client'

import React from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('ui/ErrorBoundary')

// ============================================================================
// ERROR FALLBACK COMPONENT
// ============================================================================

interface ErrorFallbackProps {
  /** The error that was caught */
  error: Error | null
  /** Function to reset the error boundary */
  reset: () => void
  /** Optional title override */
  title?: string
  /** Optional description override */
  description?: string
  /** Additional class names */
  className?: string
}

/**
 * ErrorFallback
 *
 * User-friendly error display shown when an error is caught.
 * Always includes a retry button.
 */
export function ErrorFallback({
  error,
  reset,
  title = 'Something went wrong',
  description,
  className,
}: ErrorFallbackProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center p-8 text-center',
        className
      )}
    >
      {/* Icon */}
      <div className="mb-4 rounded-full bg-destructive/10 p-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
      </div>

      {/* Title */}
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>

      {/* Description */}
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {description ||
          error?.message ||
          'An unexpected error occurred. Please try again.'}
      </p>

      {/* Error details in development */}
      {process.env.NODE_ENV === 'development' && error && (
        <details className="mt-4 max-w-md text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Error details (dev only)
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">
            {error.stack || error.message}
          </pre>
        </details>
      )}

      {/* Retry button */}
      <Button onClick={reset} className="mt-6 gap-2">
        <RefreshCw className="h-4 w-4" />
        Try again
      </Button>
    </div>
  )
}

// ============================================================================
// ERROR BOUNDARY CLASS COMPONENT
// ============================================================================

interface ErrorBoundaryProps {
  children: React.ReactNode
  /** Custom fallback component or element */
  fallback?: React.ReactNode
  /** Callback when error is caught */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  /** Custom fallback render function */
  fallbackRender?: (props: { error: Error; reset: () => void }) => React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * ErrorBoundary
 *
 * Catches JavaScript errors in child component tree and displays fallback UI.
 * Prevents one component crash from taking down the whole app.
 *
 * @example
 * ```tsx
 * // With default fallback
 * <ErrorBoundary>
 *   <RadarVisualization />
 * </ErrorBoundary>
 *
 * // With custom fallback
 * <ErrorBoundary fallback={<CustomError />}>
 *   <ForceGraph />
 * </ErrorBoundary>
 *
 * // With render function for access to error and reset
 * <ErrorBoundary
 *   fallbackRender={({ error, reset }) => (
 *     <CustomError error={error} onRetry={reset} />
 *   )}
 * >
 *   <RiskyComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to console
    log.error('ErrorBoundary caught an error', error instanceof Error ? error : undefined, { componentStack: errorInfo?.componentStack })

    // Call optional callback
    this.props.onError?.(error, errorInfo)
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      // Custom fallback render function
      if (this.props.fallbackRender) {
        return this.props.fallbackRender({
          error: this.state.error!,
          reset: this.reset,
        })
      }

      // Custom fallback element
      if (this.props.fallback) {
        return this.props.fallback
      }

      // Default fallback
      return <ErrorFallback error={this.state.error} reset={this.reset} />
    }

    return this.props.children
  }
}

// ============================================================================
// HOC FOR EASY WRAPPING
// ============================================================================

/**
 * withErrorBoundary HOC
 *
 * Wraps a component with an ErrorBoundary for easy reuse.
 *
 * @example
 * ```tsx
 * const SafeRadar = withErrorBoundary(RadarVisualization)
 * // Use: <SafeRadar entries={entries} />
 * ```
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
) {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <Component {...props} />
    </ErrorBoundary>
  )

  // Set display name for dev tools
  const displayName = Component.displayName || Component.name || 'Component'
  WrappedComponent.displayName = `withErrorBoundary(${displayName})`

  return WrappedComponent
}
