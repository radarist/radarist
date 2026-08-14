/**
 * @file AIFloatingButton.tsx
 * @description Floating button to toggle the AI Assistant
 *
 * A fixed-position button in the bottom-right corner that opens
 * the AI chat interface.
 */

'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { OctopusLogo } from '@/components/branding/OctopusLogo';

interface AIFloatingButtonProps {
  /** Number of notifications to display */
  notificationCount?: number;
  /** Click handler to open the AI panel */
  onClick: () => void;
  /** Whether the AI panel is currently open */
  isOpen?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Floating button component for triggering the AI Assistant.
 *
 * Features:
 * - Fixed position in bottom-right corner
 * - Notification badge for pending items
 * - Hover animation
 * - Tooltip with keyboard shortcut
 * - Renders the OctopusLogo as the brand mark
 */
export function AIFloatingButton({ notificationCount = 0, onClick, isOpen = false, className }: AIFloatingButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className={cn(
              'fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-50',
              'bg-background border-2 border-border hover:bg-muted',
              'transition-all duration-200 hover:scale-105',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isOpen && 'scale-0 opacity-0 pointer-events-none',
              className
            )}
            onClick={onClick}
            aria-label="Open AI Assistant"
          >
            <OctopusLogo size="md" />
            {notificationCount > 0 && (
              <Badge
                variant="destructive"
                className={cn('absolute -top-1 -right-1 h-5 min-w-5 p-0', 'flex items-center justify-center text-xs')}
              >
                {notificationCount > 9 ? '9+' : notificationCount}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          <p>
            AI Assistant <span className="text-muted-foreground ml-1">⌘/</span>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
