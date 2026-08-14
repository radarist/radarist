'use server';

import { generateStructuredContentWithMetadata } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiComprehensiveResearchModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';
import type { TechnologyResearch } from '@/lib/types';

const log = createLogger('ai-tech-research-comprehensive');

/**
 * The model this flow executes AND records — resolved through one accessor so
 * the executed model and the recorded model can never disagree (AI-029).
 *
 * DEP-010: this was a hardcoded `gemini-2.5-pro`, which shuts down 2026-10-16.
 * It now reads `geminiComprehensiveResearchModel()`, which keeps a dedicated
 * env var rather than following `GEMINI_PRO_MODEL` — see that accessor for why
 * this flow still needs its own knob, and for the schema-adherence risk the
 * move carries.
 */
// NOT exported: this module carries `'use server'`, under which every export
// must be an async server action. It is covered through
// `geminiComprehensiveResearchModel` (unit-tested directly) plus the frozen
// literal allow-list in `effective-model.test.ts`, which fails if any
// `gemini-[0-9]` literal reappears in this file.
function comprehensiveResearchModel(): GeminiModel {
  return geminiComprehensiveResearchModel() as GeminiModel;
}

/**
 * Schema for comprehensive technology research input.
 */
const _ComprehensiveTechnologyResearchInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  websiteUrl: z.string().optional(),
  existingResearch: z.any().optional(), // Previous research to build upon
});

export type ComprehensiveTechnologyResearchInput = z.infer<typeof _ComprehensiveTechnologyResearchInputSchema>;

// Helper to coerce a string to an array (split by commas or use as single item)
// Also handles arrays of objects by converting them to descriptive strings
const coerceToArray = (val: unknown): string[] => {
  if (Array.isArray(val)) {
    // If it's an array of objects, convert each to a string
    return val
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          // Convert object to a descriptive string
          // Handle common patterns like {acquirer, target, amount} or {company, amount}
          const obj = item as Record<string, unknown>;
          const parts: string[] = [];
          for (const [_key, value] of Object.entries(obj)) {
            if (value !== undefined && value !== null && value !== '') {
              parts.push(String(value));
            }
          }
          return parts.join(' - ') || JSON.stringify(item);
        }
        return String(item);
      })
      .filter(Boolean);
  }
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

// Helper to coerce verbose enum values to just the enum value
// e.g., "high (evidenced by recent launches...)" -> "high"
const coerceToEnum =
  <T extends string>(allowedValues: readonly T[]) =>
  (val: unknown): T | undefined => {
    if (typeof val !== 'string') return undefined;

    // First, try exact match
    const lower = val.toLowerCase().trim();
    const exactMatch = allowedValues.find((v) => v.toLowerCase() === lower);
    if (exactMatch) return exactMatch;

    // Second, check if the string starts with one of the allowed values
    for (const allowed of allowedValues) {
      if (lower.startsWith(allowed.toLowerCase())) {
        return allowed;
      }
    }

    // Third, check if any allowed value is contained in the string
    for (const allowed of allowedValues) {
      if (lower.includes(allowed.toLowerCase())) {
        return allowed;
      }
    }

    return undefined;
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

// Helper to coerce maturity level to 1-5
const coerceToMaturityLevel = (val: unknown): 1 | 2 | 3 | 4 | 5 | undefined => {
  const num = coerceToNumber(val);
  if (num !== undefined && num >= 1 && num <= 5) {
    return num as 1 | 2 | 3 | 4 | 5;
  }
  return undefined;
};

/**
 * Zod schema that matches the TechnologyResearch interface from types.ts.
 * Used for AI structured output validation.
 * Includes preprocessing to handle AI returning strings instead of arrays/numbers.
 */
const TechnologyResearchSchema = z.object({
  // Section 1: Executive Summary
  executiveSummary: z
    .object({
      summary: z.string().describe('2-3 paragraph comprehensive technology overview'),
      keyInsights: z.preprocess(coerceToArray, z.array(z.string())).describe('3-5 key insights about the technology'),
    })
    .optional(),

  // Section 2: Maturity Assessment
  maturityAssessment: z
    .object({
      hypeCyclePosition: z
        .preprocess(
          coerceToEnum([
            'innovation-trigger',
            'peak-of-inflated-expectations',
            'trough-of-disillusionment',
            'slope-of-enlightenment',
            'plateau-of-productivity',
          ] as const),
          z.enum([
            'innovation-trigger',
            'peak-of-inflated-expectations',
            'trough-of-disillusionment',
            'slope-of-enlightenment',
            'plateau-of-productivity',
          ])
        )
        .optional()
        .describe('Position on Gartner Hype Cycle'),
      timeToMainstream: z.string().optional().describe('Estimated time until mainstream adoption (e.g., "2-5 years")'),
      maturityTrajectory: z
        .preprocess(
          coerceToEnum(['accelerating', 'steady', 'slowing', 'declining'] as const),
          z.enum(['accelerating', 'steady', 'slowing', 'declining'])
        )
        .optional()
        .describe('Current trajectory of maturity'),
    })
    .optional(),

  // Section 3: Technology Metrics
  technologyMetrics: z
    .object({
      category: z.string().optional().describe('Primary technology category'),
      keyMetrics: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            trend: z.preprocess(
              coerceToEnum(['up', 'down', 'stable'] as const),
              z.enum(['up', 'down', 'stable']).optional()
            ),
          })
        )
        .optional()
        .describe('Key quantitative metrics (e.g., adoption rate, performance benchmarks)'),
      milestones: z
        .array(
          z.object({
            date: z.string(),
            description: z.string(),
          })
        )
        .optional()
        .describe('Significant milestones in technology development'),
    })
    .optional(),

  // Section 4: Key Players
  keyPlayers: z
    .object({
      marketLeaders: z
        .array(
          z.object({
            name: z.string(),
            role: z.string(),
            marketShare: z.string().optional(),
          })
        )
        .optional()
        .describe('Companies leading in this technology'),
      emergingStartups: z
        .array(
          z.object({
            name: z.string(),
            focus: z.string(),
            funding: z.string().optional(),
          })
        )
        .optional()
        .describe('Promising startups in this space'),
      researchInstitutions: z
        .array(
          z.object({
            name: z.string(),
            contribution: z.string(),
          })
        )
        .optional()
        .describe('Academic/research institutions contributing'),
      openSourceProjects: z
        .array(
          z.object({
            name: z.string(),
            stars: z.preprocess(coerceToNumber, z.number().optional()),
            description: z.string(),
          })
        )
        .optional()
        .describe('Major open source projects'),
    })
    .optional(),

  // Section 5: Use Cases & Applications
  useCasesAndApplications: z
    .object({
      byMaturity: z
        .object({
          production: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Use cases in production'),
          piloting: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Use cases being piloted'),
          experimental: z
            .preprocess(coerceToArray, z.array(z.string()))
            .optional()
            .describe('Experimental/R&D use cases'),
        })
        .optional(),
      byIndustry: z
        .array(
          z.object({
            industry: z.string(),
            useCases: z.preprocess(coerceToArray, z.array(z.string())),
          })
        )
        .optional()
        .describe('Use cases by industry vertical'),
      byFunction: z
        .array(
          z.object({
            function: z.string(),
            applications: z.preprocess(coerceToArray, z.array(z.string())),
          })
        )
        .optional()
        .describe('Use cases by business function'),
      flagshipExamples: z
        .array(
          z.object({
            company: z.string(),
            useCase: z.string(),
            outcome: z.string().optional(),
          })
        )
        .optional()
        .describe('Notable real-world implementations'),
    })
    .optional(),

  // Section 6: Technical Deep-Dive
  technicalDeepDive: z
    .object({
      architectureOverview: z.string().optional().describe('High-level architecture description'),
      coreComponents: z
        .array(
          z.object({
            name: z.string(),
            purpose: z.string(),
          })
        )
        .optional()
        .describe('Key architectural components'),
      competingParadigms: z
        .array(
          z.object({
            name: z.string(),
            comparison: z.string(),
          })
        )
        .optional()
        .describe('Alternative approaches and how they compare'),
      integrationRequirements: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('What is needed to integrate'),
      standards: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Relevant standards'),
      protocols: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Protocols used'),
      interoperability: z
        .object({
          level: z.preprocess(coerceToEnum(['high', 'medium', 'low'] as const), z.enum(['high', 'medium', 'low'])),
          details: z.string(),
        })
        .optional()
        .describe('Interoperability with other systems'),
    })
    .optional(),

  // Section 7: Value Assessment
  valueAssessment: z
    .object({
      maturityLevel: z
        .preprocess(
          coerceToMaturityLevel,
          z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
        )
        .optional()
        .describe('Maturity level 1-5'),
      primaryValueDrivers: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Main sources of business value'),
      quantifiedBenefits: z
        .array(
          z.object({
            benefit: z.string(),
            metric: z.string(),
          })
        )
        .optional()
        .describe('Benefits with quantifiable metrics'),
      evidenceLevel: z
        .preprocess(
          coerceToEnum(['strong', 'moderate', 'limited', 'anecdotal'] as const),
          z.enum(['strong', 'moderate', 'limited', 'anecdotal'])
        )
        .optional()
        .describe('Quality of evidence for benefits'),
      roiAssessable: z.boolean().optional().describe('Whether ROI can be meaningfully calculated'),
      typicalROI: z.string().optional().describe('Typical ROI range if assessable'),
      timeToValue: z.string().optional().describe('Time to realize value'),
      paybackPeriod: z.string().optional().describe('Typical payback period'),
      roiConfidence: z.preprocess(
        coerceToEnum(['high', 'medium', 'low'] as const),
        z.enum(['high', 'medium', 'low']).optional()
      ),
      strategicValue: z
        .preprocess(
          coerceToEnum(['transformational', 'significant', 'incremental', 'marginal'] as const),
          z.enum(['transformational', 'significant', 'incremental', 'marginal'])
        )
        .optional()
        .describe('Strategic importance'),
      competitiveAdvantageType: z
        .preprocess(
          coerceToEnum(['differentiation', 'cost-leadership', 'operational-excellence', 'none'] as const),
          z.enum(['differentiation', 'cost-leadership', 'operational-excellence', 'none'])
        )
        .optional()
        .describe('Type of competitive advantage enabled'),
    })
    .optional(),

  // Section 8: Risks & Barriers
  risksAndBarriers: z
    .object({
      technicalBarriers: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Technical challenges to adoption'),
      adoptionBarriers: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Organizational/market barriers'),
      implementationChallenges: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Implementation difficulties'),
      vendorLockInRisk: z
        .preprocess(coerceToEnum(['high', 'medium', 'low'] as const), z.enum(['high', 'medium', 'low']))
        .optional()
        .describe('Risk of vendor lock-in'),
      obsolescenceRisk: z
        .preprocess(coerceToEnum(['high', 'medium', 'low'] as const), z.enum(['high', 'medium', 'low']))
        .optional()
        .describe('Risk of technology becoming obsolete'),
      securityConsiderations: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Security concerns'),
    })
    .optional(),

  // Section 9: Investment Landscape
  investmentLandscape: z
    .object({
      vcActivityLevel: z
        .preprocess(
          coerceToEnum(['very-high', 'high', 'moderate', 'low', 'minimal'] as const),
          z.enum(['very-high', 'high', 'moderate', 'low', 'minimal'])
        )
        .optional()
        .describe('Level of VC investment activity'),
      governmentFunding: z
        .object({
          level: z.preprocess(
            coerceToEnum(['significant', 'moderate', 'limited', 'none'] as const),
            z.enum(['significant', 'moderate', 'limited', 'none'])
          ),
          details: z.string().optional(),
        })
        .optional()
        .describe('Government funding availability'),
      corporateRnD: z
        .object({
          level: z.preprocess(
            coerceToEnum(['heavy', 'moderate', 'light', 'minimal'] as const),
            z.enum(['heavy', 'moderate', 'light', 'minimal'])
          ),
          majorPlayers: z.preprocess(coerceToArray, z.array(z.string())).optional(),
        })
        .optional()
        .describe('Corporate R&D investment'),
      totalFundingLast12Months: z.string().optional().describe('Total funding in the space last 12 months'),
      notableFundingRounds: z
        .array(
          z.object({
            company: z.string(),
            amount: z.string(),
            date: z.string().optional(),
          })
        )
        .optional()
        .describe('Notable recent funding rounds'),
      mnAActivity: z
        .object({
          level: z.preprocess(
            coerceToEnum(['active', 'moderate', 'quiet'] as const),
            z.enum(['active', 'moderate', 'quiet'])
          ),
          notableDeals: z.preprocess(coerceToArray, z.array(z.string())).optional(),
        })
        .optional()
        .describe('M&A activity in the space'),
      investmentTrend: z
        .preprocess(
          coerceToEnum(['accelerating', 'stable', 'declining'] as const),
          z.enum(['accelerating', 'stable', 'declining'])
        )
        .optional()
        .describe('Overall investment trend'),
    })
    .optional(),

  // Section 10: Regulatory & Compliance
  regulatoryAndCompliance: z
    .object({
      relevantRegulations: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Current regulations affecting the technology'),
      industryStandards: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Industry standards to comply with'),
      complianceRequirements: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Compliance requirements'),
      geopoliticalConsiderations: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Geopolitical factors'),
      regulatoryTrajectory: z
        .preprocess(
          coerceToEnum(['tightening', 'stable', 'loosening', 'uncertain'] as const),
          z.enum(['tightening', 'stable', 'loosening', 'uncertain'])
        )
        .optional()
        .describe('Direction of regulatory environment'),
      upcomingRegulations: z
        .array(
          z.object({
            name: z.string(),
            expectedDate: z.string().optional(),
            impact: z.string(),
          })
        )
        .optional()
        .describe('Upcoming regulations to watch'),
    })
    .optional(),

  // Section 11: Talent & Skills
  talentAndSkills: z
    .object({
      requiredCompetencies: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('Skills needed to work with this technology'),
      talentAvailability: z
        .preprocess(
          coerceToEnum(['abundant', 'adequate', 'limited', 'scarce'] as const),
          z.enum(['abundant', 'adequate', 'limited', 'scarce'])
        )
        .optional()
        .describe('Availability of talent'),
      trainingRequirements: z
        .object({
          timeToCompetency: z.string().optional().describe('Time to train someone to competency'),
          complexity: z
            .preprocess(coerceToEnum(['high', 'medium', 'low'] as const), z.enum(['high', 'medium', 'low']))
            .optional(),
        })
        .optional()
        .describe('Training needs'),
      certifications: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Relevant certifications'),
      buildVsBuy: z
        .object({
          recommendation: z
            .preprocess(coerceToEnum(['build', 'buy', 'hybrid'] as const), z.enum(['build', 'buy', 'hybrid']))
            .optional(),
          rationale: z.string().optional(),
        })
        .optional()
        .describe('Build vs buy recommendation'),
      talentCostIndicator: z
        .preprocess(
          coerceToEnum(['premium', 'above-average', 'average', 'below-average'] as const),
          z.enum(['premium', 'above-average', 'average', 'below-average'])
        )
        .optional()
        .describe('Cost of talent'),
    })
    .optional(),

  // Section 12: Future Outlook
  futureOutlook: z
    .object({
      emergingTrends: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Emerging trends'),
      predictedDevelopments: z
        .array(
          z.object({
            timeframe: z.string(),
            prediction: z.string(),
          })
        )
        .optional()
        .describe('Predicted future developments'),
      convergenceOpportunities: z
        .array(
          z.object({
            technology: z.string(),
            opportunity: z.string(),
          })
        )
        .optional()
        .describe('Opportunities for convergence with other technologies'),
      watchSignals: z.preprocess(coerceToArray, z.array(z.string())).optional().describe('Signals to watch for'),
      disruptionPotential: z
        .preprocess(coerceToEnum(['high', 'medium', 'low'] as const), z.enum(['high', 'medium', 'low']))
        .optional()
        .describe('Potential to disrupt existing markets'),
    })
    .optional(),

  // Metadata
  metadata: z
    .object({
      sources: z
        .preprocess(coerceToArray, z.array(z.string()))
        .optional()
        .describe('URLs or descriptions of information sources'),
      confidenceScore: z
        .preprocess(coerceToNumber, z.number().min(0).max(100))
        .optional()
        .describe('Confidence in research accuracy 0-100'),
    })
    .optional(),
});

/**
 * Performs comprehensive AI research on a technology and returns data
 * matching the TechnologyResearch interface.
 *
 * Uses gemini-3.1-pro-preview with Google Search grounding for real-time data.
 *
 * @param input - Technology name, description, and optional existing data
 * @returns Promise resolving to TechnologyResearch data
 */
export async function researchTechnologyComprehensive(
  input: ComprehensiveTechnologyResearchInput
): Promise<TechnologyResearch> {
  try {
    const prompt = `You are an expert Technology Analyst, Innovation Researcher, and Market Intelligence Specialist.

TASK: Perform comprehensive research on the technology "${input.name}"${input.category ? ` (category: ${input.category})` : ''}${input.websiteUrl ? ` (website: ${input.websiteUrl})` : ''}${input.description ? `\n\nTechnology context: ${input.description}` : ''}

CRITICAL INSTRUCTIONS:
1. You MUST respond with ONLY a valid JSON object - no explanatory text
2. Research thoroughly using current, real-time information
3. Be specific and factual - avoid generic descriptions
4. If information is unavailable, omit the field rather than guessing
5. Include confidence scores based on data quality and recency

RESEARCH AREAS (provide ALL available data):

## 1. EXECUTIVE SUMMARY
- summary: Comprehensive 2-3 paragraph technology overview covering what it is, why it matters, and current state
- keyInsights: 3-5 most important insights about the technology

## 2. MATURITY ASSESSMENT
- hypeCyclePosition: One of "innovation-trigger", "peak-of-inflated-expectations", "trough-of-disillusionment", "slope-of-enlightenment", "plateau-of-productivity"
- timeToMainstream: Estimated time until mainstream adoption (e.g., "2-5 years", "<1 year")
- maturityTrajectory: One of "accelerating", "steady", "slowing", "declining"

## 3. TECHNOLOGY METRICS
- category: Primary technology category
- keyMetrics: Array of {name, value, trend (up/down/stable)} - e.g., adoption rate, performance benchmarks, market size
- milestones: Array of {date, description} - significant milestones in technology development

## 4. KEY PLAYERS
- marketLeaders: Array of {name, role, marketShare?} - companies leading in this technology
- emergingStartups: Array of {name, focus, funding?} - promising startups
- researchInstitutions: Array of {name, contribution} - academic/research contributors
- openSourceProjects: Array of {name, stars?, description} - major open source projects

## 5. USE CASES & APPLICATIONS
- byMaturity: {production: [], piloting: [], experimental: []} - use cases by maturity stage
- byIndustry: Array of {industry, useCases: []} - use cases by industry vertical
- byFunction: Array of {function, applications: []} - use cases by business function
- flagshipExamples: Array of {company, useCase, outcome?} - notable real-world implementations

## 6. TECHNICAL DEEP-DIVE
- architectureOverview: High-level architecture description
- coreComponents: Array of {name, purpose} - key architectural components
- competingParadigms: Array of {name, comparison} - alternative approaches
- integrationRequirements: Array of strings - what is needed to integrate
- standards: Array of strings - relevant standards
- protocols: Array of strings - protocols used
- interoperability: {level: high/medium/low, details: string}

## 7. VALUE ASSESSMENT
- maturityLevel: Number 1-5 (1=nascent, 5=mature)
- primaryValueDrivers: Array of strings - main sources of business value
- quantifiedBenefits: Array of {benefit, metric} - benefits with quantifiable metrics
- evidenceLevel: One of "strong", "moderate", "limited", "anecdotal"
- roiAssessable: Boolean - whether ROI can be meaningfully calculated
- typicalROI: String - typical ROI range if assessable (optional)
- timeToValue: String - time to realize value (optional)
- paybackPeriod: String - typical payback period (optional)
- roiConfidence: One of "high", "medium", "low" (optional)
- strategicValue: One of "transformational", "significant", "incremental", "marginal"
- competitiveAdvantageType: One of "differentiation", "cost-leadership", "operational-excellence", "none"

## 8. RISKS & BARRIERS
- technicalBarriers: Array of strings - technical challenges to adoption
- adoptionBarriers: Array of strings - organizational/market barriers
- implementationChallenges: Array of strings - implementation difficulties
- vendorLockInRisk: One of "high", "medium", "low"
- obsolescenceRisk: One of "high", "medium", "low"
- securityConsiderations: Array of strings - security concerns

## 9. INVESTMENT LANDSCAPE
- vcActivityLevel: One of "very-high", "high", "moderate", "low", "minimal"
- governmentFunding: {level: significant/moderate/limited/none, details?: string}
- corporateRnD: {level: heavy/moderate/light/minimal, majorPlayers?: []}
- totalFundingLast12Months: String - total funding in the space (optional)
- notableFundingRounds: Array of {company, amount, date?}
- mnAActivity: {level: active/moderate/quiet, notableDeals?: []}
- investmentTrend: One of "accelerating", "stable", "declining"

## 10. REGULATORY & COMPLIANCE
- relevantRegulations: Array of strings - current regulations
- industryStandards: Array of strings - standards to comply with
- complianceRequirements: Array of strings - compliance requirements
- geopoliticalConsiderations: Array of strings - geopolitical factors
- regulatoryTrajectory: One of "tightening", "stable", "loosening", "uncertain"
- upcomingRegulations: Array of {name, expectedDate?, impact}

## 11. TALENT & SKILLS
- requiredCompetencies: Array of strings - skills needed
- talentAvailability: One of "abundant", "adequate", "limited", "scarce"
- trainingRequirements: {timeToCompetency: string, complexity: high/medium/low}
- certifications: Array of strings - relevant certifications
- buildVsBuy: {recommendation: build/buy/hybrid, rationale: string}
- talentCostIndicator: One of "premium", "above-average", "average", "below-average"

## 12. FUTURE OUTLOOK
- emergingTrends: Array of strings - emerging trends
- predictedDevelopments: Array of {timeframe, prediction}
- convergenceOpportunities: Array of {technology, opportunity}
- watchSignals: Array of strings - signals to watch for
- disruptionPotential: One of "high", "medium", "low"

## 13. METADATA
- sources: Array of strings - URLs or descriptions of information sources
- confidenceScore: Number 0-100 - overall confidence in accuracy

EXAMPLE OUTPUT STRUCTURE:
{
  "executiveSummary": {
    "summary": "Detailed technology overview...",
    "keyInsights": ["Insight 1", "Insight 2", "Insight 3"]
  },
  "maturityAssessment": {
    "hypeCyclePosition": "slope-of-enlightenment",
    "timeToMainstream": "1-2 years",
    "maturityTrajectory": "accelerating"
  },
  "technologyMetrics": {
    "category": "Machine Learning",
    "keyMetrics": [{"name": "Adoption Rate", "value": "35% of enterprises", "trend": "up"}],
    "milestones": [{"date": "2023", "description": "Major breakthrough in performance"}]
  },
  "keyPlayers": {
    "marketLeaders": [{"name": "Company A", "role": "Platform provider", "marketShare": "25%"}],
    "emergingStartups": [{"name": "Startup B", "focus": "Enterprise applications", "funding": "$50M"}],
    "researchInstitutions": [{"name": "MIT", "contribution": "Foundational research"}],
    "openSourceProjects": [{"name": "Project X", "stars": 50000, "description": "Core implementation"}]
  },
  "valueAssessment": {
    "maturityLevel": 4,
    "primaryValueDrivers": ["Efficiency gains", "Cost reduction"],
    "quantifiedBenefits": [{"benefit": "Productivity", "metric": "30% improvement"}],
    "evidenceLevel": "strong",
    "roiAssessable": true,
    "typicalROI": "200-300%",
    "strategicValue": "significant",
    "competitiveAdvantageType": "differentiation"
  },
  "risksAndBarriers": {
    "technicalBarriers": ["Complexity", "Integration challenges"],
    "adoptionBarriers": ["Skills gap", "Change management"],
    "implementationChallenges": ["Data requirements"],
    "vendorLockInRisk": "medium",
    "obsolescenceRisk": "low",
    "securityConsiderations": ["Data privacy", "Model security"]
  },
  "futureOutlook": {
    "emergingTrends": ["Trend 1", "Trend 2"],
    "predictedDevelopments": [{"timeframe": "2024-2025", "prediction": "Mainstream enterprise adoption"}],
    "convergenceOpportunities": [{"technology": "Cloud computing", "opportunity": "Serverless ML"}],
    "watchSignals": ["Enterprise adoption metrics", "Regulatory changes"],
    "disruptionPotential": "high"
  },
  "metadata": {
    "sources": ["Gartner", "industry reports", "company websites", "news articles"],
    "confidenceScore": 85
  }
}

NOW research "${input.name}" and return ONLY the JSON object with all available data:`;

    // TEST-022: the …WithMetadata variant is what surfaces costUsd/requestId.
    // The plain call discarded both, so a research run had no visible link to
    // what it cost. Cost stays fail-closed per AI-029 — `costUsd: null` means
    // the model's pricing is unlisted and is recorded as such, never guessed.
    const {
      data: result,
      costUsd,
      requestId,
      durationMs,
      effectiveModel,
    } = await generateStructuredContentWithMetadata(prompt, TechnologyResearchSchema, {
      // Deliberate pin (enumerated in effective-model.test.ts): the stable
      // 2.5-pro tier rather than a preview for comprehensive research.
      model: comprehensiveResearchModel(),
      useGoogleSearch: true,
      temperature: 0.3,
      maxOutputTokens: 32768, // Large output for comprehensive research
    });

    // Log what sections were returned for debugging
    const populatedSections = Object.keys(result).filter(
      (key) => result[key as keyof typeof result] !== undefined && result[key as keyof typeof result] !== null
    );
    log.info(`Received ${populatedSections.length} sections from AI`, { sections: populatedSections });

    // Log a sample of the data to verify it has content
    if (result.executiveSummary) {
      log.info('Executive Summary exists', {
        hasSummary: !!result.executiveSummary.summary,
        summaryLength: result.executiveSummary.summary?.length || 0,
        keyInsightsCount: result.executiveSummary.keyInsights?.length || 0,
      });
    } else {
      log.warn('No executiveSummary in response');
    }

    // Transform to TechnologyResearch format with timestamps
    const technologyResearch: TechnologyResearch = {
      lastResearched: Date.now(),
      version: 1,
      executiveSummary: result.executiveSummary,
      maturityAssessment: result.maturityAssessment,
      technologyMetrics: result.technologyMetrics,
      keyPlayers: result.keyPlayers,
      useCasesAndApplications: result.useCasesAndApplications,
      technicalDeepDive: result.technicalDeepDive,
      valueAssessment: result.valueAssessment,
      risksAndBarriers: result.risksAndBarriers,
      investmentLandscape: result.investmentLandscape,
      regulatoryAndCompliance: result.regulatoryAndCompliance,
      talentAndSkills: result.talentAndSkills,
      futureOutlook: result.futureOutlook,
      // AI-029: record the model this flow ACTUALLY executed. It previously
      // recorded `geminiProModel()` while calling the pinned model above, so
      // the persisted metadata named a model that never ran.
      metadata: {
        sources: result.metadata?.sources ?? [],
        confidenceScore: result.metadata?.confidenceScore ?? 0,
        model: comprehensiveResearchModel(),
        // TEST-022: visible run/cost correlation. `effectiveModel` is what the
        // client actually executed; `costUsd` is omitted (with a stated
        // reason) rather than guessed when pricing is unlisted — AI-029.
        usage: {
          model: effectiveModel,
          requestId,
          ...(costUsd === null
            ? { costUnavailableReason: `No listed pricing for model ${effectiveModel}` }
            : { costUsd }),
        },
      },
    };
    log.info('Comprehensive research usage', { requestId, effectiveModel, costUsd, durationMs });

    return technologyResearch;
  } catch (error) {
    log.error('Error in comprehensive technology research', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to research technology: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Lightweight research refresh that only updates specific sections.
 * Faster and cheaper than full comprehensive research.
 */
export async function refreshTechnologyResearchSection(
  input: ComprehensiveTechnologyResearchInput,
  sections: Array<'executiveSummary' | 'maturityAssessment' | 'valueAssessment' | 'risksAndBarriers' | 'futureOutlook'>
): Promise<Partial<TechnologyResearch>> {
  // For now, delegate to full research - can be optimized later
  const fullResearch = await researchTechnologyComprehensive(input);

  // Filter to only requested sections
  const result: Partial<TechnologyResearch> = {
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
