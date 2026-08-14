/**
 * @file model-config.ts
 * @description Env-backed accessors for the Gemini model identifiers used across
 * the AI helper layer (`src/lib/ai/`).
 *
 * Every model string was previously hardcoded at its call site. Centralizing the
 * lookups here means a single env var can re-point the whole codebase at a newer
 * Gemini release without a code change, while preserving a sane default so the
 * prototype runs out-of-the-box.
 *
 * Reading style mirrors `src/lib/config.ts`: read the env var, fall back to a
 * default. Values are trimmed so stray whitespace in a `.env` file can't produce
 * an invalid model id.
 *
 * @created 2026-06-05
 */

/**
 * Reads an env var, returning its trimmed value or `undefined` when unset/empty.
 * An env var set to an all-whitespace string is treated as unset.
 */
function readModelEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Default Gemini text-generation model (fast/cheap tier).
 * Override with `GEMINI_TEXT_MODEL`.
 */
export function geminiTextModel(): string {
  return readModelEnv('GEMINI_TEXT_MODEL') ?? 'gemini-3.5-flash';
}

/**
 * Gemini "pro" model for hard reasoning / complex analysis.
 * Override with `GEMINI_PRO_MODEL`.
 */
export function geminiProModel(): string {
  return readModelEnv('GEMINI_PRO_MODEL') ?? 'gemini-3.1-pro-preview';
}

/**
 * Gemini model for the AI Assistant CHAT loop. Back on gemini-3.1-pro-preview.
 *
 * History: briefly switched to gemini-3.5-flash (2026-06-15) after a reasoning-only
 * head-to-head showed it ~2× faster/cheaper at equal answer quality. REVERTED the
 * same day: that benchmark did NOT exercise the agentic TOOL-LOOP, and flash regressed
 * it — it over-called tools, under-synthesized, and gave shallow answers where pro does
 * deep multi-hop synthesis. (The 400 "function response must follow a function call" was
 * a SEPARATE bug — thinkingConfig + the legacy SDK, which hit pro too; fixed by dropping
 * thinkingConfig, not by the model choice.) Override with `GEMINI_CHAT_MODEL`.
 */
export function geminiChatModel(): string {
  return readModelEnv('GEMINI_CHAT_MODEL') ?? 'gemini-3.1-pro-preview';
}

/**
 * Gemini model for COMPREHENSIVE technology research.
 * Override with `GEMINI_COMPREHENSIVE_RESEARCH_MODEL`.
 *
 * DEP-010: replaces a hardcoded `gemini-2.5-pro` pin that shuts down
 * 2026-10-16. That pin existed to keep this flow on a STABLE model — a preview
 * model's schema adherence at 32k output had been the failure mode here.
 *
 * There is no stable Gemini 3.x Pro (Google shipped Flash models on 2026-07-21;
 * no 3.5 Pro exists), so the only same-tier successor is itself a preview. The
 * shutdown is a hard deadline and takes priority, so the default moves to
 * Google's stated replacement — but it keeps its OWN env var rather than
 * following `GEMINI_PRO_MODEL`, so an operator can drop a tier without moving
 * every Pro call site. Watch structured-output adherence on this flow; if it
 * regresses, that is the known risk, not a new bug.
 */
export function geminiComprehensiveResearchModel(): string {
  return readModelEnv('GEMINI_COMPREHENSIVE_RESEARCH_MODEL') ?? 'gemini-3.1-pro-preview';
}

/**
 * Gemini model for super-graph VISION evaluation (image understanding).
 * Override with `GEMINI_VISION_MODEL`.
 *
 * DEP-010: replaces a hardcoded `gemini-2.5-flash` pin that shuts down
 * 2026-10-16. Google's stated replacement for that model is `gemini-3.6-flash`
 * at $1.50 input — five times the $0.30 this path pays today.
 * `gemini-3.5-flash-lite` is $0.30 / $2.50, exactly the price it replaces, so
 * the default takes the price-preserving option over the recommended one.
 */
export function geminiVisionModel(): string {
  return readModelEnv('GEMINI_VISION_MODEL') ?? 'gemini-3.5-flash-lite';
}

/**
 * Gemini image-generation model (Nano Banana family).
 * Override with `GEMINI_IMAGE_MODEL`.
 */
export function geminiImageModel(): string {
  return readModelEnv('GEMINI_IMAGE_MODEL') ?? 'gemini-3-pro-image';
}

/**
 * Gemini Deep Research agent model (Interactions API).
 * Override with `GEMINI_DEEP_RESEARCH_MODEL`.
 */
export function geminiDeepResearchModel(): string {
  return readModelEnv('GEMINI_DEEP_RESEARCH_MODEL') ?? 'deep-research-preview-04-2026';
}

/**
 * Gemini embedding model.
 * Override with `GEMINI_EMBEDDING_MODEL`.
 */
export function geminiEmbeddingModel(): string {
  return readModelEnv('GEMINI_EMBEDDING_MODEL') ?? 'gemini-embedding-001';
}

/**
 * Max output tokens for the AI-assistant chat completion. Default 50,000 —
 * room for full structured mission briefs and long answers (Gemini 3.x Pro
 * caps output at 65,536). Override with `GEMINI_CHAT_MAX_OUTPUT_TOKENS`.
 * Falls back to the default when the env value is missing or not a positive
 * integer.
 */
export function geminiChatMaxOutputTokens(): number {
  const raw = readModelEnv('GEMINI_CHAT_MAX_OUTPUT_TOKENS');
  if (raw === undefined) return 50000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50000;
}

/**
 * Embedding vector dimension used for Neo4j vector-index compatibility.
 * The embedding model may return a larger vector (Matryoshka truncation applies).
 * Override with `GEMINI_EMBEDDING_DIM`. Falls back to the default when the env
 * value is missing or not a positive integer.
 */
export function geminiEmbeddingDim(): number {
  const raw = readModelEnv('GEMINI_EMBEDDING_DIM');
  if (raw === undefined) return 768;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 768;
}
