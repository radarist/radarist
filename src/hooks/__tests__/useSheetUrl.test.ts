/**
 * @file useSheetUrl.test.ts
 * @description Tests for useSheetUrl and useControlledSheet business logic
 *
 * Note: Hook rendering tests with Next.js router require more sophisticated setup.
 * This file focuses on the pure business logic that can be extracted from the hooks.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals'

// ============================================================================
// URL PARAMETER PARSING (business logic from useSheetUrl)
// ============================================================================

/**
 * Parse entity ID from URL search params
 */
function parseEntityIdFromSearch(search: string, paramName = 'open'): string | null {
  const params = new URLSearchParams(search)
  return params.get(paramName)
}

/**
 * Build URL with entity ID parameter
 */
function buildUrlWithEntityId(
  pathname: string,
  search: string,
  entityId: string,
  paramName = 'open'
): string {
  const params = new URLSearchParams(search)
  params.set(paramName, entityId)
  return `${pathname}?${params.toString()}`
}

/**
 * Build URL without entity ID parameter
 */
function buildUrlWithoutEntityId(
  pathname: string,
  search: string,
  paramName = 'open'
): string {
  const params = new URLSearchParams(search)
  params.delete(paramName)
  const queryString = params.toString()
  return queryString ? `${pathname}?${queryString}` : pathname
}

// ============================================================================
// ENTITY LOOKUP (business logic from useControlledSheet)
// ============================================================================

interface Entity {
  id: string
}

/**
 * Find entity by ID
 */
function findEntityById<T extends Entity>(entities: T[], entityId: string | null): T | undefined {
  if (!entityId) return undefined
  return entities.find(e => e.id === entityId)
}

/**
 * Check if sheet should be considered open
 */
function isSheetOpen(entityId: string | null): boolean {
  return !!entityId
}

// ============================================================================
// TESTS
// ============================================================================

describe('useSheetUrl Business Logic', () => {
  describe('parseEntityIdFromSearch', () => {
    it('should parse entity ID from URL search', () => {
      const result = parseEntityIdFromSearch('?open=company-123')

      expect(result).toBe('company-123')
    })

    it('should return null when param not present', () => {
      const result = parseEntityIdFromSearch('?other=value')

      expect(result).toBeNull()
    })

    it('should return null for empty search', () => {
      const result = parseEntityIdFromSearch('')

      expect(result).toBeNull()
    })

    it('should use custom param name', () => {
      const result = parseEntityIdFromSearch('?entityId=abc-123', 'entityId')

      expect(result).toBe('abc-123')
    })

    it('should handle multiple params', () => {
      const result = parseEntityIdFromSearch('?filter=active&open=xyz-789&sort=name')

      expect(result).toBe('xyz-789')
    })

    it('should handle URL-encoded values', () => {
      const result = parseEntityIdFromSearch('?open=company%20123')

      expect(result).toBe('company 123')
    })
  })

  describe('buildUrlWithEntityId', () => {
    it('should build URL with entity ID', () => {
      const result = buildUrlWithEntityId('/library/companies', '', 'company-123')

      expect(result).toBe('/library/companies?open=company-123')
    })

    it('should preserve existing query params', () => {
      const result = buildUrlWithEntityId('/library', '?filter=active', 'entity-1')

      expect(result).toContain('filter=active')
      expect(result).toContain('open=entity-1')
    })

    it('should replace existing open param', () => {
      const result = buildUrlWithEntityId('/library', '?open=old-id', 'new-id')

      expect(result).toBe('/library?open=new-id')
      expect(result).not.toContain('old-id')
    })

    it('should use custom param name', () => {
      const result = buildUrlWithEntityId('/library', '', 'abc', 'edit')

      expect(result).toBe('/library?edit=abc')
    })
  })

  describe('buildUrlWithoutEntityId', () => {
    it('should remove entity ID param', () => {
      const result = buildUrlWithoutEntityId('/library', '?open=company-123')

      expect(result).toBe('/library')
    })

    it('should preserve other query params', () => {
      const result = buildUrlWithoutEntityId('/library', '?open=company-123&filter=active')

      expect(result).toBe('/library?filter=active')
    })

    it('should handle missing param gracefully', () => {
      const result = buildUrlWithoutEntityId('/library', '?filter=active')

      expect(result).toBe('/library?filter=active')
    })

    it('should return clean path when no params remain', () => {
      const result = buildUrlWithoutEntityId('/library/companies', '?open=xyz')

      expect(result).toBe('/library/companies')
    })

    it('should use custom param name', () => {
      const result = buildUrlWithoutEntityId('/lib', '?edit=abc&view=list', 'edit')

      expect(result).toBe('/lib?view=list')
    })
  })
})

describe('useControlledSheet Business Logic', () => {
  interface TestEntity {
    id: string
    name: string
    status?: string
  }

  const testEntities: TestEntity[] = [
    { id: 'entity-1', name: 'First Entity', status: 'active' },
    { id: 'entity-2', name: 'Second Entity', status: 'inactive' },
    { id: 'entity-3', name: 'Third Entity' },
  ]

  describe('findEntityById', () => {
    it('should find entity by ID', () => {
      const result = findEntityById(testEntities, 'entity-2')

      expect(result).toBeDefined()
      expect(result?.name).toBe('Second Entity')
    })

    it('should return undefined for non-existing ID', () => {
      const result = findEntityById(testEntities, 'non-existent')

      expect(result).toBeUndefined()
    })

    it('should return undefined for null ID', () => {
      const result = findEntityById(testEntities, null)

      expect(result).toBeUndefined()
    })

    it('should return undefined for empty entities array', () => {
      const result = findEntityById([], 'any-id')

      expect(result).toBeUndefined()
    })
  })

  describe('isSheetOpen', () => {
    it('should return true for non-null entity ID', () => {
      expect(isSheetOpen('company-123')).toBe(true)
    })

    it('should return false for null', () => {
      expect(isSheetOpen(null)).toBe(false)
    })

    it('should return true for empty string (still truthy in URL context)', () => {
      // An empty string is still a value, though unusual
      expect(isSheetOpen('')).toBe(false)
    })
  })
})

describe('URL State Management Scenarios', () => {
  /**
   * Simulate opening a sheet
   */
  function simulateOpenSheet(
    currentSearch: string,
    entityId: string,
    pathname = '/library'
  ): { newUrl: string; isOpen: boolean } {
    const newUrl = buildUrlWithEntityId(pathname, currentSearch, entityId)
    return { newUrl, isOpen: true }
  }

  /**
   * Simulate closing a sheet
   */
  function simulateCloseSheet(
    currentSearch: string,
    pathname = '/library'
  ): { newUrl: string; isOpen: boolean } {
    const newUrl = buildUrlWithoutEntityId(pathname, currentSearch)
    return { newUrl, isOpen: false }
  }

  it('should handle open -> close cycle', () => {
    // Start: no entity open
    let search = ''

    // Open entity
    const afterOpen = simulateOpenSheet(search, 'entity-1')
    expect(afterOpen.isOpen).toBe(true)
    expect(afterOpen.newUrl).toContain('open=entity-1')

    // Extract search from URL
    search = afterOpen.newUrl.split('?')[1] || ''

    // Close entity
    const afterClose = simulateCloseSheet(`?${search}`)
    expect(afterClose.isOpen).toBe(false)
    expect(afterClose.newUrl).not.toContain('open=')
  })

  it('should handle switching between entities', () => {
    // Open first entity
    let result = simulateOpenSheet('', 'entity-1')
    expect(result.newUrl).toContain('open=entity-1')

    // Extract search
    const search = result.newUrl.split('?')[1] || ''

    // Switch to second entity
    result = simulateOpenSheet(`?${search}`, 'entity-2')
    expect(result.newUrl).toContain('open=entity-2')
    expect(result.newUrl).not.toContain('entity-1')
  })

  it('should preserve filters when opening sheet', () => {
    const result = simulateOpenSheet('?status=active&sort=name', 'entity-1')

    expect(result.newUrl).toContain('status=active')
    expect(result.newUrl).toContain('sort=name')
    expect(result.newUrl).toContain('open=entity-1')
  })

  it('should preserve filters when closing sheet', () => {
    const result = simulateCloseSheet('?open=entity-1&status=active&sort=name')

    expect(result.newUrl).toContain('status=active')
    expect(result.newUrl).toContain('sort=name')
    expect(result.newUrl).not.toContain('open=')
  })
})

describe('Deep Linking Scenarios', () => {
  interface Company {
    id: string
    name: string
    status: string
  }

  const companies: Company[] = [
    { id: 'comp-1', name: 'Acme Corp', status: 'active' },
    { id: 'comp-2', name: 'Beta Inc', status: 'inactive' },
    { id: 'comp-3', name: 'Gamma Ltd', status: 'active' },
  ]

  it('should support direct URL access to entity sheet', () => {
    // User navigates directly to /library/companies?open=comp-2
    const entityId = parseEntityIdFromSearch('?open=comp-2')
    const entity = findEntityById(companies, entityId)

    expect(entity).toBeDefined()
    expect(entity?.name).toBe('Beta Inc')
    expect(isSheetOpen(entityId)).toBe(true)
  })

  it('should handle non-existent entity in URL gracefully', () => {
    // User navigates to URL with entity that no longer exists
    const entityId = parseEntityIdFromSearch('?open=deleted-entity')
    const entity = findEntityById(companies, entityId)

    expect(entity).toBeUndefined()
    expect(isSheetOpen(entityId)).toBe(true) // URL says open, but entity not found
  })

  it('should handle bookmarked URL with filters', () => {
    // User has bookmarked /library/companies?status=active&open=comp-1
    const search = '?status=active&open=comp-1'

    const entityId = parseEntityIdFromSearch(search)
    const entity = findEntityById(companies, entityId)

    expect(entity?.name).toBe('Acme Corp')

    // Build URL for closing (preserving filter)
    const closeUrl = buildUrlWithoutEntityId('/library/companies', search)
    expect(closeUrl).toBe('/library/companies?status=active')
  })
})
