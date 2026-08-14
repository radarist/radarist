
'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('ai-explore-technologies');

/**
 * Schema for the input required to explore new technologies.
 */
const _ExploreTechnologiesInputSchema = z.object({
  query: z.string(),
});

export type ExploreTechnologiesInput = z.infer<typeof _ExploreTechnologiesInputSchema>;

/**
 * Schema for a single technology suggestion.
 */
const TechnologySchema = z.object({
  name: z.string(),
  description: z.string(),
});

/**
 * Schema for the output list of discovered technologies.
 */
const ExploreTechnologiesOutputSchema = z.object({
  technologies: z.array(TechnologySchema),
});

export type ExploreTechnologiesOutput = z.infer<typeof ExploreTechnologiesOutputSchema>;

/**
 * Searches for technologies relevant to a user's query using Generative AI.
 * Returns a list of potential candidates with brief descriptions.
 *
 * @param input - The search query or topic.
 * @returns A promise resolving to a list of suggested technologies.
 */
export async function exploreTechnologies(input: ExploreTechnologiesInput): Promise<ExploreTechnologiesOutput> {
  try {
    const prompt = `You are an expert technology researcher. Based on the user's query, find and suggest relevant technologies.

    Query: ${input.query}

    Return a JSON object with a "technologies" key, containing an array of objects. Each object must have a "name" and a "description" (concise, one-sentence). Return at most 5 technologies.

    Example JSON structure:
    {
      "technologies": [
        { "name": "Tech Name", "description": "Tech description." }
      ]
    }
    `;

    return await generateStructuredContent(prompt, ExploreTechnologiesOutputSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
    });
  } catch (error) {
    log.error("Error in exploreTechnologies", error instanceof Error ? error : new Error(String(error)));
    return { technologies: [] };
  }
}
