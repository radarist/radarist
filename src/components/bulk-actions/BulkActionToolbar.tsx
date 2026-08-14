/**
 * @file components/bulk-actions/BulkActionToolbar.tsx
 * @description Floating toolbar that appears when items are selected in a table.
 *
 * Displays selection count and available bulk actions (e.g., delete).
 * Positioned at the bottom of the viewport for easy access.
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface BulkActionToolbarProps {
  /** Number of selected items */
  selectedCount: number;
  /** Entity type for display (e.g., "company", "technology") */
  entityType: string;
  /** Called when delete action is clicked */
  onDelete?: () => void;
  /** Called when clear selection is clicked */
  onClearSelection: () => void;
  /** Whether delete action is loading */
  isDeleting?: boolean;
  /** Additional actions to display */
  additionalActions?: React.ReactNode;
  /** Additional className for the toolbar */
  className?: string;
}

/**
 * Floating toolbar for bulk actions on selected table rows.
 *
 * @example
 * ```tsx
 * <BulkActionToolbar
 *   selectedCount={selectedIds.length}
 *   entityType="company"
 *   onDelete={() => setShowDeleteDialog(true)}
 *   onClearSelection={clearSelection}
 * />
 * ```
 */
export function BulkActionToolbar({
  selectedCount,
  entityType,
  onDelete,
  onClearSelection,
  isDeleting = false,
  additionalActions,
  className,
}: BulkActionToolbarProps) {
  // Pluralize entity type (handle irregular plurals)
  const entityLabel = selectedCount === 1
    ? entityType
    : entityType.endsWith('y')
      ? `${entityType.slice(0, -1)}ies`
      : entityType.endsWith('s') || entityType.endsWith('x') || entityType.endsWith('ch') || entityType.endsWith('sh')
        ? `${entityType}es`
        : `${entityType}s`;

  if (selectedCount === 0) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className={cn(
          'fixed bottom-6 left-1/2 -translate-x-1/2 z-50',
          'flex items-center gap-3 px-4 py-3',
          'bg-background border border-border rounded-lg shadow-lg',
          className
        )}
      >
        {/* Selection Count */}
        <div className="flex items-center gap-2 pr-3 border-r border-border">
          <span className="text-sm font-medium">
            {selectedCount} {entityLabel} selected
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClearSelection}
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {additionalActions}

          {onDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onDelete}
              disabled={isDeleting}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
