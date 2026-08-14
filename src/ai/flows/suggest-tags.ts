
'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('ai-suggest-tags');

/**
 * Schema for the input required to suggest tags for a radar entry.
 */
const _SuggestTagsInputSchema = z.object({
  quadrant: z.string(),
  content: z.string(),
});

export type SuggestTagsInput = z.infer<typeof _SuggestTagsInputSchema>;

/**
 * Schema for the output list of suggested tags.
 */
const SuggestTagsOutputSchema = z.object({
  tags: z.array(z.string()),
});

export type SuggestTagsOutput = z.infer<typeof SuggestTagsOutputSchema>;

/**
 * Analyzes the quadrant and content (description or name) of a radar entry
 * and suggests relevant tags for categorization.
 *
 * @param input - The quadrant and content of the entry.
 * @returns A promise resolving to a list of suggested tags.
 */
export async function suggestTags(input: SuggestTagsInput): Promise<SuggestTagsOutput> {
  try {
    const prompt = `You are an expert technology radar curator. Given the quadrant and content of a radar entry, you will suggest relevant tags for the entry.

    Quadrant: ${input.quadrant}
    Content: ${input.content}

    Return a JSON object with a "tags" key, containing an array of strings (max 5 tags).

    Example JSON structure:
    {
      "tags": ["tag1", "tag2"]
    }
    `;

    return await generateStructuredContent(prompt, SuggestTagsOutputSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: false,
    });
  } catch (error) {
    log.error("Error in suggestTags", error instanceof Error ? error : new Error(String(error)));
    return { tags: [] };
  }
}
