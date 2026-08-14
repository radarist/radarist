
'use server';

import { generateContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';
import type { DeepResearchData } from '@/lib/types';

const log = createLogger('ai-deep-research');

/**
 * Schema for the input required for deep research analysis.
 */
const _DeepResearchInputSchema = z.object({
  technologyName: z.string(),
  technologyDescription: z.string(),
  strategyContext: z.string().optional(),
});

export type DeepResearchInput = z.infer<typeof _DeepResearchInputSchema>;

/**
 * Schema for the output of the deep research analysis (legacy markdown format).
 */
const _DeepResearchOutputSchema = z.object({
  analysis: z.string(),
});

export type DeepResearchOutput = z.infer<typeof _DeepResearchOutputSchema>;

/**
 * Schema for structured deep research output (Phase 0 Task 0.2.3).
 * Matches the DeepResearchData interface for persistence.
 */
const StructuredDeepResearchSchema = z.object({
  summary: z.string().describe('Executive summary of the technology (2-4 sentences)'),
  keyInsights: z.array(z.string()).describe('Key insights discovered (3-7 bullet points)'),
  competitiveLandscape: z.string().optional().describe('Analysis of competitive technologies'),
  marketAnalysis: z.string().optional().describe('Market trends and business implications'),
  technicalDetails: z.string().optional().describe('Technical architecture and implementation details'),
  sources: z.array(z.string()).describe('Source URLs used in research'),
});

export type StructuredDeepResearchOutput = DeepResearchData;

/**
 * Performs a comprehensive AI-driven analysis of a specific technology.
 * Generates a report covering overview, pros/cons, and strategic value for
 * the requesting organization, including a final recommendation.
 *
 * @param input - The technology details and optional strategic context.
 * @returns A promise resolving to the markdown-formatted analysis.
 */
export async function deepResearch(input: DeepResearchInput): Promise<DeepResearchOutput> {
  try {
    const strategySection = input.strategyContext
      ? `\n    ## Strategic Context\n    The user has provided the following strategic context for this research:\n    ${input.strategyContext}\n    Please ensure the analysis, especially the Value Proposition and Recommendation, aligns with this context.\n`
      : "";

    const prompt = `You are a world-class technology strategist for the user's organization.

    Your task is to provide a detailed analysis of the following technology:
    Technology Name: ${input.technologyName}
    Description: ${input.technologyDescription}
    ${strategySection}

    Your analysis must be in well-structured Markdown format and cover the following points. Use headings for each section.

    ## Overview
    Briefly explain what the technology is and its primary purpose.

    ## Key Features
    List 3-5 key features or capabilities in a bulleted list.

    ## Pros & Cons
    Objectively list the main advantages and disadvantages of adopting this technology in a two-column table format.

    ## Value Proposition for the Organization
    This is the most important section. Analyze how this technology could benefit the organization's strategy, operating model, customer experience, and technical architecture. Be specific and use the provided strategic context when available.

    ## Strategic Recommendation
    Conclude with a clear recommendation on whether the organization should **Adopt**, **Trial**, **Assess**, or **Hold** this technology, and provide a strong, brief justification for your recommendation.
    `;

    const text = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
    });

    return { analysis: text };
  } catch (error) {
    log.error("Error in deepResearch", error instanceof Error ? error : new Error(String(error)));
    return { analysis: "An error occurred while performing research. Please try again later." };
  }
}

/**
 * Performs structured deep research on a technology for persistence to Technology entity.
 * Returns data matching the DeepResearchData interface (Phase 0 Task 0.2.3).
 *
 * @param input - The technology details and optional strategic context.
 * @returns Structured research data ready for persistence.
 */
export async function deepResearchStructured(
  input: DeepResearchInput
): Promise<StructuredDeepResearchOutput | null> {
  try {
    const strategySection = input.strategyContext
      ? `\nStrategic Context: ${input.strategyContext}`
      : "";

    const prompt = `You are a world-class technology analyst. Analyze the following technology and return a structured JSON response.

Technology Name: ${input.technologyName}
Description: ${input.technologyDescription}${strategySection}

Return a JSON object with the following structure:
{
  "summary": "Executive summary of the technology in 2-4 sentences. Focus on what it is and why it matters.",
  "keyInsights": [
    "Key insight 1 - important finding about this technology",
    "Key insight 2 - another significant point",
    "Key insight 3 - additional relevant finding",
    // 3-7 insights total
  ],
  "competitiveLandscape": "Analysis of competitive technologies and how this compares to alternatives in the market.",
  "marketAnalysis": "Market trends, adoption rates, key players, and business implications for enterprise adoption.",
  "technicalDetails": "Technical architecture, implementation considerations, integration points, and maturity level.",
  "sources": [
    "https://example.com/source1",
    "https://example.com/source2"
    // Include real, relevant source URLs you used for research
  ]
}

Important:
- All fields except sources should be substantive paragraphs or arrays
- Include at least 3-7 key insights
- Include at least 1-3 source URLs (use real, relevant URLs)
- Focus on actionable intelligence for enterprise technology decisions
- Be objective and data-driven

Return ONLY the JSON object, no markdown formatting or explanation.`;

    const text = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
    });

    // Parse the JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.error("Could not extract JSON from response", undefined, { preview: text.substring(0, 200) });
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate with zod schema
    const validated = StructuredDeepResearchSchema.safeParse(parsed);
    if (!validated.success) {
      log.error("Invalid deep research response structure", new Error(validated.error.message));
      return null;
    }

    // Return with lastResearched timestamp
    return {
      summary: validated.data.summary,
      keyInsights: validated.data.keyInsights,
      competitiveLandscape: validated.data.competitiveLandscape,
      marketAnalysis: validated.data.marketAnalysis,
      technicalDetails: validated.data.technicalDetails,
      sources: validated.data.sources,
      lastResearched: Date.now(),
    };
  } catch (error) {
    log.error("Error in deepResearchStructured", error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
