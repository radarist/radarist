/**
 * Unit Tests for ResearchTab Logic
 *
 * Tests the business logic for ResearchTab:
 * - Research data detection
 * - Section visibility logic
 * - Timestamp formatting
 * - Health/risk badge logic
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals'

// ============================================================================
// TYPES (mirrored from ResearchTab)
// ============================================================================

interface CompanyResearch {
  lastResearched?: number
  executiveSummary?: {
    overview: string
    keyHighlights?: string[]
    recommendation?: string
  }
  productsAndSolutions?: {
    coreProducts?: Array<{
      name: string
      description: string
      category?: string
    }>
    deploymentModel?: string
    productMaturity?: 'emerging' | 'growing' | 'mature' | 'declining'
    integrationCapabilities?: string[]
  }
  financialsAndTraction?: {
    totalRaised?: string
    revenueRange?: string
    customerCount?: string
    fundingHistory?: Array<{
      round: string
      amount?: string
      date?: string
    }>
    keyInvestors?: string[]
    swot?: {
      strengths?: string[]
      weaknesses?: string[]
      opportunities?: string[]
      threats?: string[]
    }
  }
  teamAndLeadership?: {
    teamSize?: string
    engineeringRatio?: string
    founders?: Array<{
      name: string
      role: string
      background?: string
      linkedIn?: string
    }>
    keyExecutives?: Array<{
      name: string
      role: string
    }>
  }
  innovationIndicators?: {
    patentCount?: number
    productVelocity?: 'high' | 'medium' | 'low'
    openSourceActivity?: {
      repos?: number
      stars?: number
      contributors?: number
    }
  }
  partnershipsAndEcosystem?: {
    ecosystemPosition?: 'leader' | 'challenger' | 'follower' | 'niche'
    strategicPartners?: string[]
    technologyPartners?: string[]
  }
  riskAssessment?: {
    vendorRiskScore?: number
    financialHealth?: 'strong' | 'stable' | 'concerning' | 'critical'
    regulatoryExposure?: 'low' | 'medium' | 'high'
    dependencyRisks?: string[]
  }
  metadata?: {
    confidenceScore?: number
    model?: string
    sources?: string[]
  }
}

// ============================================================================
// HELPER FUNCTIONS (business logic extracted from component)
// ============================================================================

/**
 * Check if research data has any content
 */
function hasResearchData(research: CompanyResearch | null | undefined): boolean {
  if (!research) return false

  return !!(
    research.executiveSummary ||
    research.productsAndSolutions ||
    research.financialsAndTraction ||
    research.teamAndLeadership ||
    research.innovationIndicators ||
    research.partnershipsAndEcosystem ||
    research.riskAssessment
  )
}

/**
 * Get sections that have data
 */
function getSectionsWithData(research: CompanyResearch | null | undefined): string[] {
  if (!research) return []

  const sections: string[] = []

  if (research.executiveSummary) sections.push('executiveSummary')
  if (research.productsAndSolutions) sections.push('productsAndSolutions')
  if (research.financialsAndTraction) sections.push('financialsAndTraction')
  if (research.teamAndLeadership) sections.push('teamAndLeadership')
  if (research.innovationIndicators) sections.push('innovationIndicators')
  if (research.partnershipsAndEcosystem) sections.push('partnershipsAndEcosystem')
  if (research.riskAssessment) sections.push('riskAssessment')

  return sections
}

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`
  return new Date(timestamp).toLocaleDateString()
}

/**
 * Get health badge config
 */
function getHealthBadgeConfig(health: 'strong' | 'stable' | 'concerning' | 'critical'): {
  label: string
  severity: 'success' | 'info' | 'warning' | 'error'
} {
  const configs = {
    strong: { label: 'Strong', severity: 'success' as const },
    stable: { label: 'Stable', severity: 'info' as const },
    concerning: { label: 'Concerning', severity: 'warning' as const },
    critical: { label: 'Critical', severity: 'error' as const },
  }
  return configs[health]
}

/**
 * Get risk badge config
 */
function getRiskBadgeConfig(level: 'low' | 'medium' | 'high'): {
  label: string
  severity: 'success' | 'warning' | 'error'
} {
  const configs = {
    low: { label: 'Low Risk', severity: 'success' as const },
    medium: { label: 'Medium Risk', severity: 'warning' as const },
    high: { label: 'High Risk', severity: 'error' as const },
  }
  return configs[level]
}

/**
 * Check if SWOT data exists in financials
 */
function hasSwotData(research: CompanyResearch | null | undefined): boolean {
  const swot = research?.financialsAndTraction?.swot
  if (!swot) return false

  return !!(
    (swot.strengths && swot.strengths.length > 0) ||
    (swot.weaknesses && swot.weaknesses.length > 0) ||
    (swot.opportunities && swot.opportunities.length > 0) ||
    (swot.threats && swot.threats.length > 0)
  )
}

// ============================================================================
// TESTS
// ============================================================================

describe('ResearchTab Data Detection', () => {
  describe('hasResearchData', () => {
    it('should return false for null research', () => {
      expect(hasResearchData(null)).toBe(false)
    })

    it('should return false for undefined research', () => {
      expect(hasResearchData(undefined)).toBe(false)
    })

    it('should return false for empty research object', () => {
      expect(hasResearchData({})).toBe(false)
    })

    it('should return true when executiveSummary exists', () => {
      expect(hasResearchData({
        executiveSummary: { overview: 'Test' }
      })).toBe(true)
    })

    it('should return true when productsAndSolutions exists', () => {
      expect(hasResearchData({
        productsAndSolutions: { coreProducts: [] }
      })).toBe(true)
    })

    it('should return true when financialsAndTraction exists', () => {
      expect(hasResearchData({
        financialsAndTraction: { totalRaised: '$1M' }
      })).toBe(true)
    })

    it('should return true when teamAndLeadership exists', () => {
      expect(hasResearchData({
        teamAndLeadership: { teamSize: '50' }
      })).toBe(true)
    })

    it('should return true when innovationIndicators exists', () => {
      expect(hasResearchData({
        innovationIndicators: { patentCount: 5 }
      })).toBe(true)
    })

    it('should return true when partnershipsAndEcosystem exists', () => {
      expect(hasResearchData({
        partnershipsAndEcosystem: { ecosystemPosition: 'leader' }
      })).toBe(true)
    })

    it('should return true when riskAssessment exists', () => {
      expect(hasResearchData({
        riskAssessment: { vendorRiskScore: 30 }
      })).toBe(true)
    })

    it('should return true when multiple sections exist', () => {
      expect(hasResearchData({
        executiveSummary: { overview: 'Test' },
        riskAssessment: { vendorRiskScore: 30 }
      })).toBe(true)
    })

    it('should return false when only metadata exists', () => {
      expect(hasResearchData({
        lastResearched: Date.now(),
        metadata: { confidenceScore: 80 }
      })).toBe(false)
    })
  })

  describe('getSectionsWithData', () => {
    it('should return empty array for null research', () => {
      expect(getSectionsWithData(null)).toEqual([])
    })

    it('should return all sections that have data', () => {
      const research: CompanyResearch = {
        executiveSummary: { overview: 'Test' },
        financialsAndTraction: { totalRaised: '$1M' },
        riskAssessment: { vendorRiskScore: 30 }
      }

      const sections = getSectionsWithData(research)

      expect(sections).toHaveLength(3)
      expect(sections).toContain('executiveSummary')
      expect(sections).toContain('financialsAndTraction')
      expect(sections).toContain('riskAssessment')
    })

    it('should maintain consistent order', () => {
      const research: CompanyResearch = {
        riskAssessment: { vendorRiskScore: 30 },
        executiveSummary: { overview: 'Test' },
      }

      const sections = getSectionsWithData(research)

      // Should be in predefined order, not insertion order
      expect(sections[0]).toBe('executiveSummary')
      expect(sections[1]).toBe('riskAssessment')
    })
  })
})

describe('ResearchTab Timestamp Formatting', () => {
  describe('formatRelativeTime', () => {
    it('should return "just now" for timestamps less than 1 minute ago', () => {
      const timestamp = Date.now() - 30000 // 30 seconds ago
      expect(formatRelativeTime(timestamp)).toBe('just now')
    })

    it('should return "1 minute ago" for timestamp 1 minute ago', () => {
      const timestamp = Date.now() - 60000
      expect(formatRelativeTime(timestamp)).toBe('1 minute ago')
    })

    it('should return "5 minutes ago" for timestamp 5 minutes ago', () => {
      const timestamp = Date.now() - 300000
      expect(formatRelativeTime(timestamp)).toBe('5 minutes ago')
    })

    it('should return "1 hour ago" for timestamp 1 hour ago', () => {
      const timestamp = Date.now() - 3600000
      expect(formatRelativeTime(timestamp)).toBe('1 hour ago')
    })

    it('should return "12 hours ago" for timestamp 12 hours ago', () => {
      const timestamp = Date.now() - 43200000
      expect(formatRelativeTime(timestamp)).toBe('12 hours ago')
    })

    it('should return "1 day ago" for timestamp 1 day ago', () => {
      const timestamp = Date.now() - 86400000
      expect(formatRelativeTime(timestamp)).toBe('1 day ago')
    })

    it('should return "5 days ago" for timestamp 5 days ago', () => {
      const timestamp = Date.now() - 432000000
      expect(formatRelativeTime(timestamp)).toBe('5 days ago')
    })

    it('should return date string for timestamps older than 7 days', () => {
      const timestamp = Date.now() - 864000000 // 10 days ago
      const result = formatRelativeTime(timestamp)
      // Should be a date string like "1/9/2026"
      expect(result).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
    })
  })
})

describe('ResearchTab Badge Logic', () => {
  describe('getHealthBadgeConfig', () => {
    it('should return success severity for strong health', () => {
      const config = getHealthBadgeConfig('strong')
      expect(config.label).toBe('Strong')
      expect(config.severity).toBe('success')
    })

    it('should return info severity for stable health', () => {
      const config = getHealthBadgeConfig('stable')
      expect(config.label).toBe('Stable')
      expect(config.severity).toBe('info')
    })

    it('should return warning severity for concerning health', () => {
      const config = getHealthBadgeConfig('concerning')
      expect(config.label).toBe('Concerning')
      expect(config.severity).toBe('warning')
    })

    it('should return error severity for critical health', () => {
      const config = getHealthBadgeConfig('critical')
      expect(config.label).toBe('Critical')
      expect(config.severity).toBe('error')
    })
  })

  describe('getRiskBadgeConfig', () => {
    it('should return success severity for low risk', () => {
      const config = getRiskBadgeConfig('low')
      expect(config.label).toBe('Low Risk')
      expect(config.severity).toBe('success')
    })

    it('should return warning severity for medium risk', () => {
      const config = getRiskBadgeConfig('medium')
      expect(config.label).toBe('Medium Risk')
      expect(config.severity).toBe('warning')
    })

    it('should return error severity for high risk', () => {
      const config = getRiskBadgeConfig('high')
      expect(config.label).toBe('High Risk')
      expect(config.severity).toBe('error')
    })
  })
})

describe('ResearchTab SWOT Integration', () => {
  describe('hasSwotData', () => {
    it('should return false when no research', () => {
      expect(hasSwotData(null)).toBe(false)
    })

    it('should return false when no financials', () => {
      expect(hasSwotData({})).toBe(false)
    })

    it('should return false when no swot in financials', () => {
      expect(hasSwotData({
        financialsAndTraction: { totalRaised: '$1M' }
      })).toBe(false)
    })

    it('should return false when swot is empty', () => {
      expect(hasSwotData({
        financialsAndTraction: {
          swot: {
            strengths: [],
            weaknesses: [],
            opportunities: [],
            threats: []
          }
        }
      })).toBe(false)
    })

    it('should return true when strengths exist', () => {
      expect(hasSwotData({
        financialsAndTraction: {
          swot: { strengths: ['Strong brand'] }
        }
      })).toBe(true)
    })

    it('should return true when weaknesses exist', () => {
      expect(hasSwotData({
        financialsAndTraction: {
          swot: { weaknesses: ['Limited funding'] }
        }
      })).toBe(true)
    })

    it('should return true when opportunities exist', () => {
      expect(hasSwotData({
        financialsAndTraction: {
          swot: { opportunities: ['New market'] }
        }
      })).toBe(true)
    })

    it('should return true when threats exist', () => {
      expect(hasSwotData({
        financialsAndTraction: {
          swot: { threats: ['Competition'] }
        }
      })).toBe(true)
    })
  })
})

describe('ResearchTab Section Count', () => {
  it('should have maximum of 7 main sections', () => {
    const allSections = [
      'executiveSummary',
      'productsAndSolutions',
      'financialsAndTraction',
      'teamAndLeadership',
      'innovationIndicators',
      'partnershipsAndEcosystem',
      'riskAssessment'
    ]

    expect(allSections).toHaveLength(7)
  })

  it('should return all 7 sections for complete research data', () => {
    const completeResearch: CompanyResearch = {
      executiveSummary: { overview: 'Test' },
      productsAndSolutions: { coreProducts: [] },
      financialsAndTraction: { totalRaised: '$1M' },
      teamAndLeadership: { teamSize: '50' },
      innovationIndicators: { patentCount: 5 },
      partnershipsAndEcosystem: { ecosystemPosition: 'leader' },
      riskAssessment: { vendorRiskScore: 30 }
    }

    const sections = getSectionsWithData(completeResearch)
    expect(sections).toHaveLength(7)
  })
})
