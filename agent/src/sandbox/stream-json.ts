/**
 * Tolerant parser for Claude Code headless `--output-format stream-json`.
 *
 * The checked-in fixture is deliberately synthetic: it exercises the protocol
 * fields without publishing session identifiers, prompts, plugin metadata, or
 * captured usage. Unknown event types are skipped, malformed lines are dropped,
 * and only the final `result` line's cost/turn fields are load-bearing. A pinned
 * CLI plus release qualification verifies compatibility with the live protocol.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNTING GRANULARITY — why the SERVED MODEL, not the response, is the unit
 * ---------------------------------------------------------------------------
 * The `assistant` lines look like per-response accounting: each carries
 * `message.model` (the served model), a stable `message.id`, and a full
 * `message.usage` including the exact `cache_creation` tier split. Two
 * protocol properties make them unusable as the PRICED accounting unit, and
 * both are represented by `stream-json-response-boundary.test.ts`:
 *
 *   1. `output_tokens` is a MID-STREAM SNAPSHOT, never finalized. Every
 *      `assistant` line carries `stop_reason: null`, and the CLI emits one line
 *      per content block with the usage frozen at first emission. Deduplicated
 *      by `message.id`, the observation remains lower than the authoritative
 *      per-model total. Input and cache counters still reconcile, so the
 *      shortfall is specific to output rather than a duplicate-line error.
 *
 *   2. Auxiliary models may be absent from response events while still being
 *      present in `result.modelUsage`. Per-response receipts would silently
 *      omit that billed model.
 *
 * So a per-response receipt could only ever be a partial, unpriceable artifact
 * that under-reports real spend — the exact failure mode the receipt ledger
 * exists to prevent. The protocol's finest AUTHORITATIVE granularity is
 * `result.modelUsage`: per SERVED model, with complete counters and the
 * provider's own per-model cost. That is what {@link extractResult} surfaces
 * and what the receipt bridge records.
 *
 * {@link collectResponseObservations} exposes the per-response view anyway, as
 * OBSERVABILITY and as the executable evidence for the boundary above. It is
 * deliberately NOT wired into pricing.
 */
import { sessionResultSchema, type SessionResult } from './types.js';

export type SessionEvent =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-use'; tool: string; summary: string }
  | { kind: 'result'; result: SessionResult }
  | { kind: 'other'; type: string };

/** Loosely-shaped raw event — every field verified before use. */
interface RawStreamEvent {
  type?: unknown;
  subtype?: unknown;
  num_turns?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
  is_error?: unknown;
  api_error_status?: unknown;
  result?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: { content?: unknown; model?: unknown; id?: unknown; usage?: unknown };
}
interface RawContentBlock {
  type?: unknown;
  name?: unknown;
  text?: unknown;
  input?: unknown;
}

/** A nonnegative safe integer, or undefined when the provider reported none. */
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Normalize the CLI's snake_case per-model usage onto the camelCase
 * {@link SessionResult} shape. Returns undefined when the value is not a usable
 * object so the schema's `.catch(undefined)` never has to fire on well-formed
 * input.
 */
function readModelUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Normalize `usage.cache_creation` onto the camelCase tier-split shape. */
function readCacheCreation(
  value: unknown
): { ephemeral5mInputTokens?: number; ephemeral1hInputTokens?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const fiveMin = readCount(raw.ephemeral_5m_input_tokens);
  const oneHour = readCount(raw.ephemeral_1h_input_tokens);
  if (fiveMin === undefined && oneHour === undefined) return undefined;
  return {
    ...(fiveMin !== undefined ? { ephemeral5mInputTokens: fiveMin } : {}),
    ...(oneHour !== undefined ? { ephemeral1hInputTokens: oneHour } : {}),
  };
}

/** Parse one stream-json line; null when the line is malformed/irrelevant. */
export function parseLine(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: RawStreamEvent;
  try {
    json = JSON.parse(trimmed) as RawStreamEvent;
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || typeof json.type !== 'string') return null;

  if (json.type === 'result') {
    const parsed = sessionResultSchema.safeParse({
      subtype: json.subtype ?? 'unknown',
      numTurns: json.num_turns ?? 0,
      // Cost is load-bearing budget authority. An absent/malformed value must
      // make the whole result non-authoritative so the supervisor charges the
      // pre-launch reservation instead of silently treating paid work as $0.
      totalCostUsd: json.total_cost_usd,
      durationMs: json.duration_ms,
      isError: typeof json.is_error === 'boolean' ? json.is_error : undefined,
      apiErrorStatus: typeof json.api_error_status === 'number' ? json.api_error_status : undefined,
      resultText: typeof json.result === 'string' ? json.result : undefined,
      usage: json.usage,
      // Per-SERVED-model usage + the provider's own per-model cost. This is the
      // finest granularity the protocol reports authoritatively (see the module
      // contract above) and is what the receipt bridge prices from.
      modelUsage: readModelUsage(json.modelUsage),
      // The session cache-write tier split lives on `usage`, not on modelUsage.
      cacheCreation: readCacheCreation((json.usage as { cache_creation?: unknown } | undefined)?.cache_creation),
    });
    return parsed.success ? { kind: 'result', result: parsed.data } : { kind: 'other', type: 'result' };
  }

  if (json.type === 'assistant') {
    const content = json.message?.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as RawContentBlock;
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          const summary =
            typeof input.file_path === 'string'
              ? input.file_path
              : typeof input.command === 'string'
                ? input.command.slice(0, 120)
                : '';
          return { kind: 'tool-use', tool: block.name, summary };
        }
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return { kind: 'assistant-text', text: block.text.trim() };
        }
      }
    }
    return { kind: 'other', type: 'assistant' };
  }

  return { kind: 'other', type: json.type };
}

/**
 * Incremental parse for the supervisor's tail-from-offset polling: consumes
 * complete lines, returns the unfinished trailing fragment as `rest` so it
 * can be prepended to the next chunk.
 */
export function parseChunk(chunk: string): { events: SessionEvent[]; rest: string } {
  const lines = chunk.split('\n');
  const rest = lines.pop() ?? '';
  const events: SessionEvent[] = [];
  for (const line of lines) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return { events, rest };
}

/** Final result of a completed session transcript, or null when absent. */
export function extractResult(transcript: string): SessionResult | null {
  const lines = transcript.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseLine(lines[i]);
    if (event?.kind === 'result') return event.result;
  }
  return null;
}

/**
 * One observable provider response in the transcript, deduplicated by the
 * provider's own `message.id`.
 *
 * OBSERVABILITY ONLY — deliberately not a pricing input. See the module
 * contract because `output_tokens` is a mid-stream snapshot and
 * auxiliary models never appear). `outputTokensIsLowerBound` is stamped `true`
 * on every observation to keep that fact travelling WITH the data, so a future
 * caller cannot mistake it for a settled counter.
 */
export interface ResponseObservation {
  /** The provider's own response id (`message.id`) — the dedup key. */
  responseId: string;
  /** The SERVED model the provider reported for this response. */
  model: string;
  /** Non-cached input tokens. Reconciles exactly with the session total. */
  inputTokens?: number;
  /**
   * Output tokens AT FIRST EMISSION — a mid-stream snapshot, always a LOWER
   * BOUND on what the response actually billed. Never sum these as truth.
   */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** Always `true` — see {@link ResponseObservation.outputTokens}. */
  outputTokensIsLowerBound: true;
  /** How many transcript lines carried this response id (content blocks). */
  lineCount: number;
}

/**
 * Collect the per-response observations from a transcript, deduplicated by
 * `message.id`.
 *
 * The CLI emits one `assistant` line per content block, all sharing one
 * `message.id` and one frozen usage object. First-seen wins: in a synthetic
 * multi-block fixture every repeated id carries byte-identical usage, so
 * first-seen and last-seen agree. Taking one prevents double counting.
 */
export function collectResponseObservations(transcript: string): ResponseObservation[] {
  const byId = new Map<string, ResponseObservation>();
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: RawStreamEvent;
    try {
      json = JSON.parse(trimmed) as RawStreamEvent;
    } catch {
      continue;
    }
    if (json?.type !== 'assistant') continue;
    const message = json.message;
    if (!message) continue;
    const responseId = typeof message.id === 'string' ? message.id : undefined;
    const model = typeof message.model === 'string' ? message.model : undefined;
    if (!responseId || !model) continue;

    const existing = byId.get(responseId);
    if (existing) {
      existing.lineCount += 1;
      continue;
    }

    const usage = (message.usage && typeof message.usage === 'object' ? message.usage : {}) as Record<string, unknown>;
    const tiers = readCacheCreation(usage.cache_creation);
    const inputTokens = readCount(usage.input_tokens);
    const outputTokens = readCount(usage.output_tokens);
    const cacheReadTokens = readCount(usage.cache_read_input_tokens);
    byId.set(responseId, {
      responseId,
      model,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(tiers?.ephemeral5mInputTokens !== undefined ? { cacheWrite5mTokens: tiers.ephemeral5mInputTokens } : {}),
      ...(tiers?.ephemeral1hInputTokens !== undefined ? { cacheWrite1hTokens: tiers.ephemeral1hInputTokens } : {}),
      outputTokensIsLowerBound: true,
      lineCount: 1,
    });
  }
  return [...byId.values()];
}
