'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// ============================================================================
// TYPES
// ============================================================================

type ParamValue = string | string[] | undefined | null

interface UseUrlStateOptions {
  /** Whether to use shallow routing (default: true) */
  shallow?: boolean
  /** Whether to scroll to top on navigation (default: false) */
  scroll?: boolean
}

interface UseUrlStateReturn<T> {
  /** Current value from URL */
  value: T | undefined
  /** Set the value in URL */
  setValue: (value: T | null) => void
  /** Clear the value from URL */
  clear: () => void
}

// ============================================================================
// SINGLE VALUE HOOK
// ============================================================================

/**
 * useUrlState
 *
 * Sync a single state value with URL query parameters.
 * Changes are persisted in the URL and survive page refreshes.
 *
 * @example
 * ```tsx
 * // String value
 * const { value: tab, setValue: setTab } = useUrlState<string>('tab')
 *
 * // With default value
 * const { value: page } = useUrlState<string>('page', { defaultValue: '1' })
 *
 * // In component
 * <Tabs value={tab ?? 'overview'} onValueChange={setTab}>
 * ```
 */
export function useUrlState<T extends string = string>(
  key: string,
  options?: UseUrlStateOptions & { defaultValue?: T }
): UseUrlStateReturn<T> {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { shallow = true, scroll = false, defaultValue } = options ?? {}

  const value = useMemo(() => {
    const param = searchParams.get(key)
    return (param as T) ?? defaultValue
  }, [searchParams, key, defaultValue])

  const setValue = useCallback(
    (newValue: T | null) => {
      const params = new URLSearchParams(searchParams.toString())

      if (newValue === null || newValue === undefined || newValue === '') {
        params.delete(key)
      } else {
        params.set(key, newValue)
      }

      const queryString = params.toString()
      const url = queryString ? `${pathname}?${queryString}` : pathname

      if (shallow) {
        router.replace(url, { scroll })
      } else {
        router.push(url, { scroll })
      }
    },
    [router, pathname, searchParams, key, shallow, scroll]
  )

  const clear = useCallback(() => {
    setValue(null)
  }, [setValue])

  return { value, setValue, clear }
}

// ============================================================================
// ARRAY VALUE HOOK
// ============================================================================

/**
 * useUrlArrayState
 *
 * Sync an array of values with URL query parameters.
 * Values are stored as comma-separated list.
 *
 * @example
 * ```tsx
 * const { values, add, remove, toggle, clear } = useUrlArrayState('tags')
 *
 * // Toggle a tag
 * <Badge onClick={() => toggle('react')}>React</Badge>
 *
 * // Clear all
 * <Button onClick={clear}>Clear Filters</Button>
 * ```
 */
export function useUrlArrayState(
  key: string,
  options?: UseUrlStateOptions
): {
  values: string[]
  setValues: (values: string[]) => void
  add: (value: string) => void
  remove: (value: string) => void
  toggle: (value: string) => void
  has: (value: string) => boolean
  clear: () => void
} {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { shallow = true, scroll = false } = options ?? {}

  const values = useMemo(() => {
    const param = searchParams.get(key)
    if (!param) return []
    return param.split(',').filter(Boolean)
  }, [searchParams, key])

  const setValues = useCallback(
    (newValues: string[]) => {
      const params = new URLSearchParams(searchParams.toString())

      if (newValues.length === 0) {
        params.delete(key)
      } else {
        params.set(key, newValues.join(','))
      }

      const queryString = params.toString()
      const url = queryString ? `${pathname}?${queryString}` : pathname

      if (shallow) {
        router.replace(url, { scroll })
      } else {
        router.push(url, { scroll })
      }
    },
    [router, pathname, searchParams, key, shallow, scroll]
  )

  const add = useCallback(
    (value: string) => {
      if (!values.includes(value)) {
        setValues([...values, value])
      }
    },
    [values, setValues]
  )

  const remove = useCallback(
    (value: string) => {
      setValues(values.filter((v) => v !== value))
    },
    [values, setValues]
  )

  const toggle = useCallback(
    (value: string) => {
      if (values.includes(value)) {
        remove(value)
      } else {
        add(value)
      }
    },
    [values, add, remove]
  )

  const has = useCallback(
    (value: string) => values.includes(value),
    [values]
  )

  const clear = useCallback(() => {
    setValues([])
  }, [setValues])

  return { values, setValues, add, remove, toggle, has, clear }
}

// ============================================================================
// MULTI-PARAM HOOK
// ============================================================================

/**
 * useUrlParams
 *
 * Read and write multiple URL parameters at once.
 *
 * @example
 * ```tsx
 * const { params, setParams, setParam, clearAll } = useUrlParams()
 *
 * // Read params
 * const tab = params.get('tab')
 * const page = params.get('page')
 *
 * // Set multiple params
 * setParams({ tab: 'settings', page: '2' })
 *
 * // Set single param
 * setParam('sort', 'name')
 * ```
 */
export function useUrlParams(options?: UseUrlStateOptions): {
  params: URLSearchParams
  setParams: (newParams: Record<string, ParamValue>) => void
  setParam: (key: string, value: ParamValue) => void
  clearAll: () => void
} {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { shallow = true, scroll = false } = options ?? {}

  const params = useMemo(
    () => new URLSearchParams(searchParams.toString()),
    [searchParams]
  )

  const setParams = useCallback(
    (newParams: Record<string, ParamValue>) => {
      const updated = new URLSearchParams(searchParams.toString())

      Object.entries(newParams).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') {
          updated.delete(key)
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            updated.delete(key)
          } else {
            updated.set(key, value.join(','))
          }
        } else {
          updated.set(key, value)
        }
      })

      const queryString = updated.toString()
      const url = queryString ? `${pathname}?${queryString}` : pathname

      if (shallow) {
        router.replace(url, { scroll })
      } else {
        router.push(url, { scroll })
      }
    },
    [router, pathname, searchParams, shallow, scroll]
  )

  const setParam = useCallback(
    (key: string, value: ParamValue) => {
      setParams({ [key]: value })
    },
    [setParams]
  )

  const clearAll = useCallback(() => {
    if (shallow) {
      router.replace(pathname, { scroll })
    } else {
      router.push(pathname, { scroll })
    }
  }, [router, pathname, shallow, scroll])

  return { params, setParams, setParam, clearAll }
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { UseUrlStateOptions, UseUrlStateReturn, ParamValue }
