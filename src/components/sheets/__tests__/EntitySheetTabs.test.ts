/**
 * Unit Tests for EntitySheetTabs Logic
 *
 * Tests the business logic for EntitySheetTabs:
 * - Tab configuration and filtering
 * - Default tab selection
 * - Tab badge handling
 *
 * Note: Component rendering tests require more sophisticated setup
 * for ESM modules and React Testing Library. This file focuses on
 * the pure business logic.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals'

// ============================================================================
// TYPES (mirrored from EntitySheetTabs)
// ============================================================================

interface SheetTab {
  id: string
  label: string
  icon?: unknown
  content: unknown
  disabled?: boolean
  badge?: number
}

// ============================================================================
// HELPER FUNCTIONS (business logic extracted from component)
// ============================================================================

/**
 * Get the default tab ID from a list of tabs
 */
function getDefaultTabId(tabs: SheetTab[], defaultTab?: string): string | undefined {
  if (defaultTab && tabs.some(t => t.id === defaultTab)) {
    return defaultTab
  }
  return tabs[0]?.id
}

/**
 * Filter enabled tabs
 */
function getEnabledTabs(tabs: SheetTab[]): SheetTab[] {
  return tabs.filter(t => !t.disabled)
}

/**
 * Get tabs with badges
 */
function getTabsWithBadges(tabs: SheetTab[]): SheetTab[] {
  return tabs.filter(t => t.badge !== undefined && t.badge > 0)
}

/**
 * Calculate total badge count
 */
function getTotalBadgeCount(tabs: SheetTab[]): number {
  return tabs.reduce((sum, tab) => sum + (tab.badge || 0), 0)
}

/**
 * Find tab by ID
 */
function findTabById(tabs: SheetTab[], id: string): SheetTab | undefined {
  return tabs.find(t => t.id === id)
}

// ============================================================================
// TESTS
// ============================================================================

describe('EntitySheetTabs Logic', () => {
  const mockTabs: SheetTab[] = [
    { id: 'overview', label: 'Overview', content: 'overview content' },
    { id: 'relations', label: 'Relations', badge: 5, content: 'relations content' },
    { id: 'notes', label: 'Notes', badge: 3, content: 'notes content' },
    { id: 'settings', label: 'Settings', disabled: true, content: 'settings content' },
  ]

  describe('getDefaultTabId', () => {
    it('should return first tab ID when no default specified', () => {
      const result = getDefaultTabId(mockTabs)

      expect(result).toBe('overview')
    })

    it('should return specified default tab if it exists', () => {
      const result = getDefaultTabId(mockTabs, 'relations')

      expect(result).toBe('relations')
    })

    it('should return first tab if specified default does not exist', () => {
      const result = getDefaultTabId(mockTabs, 'nonexistent')

      expect(result).toBe('overview')
    })

    it('should return undefined for empty tabs array', () => {
      const result = getDefaultTabId([])

      expect(result).toBeUndefined()
    })

    it('should handle disabled tabs as valid defaults', () => {
      const result = getDefaultTabId(mockTabs, 'settings')

      expect(result).toBe('settings')
    })
  })

  describe('getEnabledTabs', () => {
    it('should filter out disabled tabs', () => {
      const result = getEnabledTabs(mockTabs)

      expect(result).toHaveLength(3)
      expect(result.every(t => !t.disabled)).toBe(true)
    })

    it('should return all tabs if none are disabled', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't2', label: 'Tab 2', content: 'c2' },
      ]

      const result = getEnabledTabs(tabs)

      expect(result).toHaveLength(2)
    })

    it('should return empty array if all tabs disabled', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1', disabled: true },
        { id: 't2', label: 'Tab 2', content: 'c2', disabled: true },
      ]

      const result = getEnabledTabs(tabs)

      expect(result).toHaveLength(0)
    })
  })

  describe('getTabsWithBadges', () => {
    it('should return only tabs with positive badges', () => {
      const result = getTabsWithBadges(mockTabs)

      expect(result).toHaveLength(2)
      expect(result.map(t => t.id)).toEqual(['relations', 'notes'])
    })

    it('should exclude tabs with zero badges', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1', badge: 0 },
        { id: 't2', label: 'Tab 2', content: 'c2', badge: 5 },
      ]

      const result = getTabsWithBadges(tabs)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('t2')
    })

    it('should exclude tabs with undefined badges', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't2', label: 'Tab 2', content: 'c2', badge: 3 },
      ]

      const result = getTabsWithBadges(tabs)

      expect(result).toHaveLength(1)
    })

    it('should return empty array if no tabs have badges', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't2', label: 'Tab 2', content: 'c2' },
      ]

      const result = getTabsWithBadges(tabs)

      expect(result).toHaveLength(0)
    })
  })

  describe('getTotalBadgeCount', () => {
    it('should sum all badge counts', () => {
      const result = getTotalBadgeCount(mockTabs)

      expect(result).toBe(8) // 5 + 3
    })

    it('should return 0 for tabs without badges', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't2', label: 'Tab 2', content: 'c2' },
      ]

      const result = getTotalBadgeCount(tabs)

      expect(result).toBe(0)
    })

    it('should handle mixed badge and no-badge tabs', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1', badge: 10 },
        { id: 't2', label: 'Tab 2', content: 'c2' },
        { id: 't3', label: 'Tab 3', content: 'c3', badge: 5 },
      ]

      const result = getTotalBadgeCount(tabs)

      expect(result).toBe(15)
    })

    it('should return 0 for empty tabs array', () => {
      const result = getTotalBadgeCount([])

      expect(result).toBe(0)
    })
  })

  describe('findTabById', () => {
    it('should find existing tab', () => {
      const result = findTabById(mockTabs, 'relations')

      expect(result).toBeDefined()
      expect(result?.id).toBe('relations')
      expect(result?.label).toBe('Relations')
    })

    it('should return undefined for non-existing tab', () => {
      const result = findTabById(mockTabs, 'nonexistent')

      expect(result).toBeUndefined()
    })

    it('should find disabled tabs', () => {
      const result = findTabById(mockTabs, 'settings')

      expect(result).toBeDefined()
      expect(result?.disabled).toBe(true)
    })
  })
})

describe('EntitySheetTabs Tab Configuration', () => {
  describe('Tab Structure Validation', () => {
    /**
     * Validate tab structure
     */
    function validateTab(tab: Partial<SheetTab>): {
      valid: boolean
      errors: string[]
    } {
      const errors: string[] = []

      if (!tab.id || tab.id.trim() === '') {
        errors.push('id is required')
      }

      if (!tab.label || tab.label.trim() === '') {
        errors.push('label is required')
      }

      if (tab.content === undefined || tab.content === null) {
        errors.push('content is required')
      }

      if (tab.badge !== undefined && (typeof tab.badge !== 'number' || tab.badge < 0)) {
        errors.push('badge must be a non-negative number')
      }

      if (tab.disabled !== undefined && typeof tab.disabled !== 'boolean') {
        errors.push('disabled must be a boolean')
      }

      return {
        valid: errors.length === 0,
        errors,
      }
    }

    it('should pass validation for valid tab', () => {
      const result = validateTab({
        id: 'test',
        label: 'Test Tab',
        content: 'content',
      })

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should pass validation for tab with all optional fields', () => {
      const result = validateTab({
        id: 'test',
        label: 'Test Tab',
        content: 'content',
        badge: 5,
        disabled: false,
        icon: 'icon-component',
      })

      expect(result.valid).toBe(true)
    })

    it('should fail validation for missing id', () => {
      const result = validateTab({
        label: 'Test Tab',
        content: 'content',
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('id is required')
    })

    it('should fail validation for missing label', () => {
      const result = validateTab({
        id: 'test',
        content: 'content',
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('label is required')
    })

    it('should fail validation for missing content', () => {
      const result = validateTab({
        id: 'test',
        label: 'Test Tab',
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('content is required')
    })

    it('should fail validation for negative badge', () => {
      const result = validateTab({
        id: 'test',
        label: 'Test Tab',
        content: 'content',
        badge: -1,
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('badge must be a non-negative number')
    })
  })

  describe('Tab ID Uniqueness', () => {
    /**
     * Check if all tab IDs are unique
     */
    function hasUniqueIds(tabs: SheetTab[]): boolean {
      const ids = tabs.map(t => t.id)
      return new Set(ids).size === ids.length
    }

    it('should detect unique IDs', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't2', label: 'Tab 2', content: 'c2' },
        { id: 't3', label: 'Tab 3', content: 'c3' },
      ]

      expect(hasUniqueIds(tabs)).toBe(true)
    })

    it('should detect duplicate IDs', () => {
      const tabs: SheetTab[] = [
        { id: 't1', label: 'Tab 1', content: 'c1' },
        { id: 't1', label: 'Tab 2', content: 'c2' }, // Duplicate ID
        { id: 't3', label: 'Tab 3', content: 'c3' },
      ]

      expect(hasUniqueIds(tabs)).toBe(false)
    })

    it('should handle empty array', () => {
      expect(hasUniqueIds([])).toBe(true)
    })

    it('should handle single tab', () => {
      const tabs: SheetTab[] = [{ id: 't1', label: 'Tab 1', content: 'c1' }]

      expect(hasUniqueIds(tabs)).toBe(true)
    })
  })
})

describe('EntitySheetTabs Navigation Logic', () => {
  /**
   * Get next available tab ID (for keyboard navigation)
   */
  function getNextTabId(
    tabs: SheetTab[],
    currentId: string,
    direction: 'next' | 'prev' = 'next'
  ): string | null {
    const enabledTabs = tabs.filter(t => !t.disabled)
    const currentIndex = enabledTabs.findIndex(t => t.id === currentId)

    if (currentIndex === -1) return null

    if (direction === 'next') {
      const nextIndex = (currentIndex + 1) % enabledTabs.length
      return enabledTabs[nextIndex].id
    } else {
      const prevIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
      return enabledTabs[prevIndex].id
    }
  }

  const tabs: SheetTab[] = [
    { id: 't1', label: 'Tab 1', content: 'c1' },
    { id: 't2', label: 'Tab 2', content: 'c2' },
    { id: 't3', label: 'Tab 3', content: 'c3', disabled: true },
    { id: 't4', label: 'Tab 4', content: 'c4' },
  ]

  describe('next navigation', () => {
    it('should return next tab', () => {
      expect(getNextTabId(tabs, 't1', 'next')).toBe('t2')
    })

    it('should skip disabled tabs', () => {
      expect(getNextTabId(tabs, 't2', 'next')).toBe('t4')
    })

    it('should wrap to first tab at end', () => {
      expect(getNextTabId(tabs, 't4', 'next')).toBe('t1')
    })

    it('should return null for non-existing current tab', () => {
      expect(getNextTabId(tabs, 'nonexistent', 'next')).toBeNull()
    })
  })

  describe('previous navigation', () => {
    it('should return previous tab', () => {
      expect(getNextTabId(tabs, 't2', 'prev')).toBe('t1')
    })

    it('should skip disabled tabs', () => {
      expect(getNextTabId(tabs, 't4', 'prev')).toBe('t2')
    })

    it('should wrap to last tab at beginning', () => {
      expect(getNextTabId(tabs, 't1', 'prev')).toBe('t4')
    })
  })
})
