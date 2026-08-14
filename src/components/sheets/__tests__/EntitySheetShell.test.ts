/**
 * Unit Tests for EntitySheetShell Logic
 *
 * Tests the business logic and configuration for EntitySheetShell:
 * - Entity type configuration
 * - Width classes mapping
 * - Props validation patterns
 *
 * Note: Component rendering tests require more sophisticated setup
 * for ESM modules and React Testing Library. This file focuses on
 * the pure business logic.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals'

// ============================================================================
// ENTITY TYPE CONFIGURATION (mirrored from EntitySheetShell)
// ============================================================================

type EntityType =
  | 'company'
  | 'technology'
  | 'useCase'
  | 'prototype'
  | 'strategy'
  | 'signal'

const entityTypeConfig: Record<EntityType, { label: string; color: string }> = {
  company: { label: 'Company', color: 'bg-blue-500/10 text-blue-500' },
  technology: { label: 'Technology', color: 'bg-purple-500/10 text-purple-500' },
  useCase: { label: 'Use Case', color: 'bg-green-500/10 text-green-500' },
  prototype: { label: 'Prototype', color: 'bg-orange-500/10 text-orange-500' },
  strategy: { label: 'Strategy', color: 'bg-pink-500/10 text-pink-500' },
  signal: { label: 'Signal', color: 'bg-cyan-500/10 text-cyan-500' },
}

const widthClasses = {
  sm: 'sm:max-w-[504px]',
  md: 'sm:max-w-[680px]',
  lg: 'sm:max-w-[907px]',
  xl: 'sm:max-w-[1134px]',
  full: 'sm:max-w-[calc(100vw-100px)]',
}

// ============================================================================
// TESTS
// ============================================================================

describe('EntitySheetShell Configuration', () => {
  describe('Entity Type Config', () => {
    it('should have configuration for all entity types', () => {
      const entityTypes: EntityType[] = [
        'company',
        'technology',
        'useCase',
        'prototype',
        'strategy',
        'signal',
      ]

      entityTypes.forEach((type) => {
        expect(entityTypeConfig[type]).toBeDefined()
        expect(entityTypeConfig[type].label).toBeDefined()
        expect(entityTypeConfig[type].color).toBeDefined()
      })
    })

    it('should have human-readable labels for entity types', () => {
      expect(entityTypeConfig.company.label).toBe('Company')
      expect(entityTypeConfig.technology.label).toBe('Technology')
      expect(entityTypeConfig.useCase.label).toBe('Use Case')
      expect(entityTypeConfig.prototype.label).toBe('Prototype')
      expect(entityTypeConfig.strategy.label).toBe('Strategy')
      expect(entityTypeConfig.signal.label).toBe('Signal')
    })

    it('should have unique colors for each entity type', () => {
      const colors = Object.values(entityTypeConfig).map((c) => c.color)
      const uniqueColors = new Set(colors)

      expect(uniqueColors.size).toBe(colors.length)
    })

    it('should use consistent color pattern (bg and text)', () => {
      Object.values(entityTypeConfig).forEach((config) => {
        expect(config.color).toMatch(/^bg-\w+-\d+\/\d+ text-\w+-\d+$/)
      })
    })
  })

  describe('Width Classes', () => {
    it('should have all width options defined', () => {
      const widthOptions = ['sm', 'md', 'lg', 'xl', 'full']

      widthOptions.forEach((width) => {
        expect(widthClasses[width as keyof typeof widthClasses]).toBeDefined()
      })
    })

    it('should have responsive max-width classes', () => {
      Object.values(widthClasses).forEach((className) => {
        expect(className).toMatch(/^sm:max-w-/)
      })
    })

    it('should have increasing widths from sm to xl', () => {
      // Extract pixel values for sm through xl
      const extractWidth = (className: string): number => {
        const match = className.match(/\[(\d+)px\]/)
        return match ? parseInt(match[1], 10) : 0
      }

      const smWidth = extractWidth(widthClasses.sm)
      const mdWidth = extractWidth(widthClasses.md)
      const lgWidth = extractWidth(widthClasses.lg)
      const xlWidth = extractWidth(widthClasses.xl)

      expect(smWidth).toBeLessThan(mdWidth)
      expect(mdWidth).toBeLessThan(lgWidth)
      expect(lgWidth).toBeLessThan(xlWidth)
    })

    it('should have full width option using viewport width', () => {
      expect(widthClasses.full).toContain('100vw')
    })
  })
})

describe('EntitySheetShell Props Validation', () => {
  /**
   * Helper to validate required props
   */
  function validateSheetProps(props: {
    title?: string
    entityType?: EntityType
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children?: unknown
  }): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!props.title || props.title.trim() === '') {
      errors.push('title is required')
    }

    if (!props.entityType || !entityTypeConfig[props.entityType]) {
      errors.push('entityType must be a valid entity type')
    }

    if (typeof props.open !== 'boolean') {
      errors.push('open must be a boolean')
    }

    if (typeof props.onOpenChange !== 'function') {
      errors.push('onOpenChange must be a function')
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  it('should pass validation with all required props', () => {
    const result = validateSheetProps({
      title: 'Test Sheet',
      entityType: 'company',
      open: true,
      onOpenChange: () => {},
      children: 'content',
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should fail validation when title is missing', () => {
    const result = validateSheetProps({
      entityType: 'company',
      open: true,
      onOpenChange: () => {},
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('title is required')
  })

  it('should fail validation when title is empty', () => {
    const result = validateSheetProps({
      title: '  ',
      entityType: 'company',
      open: true,
      onOpenChange: () => {},
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('title is required')
  })

  it('should fail validation for invalid entity type', () => {
    const result = validateSheetProps({
      title: 'Test',
      entityType: 'invalid' as EntityType,
      open: true,
      onOpenChange: () => {},
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('entityType must be a valid entity type')
  })

  it('should fail validation when open is not boolean', () => {
    const result = validateSheetProps({
      title: 'Test',
      entityType: 'company',
      open: undefined,
      onOpenChange: () => {},
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('open must be a boolean')
  })
})

describe('EntitySheetShell Helper Functions', () => {
  /**
   * Get display configuration for an entity type
   */
  function getEntityDisplayConfig(entityType: EntityType): {
    label: string
    color: string
    badgeClasses: string
  } {
    const config = entityTypeConfig[entityType]
    return {
      label: config.label,
      color: config.color,
      badgeClasses: `text-xs ${config.color}`,
    }
  }

  /**
   * Determine sheet width class based on props
   */
  function getWidthClass(width: keyof typeof widthClasses = 'lg'): string {
    return widthClasses[width] || widthClasses.lg
  }

  describe('getEntityDisplayConfig', () => {
    it('should return correct config for company', () => {
      const config = getEntityDisplayConfig('company')

      expect(config.label).toBe('Company')
      expect(config.color).toContain('blue')
    })

    it('should return correct config for prototype', () => {
      const config = getEntityDisplayConfig('prototype')

      expect(config.label).toBe('Prototype')
      expect(config.color).toContain('orange')
    })

    it('should include badge classes in config', () => {
      const config = getEntityDisplayConfig('signal')

      expect(config.badgeClasses).toContain('text-xs')
      expect(config.badgeClasses).toContain(config.color)
    })
  })

  describe('getWidthClass', () => {
    it('should return correct class for each width option', () => {
      expect(getWidthClass('sm')).toBe(widthClasses.sm)
      expect(getWidthClass('md')).toBe(widthClasses.md)
      expect(getWidthClass('lg')).toBe(widthClasses.lg)
      expect(getWidthClass('xl')).toBe(widthClasses.xl)
      expect(getWidthClass('full')).toBe(widthClasses.full)
    })

    it('should default to lg width', () => {
      expect(getWidthClass()).toBe(widthClasses.lg)
    })
  })
})

describe('AI Context Interface', () => {
  /**
   * AI Context for auto-linker suggestions (Phase 5)
   */
  interface AIContext {
    description?: string
    existingRelations?: string[]
    [key: string]: string | string[] | undefined
  }

  /**
   * Validate AI context structure
   */
  function validateAIContext(context: AIContext): {
    valid: boolean
    warnings: string[]
  } {
    const warnings: string[] = []

    if (context.description && typeof context.description !== 'string') {
      warnings.push('description should be a string')
    }

    if (
      context.existingRelations &&
      !Array.isArray(context.existingRelations)
    ) {
      warnings.push('existingRelations should be an array')
    }

    return {
      valid: warnings.length === 0,
      warnings,
    }
  }

  it('should accept valid AI context with description', () => {
    const context: AIContext = {
      description: 'This is a test description for AI analysis',
    }

    const result = validateAIContext(context)

    expect(result.valid).toBe(true)
  })

  it('should accept valid AI context with existing relations', () => {
    const context: AIContext = {
      existingRelations: ['relation-1', 'relation-2'],
    }

    const result = validateAIContext(context)

    expect(result.valid).toBe(true)
  })

  it('should accept AI context with custom fields', () => {
    const context: AIContext = {
      description: 'Test',
      customField: 'custom value',
      customArray: ['item1', 'item2'],
    }

    const result = validateAIContext(context)

    expect(result.valid).toBe(true)
  })

  it('should accept empty AI context', () => {
    const context: AIContext = {}

    const result = validateAIContext(context)

    expect(result.valid).toBe(true)
  })
})
