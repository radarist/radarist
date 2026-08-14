'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface UseAutosaveOptions<T> {
  /** Data to watch for changes */
  data: T
  /** Async save function */
  onSave: (data: T) => Promise<void>
  /** Debounce delay in milliseconds (default: 2000) */
  debounceMs?: number
  /** Whether autosave is enabled (default: true) */
  enabled?: boolean
  /** Callback on successful save */
  onSuccess?: () => void
  /** Callback on error */
  onError?: (error: Error) => void
}

export interface UseAutosaveReturn {
  /** Current autosave status */
  status: AutosaveStatus
  /** Last successful save timestamp */
  lastSaved: Date | null
  /** Error if save failed */
  error: Error | null
  /** Manually trigger save */
  save: () => Promise<void>
  /** Reset status to idle */
  reset: () => void
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * useAutosave
 *
 * Automatically saves data after a debounce period when changes are detected.
 * Useful for forms where you want to save as the user types.
 *
 * @example
 * ```tsx
 * const [notes, setNotes] = useState(initialNotes)
 *
 * const { status, lastSaved } = useAutosave({
 *   data: notes,
 *   onSave: async (data) => {
 *     await updateEntityNotes(entityId, data)
 *   },
 *   debounceMs: 2000,
 * })
 *
 * return (
 *   <div>
 *     <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
 *     <AutosaveIndicator status={status} lastSaved={lastSaved} />
 *   </div>
 * )
 * ```
 */
export function useAutosave<T>({
  data,
  onSave,
  debounceMs = 2000,
  enabled = true,
  onSuccess,
  onError,
}: UseAutosaveOptions<T>): UseAutosaveReturn {
  const [status, setStatus] = useState<AutosaveStatus>('idle')
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [error, setError] = useState<Error | null>(null)

  // Track previous data to detect changes
  const previousDataRef = useRef<T>(data)
  const initialDataRef = useRef<T>(data)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const isMountedRef = useRef(true)
  const dataRef = useRef(data)
  const onSaveRef = useRef(onSave)
  const onSuccessRef = useRef(onSuccess)
  const onErrorRef = useRef(onError)

  // Keep the save function stable across renders. Consumers commonly pass
  // inline callbacks; making the debounce effect depend on their identity can
  // reschedule a failed save forever as status updates trigger rerenders.
  dataRef.current = data
  onSaveRef.current = onSave
  onSuccessRef.current = onSuccess
  onErrorRef.current = onError

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  // Save function
  const save = useCallback(async () => {
    if (!isMountedRef.current) return

    const dataToSave = dataRef.current

    setStatus('saving')
    setError(null)

    try {
      await onSaveRef.current(dataToSave)

      if (!isMountedRef.current) return

      setStatus('saved')
      setLastSaved(new Date())
      previousDataRef.current = dataToSave
      onSuccessRef.current?.()

      // Reset to idle after 2 seconds
      setTimeout(() => {
        if (isMountedRef.current) {
          setStatus('idle')
        }
      }, 2000)
    } catch (err) {
      if (!isMountedRef.current) return

      const error = err instanceof Error ? err : new Error('Save failed')
      setStatus('error')
      setError(error)
      onErrorRef.current?.(error)
    }
  }, [])

  // Watch for data changes
  useEffect(() => {
    if (!enabled) return

    // Don't save if data hasn't changed from previous or initial
    const dataString = JSON.stringify(data)
    const previousDataString = JSON.stringify(previousDataRef.current)
    const initialDataString = JSON.stringify(initialDataRef.current)

    if (dataString === previousDataString) return
    if (dataString === initialDataString && !lastSaved) return

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    // Set new debounced save
    timerRef.current = setTimeout(() => {
      save()
    }, debounceMs)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [data, enabled, debounceMs, save, lastSaved])

  // Reset function
  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    previousDataRef.current = data
    initialDataRef.current = data
  }, [data])

  return {
    status,
    lastSaved,
    error,
    save,
    reset,
  }
}
