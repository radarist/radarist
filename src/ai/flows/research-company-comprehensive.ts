'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiProModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';
import type { CompanyResearch } from '@/lib/types';

import { coerceToEnum } from './coerce-to-enum';

const log = createLogger('ai-company-research-comprehensive');

/**
 * Schema for comprehensive company research input.
 */
const _ComprehensiveResearchInputSchema = z.object({
  name: z.string(),
  website: z.string().optional(),
  description: z.string().optional(),
  existingResearch: z.any().optional(), // Previous research to build upon
});

export type ComprehensiveResearchInput = z.infer<typeof _ComprehensiveResearchInputSchema>;

// Helper to coerce a string to an array (split by commas or use as single item)
const coerceToArray = (val: unknown): string[] => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    // If it contains commas, split; otherwise treat as single item
    return val.includes(',')
      ? val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [val];
  }
  return [];
};

// Helper to coerce string to number
const coerceToNumber = (val: unknown): number | undefined => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = parseInt(val.replace(/[^0-9]/g, ''), 10);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

// Helper to coerce string to open source activity object
const coerceToOpenSourceActivity = (
  val: unknown
): { repos?: number; stars?: number; contributors?: number } | undefined => {
  if (typeof val === 'object' && val !== null) return val as { repos?: number; stars?: number; contributors?: number };
  if (typeof val === 'string') {
    // Try to parse numbers from string like "10 repos, 5000 stars"
    const repos = val.match(/(\d+)\s*repos?/i);
    const stars = val.match(/(\d+)\s*stars?/i);
    const contributors = val.match(/(\d+)\s*contributors?/i);
    return {
      repos: repos ? parseInt(repos[1], 10) : undefined,
      stars: stars ? parseInt(stars[1], 10) : undefined,
      contributors: contributors ? parseInt(contributors[1], 10) : undefined,
    };
  }
  return undefined;
};

/**
 * Zod schema that matches the CompanyResearch interface from types.ts.
 * Used for AI structured output validation.
 * Includes preprocessing to handle AI returning strings instead of arrays/numbers.
 */
const CompanyResearchSchema = z.object({
  // Executive Summary
  executiveSummary: z
    .object({
      overview: z.string().describe('2-3 paragraph comprehensive company overview'),
      keyHighlights: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 key highlights about the company'),
      suggestedTags: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('5-10 simple keyword tags (1-3 words each) for categorization'),
      recommendation: z.string().optional().describe('Strategic recommendation for engagement'),
    })
    .optional(),

  // Company Profile - Basic company information for Overview tab
  companyProfile: z
    .object({
      website: z.string().optional().describe('Company website URL'),
      companyType: z
        .preprocess(
          coerceToEnum([
            'startup',
            'scaleup',
            'sme',
            'corporate',
            'spinoff',
            'joint_venture',
            'research',
            'accelerator',
            'venture_studio',
            'consultancy',
            'government',
            'ngo',
            'consortium',
            'academic',
          ] as const),
          z
            .enum([
              'startup',
              'scaleup',
              'sme',
              'corporate',
              'spinoff',
              'joint_venture',
              'research',
              'accelerator',
              'venture_studio',
              'consultancy',
              'government',
              'ngo',
              'consortium',
              'academic',
            ])
            .optional()
        )
        .describe('Type of company'),
      industries: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Industries the company operates in'),
      size: z
        .preprocess(
          coerceToEnum(['micro', 'small', 'medium', 'large', 'enterprise'] as const),
          z.enum(['micro', 'small', 'medium', 'large', 'enterprise']).optional()
        )
        .describe('Company size: micro (1-9), small (10-49), medium (50-249), large (250-999), enterprise (1000+)'),
      stage: z
        .preprocess(
          coerceToEnum([
            'pre_seed',
            'seed',
            'series_a',
            'series_b',
            'series_c_plus',
            'bootstrapped',
            'private',
            'public',
            'ipo',
            'nonprofit',
          ] as const),
          z
            .enum([
              'pre_seed',
              'seed',
              'series_a',
              'series_b',
              'series_c_plus',
              'bootstrapped',
              'private',
              'public',
              'ipo',
              'nonprofit',
            ])
            .optional()
        )
        .describe('Funding/business stage'),
      headquarters: z
        .object({
          city: z.string().optional(),
          country: z.string().optional(),
        })
        .optional()
        .describe('Company headquarters location'),
      socialLinks: z
        .object({
          linkedin: z.string().optional().describe('LinkedIn company page URL'),
          twitter: z.string().optional().describe('Twitter/X company account URL'),
          github: z.string().optional().describe('GitHub organization URL'),
        })
        .optional()
        .describe('Social media links'),
      foundedYear: z.preprocess(coerceToNumber, z.number().optional()).describe('Year the company was founded'),
    })
    .optional(),

  // Products & Solutions
  productsAndSolutions: z
    .object({
      productPortfolio: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('List of product/service names'),
      coreProducts: z
        .array(
          z.object({
            name: z.string(),
            description: z.string(),
            category: z.string().optional(),
          })
        )
        .optional()
        .describe('Detailed core product information'),
      deploymentModel: z.preprocess(
        coerceToEnum(['cloud', 'on-premise', 'hybrid', 'saas'] as const),
        z.enum(['cloud', 'on-premise', 'hybrid', 'saas']).optional()
      ),
      integrationCapabilities: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Integration options and APIs'),
      productMaturity: z.preprocess(
        coerceToEnum(['emerging', 'growing', 'mature', 'declining'] as const),
        z.enum(['emerging', 'growing', 'mature', 'declining']).optional()
      ),
    })
    .optional(),

  // Financials & Traction
  financialsAndTraction: z
    .object({
      fundingHistory: z
        .array(
          z.object({
            round: z.string(),
            amount: z.string().optional(),
            date: z.string().optional(),
            investors: z.preprocess(coerceToArray, z.array(z.string())).optional(),
          })
        )
        .optional()
        .describe('Funding rounds with details'),
      totalRaised: z.string().optional().describe('Total funding raised (e.g., "$150M")'),
      keyInvestors: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Notable investors'),
      revenueRange: z.string().optional().describe('Estimated revenue range (e.g., "$50-100M")'),
      revenueModel: z.preprocess(
        coerceToEnum(['subscription', 'transactional', 'licensing', 'freemium', 'hybrid'] as const),
        z.enum(['subscription', 'transactional', 'licensing', 'freemium', 'hybrid']).optional()
      ),
      customerCount: z.string().optional().describe('Number or range of customers'),
      lastYearEarnings: z.string().optional(),
      swot: z
        .object({
          strengths: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 key strengths'),
          weaknesses: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 key weaknesses'),
          opportunities: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 market opportunities'),
          threats: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 competitive threats'),
        })
        .optional(),
    })
    .optional(),

  // Team & Leadership
  teamAndLeadership: z
    .object({
      founders: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            background: z.string().optional(),
            linkedIn: z.string().optional(),
          })
        )
        .optional()
        .describe('Company founders'),
      keyExecutives: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            background: z.string().optional(),
          })
        )
        .optional()
        .describe('C-level and VP leadership'),
      teamSize: z.string().optional().describe('Total employee count or range'),
      engineeringRatio: z.string().optional().describe('Percentage of engineering staff'),
      notableHires: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            previousCompany: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),

  // Innovation Indicators
  innovationIndicators: z
    .object({
      patentCount: z.preprocess(coerceToNumber, z.number().optional()).describe('Number of patents filed/granted'),
      productVelocity: z
        .preprocess(coerceToEnum(['low', 'medium', 'high'] as const), z.enum(['low', 'medium', 'high']).optional())
        .describe('Rate of product releases'),
      openSourceActivity: z.preprocess(
        coerceToOpenSourceActivity,
        z
          .object({
            repos: z.number().optional(),
            stars: z.number().optional(),
            contributors: z.number().optional(),
          })
          .optional()
      ),
      technicalPublications: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Technical blogs, papers'),
    })
    .optional(),

  // Partnerships & Ecosystem
  partnershipsAndEcosystem: z
    .object({
      strategicPartners: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Major strategic partnerships'),
      technologyPartners: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Technology/integration partners'),
      channelPartners: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Resellers, distributors'),
      ecosystemPosition: z.preprocess(
        coerceToEnum(['leader', 'challenger', 'follower', 'niche'] as const),
        z.enum(['leader', 'challenger', 'follower', 'niche']).optional()
      ),
    })
    .optional(),

  // Risk Assessment
  riskAssessment: z
    .object({
      vendorRiskScore: z
        .preprocess(coerceToNumber, z.number().min(0).max(100).optional())
        .describe('Overall vendor risk 0-100'),
      regulatoryExposure: z.preprocess(
        coerceToEnum(['low', 'medium', 'high'] as const),
        z.enum(['low', 'medium', 'high']).optional()
      ),
      dependencyRisks: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Key dependencies and risks'),
      financialHealth: z.preprocess(
        coerceToEnum(['strong', 'stable', 'concerning', 'critical'] as const),
        z.enum(['strong', 'stable', 'concerning', 'critical']).optional()
      ),
    })
    .optional(),

  // Metadata - AI should provide confidence and sources
  metadata: z
    .object({
      // AI-043 — MUST be absolute http(s) URLs. A human reviewer cannot check a
      // free-text citation ("company website", "crunchbase"), so the review
      // projection drops every non-URL entry; a draft sourced that way is
      // unreviewable by construction and re-researching never rescues it.
      sources: z
        .preprocess(coerceToArray, z.array(z.string()))
        .describe('Absolute http(s) URLs of the sources used — never bare names or descriptions'),
      confidenceScore: z
        .preprocess(coerceToNumber, z.number().min(0).max(100))
        .describe('Confidence in research accuracy 0-100'),
    })
    .optional(),
});

/**
 * Performs comprehensive AI research on a company and returns data
 * matching the CompanyResearch interface.
 *
 * Uses gemini-3.1-pro-preview with Google Search grounding for real-time data.
 *
 * @param input - Company name, website, and optional existing data
 * @returns Promise resolving to CompanyResearch data
 */
export async function researchCompanyComprehensive(input: ComprehensiveResearchInput): Promise<CompanyResearch> {
  try {
    const prompt = `You are an expert Market Researcher, Technology Analyst, and Due Diligence Specialist.

TASK: Perform comprehensive research on the company "${input.name}"${input.website ? ` (website: ${input.website})` : ''}${input.description ? `\n\nCompany context: ${input.description}` : ''}

CRITICAL INSTRUCTIONS:
1. You MUST respond with ONLY a valid JSON object - no explanatory text
2. Research thoroughly using current, real-time information
3. Be specific and factual - avoid generic descriptions
4. If information is unavailable, omit the field rather than guessing
5. Include confidence scores based on data quality and recency

RESEARCH AREAS (provide ALL available data):

## 1. EXECUTIVE SUMMARY
- overview: Comprehensive 2-3 paragraph company description covering their market position, key offerings, and strategic direction
- keyHighlights: 3-5 most important facts about the company
- suggestedTags: 5-10 simple keyword tags for categorization. IMPORTANT: Each tag must be 1-3 words only (e.g., "AI", "Healthcare", "B2B SaaS", "Climate Tech", "Series B", "Enterprise", "Open Source", "API Platform"). NO sentences or descriptions.
- recommendation: Strategic recommendation for potential partnership/engagement

## 2. COMPANY PROFILE (IMPORTANT - populate all available fields)
- website: Company website URL (must be a valid URL)
- companyType: One of "startup", "scaleup", "sme", "corporate", "spinoff", "joint_venture", "research", "accelerator", "venture_studio", "consultancy", "government", "ngo", "consortium", "academic"
- industries: Array of industries from: "healthcare", "food_agriculture", "technology", "manufacturing", "energy", "consumer", "financial", "logistics", "media", "professional", "defense", "education", "real_estate", "telecommunications", "automotive", "chemicals", "materials", "biotech", "pharma", "other"
- size: One of "micro" (1-9 employees), "small" (10-49), "medium" (50-249), "large" (250-999), "enterprise" (1000+)
- stage: One of "pre_seed", "seed", "series_a", "series_b", "series_c_plus", "bootstrapped", "private", "public", "ipo", "nonprofit"
- headquarters: Object with city and country (e.g., {"city": "San Francisco", "country": "United States"})
- socialLinks: Object with linkedin, twitter, github URLs
- foundedYear: Year the company was founded (number)

## 3. PRODUCTS & SOLUTIONS
- productPortfolio: List of all products/services
- coreProducts: Detailed info on main products (name, description, category)
- deploymentModel: One of "cloud", "on-premise", "hybrid", "saas"
- integrationCapabilities: APIs, integrations, connectors available
- productMaturity: One of "emerging", "growing", "mature", "declining"

## 4. FINANCIALS & TRACTION
- fundingHistory: Array of funding rounds with round, amount, date, investors
- totalRaised: Total funding raised (e.g., "$150M")
- keyInvestors: Notable investors backing the company
- revenueRange: Estimated revenue (e.g., "$50-100M ARR")
- revenueModel: One of "subscription", "transactional", "licensing", "freemium", "hybrid"
- customerCount: Number or range of customers
- swot: SWOT analysis with 3-5 items each for strengths, weaknesses, opportunities, threats

## 5. TEAM & LEADERSHIP
- founders: Founders with name, role, background, linkedIn
- keyExecutives: C-level executives with name, role, background
- teamSize: Total employees or range (e.g., "200-500")
- engineeringRatio: Percentage of engineering staff (e.g., "40%")
- notableHires: Recent significant hires with name, role, previousCompany

## 6. INNOVATION INDICATORS
- patentCount: Number of patents
- productVelocity: One of "low", "medium", "high" based on release frequency
- openSourceActivity: GitHub presence with repos, stars, contributors
- technicalPublications: Technical blogs, papers, or documentation

## 7. PARTNERSHIPS & ECOSYSTEM
- strategicPartners: Major strategic partnerships
- technologyPartners: Technology/integration partners
- channelPartners: Resellers, distributors, implementation partners
- ecosystemPosition: One of "leader", "challenger", "follower", "niche"

## 8. RISK ASSESSMENT
- vendorRiskScore: Overall risk score 0-100 (lower is better)
- regulatoryExposure: One of "low", "medium", "high"
- dependencyRisks: Key risks and dependencies
- financialHealth: One of "strong", "stable", "concerning", "critical"

## 9. METADATA
- sources: The absolute http(s) URLs you actually used, one entry per page (e.g. "https://acme.com/about", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000001"). A human reviewer must be able to open each one to check the claim it supports. NEVER emit a bare site or database NAME ("company website", "crunchbase", "linkedin", "news articles") — an entry without a full URL is discarded, and a draft whose sources are all discarded cannot be reviewed or approved at all. If you could not obtain a real URL for something, omit that source rather than naming it.
- confidenceScore: Overall confidence in accuracy 0-100

EXAMPLE OUTPUT STRUCTURE:
{
  "executiveSummary": {
    "overview": "Detailed company overview...",
    "keyHighlights": ["Point 1", "Point 2", "Point 3"],
    "suggestedTags": ["AI", "B2B SaaS", "Healthcare", "Series B", "Enterprise"],
    "recommendation": "Strategic recommendation..."
  },
  "companyProfile": {
    "website": "https://example.com",
    "companyType": "startup",
    "industries": ["technology", "healthcare"],
    "size": "medium",
    "stage": "series_b",
    "headquarters": {"city": "San Francisco", "country": "United States"},
    "socialLinks": {"linkedin": "https://linkedin.com/company/example", "twitter": "https://twitter.com/example"},
    "foundedYear": 2018
  },
  "productsAndSolutions": {
    "productPortfolio": ["Product A", "Product B"],
    "coreProducts": [{"name": "Main Product", "description": "Description...", "category": "Category"}],
    "deploymentModel": "saas",
    "productMaturity": "growing"
  },
  "financialsAndTraction": {
    "fundingHistory": [{"round": "Series B", "amount": "$50M", "date": "2023", "investors": ["Investor A"]}],
    "totalRaised": "$80M",
    "swot": {
      "strengths": ["Strong tech", "Market leader"],
      "weaknesses": ["Small team", "Limited geography"],
      "opportunities": ["Growing market", "New verticals"],
      "threats": ["Competition", "Regulation"]
    }
  },
  "teamAndLeadership": {
    "founders": [{"name": "John Doe", "role": "CEO", "background": "Ex-Google"}],
    "teamSize": "100-200"
  },
  "innovationIndicators": {
    "productVelocity": "high",
    "openSourceActivity": {"repos": 10, "stars": 5000}
  },
  "partnershipsAndEcosystem": {
    "strategicPartners": ["Partner A", "Partner B"],
    "ecosystemPosition": "challenger"
  },
  "riskAssessment": {
    "vendorRiskScore": 25,
    "financialHealth": "strong"
  },
  "metadata": {
    "sources": ["https://acme.com/about", "https://www.crunchbase.com/organization/acme", "https://techcrunch.com/2026/01/15/acme-series-b"],
    "confidenceScore": 85
  }
}

NOW research "${input.name}" and return ONLY the JSON object with all available data:`;

    const result = await generateStructuredContent(prompt, CompanyResearchSchema, {
      model: geminiProModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
      maxOutputTokens: 32768, // Large output for comprehensive research
    });

    // Transform to CompanyResearch format with timestamps
    const companyResearch: CompanyResearch = {
      lastResearched: Date.now(),
      // AI-043 — a refresh must record a NEW artifact version, matching
      // `refreshCompanyResearchSection`. Hardcoding 1 pinned every regenerated
      // draft to the same version, so the review artifact identity never moved.
      version: (typeof input.existingResearch?.version === 'number' ? input.existingResearch.version : 0) + 1,
      executiveSummary: result.executiveSummary,
      companyProfile: result.companyProfile,
      productsAndSolutions: result.productsAndSolutions,
      financialsAndTraction: result.financialsAndTraction,
      teamAndLeadership: result.teamAndLeadership,
      innovationIndicators: result.innovationIndicators,
      partnershipsAndEcosystem: result.partnershipsAndEcosystem,
      riskAssessment: result.riskAssessment,
      metadata: result.metadata
        ? {
            sources: result.metadata.sources,
            confidenceScore: result.metadata.confidenceScore,
            model: geminiProModel() as GeminiModel,
          }
        : {
            sources: [],
            confidenceScore: 0,
            model: geminiProModel() as GeminiModel,
          },
    };

    return companyResearch;
  } catch (error) {
    log.error('Error in comprehensive company research', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to research company: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Lightweight research refresh that only updates specific sections.
 * Faster and cheaper than full comprehensive research.
 */
export async function refreshCompanyResearchSection(
  input: ComprehensiveResearchInput,
  sections: Array<
    'executiveSummary' | 'financialsAndTraction' | 'teamAndLeadership' | 'innovationIndicators' | 'riskAssessment'
  >
): Promise<Partial<CompanyResearch>> {
  // For now, delegate to full research - can be optimized later
  const fullResearch = await researchCompanyComprehensive(input);

  // Filter to only requested sections
  const result: Partial<CompanyResearch> = {
    lastResearched: fullResearch.lastResearched,
    version: (input.existingResearch?.version || 0) + 1,
    metadata: fullResearch.metadata,
  };

  for (const section of sections) {
    if (fullResearch[section]) {
      (result as Record<string, unknown>)[section] = fullResearch[section];
    }
  }

  return result;
}
