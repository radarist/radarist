/**
 * @file lib/ai/infographic-prompt.ts
 * @description Pure prompt assembly for gemini-image infographics. Split out of
 * image-client.ts so it carries no firebase/genai imports and can be unit-tested
 * directly. When a `brandStyle` fragment is supplied (from the mission's
 * DesignBrief), it replaces the generic palette line so the generated image
 * matches the report's brand instead of an arbitrary "professional" palette.
 */
export interface InfographicPromptInput {
  prompt: string;
  style?: 'professional' | 'minimal' | 'colorful' | 'dark';
  aspectRatio?: '1:1' | '16:9' | '4:3' | '9:16' | string;
  /** Brand palette/style fragment from the DesignBrief (e.g. exact hexes). */
  brandStyle?: string;
}

export function buildInfographicPrompt(req: InfographicPromptInput): string {
  const style = req.style ?? 'professional';
  const aspectRatio = req.aspectRatio ?? '16:9';
  return [
    `Generate a ${style} infographic (${aspectRatio} aspect ratio).`,
    `Content: ${req.prompt}`,
    req.brandStyle ?? 'Use clean typography, clear data visualization, and a professional color palette.',
    'Do NOT include any text that could be factually wrong — only visualize the data provided.',
  ].join('\n');
}
