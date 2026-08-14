'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';

const log = createLogger('ai-auto-fill-entry');

/**
 * Schema for the input required to auto-fill a radar entry.
 *
 * The caller must pass the target radar's quadrant configs (id + name) so the
 * model can return a stable `quadrantId` instead of a free-form display name.
 */
const _AutoFillEntryInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  quadrantConfigs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
    })
  ),
});

export type AutoFillEntryInput = z.infer<typeof _AutoFillEntryInputSchema>;

/**
 * Schema for the output provided by the auto-fill AI service.
 *
 * `quadrantId` is the stable id the model picked from the provided configs —
 * the caller is responsible for resolving it back to a display name when
 * rendering. `quadrant` (the legacy display name) is retained as an optional
 * fallback for models that haven't adopted the ID-first surface yet.
 */
const AutoFillEntryOutputSchema = z.object({
  description: z.string(),
  quadrantId: z.string(),
  /** Legacy display name — optional, kept for backward compatibility. */
  quadrant: z.string().optional(),
  hata: z.string(),
  trl: z.string(),
  status: z.string(),
  costToPrototype: z.number(),
  tags: z.array(z.string()),
});

export type AutoFillEntryOutput = z.infer<typeof AutoFillEntryOutputSchema>;

/**
 * Uses Generative AI to analyze a technology and provide complete metadata for a Tech Radar entry.
 * This includes determining the quadrant, ring, status, and generating a description.
 *
 * @param input - The technology name and the target radar's quadrant configs.
 * @returns A promise resolving to the populated entry data.
 * @throws {Error} If the AI generation fails or returns invalid JSON.
 */
export async function autoFillEntry(input: AutoFillEntryInput): Promise<AutoFillEntryOutput> {
  try {
    const quadrantListing = input.quadrantConfigs.map((q) => `  - ${q.name} (id=${q.id})`).join('\n');

    const prompt = `You are an expert Technology Analyst.

    Task: Analyze the technology "${input.name}" and provide detailed classification data for a Tech Radar.
    ${input.description ? `User provided context: "${input.description}"` : ''}

    Available Quadrants:
${quadrantListing}

    Determine the following:
    1.  **Description**: A professional, concise description (2 sentences).
    2.  **Quadrant ID**: The id of the best-fit quadrant from the provided list (use the exact id value, e.g. "q_techniques").
    3.  **HATA (Standard Ring)**: Adopt, Trial, Assess, or Hold.
    4.  **TRL**: Technology Readiness Level (TRL 1 - TRL 9).
    5.  **Status**: Stable, Trending, New, Fading, or Warning.
    6.  **Cost to Prototype**: Estimate 0-100.
    7.  **Tags**: 3-5 relevant tags.

    Return JSON (quadrantId must match one of the ids listed above):
    {
      "description": "...",
      "quadrantId": "...",
      "hata": "...",
      "trl": "...",
      "status": "...",
      "costToPrototype": 0,
      "tags": ["..."]
    }
    `;

    return await generateStructuredContent(prompt, AutoFillEntryOutputSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
    });
  } catch (error) {
    log.error('Error in autoFillEntry', error instanceof Error ? error : new Error(String(error)));
    // Return a fallback or throw
    throw new Error('Failed to auto-fill entry');
  }
}
