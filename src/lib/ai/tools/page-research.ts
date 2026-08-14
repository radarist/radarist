/**
 * @file ai/tools/page-research.ts
 * @description Web page research tool for discovering companies aligned with strategies/technologies
 *
 * Enables the AI Assistant to:
 * - Scrape event pages, exhibitor lists, startup directories
 * - Extract companies and match against user-specified strategies/technologies/use cases
 * - Discover emerging technologies not currently tracked
 *
 * @author Radarist Team
 * @created 2025-12-03
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { generateContent, generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { z } from 'zod';
import { adminGetStrategyById } from '@/lib/strategies-admin';
import { adminGetTechnologies, adminGetTechnologyById } from '@/lib/technology-admin';
import { adminGetUseCaseById } from '@/lib/use-cases-admin';
import { adminGetPrototypeById } from '@/lib/prototypes-admin';
import type { Strategy } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/page-research');

// ============================================================================
// Types
// ============================================================================

export interface MatchCriteria {
  type: 'strategy' | 'technology' | 'useCase' | 'prototype';
  id: string;
  name: string;
  description?: string;
}

export interface DiscoveredCompany {
  name: string;
  description: string;
  website?: string;
  alignmentScore: number; // 0-100
  alignmentReason: string;
  technologies: string[];
  relevantProducts?: string[];
}

export interface EmergingTechnology {
  name: string;
  description: string;
  companiesUsing: number;
  companyNames: string[];
  relevanceReason: string;
  suggestedQuadrant?: string;
}

export interface PageResearchResult {
  url: string;
  pageTitle?: string;
  scannedAt: string;
  matchCriteria: MatchCriteria;
  options: {
    deepCrawl: boolean;
    maxCompanies: number;
    discoverNewTech: boolean;
  };
  totalCompaniesFound: number;
  matchedCompanies: DiscoveredCompany[];
  emergingTechnologies?: EmergingTechnology[];
  summary: string;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const PAGE_RESEARCH_TOOLS: FunctionDeclaration[] = [
  {
    name: 'researchWebPage',
    description: `Research a web page (event exhibitor list, startup directory, industry report) to discover companies aligned with a specific strategy, technology, use case, or prototype.

Use this when a user wants to:
- Scan an event page for relevant companies
- Find startups aligned with their innovation strategy
- Discover companies using specific technologies
- Identify potential partners or vendors

The tool will:
1. Scrape and analyze the provided URL
2. Extract companies mentioned on the page
3. Match each company against the specified criteria
4. Return a ranked list with alignment scores
5. Optionally discover emerging technologies not currently tracked`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: {
          type: SchemaType.STRING,
          description: 'URL of the page to research (e.g., event exhibitor page, startup list, industry report)',
        },
        matchAgainst: {
          type: SchemaType.OBJECT,
          description: 'What to match companies against',
          properties: {
            type: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: ['strategy', 'technology', 'useCase', 'prototype'],
              description: 'Type of entity to match against',
            },
            id: {
              type: SchemaType.STRING,
              description: 'ID of the entity to match against',
            },
            name: {
              type: SchemaType.STRING,
              description: 'Name of the entity (for display)',
            },
          },
          required: ['type', 'id', 'name'],
        },
        options: {
          type: SchemaType.OBJECT,
          description: 'Research options',
          properties: {
            deepCrawl: {
              type: SchemaType.BOOLEAN,
              description: 'Follow links to company detail pages for more info (default: false)',
            },
            maxCompanies: {
              type: SchemaType.NUMBER,
              description: 'Maximum companies to return (default: 20, max: 50)',
            },
            discoverNewTech: {
              type: SchemaType.BOOLEAN,
              description: 'Also discover emerging technologies not on current radar (default: true)',
            },
          },
        },
      },
      required: ['url', 'matchAgainst'],
    },
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the description/context for the entity to match against
 */
async function getMatchCriteriaContext(criteria: MatchCriteria): Promise<string> {
  try {
    switch (criteria.type) {
      case 'strategy': {
        const strategy = await adminGetStrategyById(criteria.id);
        if (strategy) {
          const directives = (strategy as Strategy).mainDirectives?.join(', ') || '';
          return `Strategy: ${strategy.name}
Description: ${strategy.description || 'No description'}
Key Directives: ${directives}`;
        }
        break;
      }
      case 'technology': {
        // Phase 3: Handle both new (tech-xxx) and legacy (radarId:techId) formats.
        // Technology shape varies by source (decoupled has quadrantName on placements,
        // legacy has quadrant name on the radar entry). Widen the type so both paths
        // can populate display context without a cast.
        const tech = await adminGetTechnologyById(criteria.id);

        if (tech) {
          return `Technology: ${tech.name}
Description: ${tech.description || 'No description'}
Tags: ${tech.tags?.join(', ') || 'None'}`;
        }
        break;
      }
      case 'useCase': {
        const useCase = await adminGetUseCaseById(criteria.id);
        if (useCase) {
          return `Use Case: ${useCase.title}
Description: ${useCase.description || 'No description'}
Category: ${useCase.category || 'Unknown'}
Status: ${useCase.status || 'Unknown'}`;
        }
        break;
      }
      case 'prototype': {
        const prototype = await adminGetPrototypeById(criteria.id);
        if (prototype) {
          return `Prototype: ${prototype.name}
Description: ${prototype.description || 'No description'}
Status: ${prototype.status || 'Unknown'}
Business Unit: ${prototype.targetBusinessUnit || 'Unknown'}`;
        }
        break;
      }
    }
  } catch (error) {
    log.error('Error fetching entities', error instanceof Error ? error : undefined, { type: criteria.type });
  }

  // Fallback to just the name
  return `${criteria.type}: ${criteria.name}`;
}

/**
 * Get all technologies for emerging tech comparison
 */
async function getExistingTechnologies(): Promise<string[]> {
  try {
    const technologies = await adminGetTechnologies();
    return technologies.map((t) => t.name.toLowerCase());
  } catch (error) {
    log.error('Error fetching technologies', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Scrape page content using Firecrawl MCP (via fetch to our API)
 * Falls back to Gemini with Google Search if Firecrawl unavailable
 */
async function scrapePageContent(
  url: string,
  deepCrawl: boolean
): Promise<{ content: string; title?: string; error?: string }> {
  log.info('Scraping URL', { url, deepCrawl });

  // Try using Gemini with Google Search grounding to research the page
  // This is more reliable than direct scraping for most use cases
  try {
    const prompt = `Research and analyze this web page: "${url}"

Please provide:
1. The page title and what the page is about
2. A comprehensive list of ALL companies, startups, or organizations mentioned on this page
3. For each company, extract:
   - Company name
   - Brief description or what they do
   - Technologies they use or provide
   - Website URL if available
   - Any products or services mentioned

Be thorough - extract EVERY company mentioned, even if just briefly.
Format the response clearly with each company on its own section.`;

    const response = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
    });

    log.debug('Scraped content length', { length: response?.length || 0 });
    log.debug('Scraped content preview', { preview: response?.substring(0, 500) || 'EMPTY' });

    return {
      content: response,
      title: `Research: ${url}`,
    };
  } catch (error) {
    log.error('Gemini scraping failed', error instanceof Error ? error : undefined);
    return {
      content: '',
      error: error instanceof Error ? error.message : 'Failed to scrape page',
    };
  }
}

// Zod schemas for structured AI output
// Using preprocess() to properly handle null/undefined values from AI responses
// The AI often returns null instead of omitting fields, which causes validation failures

// Helper: Convert null/undefined/empty to undefined for optional strings
const optionalString = z.preprocess(
  (val) => (val === null || val === undefined || val === '' ? undefined : val),
  z.string().optional()
);

// Helper: Convert null/undefined to empty array
const optionalStringArray = z.preprocess(
  (val) => (val === null || val === undefined ? [] : val),
  z.array(z.string()).default([])
);

// Helper: Convert null/undefined to default number
const optionalNumber = (defaultVal: number) =>
  z.preprocess((val) => (val === null || val === undefined ? defaultVal : val), z.number().default(defaultVal));

// Helper: Convert null/undefined to empty string for required-ish strings
const requiredString = z.preprocess((val) => (val === null || val === undefined ? '' : val), z.string());

const DiscoveredCompanySchema = z.object({
  name: z.string(),
  description: requiredString,
  website: optionalString,
  alignmentScore: z.preprocess((val) => (val === null || val === undefined ? 50 : val), z.number().min(0).max(100)),
  alignmentReason: requiredString,
  technologies: optionalStringArray,
  relevantProducts: optionalStringArray,
});

const EmergingTechnologySchema = z.object({
  name: z.string(),
  description: requiredString,
  companiesUsing: optionalNumber(0),
  companyNames: optionalStringArray,
  relevanceReason: requiredString,
  suggestedQuadrant: optionalString,
});

const PageAnalysisResultSchema = z.object({
  companies: z.preprocess(
    (val) => (val === null || val === undefined ? [] : val),
    z.array(DiscoveredCompanySchema).default([])
  ),
  emergingTechnologies: z.preprocess(
    (val) => (val === null || val === undefined ? [] : val),
    z.array(EmergingTechnologySchema).default([])
  ),
});

/**
 * Use AI to extract and match companies from page content
 */
async function analyzePageForCompanies(
  pageContent: string,
  criteriaContext: string,
  options: { maxCompanies: number; discoverNewTech: boolean },
  existingTechs: string[]
): Promise<{
  companies: DiscoveredCompany[];
  emergingTech: EmergingTechnology[];
}> {
  const techListForPrompt = existingTechs.slice(0, 50).join(', ');

  const emergingTechSection = options.discoverNewTech
    ? `
Also identify emerging technologies mentioned that are NOT in our current tracked list: [${techListForPrompt}]
For each new technology, note how many companies are using it and why it might be relevant.`
    : '';

  const prompt = `You are analyzing a web page to find companies aligned with specific criteria.

## MATCHING CRITERIA
${criteriaContext}

## PAGE CONTENT
${pageContent.substring(0, 12000)}

## YOUR TASK

1. Extract ALL companies mentioned in the content above
2. For each company, evaluate alignment with the matching criteria
3. Calculate an alignment score (0-100):
   - 90-100: Direct match, clearly aligned with criteria
   - 70-89: Strong alignment, relevant technologies/focus
   - 50-69: Moderate alignment, some overlap
   - 30-49: Weak alignment, tangential connection
   - 0-29: Low/no alignment

4. Return the top ${options.maxCompanies} most aligned companies, sorted by score

${emergingTechSection}

Return the analysis as JSON with:
- companies: array of company objects with name, description, website (if known), alignmentScore, alignmentReason, technologies, relevantProducts
- emergingTechnologies: array of new technology objects (if applicable)`;

  log.info('Starting company analysis');
  log.debug('Content length for analysis', { length: pageContent.length });

  try {
    // Use structured content generation for reliable JSON output
    const result = await generateStructuredContent(prompt, PageAnalysisResultSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    log.info('Analysis complete', { companiesFound: result.companies.length });

    return {
      companies: result.companies,
      emergingTech: options.discoverNewTech ? result.emergingTechnologies || [] : [],
    };
  } catch (error) {
    log.error('Structured analysis failed', error instanceof Error ? error : undefined);

    // Fallback: try with basic generateContent and manual parsing
    log.info('Attempting fallback with manual parsing');
    try {
      const fallbackPrompt = `${prompt}

IMPORTANT: Return ONLY valid JSON, no other text. Example format:
{"companies": [{"name": "Company", "description": "Desc", "alignmentScore": 75, "alignmentReason": "Reason", "technologies": ["Tech"]}], "emergingTechnologies": []}`;

      const response = await generateContent(fallbackPrompt, {
        model: geminiTextModel() as GeminiModel,
        temperature: 0.2,
      });

      log.debug('Fallback response length', { length: response?.length || 0 });

      // Try to parse JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(jsonStr);
        return {
          companies: parsed.companies || [],
          emergingTech: parsed.emergingTechnologies || [],
        };
      }
    } catch (fallbackError) {
      log.error('Fallback also failed', fallbackError instanceof Error ? fallbackError : undefined);
    }

    return { companies: [], emergingTech: [] };
  }
}

// ============================================================================
// Main Execution Function
// ============================================================================

export async function executeResearchWebPage(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: PageResearchResult; error?: string }> {
  const url = args.url as string;
  const matchAgainst = args.matchAgainst as MatchCriteria;
  const options = {
    deepCrawl: (args.options as Record<string, unknown>)?.deepCrawl === true,
    maxCompanies: Math.min(((args.options as Record<string, unknown>)?.maxCompanies as number) || 20, 50),
    discoverNewTech: (args.options as Record<string, unknown>)?.discoverNewTech !== false,
  };

  log.info('Starting research', { url });

  try {
    // 1. Get context for matching criteria
    const criteriaContext = await getMatchCriteriaContext(matchAgainst);
    log.debug('Criteria context');

    // 2. Get existing technologies for emerging tech detection
    const existingTechs = options.discoverNewTech ? await getExistingTechnologies() : [];

    // 3. Scrape the page content
    const {
      content: pageContent,
      title: pageTitle,
      error: scrapeError,
    } = await scrapePageContent(url, options.deepCrawl);

    if (scrapeError || !pageContent) {
      return {
        success: false,
        error: scrapeError || 'Failed to retrieve page content',
      };
    }

    // 4. Analyze page for companies and emerging tech
    const { companies, emergingTech } = await analyzePageForCompanies(
      pageContent,
      criteriaContext,
      options,
      existingTechs
    );

    // 5. Sort companies by alignment score
    const sortedCompanies = companies
      .sort((a, b) => b.alignmentScore - a.alignmentScore)
      .slice(0, options.maxCompanies);

    // 6. Generate summary
    const highlyAligned = sortedCompanies.filter((c) => c.alignmentScore >= 70);
    const moderatelyAligned = sortedCompanies.filter((c) => c.alignmentScore >= 50 && c.alignmentScore < 70);

    let summary = `Found ${sortedCompanies.length} companies on the page.`;
    if (highlyAligned.length > 0) {
      summary += ` ${highlyAligned.length} highly aligned (70%+).`;
    }
    if (moderatelyAligned.length > 0) {
      summary += ` ${moderatelyAligned.length} moderately aligned (50-69%).`;
    }
    if (options.discoverNewTech && emergingTech.length > 0) {
      summary += ` Also discovered ${emergingTech.length} emerging technologies not currently tracked.`;
    }

    const result: PageResearchResult = {
      url,
      pageTitle,
      scannedAt: new Date().toISOString(),
      matchCriteria: matchAgainst,
      options,
      totalCompaniesFound: companies.length,
      matchedCompanies: sortedCompanies,
      emergingTechnologies: options.discoverNewTech ? emergingTech : undefined,
      summary,
    };

    log.info('Research complete', { companiesFound: sortedCompanies.length, emergingTech: emergingTech.length });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    log.error('Research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Research failed',
    };
  }
}
