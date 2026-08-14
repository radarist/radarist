'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { AppShell } from './AppShell';
import { Breadcrumbs, type BreadcrumbSegment } from './Breadcrumbs';
import { CommandPaletteTrigger } from '../CommandPalette';
import { ThemeToggle } from '../ThemeToggle';
import { Separator } from '@/components/ui/separator';
import { AIContextProvider } from '@/contexts/AIContextProvider';
import { AIAssistant } from '@/components/ai';

// PERFORMANCE: Lazy load heavy components to reduce initial bundle size
const CommandPalette = dynamic(() => import('../CommandPalette').then((mod) => ({ default: mod.CommandPalette })), {
  ssr: false,
});

const NotificationBell = dynamic(
  () => import('../NotificationBell').then((mod) => ({ default: mod.NotificationBell })),
  { ssr: false }
);

// ============================================================================
// TYPES
// ============================================================================

interface AppLayoutV2Props {
  children: React.ReactNode;
  /**
   * Entity name for breadcrumbs on detail pages
   */
  entityName?: string;
  /**
   * Custom breadcrumbs to override auto-generation
   */
  customBreadcrumbs?: BreadcrumbSegment[];
  /**
   * Whether to show breadcrumbs
   * @default true
   */
  showBreadcrumbs?: boolean;
  /**
   * Whether to show the command palette trigger in header
   * @default true
   */
  showCommandTrigger?: boolean;
}

// ============================================================================
// MAIN LAYOUT COMPONENT
// ============================================================================

/**
 * AppLayoutV2
 *
 * New application layout following the shadcn sidebar pattern with AppShell wrapper.
 * Uses AppShell for the "desktop app" frame effect:
 * - Black page background
 * - Rounded container with border and shadow
 * - Sidebar and main content share the same bg-background surface
 */
export function AppLayoutV2({
  children,
  entityName,
  customBreadcrumbs,
  showBreadcrumbs = true,
  showCommandTrigger = true,
}: AppLayoutV2Props) {
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);

  return (
    <AIContextProvider>
      <AppShell>
        {/* Flex container to properly share space between sidebar and AI panel */}
        <SidebarProvider className="!w-auto flex-1 min-w-0">
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden">
            {/* Top bar */}
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/50 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />

              {/* Breadcrumbs */}
              {showBreadcrumbs && <Breadcrumbs entityName={entityName} customBreadcrumbs={customBreadcrumbs} />}

              {/* Right side actions */}
              <div className="ml-auto flex items-center gap-2">
                <span className="hidden sm:inline text-xs text-muted-foreground px-2">
                  v0.1 prototype
                </span>
                {showCommandTrigger && <CommandPaletteTrigger onClick={() => setCommandPaletteOpen(true)} />}
                <NotificationBell />
                <ThemeToggle />
              </div>
            </header>

            {/* Main content area - using div since SidebarInset is already a <main> element */}
            <div id="main-content" className="flex-1 overflow-auto p-4 md:p-6 min-w-0">
              <div className="flex h-full w-full flex-col gap-4">{children}</div>
            </div>
          </SidebarInset>
        </SidebarProvider>

        {/* Command Palette (global overlay) */}
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

        {/* AI Assistant */}
        <AIAssistant />
      </AppShell>
    </AIContextProvider>
  );
}

// ============================================================================
// LAYOUT WRAPPER
// ============================================================================

interface SmartLayoutProps {
  children: React.ReactNode;
  entityName?: string;
  customBreadcrumbs?: BreadcrumbSegment[];
  showBreadcrumbs?: boolean;
  showCommandTrigger?: boolean;
}

/**
 * SmartLayout
 *
 * Wrapper around AppLayoutV2 for consistent layout usage across pages.
 */
export function SmartLayout({
  children,
  entityName,
  customBreadcrumbs,
  showBreadcrumbs = true,
  showCommandTrigger = true,
}: SmartLayoutProps) {
  return (
    <AppLayoutV2
      entityName={entityName}
      customBreadcrumbs={customBreadcrumbs}
      showBreadcrumbs={showBreadcrumbs}
      showCommandTrigger={showCommandTrigger}
    >
      {children}
    </AppLayoutV2>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { AppLayoutV2Props, SmartLayoutProps };
