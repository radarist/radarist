/**
 * @file client.ts
 * @description Unified AI client abstraction layer for Google Gemini
 *
 * This module provides a clean abstraction over the Google Generative AI SDK,
 * supporting both text generation and structured output (JSON mode).
 *
 * Features:
 * - Unified interface for all AI operations
 * - Support for latest Gemini models (3-pro, 2.5-pro, 2.5-flash)
 * - Thinking mode and Google Search integration
 * - Type-safe structured output with Zod schemas
 * - **Phase 0 Reliability Layer** (retry, rate limit, circuit breaker, cost tracking)
 *
 * @author Radarist Team
 * @created 2025-11-26
 * @updated 2025-01-07 - Added reliability layer integration
 * @updated 2026-06-10 - Centralized Gemini key resolution. The sync helpers
 *   (resolveGeminiApiKey / isPlaceholderKey / MissingAIKeyError) live in
 *   `./key-resolution` — this module must keep the `'use server'` directive
 *   (client components reach it transitively via the `@/lib/ai` barrel, e.g.
 *   strategies.ts → CommandPalette), and that directive forbids exporting
 *   classes or sync functions.
 */

'use server';

import {
  GoogleGenerativeAI,
  TaskType,
  type GenerationConfig as GeminiGenerationConfig,
  type Tool as GeminiTool,
  type UsageMetadata as GeminiUsageMetadata,
} from '@google/generative-ai';
import { z } from 'zod';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSION } from './constants';
import { geminiTextModel } from './model-config';
import {
  withReliability,
  generateRequestId,
  trackCost,
  assertCostBudgetAvailable,
  type AIReliabilityConfig,
} from './reliability';
import { resolveEffectiveModel } from './effective-model';
import { resolveGeminiTestRequestOptions } from './gemini-test-endpoint';
import { assertGeminiKey, resolveGeminiApiKey, MissingAIKeyError } from './key-resolution';
import { createLogger } from '@/lib/logger';
import {
  resolveGroundingCitationIdentities,
  type GroundingCitationResolutionOptions,
} from '@/lib/signals/grounding-citations';
import { captureProviderUsage } from '@/lib/operation-context';
import { geminiUsageToReceipt } from '@/lib/operation-usage-map';

const log = createLogger('ai/client');

/**
 * Available Gemini models for text generation
 *
 * @see https://firebase.blog/posts/2025/11/gemini-3-firebase-ai-logic/
 */
export type GeminiModel =
  | 'gemini-2.5-flash' // Stable 2.5 flash — SHUTS DOWN 2026-10-16
  | 'gemini-2.5-pro' // Stable 2.5 pro — SHUTS DOWN 2026-10-16
  | 'gemini-3-flash-preview' // Gemini 3.0 flash preview (still served, no shutdown date)
  | 'gemini-3.5-flash' // Gemini 3.5 flash — default text tier (fast, cheap)
  | 'gemini-3.5-flash-lite' // Gemini 3.5 flash-lite — cheapest tier; vision-evaluator default
  | 'gemini-3.6-flash' // Gemini 3.6 flash — same input price as 3.5-flash, 16.7% cheaper output
  | 'gemini-3.1-pro-preview'; // Gemini 3.1 pro preview (most advanced, best reasoning)

/**
 * Thinking level for models that support it
 */
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';

/**
 * Configuration options for AI generation
 */
export interface GenerationConfig {
  /** Model to use for generation */
  model?: GeminiModel;
  /** Enable thinking mode (only works with thinking-enabled models) */
  thinkingLevel?: ThinkingLevel;
  /** Enable Google Search grounding */
  useGoogleSearch?: boolean;
  /**
   * @deprecated DEP-011 — Google deprecated `temperature` on 2026-07-21. It is
   * accepted and silently ignored on 3.6-era models and returns HTTP 400 in the
   * next generation, so it is no longer sent. Retained so existing call sites
   * keep compiling while they are swept; steer deliberation with `thinkingLevel`.
   */
  temperature?: number;
  /** Maximum tokens to generate */
  maxOutputTokens?: number;
  /** @deprecated DEP-011 — deprecated 2026-07-21; no longer sent. See `temperature`. */
  topP?: number;
  /** @deprecated DEP-011 — deprecated 2026-07-21; no longer sent. See `temperature`. */
  topK?: number;
  /** Reliability configuration overrides */
  reliability?: Partial<AIReliabilityConfig>;
  /** Skip reliability wrapper (for internal use only) */
  skipReliability?: boolean;
  /** Request ID for correlation (auto-generated if not provided) */
  requestId?: string;
  /**
   * AI-048 — grounding-citation identity resolution. Enabled by default on
   * `generateGroundedContent`; set `enabled: false` for callers that only count
   * citations and never persist or render their URLs, so they pay no latency.
   * `fetchImpl` is for tests — production resolution contacts only Google's
   * known redirect endpoint and never fetches the publisher destination.
   */
  citationResolution?: GroundingCitationResolutionOptions & { enabled?: boolean };
}

/**
 * Extended result type that includes reliability metadata
 */
export interface GenerationResult {
  /** The generated text content */
  text: string;
  /** Request ID for correlation */
  requestId: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Estimated cost in USD. AI-029: `null` when the model is unpriced. */
  costUsd: number | null;
  /** AI-029: the model the provider reported serving — record THIS, not the
   * requested string, so run history and cost attribution reflect reality. */
  effectiveModel: string;
  /** Number of retries used */
  retriesUsed: number;
}

// ============================================================================
// GEMINI API KEY RESOLUTION — see ./key-resolution.ts (single source of truth)
// ============================================================================
// Imported (not re-exported): `'use server'` modules may only export async
// functions, so consumers import the sync helpers from key-resolution directly.

/**
 * Gets the configured AI client instance
 */
function getAIClient(): GoogleGenerativeAI {
  const apiKey = resolveGeminiApiKey();

  if (!apiKey) {
    throw new MissingAIKeyError();
  }

  return new GoogleGenerativeAI(apiKey);
}

type GeminiModelParams = Parameters<GoogleGenerativeAI['getGenerativeModel']>[0];

/**
 * Creates a model with the guarded deterministic-provider endpoint only when
 * the shared disposable-environment contract allows it. Keep the normal path
 * as the SDK's original single-argument call so production behavior is
 * unchanged when the test seam is inactive.
 */
function getGenerativeModel(client: GoogleGenerativeAI, params: GeminiModelParams) {
  const requestOptions = resolveGeminiTestRequestOptions();
  return requestOptions === undefined
    ? client.getGenerativeModel(params)
    : client.getGenerativeModel(params, requestOptions);
}

/*
 * DEP-011 — the `thinkingLevel` → temperature/topP preset map lived here.
 *
 * Google deprecated `temperature`, `top_p` and `top_k` on 2026-07-21: they are
 * accepted and SILENTLY IGNORED on 3.6-era models, and the migration guide
 * states future generations return HTTP 400. That made this map a no-op that
 * still looked live. `thinking_level` is Google's documented replacement and is
 * already wired through `buildThinkingConfig` below, so this is a deletion, not
 * a substitution.
 */

/**
 * Concrete thinking-level values accepted by the Gemini API. `'none'` from
 * {@link ThinkingLevel} is intentionally NOT a wire value — it maps to "use the
 * model's own default thinking" (no `thinkingConfig` sent at all).
 */
type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Builds the REAL Gemini `thinkingConfig` for a given model + level.
 *
 * The legacy `@google/generative-ai` SDK forwards the whole `generationConfig`
 * object to the REST API without a field whitelist, so `thinkingConfig` reaches
 * the API (same mechanism `image-client.ts` uses for `responseModalities`).
 *
 * Mapping:
 * - `level === 'none'` → `undefined`: do NOT force a level; let the model use
 *   its own default thinking budget (we don't want to reduce the default).
 * - `model` starts with `'gemini-3'` → `{ thinkingLevel: level }`. Gemini 3
 *   models accept `thinkingLevel` of `'low' | 'medium' | 'high'` (and
 *   `'minimal'`). For non-`'none'` levels the value is already a valid Gemini-3
 *   thinking level.
 * - otherwise (e.g. `gemini-2.5-*`) → `undefined`: those models use
 *   `thinkingBudget`, NOT `thinkingLevel` — sending `thinkingLevel` risks a 400,
 *   so we omit it entirely.
 *
 * @see https://ai.google.dev/gemini-api/docs/thinking
 */
function buildThinkingConfig(model: string, level: ThinkingLevel): { thinkingLevel: GeminiThinkingLevel } | undefined {
  if (level === 'none') {
    return undefined;
  }

  if (model.startsWith('gemini-3')) {
    // level is narrowed to 'low' | 'medium' | 'high' here — all valid Gemini-3 values.
    return { thinkingLevel: level };
  }

  // Gemini 2.5 (and anything else) does not accept thinkingLevel → avoid a 400.
  return undefined;
}

/**
 * Async accessor for {@link buildThinkingConfig}.
 *
 * Kept async for call-site compatibility (this module was historically a
 * `'use server'` file, which only allowed async exports). Exposes the
 * (otherwise internal) thinking mapping for callers/tests that want to resolve
 * the wire-level `thinkingConfig` a given model + level would produce, without
 * duplicating the mapping logic.
 */
export async function resolveThinkingConfig(
  model: string,
  level: ThinkingLevel
): Promise<{ thinkingLevel: GeminiThinkingLevel } | undefined> {
  return buildThinkingConfig(model, level);
}

/**
 * Typed shape of a generationConfig augmented with the real Gemini thinkingConfig.
 * The legacy SDK type {@link GeminiGenerationConfig} predates `thinkingConfig`,
 * so we extend it with a typed intersection rather than casting through `any`.
 */
type GenerationConfigWithThinking = GeminiGenerationConfig & {
  thinkingConfig?: { thinkingLevel: GeminiThinkingLevel };
};

/**
 * The legacy SDK's {@link GeminiUsageMetadata} type predates the thinking API
 * and omits `thoughtsTokenCount`, but the REST response includes it for
 * thinking-enabled models. We widen the type with the optional field rather than
 * casting through `any`.
 */
type UsageMetadataWithThoughts = GeminiUsageMetadata & { thoughtsTokenCount?: number };

/**
 * Extracts thinking-token count from usage metadata, defaulting to 0.
 * Thinking tokens are billed as output, so callers ADD this to outputTokens.
 */
function extractThoughtsTokens(usageMetadata: UsageMetadataWithThoughts | undefined): number {
  return usageMetadata?.thoughtsTokenCount ?? 0;
}

/**
 * Internal function to generate content without reliability wrapper
 * Used by the reliability layer to avoid circular wrapping
 */
/** A web source Gemini grounded on, from `groundingMetadata.groundingChunks`. */
export interface GroundingCitation {
  uri: string;
  title?: string;
  /**
   * AI-048 — publisher URL recovered from a Google grounding redirect. Used for
   * identity, citation display, and durable evidence; `uri` stays the
   * provider-supplied navigation URL. Absent when `uri` was already a publisher
   * URL, when resolution was disabled, or when resolution did not succeed.
   *
   * Structurally identical to `SignalGroundingCitation.identityUri`, so the
   * shared resolver accepts either shape.
   */
  identityUri?: string;
  /**
   * AI-048 — the answer text segments this source supports, read from
   * `groundingMetadata.groundingSupports`. This is what upgrades a grounded
   * result from document-level citation ("these pages were consulted") to
   * claim-level provenance ("this sentence came from this page"), and is what
   * fills `EvidenceRef.snippet`. Absent when the provider sent no supports, or
   * when every support for this source was malformed.
   */
  supportedSegments?: string[];
}

/** Cap on the segment text one source may accumulate, so a chatty grounded
 * answer cannot produce an unbounded evidence snippet. */
const MAX_SEGMENT_CHARS_PER_CITATION = 2_000;

/** Structural shape of one `groundingSupports` entry (the SDK does not type it). */
interface RawGroundingSupport {
  segment?: { text?: unknown };
  groundingChunkIndices?: unknown;
}

/**
 * AI-048 — attach each answer segment to the sources that support it.
 *
 * `groundingChunkIndices` index into the RAW `groundingChunks` array, but
 * citations are deduped by URI and skip chunks with no URI, so the two arrays
 * do NOT share indices. `chunkIndexToCitation` carries that correspondence;
 * mapping through it is the difference between claim-level provenance and
 * attributing a claim to a source that never made it.
 *
 * Every malformed support fails closed — dropped individually, so one bad entry
 * can never discard a well-formed one.
 */
function attachSupportedSegments(
  citations: GroundingCitation[],
  chunkIndexToCitation: Map<number, GroundingCitation>,
  supports: unknown
): void {
  if (!Array.isArray(supports)) return;

  const accumulated = new Map<GroundingCitation, { segments: string[]; chars: number }>();

  for (const raw of supports as RawGroundingSupport[]) {
    const text = raw?.segment?.text;
    if (typeof text !== 'string' || !text.trim()) continue;

    const indices = raw?.groundingChunkIndices;
    if (!Array.isArray(indices)) continue;

    for (const index of indices) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
      const citation = chunkIndexToCitation.get(index);
      if (!citation) continue;

      const bucket = accumulated.get(citation) ?? { segments: [], chars: 0 };
      if (bucket.chars + text.length > MAX_SEGMENT_CHARS_PER_CITATION) continue;
      bucket.segments.push(text);
      bucket.chars += text.length;
      accumulated.set(citation, bucket);
    }
  }

  for (const citation of citations) {
    const bucket = accumulated.get(citation);
    if (bucket && bucket.segments.length > 0) citation.supportedSegments = bucket.segments;
  }
}

/**
 * Phase 2.1 (Part D) — extract the real web sources Gemini grounded on. When
 * `useGoogleSearch` is on, the response carries `candidates[0].groundingMetadata
 * .groundingChunks[].web.{uri,title}`; the legacy SDK types don't expose it, so
 * we cast defensively and dedupe by URI. Returns [] when grounding produced no
 * sources (so the caller can honestly say "no sources found").
 *
 * AI-048 — also reads `groundingSupports` to attach the answer segments each
 * source supports (see `attachSupportedSegments`).
 */
function extractGroundingCitations(response: unknown): GroundingCitation[] {
  try {
    const candidates = (
      response as {
        candidates?: Array<{
          groundingMetadata?: {
            groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
            groundingSupports?: unknown;
          };
        }>;
      }
    ).candidates;
    const groundingMetadata = candidates?.[0]?.groundingMetadata;
    const chunks = groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];
    const out: GroundingCitation[] = [];
    const seen = new Map<string, GroundingCitation>();
    // Raw chunk index → the citation it folded into. Duplicate URIs map to the
    // SAME citation, and chunks with no URI map to nothing at all.
    const chunkIndexToCitation = new Map<number, GroundingCitation>();
    for (const [chunkIndex, c] of chunks.entries()) {
      const uri = c?.web?.uri;
      if (!uri) continue;
      const existing = seen.get(uri);
      if (existing) {
        chunkIndexToCitation.set(chunkIndex, existing);
        continue;
      }
      const citation: GroundingCitation = { uri, title: c.web?.title };
      seen.set(uri, citation);
      chunkIndexToCitation.set(chunkIndex, citation);
      out.push(citation);
    }
    attachSupportedSegments(out, chunkIndexToCitation, groundingMetadata?.groundingSupports);
    return out;
  } catch {
    return [];
  }
}

/**
 * ARUN-022 — the number of web-search queries Gemini billed for a grounded
 * response, from `candidates[0].groundingMetadata.webSearchQueries` (the billed
 * grounding surcharge is per query, distinct from the citation chunks). Returns
 * 0 when grounding produced no queries or the field is absent.
 */
function extractGroundingQueryCount(response: unknown): number {
  try {
    const queries = (
      response as {
        candidates?: Array<{ groundingMetadata?: { webSearchQueries?: unknown } }>;
      }
    ).candidates?.[0]?.groundingMetadata?.webSearchQueries;
    return Array.isArray(queries) ? queries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * ARUN-022 — capture one Gemini text/grounded response into the ambient
 * operation-usage sink. A strict no-op when no boundary opened a sink, and never
 * throws into the generation path. `requestedModel` is what we asked for; the
 * provider's served model is read from `response.modelVersion` when the receipt
 * is built, so `model` / `requestedModel` provenance stays honest.
 */
function captureGeminiProviderUsage(
  response: unknown,
  usageMetadata: UsageMetadataWithThoughts | undefined,
  requestedModel: string,
  operation: string,
  useGoogleSearch: boolean
): void {
  // Structurally non-fatal: usage capture must NEVER break generation, so the
  // whole mapping + capture is guarded (captureProviderUsage already swallows a
  // throwing sink; this also covers any mapper edge case).
  try {
    const { counters, usageCompleteness } = geminiUsageToReceipt(usageMetadata, {
      groundingQueryCount: useGoogleSearch ? extractGroundingQueryCount(response) : 0,
    });
    // A grounded request owes a Google Search fee whose exact per-request charge
    // is free-tier-windowed and NOT reported per response — record it as
    // applicable-but-unknown so it is never read as $0. This holds whenever
    // grounding was REQUESTED, even if the provider reported no query count (an
    // absent query count is unknown grounding, not "no fee").
    const feeState = useGoogleSearch ? 'applicable-but-unknown' : 'none';
    captureProviderUsage({
      provider: 'gemini',
      operation,
      requestedModel,
      providerModel: (response as { modelVersion?: unknown }).modelVersion,
      counters,
      usageCompleteness,
      occurredAt: new Date().toISOString(),
      feeState,
    });
  } catch (captureError) {
    log.debug('operation-usage capture skipped (non-fatal)', {
      operation,
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
  }
}

async function generateContentInternal(
  prompt: string,
  config: GenerationConfig = {}
): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  citations: GroundingCitation[];
  /** AI-029: the model the provider reports having served this request. */
  effectiveModel: string;
}> {
  const client = getAIClient();

  const {
    model = geminiTextModel() as GeminiModel,
    thinkingLevel = 'none',
    useGoogleSearch = false,
    maxOutputTokens,
  } = config;

  // DEP-011: no temperature/topP/topK — deprecated 2026-07-21, ignored today and
  // an HTTP 400 in the next model generation. Deliberation is steered by
  // thinkingConfig below.
  const generationConfig: GeminiGenerationConfig = {
    maxOutputTokens: maxOutputTokens ?? 8192,
  };

  // ...plus the REAL Gemini thinkingConfig (only attached when the model supports it).
  const tc = buildThinkingConfig(model, thinkingLevel);
  const genCfg: GenerationConfigWithThinking = {
    ...generationConfig,
    ...(tc ? { thinkingConfig: tc } : {}),
  };

  // Configure tools (Google Search if enabled)
  const tools: GeminiTool[] = [];
  if (useGoogleSearch) {
    tools.push({ googleSearch: {} } as GeminiTool);
  }

  const generativeModel = getGenerativeModel(client, {
    model,
    generationConfig: genCfg,
    ...(tools.length > 0 && { tools }),
  });

  const result = await generativeModel.generateContent(prompt);
  const response = await result.response;

  // Extract token usage from response metadata.
  // Thinking tokens (`thoughtsTokenCount`) are billed as output, so fold them in.
  const usageMetadata = response.usageMetadata;
  const inputTokens = usageMetadata?.promptTokenCount ?? Math.ceil(prompt.length / 4);
  const thoughtsTokens = extractThoughtsTokens(usageMetadata);
  const outputTokens = (usageMetadata?.candidatesTokenCount ?? Math.ceil(response.text().length / 4)) + thoughtsTokens;

  if (thoughtsTokens > 0) {
    log.debug('Gemini thinking tokens consumed', { model, thinkingLevel, thoughtsTokens });
  }

  // ARUN-022 — capture this provider response into the ambient operation-usage
  // sink (a no-op when no boundary opened one). Uses the RAW usageMetadata so the
  // receipt keeps thinking / cached-input tiers distinct, unlike the cost path
  // above which folds thinking into output.
  captureGeminiProviderUsage(
    response,
    usageMetadata,
    model,
    useGoogleSearch ? 'gemini.grounded-generate' : 'gemini.generate-content',
    useGoogleSearch
  );

  return {
    text: response.text(),
    inputTokens,
    outputTokens,
    citations: useGoogleSearch ? extractGroundingCitations(response) : [],
    // AI-029: prefer what the provider says it ran over what we asked for —
    // an alias or preview id can route to a different concrete model, and
    // recording the request as the response makes run history and per-model
    // cost attribution quietly wrong.
    effectiveModel: resolveEffectiveModel(model, (response as { modelVersion?: unknown }).modelVersion),
  };
}

/**
 * Generates text content using Google Gemini
 *
 * @param prompt - The text prompt to send to the model
 * @param config - Optional generation configuration
 * @returns Generated text response
 *
 * @example
 * ```typescript
 * const response = await generateContent(
 *   'Explain quantum computing in simple terms',
 *   { model: 'gemini-1.5-pro', temperature: 0.7 }
 * );
 * console.log(response);
 * ```
 */
export async function generateContent(prompt: string, config: GenerationConfig = {}): Promise<string> {
  const { model = geminiTextModel() as GeminiModel, skipReliability, reliability, requestId } = config;

  // Keyless guard BEFORE the reliability wrapper — a missing/placeholder key
  // must never trip the circuit breaker or consume rate-limit tokens.
  assertGeminiKey();

  // Skip reliability for internal calls or when explicitly disabled
  if (skipReliability) {
    assertCostBudgetAvailable();
    const result = await generateContentInternal(prompt, config);
    trackCost(result.effectiveModel, result.inputTokens, result.outputTokens);
    return result.text;
  }

  try {
    const reliabilityResult = await withReliability(
      async () => {
        const result = await generateContentInternal(prompt, config);
        return {
          result: result.text,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          effectiveModel: result.effectiveModel,
        };
      },
      {
        requestId: requestId || generateRequestId(),
        model,
        operation: 'generate',
        config: reliability,
        metadata: {
          promptLength: prompt.length,
          hasGoogleSearch: config.useGoogleSearch ?? false,
        },
      }
    );

    return reliabilityResult.data;
  } catch (error) {
    // Re-throw with more context
    throw new Error(`Failed to generate content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Phase 2.1 (Part D) — Google-Search-grounded generation that ALSO returns the
 * real web sources Gemini grounded on (so callers can cite/verify, instead of
 * discarding them like plain `generateContent` does). Always forces
 * `useGoogleSearch: true`. Returns `{ text, citations }`; `citations` is `[]`
 * when grounding produced no sources.
 */
export async function generateGroundedContent(
  prompt: string,
  config: GenerationConfig = {}
): Promise<{ text: string; citations: GroundingCitation[] }> {
  const groundedConfig: GenerationConfig = { ...config, useGoogleSearch: true };
  const { model = geminiTextModel() as GeminiModel, skipReliability, reliability, requestId } = config;

  assertGeminiKey();

  if (skipReliability) {
    assertCostBudgetAvailable();
    const r = await generateContentInternal(prompt, groundedConfig);
    trackCost(r.effectiveModel, r.inputTokens, r.outputTokens);
    return { text: r.text, citations: await resolveCitationIdentities(r.citations, config) };
  }

  const reliabilityResult = await withReliability(
    async () => {
      const r = await generateContentInternal(prompt, groundedConfig);
      return {
        result: { text: r.text, citations: r.citations },
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        effectiveModel: r.effectiveModel,
      };
    },
    {
      requestId: requestId || generateRequestId(),
      model,
      operation: 'generate',
      config: reliability,
      metadata: { promptLength: prompt.length, hasGoogleSearch: true },
    }
  );

  // Resolved OUTSIDE the reliability wrapper: identity resolution is a pure
  // read over the final citation set, so a retry of the generation must not
  // re-run it, and a resolution result must not be discarded by one.
  return {
    text: reliabilityResult.data.text,
    citations: await resolveCitationIdentities(reliabilityResult.data.citations, config),
  };
}

/**
 * AI-048 — recover publisher identities for a grounded response's citations.
 *
 * Gemini returns opaque `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
 * URLs, never publisher URLs. Those redirects EXPIRE, so a stored citation rots
 * into a dead link, a title-less citation renders as an opaque string, and two
 * redirects aliasing one article look like two independent sources (GRAPH-070).
 *
 * Resolution is best-effort and never fatal: the shared resolver contacts only
 * Google's known redirect endpoint, never the publisher destination, and caps
 * itself at 20 citations / 2 hops / 3s. A failure leaves the citation
 * unresolved, which every downstream reader already treats as inconclusive.
 */
async function resolveCitationIdentities(
  citations: GroundingCitation[],
  config: GenerationConfig
): Promise<GroundingCitation[]> {
  const { enabled = true, ...resolutionOptions } = config.citationResolution ?? {};
  if (!enabled || citations.length === 0) return citations;

  try {
    return await resolveGroundingCitationIdentities(citations, resolutionOptions);
  } catch (error) {
    log.warn('grounding citation identity resolution failed; citations stay unresolved', {
      error: error instanceof Error ? error.message : String(error),
      citationCount: citations.length,
    });
    return citations;
  }
}

/**
 * Generates text content with full reliability metadata
 *
 * @param prompt - The text prompt to send to the model
 * @param config - Optional generation configuration
 * @returns Generated text response with metadata
 */
export async function generateContentWithMetadata(
  prompt: string,
  config: GenerationConfig = {}
): Promise<GenerationResult> {
  const { model = geminiTextModel() as GeminiModel, reliability, requestId } = config;

  // Keyless guard BEFORE the reliability wrapper (see generateContent).
  assertGeminiKey();

  const reliabilityResult = await withReliability(
    async () => {
      const result = await generateContentInternal(prompt, config);
      return {
        result: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        effectiveModel: result.effectiveModel,
      };
    },
    {
      requestId: requestId || generateRequestId(),
      model,
      operation: 'generate',
      config: reliability,
      metadata: {
        promptLength: prompt.length,
        hasGoogleSearch: config.useGoogleSearch ?? false,
      },
    }
  );

  return {
    text: reliabilityResult.data,
    requestId: reliabilityResult.requestId,
    durationMs: reliabilityResult.durationMs,
    costUsd: reliabilityResult.costUsd,
    effectiveModel: reliabilityResult.effectiveModel,
    retriesUsed: reliabilityResult.retriesUsed,
  };
}

/**
 * Internal function to generate structured content without reliability wrapper
 */
async function generateStructuredContentInternal<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: GenerationConfig = {}
): Promise<{ data: z.infer<T>; inputTokens: number; outputTokens: number; effectiveModel: string }> {
  const client = getAIClient();

  const {
    model = geminiTextModel() as GeminiModel,
    thinkingLevel = 'none',
    useGoogleSearch = false,
    maxOutputTokens,
  } = config;

  // Configure tools (Google Search if enabled)
  const tools: GeminiTool[] = [];
  if (useGoogleSearch) {
    tools.push({ googleSearch: {} } as GeminiTool);
  }

  // Build generation config
  // NOTE: Cannot use responseMimeType with tools, so only set it when no tools are used
  // When using Google Search, increase maxOutputTokens to avoid truncation
  // DEP-011: no temperature/topP/topK — see the note above buildThinkingConfig.
  const defaultMaxTokens = useGoogleSearch ? 16384 : 8192; // More tokens for Google Search
  const generationConfig: GeminiGenerationConfig = {
    maxOutputTokens: maxOutputTokens ?? defaultMaxTokens,
    ...(tools.length === 0 && { responseMimeType: 'application/json' }),
  };

  // Attach the REAL Gemini thinkingConfig (only when the model supports it).
  const tc = buildThinkingConfig(model, thinkingLevel);
  const genCfg: GenerationConfigWithThinking = {
    ...generationConfig,
    ...(tc ? { thinkingConfig: tc } : {}),
  };

  const generativeModel = getGenerativeModel(client, {
    model,
    generationConfig: genCfg,
    ...(tools.length > 0 && { tools }),
  });

  const result = await generativeModel.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  // Extract token usage. Thinking tokens (`thoughtsTokenCount`) are billed as output.
  const usageMetadata = response.usageMetadata;
  const inputTokens = usageMetadata?.promptTokenCount ?? Math.ceil(prompt.length / 4);
  const thoughtsTokens = extractThoughtsTokens(usageMetadata);
  const outputTokens = (usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4)) + thoughtsTokens;

  if (thoughtsTokens > 0) {
    log.debug('Gemini thinking tokens consumed', { model, thinkingLevel, thoughtsTokens });
  }

  // ARUN-022 — capture the provider response BEFORE parsing: the model was
  // billed even if the JSON below fails to parse or validate, so the spend must
  // still reach the ledger. No-op when no operation-usage sink is active.
  captureGeminiProviderUsage(
    response,
    usageMetadata,
    model,
    useGoogleSearch ? 'gemini.grounded-structured' : 'gemini.generate-structured',
    useGoogleSearch
  );

  // Clean and parse JSON with retries
  let parsed;
  let parseAttempt = 0;
  const parseErrors: string[] = [];

  // Attempt 1: Basic cleaning
  try {
    parseAttempt = 1;
    const cleanedText = cleanJSON(text);
    parsed = JSON.parse(cleanedText);
  } catch (parseError) {
    parseErrors.push(`Attempt ${parseAttempt}: ${parseError instanceof Error ? parseError.message : 'Invalid JSON'}`);

    // Attempt 2: Aggressive cleaning (fix unterminated strings, balance brackets)
    try {
      parseAttempt = 2;
      const aggressivelyCleaned = cleanJSON(text, true);
      parsed = JSON.parse(aggressivelyCleaned);
    } catch (retryError) {
      parseErrors.push(`Attempt ${parseAttempt}: ${retryError instanceof Error ? retryError.message : 'Invalid JSON'}`);

      // Log debug info for troubleshooting
      log.error('JSON parsing failed after all attempts');
      log.error('Parse errors', undefined, { parseErrors });
      log.error('Raw response length', undefined, { length: text.length });
      log.error('Raw response preview (first 500 chars)', undefined, { preview: text.substring(0, 500) });
      log.error('Raw response preview (last 200 chars)', undefined, {
        preview: text.substring(Math.max(0, text.length - 200)),
      });

      throw new Error(`Failed to parse JSON response: ${parseErrors.join('; ')}`);
    }
  }

  // Transform null values to undefined for Zod compatibility
  // AI models often return null for optional fields, but Zod's .optional() only accepts undefined
  const transformed = transformNullToUndefined(parsed);

  // Validate against schema with helpful error messages
  try {
    return {
      data: schema.parse(transformed),
      inputTokens,
      outputTokens,
      effectiveModel: resolveEffectiveModel(model, (response as { modelVersion?: unknown }).modelVersion),
    };
  } catch (validationError) {
    if (validationError instanceof z.ZodError) {
      const issues = validationError.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      log.error('Schema validation failed', undefined, { issues });
      throw new Error(`Schema validation failed: ${issues}`);
    }
    throw validationError;
  }
}

/**
 * Generates structured output validated against a Zod schema
 *
 * @param prompt - The text prompt to send to the model
 * @param schema - Zod schema for validating the output
 * @param config - Optional generation configuration
 * @returns Parsed and validated structured output
 *
 * @example
 * ```typescript
 * const CompanySchema = z.object({
 *   name: z.string(),
 *   industry: z.array(z.string()),
 *   founded: z.number(),
 * });
 *
 * const company = await generateStructuredContent(
 *   'Research Tesla, Inc.',
 *   CompanySchema,
 *   { model: 'gemini-1.5-pro', useGoogleSearch: true }
 * );
 * console.log(company.name); // Type-safe access
 * ```
 */
export async function generateStructuredContent<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: GenerationConfig = {}
): Promise<z.infer<T>> {
  const { model = geminiTextModel() as GeminiModel, skipReliability, reliability, requestId } = config;

  // Keyless guard BEFORE the reliability wrapper (see generateContent).
  assertGeminiKey();

  // Skip reliability for internal calls or when explicitly disabled
  if (skipReliability) {
    assertCostBudgetAvailable();
    const result = await generateStructuredContentInternal(prompt, schema, config);
    trackCost(result.effectiveModel, result.inputTokens, result.outputTokens);
    return result.data;
  }

  try {
    const reliabilityResult = await withReliability(
      async () => {
        const result = await generateStructuredContentInternal(prompt, schema, config);
        return {
          result: result.data,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          effectiveModel: result.effectiveModel,
        };
      },
      {
        requestId: requestId || generateRequestId(),
        model,
        operation: 'structured',
        config: reliability,
        metadata: {
          promptLength: prompt.length,
          hasGoogleSearch: config.useGoogleSearch ?? false,
          schemaKeys: Object.keys((schema as { shape?: Record<string, unknown> })?.shape || {}),
        },
      }
    );

    return reliabilityResult.data;
  } catch (error) {
    throw new Error(
      `Failed to generate structured content: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * MISSION-005: structured generation that also returns the reliability
 * layer's cost accounting, so auxiliary mission helpers (judge, fact-check)
 * can fold their real Gemini spend into the mission's cost record instead of
 * spending invisibly. Mirrors `generateContentWithMetadata`.
 */
export async function generateStructuredContentWithMetadata<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: GenerationConfig = {}
): Promise<{
  data: z.infer<T>;
  costUsd: number | null;
  requestId: string;
  durationMs: number;
  effectiveModel: string;
}> {
  const { model = geminiTextModel() as GeminiModel, reliability, requestId, skipReliability } = config;

  // Keyless guard BEFORE the reliability wrapper (see generateContent).
  assertGeminiKey();

  // skipReliability callers (fact-check extraction/verdict — deliberately
  // outside the breaker) still get honest cost accounting: compute from the
  // internal call's token counts via the same tracker the reliability layer
  // uses. These calls were previously untracked entirely.
  if (skipReliability) {
    assertCostBudgetAvailable();
    const started = Date.now();
    const internal = await generateStructuredContentInternal(prompt, schema, config);
    return {
      data: internal.data,
      costUsd: trackCost(internal.effectiveModel, internal.inputTokens, internal.outputTokens),
      requestId: requestId || generateRequestId(),
      durationMs: Date.now() - started,
      effectiveModel: internal.effectiveModel,
    };
  }

  const reliabilityResult = await withReliability(
    async () => {
      const result = await generateStructuredContentInternal(prompt, schema, config);
      return {
        result: result.data,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        effectiveModel: result.effectiveModel,
      };
    },
    {
      requestId: requestId || generateRequestId(),
      model,
      operation: 'structured',
      config: reliability,
      metadata: {
        promptLength: prompt.length,
        hasGoogleSearch: config.useGoogleSearch ?? false,
        schemaKeys: Object.keys((schema as { shape?: Record<string, unknown> })?.shape || {}),
      },
    }
  );

  return {
    data: reliabilityResult.data,
    costUsd: reliabilityResult.costUsd,
    requestId: reliabilityResult.requestId,
    durationMs: reliabilityResult.durationMs,
    effectiveModel: reliabilityResult.effectiveModel,
  };
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

/**
 * Configuration for embedding generation
 */
export interface EmbeddingConfig {
  /** Model to use for embedding (default: gemini-embedding-001) */
  model?: string;
  /** Task type for the embedding (retrieval_document, retrieval_query, etc.) */
  taskType?: TaskType;
  /** Request ID for correlation */
  requestId?: string;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingResult {
  /** The embedding vector */
  embedding: number[];
  /** Model used */
  model: string;
  /** Request ID for correlation */
  requestId: string;
}

/**
 * Generates an embedding vector for a single text input
 *
 * @param text - The text to embed
 * @param config - Optional embedding configuration
 * @returns Embedding vector (768 dimensions, truncated from gemini-embedding-001)
 *
 * @example
 * ```typescript
 * const embedding = await generateEmbedding('How does quantum computing work?');
 * console.log(embedding.length); // 768
 * ```
 */
export async function generateEmbedding(text: string, config: EmbeddingConfig = {}): Promise<number[]> {
  const client = getAIClient();
  const { model = DEFAULT_EMBEDDING_MODEL, taskType = TaskType.RETRIEVAL_DOCUMENT } = config;

  const generativeModel = getGenerativeModel(client, { model });

  const result = await generativeModel.embedContent({
    content: { parts: [{ text }], role: 'user' },
    taskType,
  });

  // ARUN-022 — capture the embedding call. The legacy SDK surfaces no per-call
  // usage, so this is honestly an `unreported`-usage receipt (provider + model +
  // the fact of the call under the active correlation); if a future SDK returns
  // `usageMetadata` it is mapped through the same path. No-op without a sink.
  captureGeminiProviderUsage(
    result,
    (result as { usageMetadata?: UsageMetadataWithThoughts }).usageMetadata,
    model,
    'gemini.generate-embedding',
    false
  );

  const values = result.embedding.values;
  // Truncate to EMBEDDING_DIMENSION for Neo4j vector index compatibility
  // (gemini-embedding-001 returns 3072 dims by default; Matryoshka truncation to 768 is valid)
  return values.length > EMBEDDING_DIMENSION ? values.slice(0, EMBEDDING_DIMENSION) : values;
}

/**
 * Generates an embedding vector with full metadata
 *
 * @param text - The text to embed
 * @param config - Optional embedding configuration
 * @returns Embedding result with metadata
 */
export async function generateEmbeddingWithMetadata(
  text: string,
  config: EmbeddingConfig = {}
): Promise<EmbeddingResult> {
  const { model = DEFAULT_EMBEDDING_MODEL, requestId } = config;

  const embedding = await generateEmbedding(text, config);

  return {
    embedding,
    model,
    requestId: requestId || generateRequestId(),
  };
}

/**
 * Configuration for batch embedding generation
 */
export interface BatchEmbeddingConfig extends EmbeddingConfig {
  /** Maximum concurrent requests (default: 5) */
  concurrency?: number;
  /** Delay between batches in ms (default: 100) */
  batchDelayMs?: number;
  /** Maximum retries per text (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseRetryDelayMs?: number;
  /** Callback for progress updates */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Result of batch embedding generation
 */
export interface BatchEmbeddingResult {
  /** Successfully generated embeddings (index -> embedding) */
  embeddings: Map<number, number[]>;
  /** Failed indices with error messages */
  failures: Map<number, string>;
  /** Model used */
  model: string;
  /** Total processing time in ms */
  durationMs: number;
}

/**
 * Generates embeddings for multiple texts with rate limiting and exponential backoff
 *
 * This function handles:
 * - Concurrent processing with configurable parallelism
 * - Rate limiting to avoid API throttling
 * - Exponential backoff retry on failures
 * - Progress tracking
 *
 * @param texts - Array of texts to embed
 * @param config - Optional batch configuration
 * @returns Map of index to embedding for successful items, and failures
 *
 * @example
 * ```typescript
 * const texts = ['Document chunk 1', 'Document chunk 2', 'Document chunk 3'];
 * const result = await generateEmbeddings(texts, {
 *   concurrency: 3,
 *   onProgress: (done, total) => console.log(`${done}/${total} complete`),
 * });
 *
 * result.embeddings.forEach((embedding, index) => {
 *   console.log(`Chunk ${index}: ${embedding.length} dimensions`);
 * });
 * ```
 */
export async function generateEmbeddings(
  texts: string[],
  config: BatchEmbeddingConfig = {}
): Promise<BatchEmbeddingResult> {
  const startTime = Date.now();
  const {
    model = DEFAULT_EMBEDDING_MODEL,
    taskType = TaskType.RETRIEVAL_DOCUMENT,
    concurrency = 5,
    batchDelayMs = 100,
    maxRetries = 3,
    baseRetryDelayMs = 1000,
    onProgress,
  } = config;

  const embeddings = new Map<number, number[]>();
  const failures = new Map<number, string>();
  let completed = 0;

  // Process texts in batches
  const processBatch = async (batchIndices: number[]): Promise<void> => {
    await Promise.all(
      batchIndices.map(async (index) => {
        const text = texts[index];
        let lastError: Error | null = null;

        // Retry with exponential backoff
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const embedding = await generateEmbedding(text, { model, taskType });
            embeddings.set(index, embedding);
            completed++;
            onProgress?.(completed, texts.length);
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Check if it's a rate limit error (429)
            const isRateLimit =
              lastError.message.includes('429') ||
              lastError.message.includes('RESOURCE_EXHAUSTED') ||
              lastError.message.includes('quota');

            if (attempt < maxRetries - 1) {
              // Exponential backoff: 1s, 2s, 4s, etc.
              const delay = baseRetryDelayMs * Math.pow(2, attempt);
              // Add jitter (±20%)
              const jitter = delay * 0.2 * (Math.random() - 0.5);
              await sleep(delay + jitter);

              // Longer delay for rate limits
              if (isRateLimit) {
                await sleep(delay);
              }
            }
          }
        }

        // All retries failed
        failures.set(index, lastError?.message || 'Unknown error');
        completed++;
        onProgress?.(completed, texts.length);
      })
    );
  };

  // Process all texts in batches of `concurrency`
  for (let i = 0; i < texts.length; i += concurrency) {
    const batchIndices = Array.from({ length: Math.min(concurrency, texts.length - i) }, (_, j) => i + j);

    await processBatch(batchIndices);

    // Add delay between batches to avoid rate limiting
    if (i + concurrency < texts.length) {
      await sleep(batchDelayMs);
    }
  }

  return {
    embeddings,
    failures,
    model,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively transforms null values to undefined in an object.
 *
 * AI models (like Gemini) often return `null` for fields they don't have data for,
 * but Zod's `.optional()` only accepts `undefined`, not `null`.
 * This function ensures compatibility between AI output and Zod schemas.
 *
 * @param obj - The object to transform
 * @returns A new object with null values replaced by undefined
 */
function transformNullToUndefined<T>(obj: T): T {
  if (obj === null) {
    return undefined as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => transformNullToUndefined(item)) as T;
  }

  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = transformNullToUndefined(value);
    }
    return result as T;
  }

  return obj;
}

// ============================================================================
// JSON UTILITIES
// ============================================================================

/**
 * Fixes unterminated strings in JSON by finding unclosed quotes and closing them
 */
function fixUnterminatedStrings(json: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  let lastStringStart = -1;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      result += char;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        inString = true;
        lastStringStart = i;
      } else {
        inString = false;
      }
    }

    result += char;
  }

  // If we ended inside a string, close it and try to complete the JSON structure
  if (inString && lastStringStart >= 0) {
    // Close the unterminated string
    result += '"';

    // Try to balance brackets and braces
    const openBraces = (result.match(/{/g) || []).length;
    const closeBraces = (result.match(/}/g) || []).length;
    const openBrackets = (result.match(/\[/g) || []).length;
    const closeBrackets = (result.match(/]/g) || []).length;

    // Add missing closing brackets/braces
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      result += ']';
    }
    for (let i = 0; i < openBraces - closeBraces; i++) {
      result += '}';
    }
  }

  return result;
}

/**
 * Completes an otherwise well-formed JSON prefix when the model stops before
 * emitting only the final object/array delimiters. Mismatched delimiters are
 * left untouched so the normal parse error remains honest.
 */
function balanceJSONDelimiters(json: string): string {
  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      expectedClosers.push('}');
    } else if (char === '[') {
      expectedClosers.push(']');
    } else if (char === '}' || char === ']') {
      if (expectedClosers.pop() !== char) {
        return json;
      }
    }
  }

  if (inString) {
    return json;
  }

  return json + expectedClosers.reverse().join('');
}

function findLastStructuralCloser(json: string): number {
  let inString = false;
  let escaped = false;
  let lastCloser = -1;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '}' || char === ']') {
      lastCloser = index;
    }
  }

  return lastCloser;
}

/**
 * Cleans JSON text by removing markdown code blocks and extra whitespace
 *
 * @param text - Raw text that may contain JSON
 * @param aggressive - If true, apply more aggressive cleaning for malformed JSON
 * @returns Cleaned JSON string
 */
function cleanJSON(text: string, aggressive: boolean = false): string {
  // Remove markdown code blocks
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  if (aggressive) {
    // Remove trailing commas before closing brackets/braces
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

    // Fix common issues with unescaped quotes in strings
    // This is a simplified approach - may not catch all cases
    cleaned = cleaned.replace(/:\\s*"([^"]*)"([^,:}\]]*[^\\])"([^,:}\]]*?)"/g, (match, p1, p2, p3) => {
      // If we find a quote that's not escaped in the middle of a string value
      if (p2 && !p2.endsWith('\\')) {
        return `: "${p1}\\"${p2}\\"${p3}"`;
      }
      return match;
    });

    // Remove any text before the first { or [
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    if (firstBrace >= 0 || firstBracket >= 0) {
      const start =
        firstBrace >= 0 && firstBracket >= 0 ? Math.min(firstBrace, firstBracket) : Math.max(firstBrace, firstBracket);
      cleaned = cleaned.substring(start);
    }

    // Remove any text after the last } or ]
    const lastStructuralCloser = findLastStructuralCloser(cleaned);
    if (lastStructuralCloser >= 0) {
      const end = lastStructuralCloser;
      cleaned = cleaned.substring(0, end + 1);
    }

    // Fix unterminated strings (common issue with Google Search grounding)
    cleaned = fixUnterminatedStrings(cleaned);

    // Gemini can finish a complete final value but omit only the outer
    // delimiter at the token boundary. Complete that safe JSON prefix.
    cleaned = balanceJSONDelimiters(cleaned);

    // Remove any control characters that could break JSON parsing
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (match) => {
      // Keep newlines and tabs as they might be intentional
      if (match === '\n' || match === '\r' || match === '\t') {
        return match;
      }
      return '';
    });
  }

  return cleaned;
}
