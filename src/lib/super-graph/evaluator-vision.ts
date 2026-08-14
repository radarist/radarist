/**
 * Layer B — vision-LLM critic for the super-graph evaluator.
 *
 * Per spec §17 ("Two-layer evaluator"): once Layer A's heuristic checks
 * pass, this critic rasterizes the SVG, sends the PNG to Gemini Vision
 * with an editorial-design rubric, and returns a structured verdict. If
 * the average score is below VERDICT_PASS_THRESHOLD, the diagram is
 * sent back through the existing refine path.
 *
 * Cost: ~$0.005–0.01 per diagram. Opt-in via `PER_DIAGRAM_VISION_EVAL=1`.
 *
 * Failure mode: if the vision call fails or returns malformed output,
 * the critic returns PASS with an `error` flag. We never block a
 * Layer-A-passing diagram on a flaky vision call.
 */

import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger } from '@/lib/logger';
import { geminiVisionModel } from '@/lib/ai/model-config';
import type { DesignTokens } from './design-tokens';
import type { DiagramRenderer } from './render';

const log = createLogger('super-graph:vision-critic');

const VERDICT_PASS_THRESHOLD = 7.5;

/**
 * The model this evaluator runs on.
 *
 * DEP-010: this was a hardcoded `gemini-2.5-flash`, which shuts down
 * 2026-10-16 and had no env-override path. It now reads `geminiVisionModel()`,
 * which defaults to the price-identical `gemini-3.5-flash-lite` rather than
 * Google's recommended `gemini-3.6-flash` (5x the input cost on this path).
 */
export function visionModel(): string {
  return geminiVisionModel();
}

export const VisionRubricSchema = z.object({
  scores: z.object({
    legibility: z.number().min(1).max(10),
    hierarchy: z.number().min(1).max(10),
    whitespace: z.number().min(1).max(10),
    professionalism: z.number().min(1).max(10),
    label_clarity: z.number().min(1).max(10),
    premium_feel: z.number().min(1).max(10),
  }),
  issues: z.array(
    z.object({
      severity: z.enum(['low', 'med', 'high']),
      dimension: z.string(),
      fix: z.string(),
    })
  ),
});

export type VisionRubric = z.infer<typeof VisionRubricSchema>;

export interface VisionEvalResult {
  verdict: 'PASS' | 'REVISE';
  averageScore: number;
  rubric?: VisionRubric;
  /** Set when the vision call failed; verdict is forced to PASS. */
  error?: string;
  /** Set when the critic was skipped because the env flag was off. */
  skipped?: boolean;
}

export function isVisionCriticEnabled(): boolean {
  return process.env.PER_DIAGRAM_VISION_EVAL === '1' || process.env.PER_DIAGRAM_VISION_EVAL === 'true';
}

/**
 * Average the six scores into a single 1-10 number.
 */
export function averageRubricScore(rubric: VisionRubric): number {
  const s = rubric.scores;
  const sum = s.legibility + s.hierarchy + s.whitespace + s.professionalism + s.label_clarity + s.premium_feel;
  return sum / 6;
}

/**
 * Decide PASS / REVISE from the average score.
 */
export function verdictFromAverage(avg: number): 'PASS' | 'REVISE' {
  return avg >= VERDICT_PASS_THRESHOLD ? 'PASS' : 'REVISE';
}

const RUBRIC_PROMPT = `You are an editorial design director at a top-tier strategy consultancy (McKinsey, BCG, or Bain). You are reviewing a single chart that will go in a CTO-level strategic report.

Evaluate the chart on six dimensions, scoring each 1–10 (10 = publication-ready, 5 = passable but flawed, 1 = unusable):

1. **legibility** — every label, axis tick, and data value is readable; no clipping, no microscopic text, no overlapping text.
2. **hierarchy** — the eye knows where to go first, second, third; the most important data is the most prominent.
3. **whitespace** — neither cramped nor empty; padding and spacing feel deliberate.
4. **professionalism** — looks like it came out of a billable deck, not a spreadsheet auto-export.
5. **label_clarity** — labels are unambiguous, well-anchored to their data, and free of clutter.
6. **premium_feel** — typography, alignment, and color discipline read as editorial-grade.

Return ONLY a JSON object matching this exact schema, no prose:

{
  "scores": {
    "legibility": <1-10>,
    "hierarchy": <1-10>,
    "whitespace": <1-10>,
    "professionalism": <1-10>,
    "label_clarity": <1-10>,
    "premium_feel": <1-10>
  },
  "issues": [
    { "severity": "low" | "med" | "high", "dimension": "<one of the six>", "fix": "<one specific, mechanical fix>" }
  ]
}

If the chart is excellent and you have no concrete fixes, return an empty issues array. Issues must describe mechanical fixes only ("reduce label font 10%", "shift legend to bottom", "abbreviate longest 2 labels") — not redesigns.`;

/**
 * Strip a fenced ```json``` block from a Gemini response, if present.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Call Gemini Vision with the rasterized PNG and the rubric prompt.
 * Returns the parsed rubric, or throws if the call/parse failed.
 */
async function callVisionApi(pngBuffer: Buffer): Promise<VisionRubric> {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY) not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: visionModel() });

  const result = await model.generateContent([
    { text: RUBRIC_PROMPT },
    {
      inlineData: {
        mimeType: 'image/png',
        data: pngBuffer.toString('base64'),
      },
    },
  ]);

  const text = result.response.text();
  const stripped = stripCodeFence(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Vision response was not JSON: ${(err as Error).message}; raw='${text.slice(0, 200)}'`);
  }

  return VisionRubricSchema.parse(parsed);
}

/**
 * Run the vision critic on a rendered SVG. Returns a result envelope
 * even on failure — never throws to the caller.
 */
export async function runVisionCritic(
  svg: string,
  context: { kind: string; tokens: DesignTokens; renderer: DiagramRenderer }
): Promise<VisionEvalResult> {
  if (!isVisionCriticEnabled()) {
    return { verdict: 'PASS', averageScore: 0, skipped: true };
  }

  let pngBuffer: Buffer;
  try {
    pngBuffer = await context.renderer.rasterizeSvg(svg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('[vision-critic] rasterize failed; passing through', { kind: context.kind, error: msg });
    return { verdict: 'PASS', averageScore: 0, error: `rasterize: ${msg}` };
  }

  let rubric: VisionRubric;
  try {
    rubric = await callVisionApi(pngBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('[vision-critic] vision call failed; passing through', { kind: context.kind, error: msg });
    return { verdict: 'PASS', averageScore: 0, error: `vision: ${msg}` };
  }

  const averageScore = averageRubricScore(rubric);
  const verdict = verdictFromAverage(averageScore);
  log.info('[vision-critic] result', {
    kind: context.kind,
    averageScore: averageScore.toFixed(2),
    verdict,
    issueCount: rubric.issues.length,
  });

  return { verdict, averageScore, rubric };
}
