/**
 * @file lib/ai/deep-research-client.ts
 * @description Client for Gemini Deep Research via the Interactions API.
 *
 * Uses the `@google/genai` SDK (v2.x — migrated 2026-06-07 for the Interactions
 * API `outputs`→`steps` cutover) — separate from the project's
 * `@google/generative-ai` SDK used in `client.ts`. Both share the same API key.
 *
 * Deep Research is an async background agent that autonomously browses the web
 * for 1-5+ minutes, producing a comprehensive markdown report.
 *
 * @author Radarist Team
 * @created 2026-02-27
 */

import { GoogleGenAI } from '@google/genai';
import { resolveGeminiApiKey, MissingAIKeyError } from './key-resolution';
import { geminiDeepResearchModel } from './model-config';
import { resolveGeminiTestRequestOptions } from './gemini-test-endpoint';
import { createLogger } from '@/lib/logger';
import { captureProviderUsage } from '@/lib/operation-context';
import { readDeepResearchObservation, type DeepResearchObservation } from '@/lib/research/deep-research-progress';

const log = createLogger('ai/deep-research-client');

/**
 * The dedicated Deep Research agent model identifier.
 * Env-backed via geminiDeepResearchModel() (override: GEMINI_DEEP_RESEARCH_MODEL).
 */
const DEEP_RESEARCH_AGENT = geminiDeepResearchModel();

/**
 * Creates a GoogleGenAI client instance.
 * Uses the centralized key resolution from `src/lib/ai/client.ts`
 * (GOOGLE_API_KEY or GEMINI_API_KEY; setup-script placeholders count as missing).
 */
function getClient(): GoogleGenAI {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new MissingAIKeyError();
  }
  const requestOptions = resolveGeminiTestRequestOptions();
  return requestOptions === undefined
    ? new GoogleGenAI({ apiKey })
    : new GoogleGenAI({ apiKey, httpOptions: requestOptions });
}

/** Result of starting a deep research task. */
export interface DeepResearchStartResult {
  interactionId: string;
}

/** Result of polling a deep research task. */
export interface DeepResearchPollResult {
  status: 'in_progress' | 'completed' | 'failed';
  text?: string;
  /** Truthful failure reason for terminal non-success states, when one is known. */
  reason?: string;
  /**
   * True when the PROVIDER has settled this interaction into a state no further
   * poll or function retry can change (`failed`/`cancelled`/`incomplete`, or the
   * headless-unsupported `requires_action`). The job marks the document failed
   * immediately instead of burning its retry budget re-polling a settled
   * interaction. Previously this was inferred from `reason` being set, which
   * coupled "we can describe it" to "it cannot recover".
   */
  terminal?: boolean;
  /**
   * PRODUCT-003 — the provider's OWN plan/progress facts for this poll: the raw
   * interaction status and the agent's `steps[]` list. Previously read only to
   * branch on completed/failed and then discarded, which is why a nine-minute
   * run could show nothing but "Processing". Never enriched with an invented
   * stage, percentage, or ETA — the provider reports none of those.
   */
  progress: DeepResearchObservation;
}

/**
 * Terminal reason for the `requires_action` interaction state — this integration
 * is headless (no channel to relay the agent's question back to a user), so the
 * state can never resolve and polling it would only burn the ~15 min budget.
 */
export const REQUIRES_ACTION_REASON =
  'Deep research requested user input (requires_action), which this integration does not support — try a more specific query';

/**
 * ARUN-022 — capture one Deep Research TERMINAL event into the ambient
 * operation-usage sink (a strict no-op when no boundary opened one, and never
 * throwing into the poll path). Deep Research is a paid background agent whose
 * Interactions-API poll response exposes NO per-call token usage, so the honest
 * receipt is `unreported` usage with an `applicable-but-unknown` fee (it is
 * billed, but the per-call amount is not reported here). A failed/aborted task
 * may still have incurred partial provider spend, so a terminal non-success is
 * captured too (requirement: failed/aborted billable attempts remain visible).
 *
 * `status` is the raw provider interaction status so the receipt keeps the
 * truthful terminal classification (`completed` vs a failure state). No prompt
 * or report text is captured — capture is content-free.
 */
function captureDeepResearchTerminal(status: string): void {
  try {
    captureProviderUsage({
      provider: 'gemini',
      operation: 'gemini.deep-research',
      requestedModel: DEEP_RESEARCH_AGENT,
      // The Interactions API does not report a served model per poll; the
      // configured Deep Research agent id is the requested model only.
      counters: {},
      usageCompleteness: 'unreported',
      occurredAt: new Date().toISOString(),
      // Deep Research is a paid agent; the exact charge is not reported per
      // response, so it must never read as $0. No `externalFees` amount is
      // supplied — that field is reserved for KNOWN micro-amounts; an unknown
      // fee is expressed by `feeState` alone.
      feeState: 'applicable-but-unknown',
    });
  } catch (captureError) {
    log.debug('deep-research usage capture skipped (non-fatal)', {
      status,
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
  }
}

/**
 * Start a deep research task via the Interactions API.
 * Returns an interaction ID for polling.
 *
 * @param query - The research topic or question
 * @returns The interaction ID for subsequent polling
 */
export async function startDeepResearch(query: string): Promise<DeepResearchStartResult> {
  const client = getClient();

  log.info('Starting deep research', { query: query.substring(0, 100) });

  const interaction = await client.interactions.create({
    agent: DEEP_RESEARCH_AGENT,
    input: query,
    background: true,
  });

  log.info('Deep research started', { interactionId: interaction.id });

  return { interactionId: interaction.id };
}

/**
 * Reads the `.text` property off the last element of a flat array of objects
 * (the legacy `outputs[].text` shape). Narrow `Record<string, unknown>` cast
 * because the SDK union doesn't expose `text` uniformly across variants.
 *
 * @returns The trimmed text, or `undefined` when the array is empty or the last
 *   element has no non-empty `text` property.
 */
function readLastText(items: unknown): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const last = items[items.length - 1] as Record<string, unknown> | null | undefined;
  const text = last?.text;
  if (typeof text === 'string' && text.trim().length > 0) {
    return text;
  }
  return undefined;
}

/**
 * Reads report text out of the new `steps` schema (Interactions API, 2026-05).
 * Each step may carry text either nested at `step.content[].text` (the documented
 * `model_output` shape) or, in some builds, flat at `step.text`. We scan from the
 * end so the final model answer wins, and join multi-part content.
 *
 * @returns The trimmed text of the last step that has any, or `undefined`.
 */
function readStepsText(steps: unknown): string | undefined {
  if (!Array.isArray(steps)) return undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as Record<string, unknown> | null | undefined;
    if (!step) continue;
    // Documented shape: step.content[] = [{ type: 'text', text: '...' }]
    const content = step.content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c as Record<string, unknown> | null)?.text)
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .join('\n')
        .trim();
      if (text.length > 0) return text;
    }
    // Fallback: some builds expose flat step.text.
    const direct = step.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  }
  return undefined;
}

/**
 * Extracts the final research report text from a completed interaction.
 *
 * The Interactions API replaced the legacy `outputs` array with a `steps` array
 * (legacy `outputs` removed 2026-06-08). We read in priority order:
 *   1. `output_text` — the SDK >=2.0 convenience accessor (most robust);
 *   2. the new `steps` schema (`steps[].content[].text`, scanned newest-first);
 *   3. the legacy `outputs[].text` (harmless fallback until the cutover).
 * Read via narrow casts because the installed SDK type doesn't declare every field.
 *
 * @returns The report text, or `undefined` when no field yields any text.
 */
function extractReportText(interaction: unknown): string | undefined {
  const record = interaction as Record<string, unknown>;
  const sugar = record.output_text ?? record.outputText;
  if (typeof sugar === 'string' && sugar.trim().length > 0) {
    return sugar;
  }
  return readStepsText(record.steps) ?? readLastText(record.outputs);
}

/**
 * Poll deep research status via the Interactions API.
 * Returns 'completed' with text, 'in_progress', or 'failed'.
 *
 * @param interactionId - The interaction ID from startDeepResearch
 * @returns Current status and result text if completed
 */
export async function pollDeepResearch(interactionId: string): Promise<DeepResearchPollResult> {
  const client = getClient();

  const interaction = await client.interactions.get(interactionId);
  const progress = readDeepResearchObservation(interaction, new Date().toISOString());

  log.debug('Polled deep research', {
    interactionId,
    status: interaction.status,
    providerSteps: progress.steps?.length ?? null,
  });

  if (interaction.status === 'completed') {
    const text = extractReportText(interaction);

    if (text === undefined) {
      // Neither the new `steps` field nor the legacy `outputs` field carried any
      // text. Surface this loudly rather than silently returning an empty report
      // (a silent failure would look like a successful empty research run).
      log.warn('Deep research completed but no report text found in steps or outputs', {
        interactionId,
      });
    }

    // ARUN-022 — the paid background agent reached a terminal completion.
    captureDeepResearchTerminal('completed');

    return {
      status: 'completed',
      text: text ?? '',
      progress,
    };
  }

  if (interaction.status === 'requires_action') {
    // Fail fast: the agent paused for user input we can never provide — treating
    // this as in-progress would poll to timeout and surface a misleading error.
    log.warn('Deep research requires user action — failing fast', { interactionId });
    captureDeepResearchTerminal('requires_action');
    return { status: 'failed', reason: REQUIRES_ACTION_REASON, terminal: true, progress };
  }

  if (['failed', 'cancelled', 'incomplete'].includes(interaction.status)) {
    log.warn('Deep research ended with non-success status', {
      interactionId,
      status: interaction.status,
    });
    captureDeepResearchTerminal(interaction.status);
    // The raw provider status IS the reason here — `failed`, `cancelled` and
    // `incomplete` are materially different outcomes and collapsing them into a
    // bare "failed" discarded the only terminal detail the provider gave.
    return {
      status: 'failed',
      reason: `Deep research ended with provider status "${interaction.status}"`,
      terminal: true,
      progress,
    };
  }

  // 'in_progress'
  return { status: 'in_progress', progress };
}
