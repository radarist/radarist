/**
 * Bounded, persistence-safe summary of tools used during one Assistant turn.
 *
 * This boundary deliberately reads only the tool name, outcome, and measured
 * duration. Tool arguments and results can contain prompts, document text,
 * confirmation phrases, or credentials and must never enter AgentRun history.
 */

export const MAX_CHAT_TOOL_SUMMARY_ENTRIES = 50;
export const MAX_CHAT_TOOL_NAME_LENGTH = 96;
export const MAX_CHAT_TOOL_DURATION_MS = 5 * 60 * 1000;

export type ChatToolSummaryStatus = 'success' | 'failure';

export interface ChatToolSummaryEntry {
  name: string;
  status: ChatToolSummaryStatus;
  durationMs?: number;
}

export interface ChatToolSummary {
  toolSummary: ChatToolSummaryEntry[];
  toolSummaryTruncated: boolean;
}

export const CHAT_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !CHAT_TOOL_NAME_PATTERN.test(trimmed)) return undefined;
  return trimmed.slice(0, MAX_CHAT_TOOL_NAME_LENGTH);
}

function safeStatus(value: Record<string, unknown>): ChatToolSummaryStatus | undefined {
  if (value.status === 'success' || value.status === 'failure') return value.status;
  if (typeof value.success === 'boolean') return value.success ? 'success' : 'failure';

  const result = record(value.result);
  return typeof result?.success === 'boolean' ? (result.success ? 'success' : 'failure') : undefined;
}

function safeDuration(value: Record<string, unknown>): number | undefined {
  const candidate = value.durationMs ?? value.duration;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) return undefined;
  return Math.min(Math.floor(candidate), MAX_CHAT_TOOL_DURATION_MS);
}

/**
 * Convert either provider's in-memory tool-call records into the only shape
 * allowed to cross the AgentRun persistence boundary.
 */
export function summarizeChatToolCalls(input: unknown): ChatToolSummary {
  if (!Array.isArray(input)) {
    return { toolSummary: [], toolSummaryTruncated: false };
  }

  const toolSummary: ChatToolSummaryEntry[] = [];
  for (const raw of input) {
    if (toolSummary.length === MAX_CHAT_TOOL_SUMMARY_ENTRIES) break;
    const value = record(raw);
    if (!value) continue;

    const name = safeName(value.name);
    const status = safeStatus(value);
    if (!name || !status) continue;

    const durationMs = safeDuration(value);
    toolSummary.push({ name, status, ...(durationMs === undefined ? {} : { durationMs }) });
  }

  return {
    toolSummary,
    toolSummaryTruncated: input.length > MAX_CHAT_TOOL_SUMMARY_ENTRIES,
  };
}
