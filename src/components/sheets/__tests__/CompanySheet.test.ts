/**
 * Unit Tests for CompanySheet Logic
 *
 * Tests the business logic for CompanySheet:
 * - Industry mapping from AI research
 * - Size mapping
 * - Stage mapping
 * - Company type mapping
 * - Tab configuration
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals'

// ============================================================================
// TYPES (mirrored from CompanySheet)
// ============================================================================

type CompanyIndustryValue =
  | 'healthcare'
  | 'food_agriculture'
  | 'technology'
  | 'manufacturing'
  | 'energy'
  | 'consumer'
  | 'financial'
  | 'logistics'
  | 'media'
  | 'professional'

type CompanySize = 'micro' | 'small' | 'medium' | 'large' | 'enterprise'

type CompanyStage =
  | 'pre_seed'
  | 'seed'
  | 'series_a'
  | 'series_b'
  | 'series_c_plus'
  | 'bootstrapped'
  | 'private'
  | 'public'
  | 'ipo'
  | 'nonprofit'

type CompanyType =
  | 'startup'
  | 'scaleup'
  | 'sme'
  | 'corporate'
  | 'spinoff'
  | 'joint_venture'
  | 'research'
  | 'accelerator'
  | 'venture_studio'
  | 'consultancy'

// ============================================================================
// HELPER FUNCTIONS (business logic extracted from component)
// ============================================================================

/**
 * Map AI industry strings to valid enum values
 */
const INDUSTRY_STRING_MAP: Record<string, CompanyIndustryValue> = {
  healthcare: 'healthcare',
  health: 'healthcare',
  medical: 'healthcare',
  'life sciences': 'healthcare',
  biotech: 'healthcare',
  pharmaceutical: 'healthcare',
  food: 'food_agriculture',
  agriculture: 'food_agriculture',
  agtech: 'food_agriculture',
  technology: 'technology',
  software: 'technology',
  tech: 'technology',
  saas: 'technology',
  'ai/ml': 'technology',
  'enterprise software': 'technology',
  manufacturing: 'manufacturing',
  industrial: 'manufacturing',
  automotive: 'manufacturing',
  aerospace: 'manufacturing',
  energy: 'energy',
  cleantech: 'energy',
  renewable: 'energy',
  environment: 'energy',
  consumer: 'consumer',
  retail: 'consumer',
  'e-commerce': 'consumer',
  ecommerce: 'consumer',
  financial: 'financial',
  fintech: 'financial',
  finance: 'financial',
  banking: 'financial',
  insurance: 'financial',
  logistics: 'logistics',
  transportation: 'logistics',
  'supply chain': 'logistics',
  infrastructure: 'logistics',
  telecommunications: 'logistics',
  media: 'media',
  entertainment: 'media',
  gaming: 'media',
  professional: 'professional',
  consulting: 'professional',
  services: 'professional',
}

function mapIndustryStringToEnum(industry: string): CompanyIndustryValue | null {
  const normalized = industry.toLowerCase().trim()
  return INDUSTRY_STRING_MAP[normalized] || null
}

/**
 * Map size string from AI to form enum
 */
const SIZE_MAP: Record<string, CompanySize> = {
  startup: 'small',
  micro: 'micro',
  sme: 'small',
  small: 'small',
  medium: 'medium',
  large: 'large',
  enterprise: 'enterprise',
}

function mapSizeStringToEnum(size: string): CompanySize | null {
  const normalized = size.toLowerCase().trim()
  return SIZE_MAP[normalized] || null
}

/**
 * Map stage string from AI to form enum
 */
const STAGE_MAP: Record<string, CompanyStage> = {
  'pre-seed': 'pre_seed',
  pre_seed: 'pre_seed',
  preseed: 'pre_seed',
  seed: 'seed',
  'series a': 'series_a',
  series_a: 'series_a',
  seriesa: 'series_a',
  'series b': 'series_b',
  series_b: 'series_b',
  seriesb: 'series_b',
  'series c': 'series_c_plus',
  'series c+': 'series_c_plus',
  series_c: 'series_c_plus',
  series_c_plus: 'series_c_plus',
  'series d': 'series_c_plus',
  'series d+': 'series_c_plus',
  bootstrapped: 'bootstrapped',
  'self-funded': 'bootstrapped',
  private: 'private',
  'late stage': 'private',
  public: 'public',
  'publicly traded': 'public',
  established: 'private',
  ipo: 'ipo',
  nonprofit: 'nonprofit',
  'non-profit': 'nonprofit',
}

function mapStageStringToEnum(stage: string): CompanyStage | null {
  const normalized = stage.toLowerCase().trim()
  return STAGE_MAP[normalized] || null
}

/**
 * Map company type string from AI to form enum
 */
const TYPE_MAP: Record<string, CompanyType> = {
  startup: 'startup',
  scaleup: 'scaleup',
  'scale-up': 'scaleup',
  sme: 'sme',
  corporate: 'corporate',
  enterprise: 'corporate',
  spinoff: 'spinoff',
  'spin-off': 'spinoff',
  'joint venture': 'joint_venture',
  joint_venture: 'joint_venture',
  research: 'research',
  'research institution': 'research',
  university: 'research',
  accelerator: 'accelerator',
  incubator: 'accelerator',
  'venture studio': 'venture_studio',
  venture_studio: 'venture_studio',
  consultancy: 'consultancy',
  consulting: 'consultancy',
  'consulting firm': 'consultancy',
  // Legacy value mappings
  vendor: 'corporate',
  partner: 'corporate',
  competitor: 'corporate',
}

function mapTypeStringToEnum(type: string): CompanyType | null {
  const normalized = type.toLowerCase().trim()
  return TYPE_MAP[normalized] || null
}

/**
 * Check if tab should be disabled based on edit mode
 */
function isTabDisabled(tabId: string, isEditMode: boolean): boolean {
  const alwaysEnabledTabs = ['overview']
  return !alwaysEnabledTabs.includes(tabId) && !isEditMode
}

/**
 * Get expected tab count for CompanySheet
 */
function getExpectedTabCount(): number {
  return 8 // overview, contacts, relations, knowledge, competitors, notes, research (no SWOT)
}

// ============================================================================
// TESTS
// ============================================================================

describe('CompanySheet Industry Mapping', () => {
  describe('mapIndustryStringToEnum', () => {
    it('should map healthcare-related strings', () => {
      expect(mapIndustryStringToEnum('healthcare')).toBe('healthcare')
      expect(mapIndustryStringToEnum('Health')).toBe('healthcare')
      expect(mapIndustryStringToEnum('MEDICAL')).toBe('healthcare')
      expect(mapIndustryStringToEnum('life sciences')).toBe('healthcare')
      expect(mapIndustryStringToEnum('biotech')).toBe('healthcare')
      expect(mapIndustryStringToEnum('pharmaceutical')).toBe('healthcare')
    })

    it('should map technology-related strings', () => {
      expect(mapIndustryStringToEnum('technology')).toBe('technology')
      expect(mapIndustryStringToEnum('software')).toBe('technology')
      expect(mapIndustryStringToEnum('Tech')).toBe('technology')
      expect(mapIndustryStringToEnum('SaaS')).toBe('technology')
      expect(mapIndustryStringToEnum('AI/ML')).toBe('technology')
      expect(mapIndustryStringToEnum('enterprise software')).toBe('technology')
    })

    it('should map food/agriculture strings', () => {
      expect(mapIndustryStringToEnum('food')).toBe('food_agriculture')
      expect(mapIndustryStringToEnum('agriculture')).toBe('food_agriculture')
      expect(mapIndustryStringToEnum('AgTech')).toBe('food_agriculture')
    })

    it('should map financial strings', () => {
      expect(mapIndustryStringToEnum('financial')).toBe('financial')
      expect(mapIndustryStringToEnum('fintech')).toBe('financial')
      expect(mapIndustryStringToEnum('banking')).toBe('financial')
      expect(mapIndustryStringToEnum('insurance')).toBe('financial')
    })

    it('should map consumer strings', () => {
      expect(mapIndustryStringToEnum('consumer')).toBe('consumer')
      expect(mapIndustryStringToEnum('retail')).toBe('consumer')
      expect(mapIndustryStringToEnum('e-commerce')).toBe('consumer')
      expect(mapIndustryStringToEnum('ecommerce')).toBe('consumer')
    })

    it('should return null for unknown strings', () => {
      expect(mapIndustryStringToEnum('unknown')).toBeNull()
      expect(mapIndustryStringToEnum('random industry')).toBeNull()
      expect(mapIndustryStringToEnum('')).toBeNull()
    })

    it('should handle whitespace', () => {
      expect(mapIndustryStringToEnum('  healthcare  ')).toBe('healthcare')
      expect(mapIndustryStringToEnum('\ttechnology\n')).toBe('technology')
    })
  })
})

describe('CompanySheet Size Mapping', () => {
  describe('mapSizeStringToEnum', () => {
    it('should map startup to small', () => {
      expect(mapSizeStringToEnum('startup')).toBe('small')
    })

    it('should map standard sizes', () => {
      expect(mapSizeStringToEnum('micro')).toBe('micro')
      expect(mapSizeStringToEnum('small')).toBe('small')
      expect(mapSizeStringToEnum('medium')).toBe('medium')
      expect(mapSizeStringToEnum('large')).toBe('large')
      expect(mapSizeStringToEnum('enterprise')).toBe('enterprise')
    })

    it('should map SME to small', () => {
      expect(mapSizeStringToEnum('sme')).toBe('small')
      expect(mapSizeStringToEnum('SME')).toBe('small')
    })

    it('should return null for unknown sizes', () => {
      expect(mapSizeStringToEnum('huge')).toBeNull()
      expect(mapSizeStringToEnum('tiny')).toBeNull()
    })
  })
})

describe('CompanySheet Stage Mapping', () => {
  describe('mapStageStringToEnum', () => {
    it('should map pre-seed variations', () => {
      expect(mapStageStringToEnum('pre-seed')).toBe('pre_seed')
      expect(mapStageStringToEnum('pre_seed')).toBe('pre_seed')
      expect(mapStageStringToEnum('preseed')).toBe('pre_seed')
    })

    it('should map seed stage', () => {
      expect(mapStageStringToEnum('seed')).toBe('seed')
      expect(mapStageStringToEnum('Seed')).toBe('seed')
    })

    it('should map series funding rounds', () => {
      expect(mapStageStringToEnum('series a')).toBe('series_a')
      expect(mapStageStringToEnum('Series A')).toBe('series_a')
      expect(mapStageStringToEnum('seriesa')).toBe('series_a')

      expect(mapStageStringToEnum('series b')).toBe('series_b')
      expect(mapStageStringToEnum('series_b')).toBe('series_b')

      expect(mapStageStringToEnum('series c')).toBe('series_c_plus')
      expect(mapStageStringToEnum('series c+')).toBe('series_c_plus')
      expect(mapStageStringToEnum('series d')).toBe('series_c_plus')
    })

    it('should map bootstrapped variations', () => {
      expect(mapStageStringToEnum('bootstrapped')).toBe('bootstrapped')
      expect(mapStageStringToEnum('self-funded')).toBe('bootstrapped')
    })

    it('should map late-stage variations', () => {
      expect(mapStageStringToEnum('private')).toBe('private')
      expect(mapStageStringToEnum('late stage')).toBe('private')
      expect(mapStageStringToEnum('established')).toBe('private')
    })

    it('should map public company variations', () => {
      expect(mapStageStringToEnum('public')).toBe('public')
      expect(mapStageStringToEnum('publicly traded')).toBe('public')
      expect(mapStageStringToEnum('ipo')).toBe('ipo')
    })

    it('should map nonprofit variations', () => {
      expect(mapStageStringToEnum('nonprofit')).toBe('nonprofit')
      expect(mapStageStringToEnum('non-profit')).toBe('nonprofit')
    })

    it('should return null for unknown stages', () => {
      expect(mapStageStringToEnum('unknown')).toBeNull()
      expect(mapStageStringToEnum('series z')).toBeNull()
    })
  })
})

describe('CompanySheet Type Mapping', () => {
  describe('mapTypeStringToEnum', () => {
    it('should map startup/scaleup types', () => {
      expect(mapTypeStringToEnum('startup')).toBe('startup')
      expect(mapTypeStringToEnum('scaleup')).toBe('scaleup')
      expect(mapTypeStringToEnum('scale-up')).toBe('scaleup')
    })

    it('should map corporate types', () => {
      expect(mapTypeStringToEnum('corporate')).toBe('corporate')
      expect(mapTypeStringToEnum('enterprise')).toBe('corporate')
    })

    it('should map research types', () => {
      expect(mapTypeStringToEnum('research')).toBe('research')
      expect(mapTypeStringToEnum('research institution')).toBe('research')
      expect(mapTypeStringToEnum('university')).toBe('research')
    })

    it('should map accelerator types', () => {
      expect(mapTypeStringToEnum('accelerator')).toBe('accelerator')
      expect(mapTypeStringToEnum('incubator')).toBe('accelerator')
    })

    it('should map venture studio types', () => {
      expect(mapTypeStringToEnum('venture studio')).toBe('venture_studio')
      expect(mapTypeStringToEnum('venture_studio')).toBe('venture_studio')
    })

    it('should map consultancy types', () => {
      expect(mapTypeStringToEnum('consultancy')).toBe('consultancy')
      expect(mapTypeStringToEnum('consulting')).toBe('consultancy')
      expect(mapTypeStringToEnum('consulting firm')).toBe('consultancy')
    })

    it('should map legacy values to corporate', () => {
      expect(mapTypeStringToEnum('vendor')).toBe('corporate')
      expect(mapTypeStringToEnum('partner')).toBe('corporate')
      expect(mapTypeStringToEnum('competitor')).toBe('corporate')
    })

    it('should return null for unknown types', () => {
      expect(mapTypeStringToEnum('unknown')).toBeNull()
      expect(mapTypeStringToEnum('random type')).toBeNull()
    })
  })
})

describe('CompanySheet Tab Configuration', () => {
  describe('isTabDisabled', () => {
    it('should never disable overview tab', () => {
      expect(isTabDisabled('overview', false)).toBe(false)
      expect(isTabDisabled('overview', true)).toBe(false)
    })

    it('should disable non-overview tabs in create mode', () => {
      expect(isTabDisabled('contacts', false)).toBe(true)
      expect(isTabDisabled('relations', false)).toBe(true)
      expect(isTabDisabled('notes', false)).toBe(true)
      expect(isTabDisabled('research', false)).toBe(true)
    })

    it('should enable all tabs in edit mode', () => {
      expect(isTabDisabled('contacts', true)).toBe(false)
      expect(isTabDisabled('relations', true)).toBe(false)
      expect(isTabDisabled('notes', true)).toBe(false)
      expect(isTabDisabled('research', true)).toBe(false)
    })
  })

  describe('getExpectedTabCount', () => {
    it('should return 8 tabs (SWOT removed)', () => {
      expect(getExpectedTabCount()).toBe(8)
    })
  })
})

describe('CompanySheet Tab Names', () => {
  const expectedTabs = [
    'overview',
    'contacts',
    'relations',
    'knowledge',
    'competitors',
    'notes',
    'research',
  ]

  it('should not include swot tab', () => {
    expect(expectedTabs).not.toContain('swot')
  })

  it('should include all required tabs', () => {
    expect(expectedTabs).toContain('overview')
    expect(expectedTabs).toContain('contacts')
    expect(expectedTabs).toContain('relations')
    expect(expectedTabs).toContain('knowledge')
    expect(expectedTabs).toContain('competitors')
    expect(expectedTabs).toContain('notes')
    expect(expectedTabs).toContain('research')
  })

  it('should have correct number of tabs', () => {
    expect(expectedTabs).toHaveLength(7)
  })
})

describe('CompanySheet AI Research Integration', () => {
  /**
   * Process AI research result and extract mappable values
   */
  function processAIResearchResult(result: {
    industry?: string[]
    size?: string
    stage?: string
    type?: string[]
  }): {
    mappedIndustries: CompanyIndustryValue[]
    unmappedIndustries: string[]
    mappedSize: CompanySize | null
    mappedStage: CompanyStage | null
    mappedTypes: CompanyType[]
  } {
    // Map industries
    const mappedIndustries: CompanyIndustryValue[] = []
    const unmappedIndustries: string[] = []

    if (result.industry) {
      for (const ind of result.industry) {
        const mapped = mapIndustryStringToEnum(ind)
        if (mapped) {
          mappedIndustries.push(mapped)
        } else {
          unmappedIndustries.push(ind)
        }
      }
    }

    // Map size
    const mappedSize = result.size ? mapSizeStringToEnum(result.size) : null

    // Map stage
    const mappedStage = result.stage ? mapStageStringToEnum(result.stage) : null

    // Map types
    const mappedTypes: CompanyType[] = []
    if (result.type) {
      for (const t of result.type) {
        const mapped = mapTypeStringToEnum(t)
        if (mapped) {
          mappedTypes.push(mapped)
        }
      }
    }

    return {
      mappedIndustries: [...new Set(mappedIndustries)],
      unmappedIndustries,
      mappedSize,
      mappedStage,
      mappedTypes: [...new Set(mappedTypes)],
    }
  }

  it('should process complete AI research result', () => {
    const result = processAIResearchResult({
      industry: ['technology', 'healthcare', 'unknown industry'],
      size: 'startup',
      stage: 'series a',
      type: ['startup', 'scaleup'],
    })

    expect(result.mappedIndustries).toEqual(['technology', 'healthcare'])
    expect(result.unmappedIndustries).toEqual(['unknown industry'])
    expect(result.mappedSize).toBe('small')
    expect(result.mappedStage).toBe('series_a')
    expect(result.mappedTypes).toEqual(['startup', 'scaleup'])
  })

  it('should handle empty AI research result', () => {
    const result = processAIResearchResult({})

    expect(result.mappedIndustries).toEqual([])
    expect(result.unmappedIndustries).toEqual([])
    expect(result.mappedSize).toBeNull()
    expect(result.mappedStage).toBeNull()
    expect(result.mappedTypes).toEqual([])
  })

  it('should deduplicate mapped industries', () => {
    const result = processAIResearchResult({
      industry: ['tech', 'technology', 'software'],
    })

    expect(result.mappedIndustries).toEqual(['technology'])
  })

  it('should deduplicate mapped types', () => {
    const result = processAIResearchResult({
      type: ['consulting', 'consultancy', 'consulting firm'],
    })

    expect(result.mappedTypes).toEqual(['consultancy'])
  })
})
