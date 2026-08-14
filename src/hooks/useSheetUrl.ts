'use client'

import { useCallback, useState, useEffect } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('hooks/useSheetUrl')
import { useRouter, usePathname } from 'next/navigation'

// ============================================================================
// TYPES
// ============================================================================

interface UseSheetUrlOptions {
  /** Query parameter name for the open entity ID */
  paramName?: string
  /** Whether to replace or push the URL change */
  replace?: boolean
}

interface UseSheetUrlReturn {
  /** Currently open entity ID from URL */
  openEntityId: string | null
  /** Whether a sheet is open */
  isOpen: boolean
  /** Open a sheet for an entity */
  openSheet: (entityId: string) => void
  /** Close the sheet */
  closeSheet: () => void
  /** Set the open entity ID directly */
  setOpenEntityId: (entityId: string | null) => void
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * useSheetUrl
 *
 * Manages sheet open state through URL query parameters.
 * Enables deep linking to entity sheets.
 *
 * NOTE: Uses client-side URL reading to avoid Suspense boundary requirements
 * in Next.js App Router static generation.
 *
 * @example
 * ```tsx
 * // In your library page
 * const { openEntityId, isOpen, openSheet, closeSheet } = useSheetUrl()
 *
 * // Open sheet when clicking a row
 * <TableRow onClick={() => openSheet(company.id)}>
 *
 * // Pass to sheet component
 * <CompanySheet
 *   open={isOpen}
 *   onOpenChange={(open) => !open && closeSheet()}
 *   company={companies.find(c => c.id === openEntityId)}
 * />
 * ```
 */
export function useSheetUrl({
  paramName = 'open',
  replace = true,
}: UseSheetUrlOptions = {}): UseSheetUrlReturn {
  const router = useRouter()
  const pathname = usePathname()
  const [openEntityId, setOpenEntityIdState] = useState<string | null>(null)

  // Read from URL on mount and when pathname changes (client-side only)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      setOpenEntityIdState(params.get(paramName))
    }
  }, [pathname, paramName])

  // Listen for popstate events (browser back/forward)
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search)
      setOpenEntityIdState(params.get(paramName))
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [paramName])

  const isOpen = !!openEntityId

  const openSheet = useCallback((entityId: string) => {
    const params = new URLSearchParams(window.location.search)
    params.set(paramName, entityId)
    const url = `${pathname}?${params.toString()}`

    // Update local state immediately (optimistic update)
    setOpenEntityIdState(entityId)

    // Wrap router navigation in try-catch to handle transient "Failed to fetch" errors
    // that can occur during development (HMR) or due to network timing issues
    try {
      if (replace) {
        router.replace(url, { scroll: false })
      } else {
        router.push(url, { scroll: false })
      }
    } catch (error) {
      // Log but don't throw - the state is already updated
      log.warn('Navigation failed, state already updated', { error: String(error) })
    }
  }, [pathname, paramName, replace, router])

  const closeSheet = useCallback(() => {
    const params = new URLSearchParams(window.location.search)
    params.delete(paramName)
    const queryString = params.toString()
    const url = queryString ? `${pathname}?${queryString}` : pathname

    // Update local state immediately (optimistic update)
    setOpenEntityIdState(null)

    // Wrap router navigation in try-catch to handle transient "Failed to fetch" errors
    try {
      if (replace) {
        router.replace(url, { scroll: false })
      } else {
        router.push(url, { scroll: false })
      }
    } catch (error) {
      // Log but don't throw - the state is already updated
      log.warn('Navigation failed, state already updated', { error: String(error) })
    }
  }, [pathname, paramName, replace, router])

  const setOpenEntityId = useCallback((entityId: string | null) => {
    if (entityId) {
      openSheet(entityId)
    } else {
      closeSheet()
    }
  }, [openSheet, closeSheet])

  return {
    openEntityId,
    isOpen,
    openSheet,
    closeSheet,
    setOpenEntityId,
  }
}

// ============================================================================
// UTILITY HOOK FOR CONTROLLED SHEET STATE
// ============================================================================

interface UseControlledSheetOptions<T> {
  /** List of entities to search through */
  entities: T[]
  /** Function to get entity ID */
  getId: (entity: T) => string
  /** Query parameter name */
  paramName?: string
}

interface UseControlledSheetReturn<T> {
  /** Currently selected entity */
  selectedEntity: T | undefined
  /** Whether sheet is open */
  isOpen: boolean
  /** Open sheet for entity */
  open: (entity: T) => void
  /** Close sheet */
  close: () => void
  /** Handle sheet open change */
  onOpenChange: (open: boolean) => void
}

/**
 * useControlledSheet
 *
 * Higher-level hook that manages sheet state with URL sync and entity lookup.
 *
 * @example
 * ```tsx
 * const { selectedEntity, isOpen, open, close, onOpenChange } = useControlledSheet({
 *   entities: companies,
 *   getId: (c) => c.id,
 * })
 *
 * <CompanySheet
 *   open={isOpen}
 *   onOpenChange={onOpenChange}
 *   company={selectedEntity}
 * />
 * ```
 */
export function useControlledSheet<T>({
  entities,
  getId,
  paramName = 'open',
}: UseControlledSheetOptions<T>): UseControlledSheetReturn<T> {
  const { openEntityId, isOpen, openSheet, closeSheet } = useSheetUrl({ paramName })

  const selectedEntity = entities.find((e) => getId(e) === openEntityId)

  const open = useCallback((entity: T) => {
    openSheet(getId(entity))
  }, [openSheet, getId])

  const onOpenChange = useCallback((open: boolean) => {
    if (!open) {
      closeSheet()
    }
  }, [closeSheet])

  return {
    selectedEntity,
    isOpen,
    open,
    close: closeSheet,
    onOpenChange,
  }
}
