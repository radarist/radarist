/**
 * @file ScrollToBottom.tsx
 * @description Floating button to scroll to the bottom of a scrollable container
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

"use client";

import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScrollToBottomProps {
  /** Whether the button should be visible */
  visible: boolean;
  /** Called when button is clicked */
  onClick: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Floating button that appears when user scrolls up in a chat.
 * Clicking it scrolls back to the most recent message.
 */
export function ScrollToBottom({
  visible,
  onClick,
  className,
}: ScrollToBottomProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.2 }}
          className={cn(
            "absolute bottom-2 left-1/2 -translate-x-1/2 z-10",
            className
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            className="shadow-lg gap-1 text-xs"
            onClick={onClick}
            data-testid="scroll-to-bottom-button"
          >
            <ChevronDown className="h-3 w-3" />
            Scroll to bottom
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
