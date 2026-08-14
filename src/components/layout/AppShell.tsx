'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

// ============================================================================
// APP SHELL - Outer frame container
// ============================================================================

interface AppShellProps {
  children: React.ReactNode
  className?: string
}

/**
 * AppShell
 *
 * The outermost container that creates the "desktop app" feel.
 * Provides:
 * - Dark page background (pure black)
 * - Rounded container with border and shadow
 * - Padding from viewport edges
 *
 * This is what makes it look like a sleek app inside the browser,
 * similar to shadcn's dashboard examples.
 *
 * Usage:
 * ```tsx
 * <AppShell>
 *   <Sidebar />
 *   <MainArea />
 * </AppShell>
 * ```
 */
export function AppShell({ children, className }: AppShellProps) {
  return (
    <div className="min-h-screen bg-black p-2 md:p-3 lg:p-4">
      <div
        className={cn(
          // Layout
          'mx-auto flex h-[calc(100vh-1rem)] md:h-[calc(100vh-1.5rem)] lg:h-[calc(100vh-2rem)]',
          // Shape
          'overflow-hidden rounded-xl md:rounded-2xl',
          // Border & background
          'border border-border/50 bg-background',
          // Shadow - creates depth
          'shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_8px_40px_rgba(0,0,0,0.5)]',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

// ============================================================================
// MAIN AREA - Content area next to sidebar
// ============================================================================

interface MainAreaProps {
  children: React.ReactNode
  className?: string
}

/**
 * MainArea
 *
 * The main content area that sits next to the sidebar.
 * Provides the flex-1 container with proper background.
 */
export function MainArea({ children, className }: MainAreaProps) {
  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden bg-background', className)}>
      {children}
    </div>
  )
}

// ============================================================================
// MAIN HEADER - Top bar in main area
// ============================================================================

interface MainHeaderProps {
  children: React.ReactNode
  className?: string
}

/**
 * MainHeader
 *
 * Header bar at the top of the main content area.
 * Contains breadcrumbs, title, and actions.
 */
export function MainHeader({ children, className }: MainHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center justify-between gap-4',
        'border-b border-border/50 px-6 py-4',
        className
      )}
    >
      {children}
    </header>
  )
}

// ============================================================================
// MAIN CONTENT - Scrollable content area
// ============================================================================

interface MainContentProps {
  children: React.ReactNode
  className?: string
  /** Remove default padding */
  noPadding?: boolean
}

/**
 * MainContent
 *
 * The scrollable content area below the header.
 */
export function MainContent({ children, className, noPadding }: MainContentProps) {
  return (
    <div
      className={cn(
        'flex-1 overflow-auto',
        !noPadding && 'p-4 md:p-6',
        className
      )}
    >
      {children}
    </div>
  )
}

// ============================================================================
// CONTENT CARD - Inner card for content sections
// ============================================================================

interface ContentCardProps {
  children: React.ReactNode
  className?: string
}

/**
 * ContentCard
 *
 * A card component for content sections within the main area.
 * Has bolder styling than regular cards - rounded-xl, visible border, subtle shadow.
 */
export function ContentCard({ children, className }: ContentCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card',
        'shadow-[0_4px_20px_rgba(0,0,0,0.3)]',
        className
      )}
    >
      {children}
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type {
  AppShellProps,
  MainAreaProps,
  MainHeaderProps,
  MainContentProps,
  ContentCardProps,
}
