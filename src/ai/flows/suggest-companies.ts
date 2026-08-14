'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('ai-suggest-companies');

/**
 * Schema for the input required to suggest companies.
 */
const _SuggestCompaniesInputSchema = z.object({
    technology: z.string(),
    description: z.string().optional(),
    count: z.number().default(5),
});

export type SuggestCompaniesInput = z.infer<typeof _SuggestCompaniesInputSchema>;

/**
 * Schema for a single suggested company.
 */
const SuggestedCompanySchema = z.object({
    name: z.string(),
    description: z.string(),
    website: z.string().optional(),
    reason: z.string(),
    type: z.string(), // Vendor, Startup, etc.
});

/**
 * Schema for the output provided by the suggest companies AI service.
 */
const SuggestCompaniesOutputSchema = z.object({
    companies: z.array(SuggestedCompanySchema),
});

export type SuggestCompaniesOutput = z.infer<typeof SuggestCompaniesOutputSchema>;

/**
 * Uses Generative AI to suggest relevant companies for a specific technology.
 * 
 * @param input - The technology name and context.
 * @returns A promise resolving to a list of suggested companies.
 * @throws {Error} If the AI generation fails or returns invalid JSON.
 */
export async function suggestCompanies(input: SuggestCompaniesInput): Promise<SuggestCompaniesOutput> {
    try {
        const prompt = `You are an expert Technology Scout.

    Task: Suggest ${input.count} companies that are relevant to the technology "${input.technology}".
    ${input.description ? `Context: "${input.description}"` : ''}

    Focus on a mix of established vendors, innovative startups, and key players in this space.

    For each company, provide:
    1.  **Name**: Company name.
    2.  **Description**: Brief one-line description.
    3.  **Website**: URL (if known).
    4.  **Reason**: Why is this company relevant to ${input.technology}?
    5.  **Type**: Vendor, Startup, Partner, Competitor, etc.

    Return JSON:
    {
      "companies": [
        {
          "name": "...",
          "description": "...",
          "website": "...",
          "reason": "...",
          "type": "..."
        }
      ]
    }
    `;

        return await generateStructuredContent(prompt, SuggestCompaniesOutputSchema, {
            model: geminiTextModel() as GeminiModel,
            useGoogleSearch: true,
        });
    } catch (error) {
        log.error("Error in suggestCompanies", error instanceof Error ? error : new Error(String(error)));
        throw new Error("Failed to suggest companies");
    }
}
