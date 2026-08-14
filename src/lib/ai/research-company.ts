'use server';

/**
 * @file research-company.ts
 * @description AI-powered company research functionality
 *
 * Uses Gemini to research and gather information about companies
 * based on their name and optional context (website, description).
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { generateStructuredContent, type GeminiModel } from './client';
import { geminiTextModel } from './model-config';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/research-company');

// ============================================================================
// SCHEMA
// ============================================================================

const companyResearchSchema = z.object({
  summary: z.string().optional().describe('Brief 1-2 sentence summary of the company'),
  description: z.string().optional().describe('Detailed description of what the company does'),
  industry: z.array(z.string()).optional().describe('Industries the company operates in'),
  location: z
    .object({
      city: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .describe('Company headquarters location'),
  tags: z.array(z.string()).optional().describe('Relevant tags for categorization'),
  technologies: z.array(z.string()).optional().describe('Technologies the company uses or provides'),
  competitors: z.array(z.string()).optional().describe('Known competitors'),
  insights: z.array(z.string()).optional().describe('Key insights about the company'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence level of the research (0-1)'),
});

export type CompanyResearchResult = z.infer<typeof companyResearchSchema>;

// ============================================================================
// RESEARCH FUNCTION
// ============================================================================

/**
 * Research a company using AI
 *
 * @param companyName - Name of the company to research
 * @param context - Optional context like website URL or existing description
 * @returns Research results or null if research fails
 *
 * @example
 * ```ts
 * const result = await researchCompany('Anthropic', {
 *   website: 'https://anthropic.com'
 * });
 * ```
 */
export async function researchCompany(
  companyName: string,
  context?: Record<string, string>
): Promise<CompanyResearchResult | null> {
  if (!companyName.trim()) {
    return null;
  }

  const contextParts: string[] = [];
  if (context?.website) {
    contextParts.push(`Website: ${context.website}`);
  }
  if (context?.description) {
    contextParts.push(`Existing description: ${context.description}`);
  }

  const contextString = contextParts.length > 0 ? `\n\nAdditional context:\n${contextParts.join('\n')}` : '';

  const prompt = `Research the company "${companyName}" and provide structured information about it.${contextString}

You MUST respond with ONLY a valid JSON object, no other text. Do not include any explanatory text before or after the JSON.

The JSON object must follow this exact structure:
{
  "summary": "Brief 1-2 sentence summary of the company",
  "description": "Detailed description of what they do",
  "industry": ["Industry 1", "Industry 2"],
  "location": {
    "city": "City name",
    "country": "Country name"
  },
  "tags": ["tag1", "tag2"],
  "technologies": ["Tech 1", "Tech 2"],
  "competitors": ["Competitor 1", "Competitor 2"],
  "insights": ["Key insight 1", "Key insight 2"],
  "confidence": 0.85
}

Research and provide:
- summary: Brief 1-2 sentence summary
- description: Detailed description of what they do
- industry: Array of industries they operate in
- location: Object with city and country of headquarters
- tags: Array of relevant tags for categorization
- technologies: Array of technologies they use or provide
- competitors: Array of known competitors
- insights: Array of key insights (market position, recent news, unique aspects)
- confidence: Your confidence level in this research (0.0 to 1.0)

If you're not sure about a field, you may omit it. Focus on accuracy over completeness.
Use Google Search grounding to get up-to-date information.

IMPORTANT: Respond with ONLY the JSON object. No markdown, no code blocks, no explanations.`;

  try {
    const result = await generateStructuredContent(prompt, companyResearchSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
      maxOutputTokens: 2000,
    });

    return result;
  } catch (error) {
    log.error('Failed to research company', error instanceof Error ? error : undefined);
    return null;
  }
}
