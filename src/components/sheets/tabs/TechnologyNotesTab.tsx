'use client'

import * as React from 'react'
import { Loader2, Check, AlertCircle } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useAutosave, type AutosaveStatus } from '@/hooks/useAutosave'

// ============================================================================
// TYPES
// ============================================================================

interface TechnologyNotesTabProps {
  /** Current notes value */
  notes: string
  /** Callback when notes change (for autosave) */
  onSave: (notes: string) => Promise<void>
  /** Whether in read-only mode */
  readOnly?: boolean
  /** Placeholder text */
  placeholder?: string
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * TechnologyNotesTab
 *
 * Simple notes tab with a single textarea and autosave.
 * Designed for the Technology entity's notes field (single string).
 *
 * @example
 * ```tsx
 * <TechnologyNotesTab
 *   notes={technology.notes || ''}
 *   onSave={async (notes) => {
 *     await updateTechnology(id, { notes })
 *   }}
 * />
 * ```
 */
export function TechnologyNotesTab({
  notes,
  onSave,
  readOnly = false,
  placeholder = 'Add notes about this technology...',
  className,
}: TechnologyNotesTabProps) {
  const [content, setContent] = React.useState(notes)

  // Sync with prop changes
  React.useEffect(() => {
    setContent(notes)
  }, [notes])

  // Autosave
  const { status } = useAutosave({
    data: content,
    onSave: async (newContent) => {
      if (newContent !== notes) {
        await onSave(newContent)
      }
    },
    debounceMs: 1500,
    enabled: !readOnly,
  })

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        rows={12}
        className="resize-none flex-1 min-h-[300px]"
        disabled={readOnly}
      />

      {/* Status indicator */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {content.length} characters
        </span>
        <AutosaveIndicator status={status} />
      </div>
    </div>
  )
}

// ============================================================================
// AUTOSAVE INDICATOR
// ============================================================================

function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  if (status === 'idle') {
    return <span className="text-xs text-muted-foreground">Auto-saves as you type</span>
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === 'saving' && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Saving...</span>
        </>
      )}
      {status === 'saved' && (
        <>
          <Check className="h-3 w-3 text-green-500" />
          <span>Saved</span>
        </>
      )}
      {status === 'error' && (
        <>
          <AlertCircle className="h-3 w-3 text-destructive" />
          <span>Failed to save</span>
        </>
      )}
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { TechnologyNotesTabProps }
