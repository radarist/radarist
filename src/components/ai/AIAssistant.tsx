/**
 * @file AIAssistant.tsx
 * @description Main AI Assistant component with two display modes
 *
 * Supports:
 * - Floating button mode (default): Button in corner, opens sheet
 * - Panel mode: Persistent right panel
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { PanelRightClose, PanelRightOpen, GripVertical } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAIStore } from '@/stores/ai-store';
import { AIFloatingButton } from './AIFloatingButton';
import { AIChat } from './AIChat';

/**
 * True while the chat input's slash-command menu is open (it renders a
 * `[data-slash-menu-open]` element). In floating mode the Sheet's Radix escape
 * handler fires on document capture — before React dismisses the menu — so it
 * consults this to let the first Escape back out of the menu rather than close
 * the panel. (Panel mode is handled separately: ChatInput stops the Escape from
 * propagating to the window listener.)
 */
const isSlashMenuOpen = () =>
  typeof document !== 'undefined' && document.querySelector('[data-slash-menu-open]') !== null;

interface AIAssistantProps {
  /** Additional CSS classes for the panel */
  className?: string;
}

/**
 * Main AI Assistant component.
 *
 * Usage:
 * ```tsx
 * // In root layout
 * <AIAssistant />
 * ```
 */
export function AIAssistant({ className }: AIAssistantProps) {
  const { config, setConfig, isOpen, setIsOpen, toggle, notificationCount } = useAIStore();

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for mod+/ (Cmd+/ on Mac, Ctrl+/ on Windows)
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === '/') {
        e.preventDefault();
        toggle();
      }

      // Close on Escape (but not if inside a nested Radix popover). In panel
      // mode the chat input's slash-command menu calls stopPropagation on the
      // first Escape so it never reaches this window listener — the menu
      // dismisses and a second Escape closes the panel.
      if (e.key === 'Escape' && isOpen) {
        const target = e.target as HTMLElement;
        const isInPopover = target?.closest('[data-radix-popper-content-wrapper]');
        if (!isInPopover) {
          setIsOpen(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle, isOpen, setIsOpen]);

  // Resize handlers for panel mode
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = config.panelWidth;
    },
    [config.panelWidth]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate new width (drag left = increase width since panel is on right)
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.min(600, Math.max(300, startWidthRef.current + delta));
      setConfig({ panelWidth: newWidth });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, setConfig]);

  // Handle sheet close
  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
    },
    [setIsOpen]
  );

  // Floating Button Mode (default)
  if (config.mode === 'floating') {
    return (
      <>
        {/* Floating Button — badge respects the "Show notification badge"
            setting (Settings → AI Assistant → notificationsEnabled). */}
        <AIFloatingButton
          notificationCount={config.notificationsEnabled ? notificationCount : 0}
          onClick={toggle}
          isOpen={isOpen}
        />

        {/* Sheet for Chat.
            UX-055: floating mode is non-modal. The default modal Sheet renders a
            full-viewport overlay that sets `document.body { pointer-events: none }`,
            making every page control (Settings tabs, triage approve/reject) inert
            while the Assistant is open and dismissing it on any outside click.
            `modal={false}` drops the overlay and lets outside clicks pass through,
            so the panel behaves like a docked pane: page interactions keep working
            and an intentional conversation survives app navigation. Close via the
            header button, the floating toggle, or Escape. */}
        <Sheet open={isOpen} onOpenChange={handleSheetOpenChange} modal={false}>
          <SheetContent
            side="right"
            modal={false}
            className="w-full sm:max-w-[400px] p-0 flex flex-col"
            onEscapeKeyDown={(e) => {
              // Let the slash-command menu handle the first Escape itself.
              if (isSlashMenuOpen()) e.preventDefault();
            }}
          >
            <SheetHeader className="px-4 py-3 border-b">
              <SheetTitle className="flex items-center gap-2">AI Assistant</SheetTitle>
              <SheetDescription className="sr-only">
                AI-powered assistant for filtering entities, understanding patterns, and performing bulk operations
              </SheetDescription>
            </SheetHeader>
            <AIChat className="flex-1 min-h-0 min-w-0" />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Panel Mode
  return (
    <aside
      ref={resizeRef}
      className={cn(
        'relative border-l bg-background flex flex-col h-full min-h-0 overflow-hidden shrink-0',
        !isResizing && 'transition-all duration-300',
        isOpen ? 'w-[400px]' : 'w-0',
        className
      )}
      style={{
        width: isOpen ? config.panelWidth : 0,
        minWidth: isOpen ? 300 : 0,
        maxWidth: isOpen ? 600 : 0,
      }}
    >
      {/* Resize Handle */}
      {isOpen && (
        <div
          className={cn(
            'absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10',
            'hover:bg-primary/20 active:bg-primary/30',
            'flex items-center justify-center',
            isResizing && 'bg-primary/30'
          )}
          onMouseDown={handleResizeStart}
        >
          <div className="absolute left-0 w-4 h-12 flex items-center justify-center -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity">
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      )}

      {/* Panel Header — h-14 + border-border/50 mirror the app header exactly
          so the two bottom borders form one continuous line (was py-3, whose
          content-derived ~57px height sat 1px lower than the app header's 56px). */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4 border-b border-border/50">
        <h2 className="font-semibold">AI Assistant</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={toggle}
            title={isOpen ? 'Collapse panel' : 'Expand panel'}
          >
            {isOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Panel Content */}
      {isOpen && <AIChat className="flex-1 min-h-0 min-w-0" />}

      {/* Collapsed state toggle button (shown when collapsed) */}
      {!isOpen && config.mode === 'panel' && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed right-2 top-1/2 -translate-y-1/2 z-50"
          onClick={toggle}
          title="Open AI Assistant"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      )}
    </aside>
  );
}

// ============================================================================
// Panel Layout Wrapper
// ============================================================================

interface AILayoutWrapperProps {
  children: React.ReactNode;
}

/**
 * Wraps the main content to handle panel mode layout.
 * Use this in the root layout to enable shrinking when panel opens.
 *
 * Usage:
 * ```tsx
 * <AILayoutWrapper>
 *   <main>{children}</main>
 * </AILayoutWrapper>
 * <AIAssistant />
 * ```
 */
export function AILayoutWrapper({ children }: AILayoutWrapperProps) {
  const { config, isOpen } = useAIStore();

  // In floating mode, no layout changes needed
  if (config.mode === 'floating') {
    return <>{children}</>;
  }

  // In panel mode, content shrinks when panel is open
  return (
    <div
      className={cn(
        'flex-1 min-w-0 overflow-auto transition-all duration-300',
        isOpen && 'mr-0' // Content shrinks, panel takes remaining space
      )}
    >
      {children}
    </div>
  );
}
