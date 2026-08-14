/**
 * @file chat-stream-service.ts
 * @description Phase 3.1 — SSE streaming client for the AI chat endpoint.
 *
 * Sends the same request as sendChatMessage but with `stream: true`, and consumes
 * the Server-Sent-Events response (token deltas, tool-progress, terminal `done`
 * envelope). If the server returns plain JSON (streaming gate off), it falls back
 * to parsing the JSON and firing onDone once — so the caller can always opt in.
 *
 * The SSE reader loop mirrors the proven pattern in useAgentEventStream.
 */

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type {
  AIChatRequest,
  AIChatResponse,
  AIChatQuickActionMetadata,
  AIContext,
  ChatImagePayload,
  FileContentPayload,
} from '@/types/ai-assistant';

const log = createLogger('chat-stream-service');

/** A tool-progress frame from the stream. */
export interface ToolProgressFrame {
  status: 'start' | 'done';
  /** present on status:'start' — the tools about to run this batch */
  names?: string[];
  /** present on status:'done' — the tool that just finished */
  name?: string;
  success?: boolean;
}

export interface StreamHandlers {
  onToken?: (delta: string) => void;
  onTool?: (frame: ToolProgressFrame) => void;
  onDone?: (envelope: AIChatResponse) => void;
  onError?: (message: string) => void;
}

export async function sendChatMessageStreaming(
  message: string,
  context: AIContext,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
  handlers: StreamHandlers,
  fileContent?: FileContentPayload,
  documentReferences?: Array<{ documentId: string; name: string }>,
  images?: ChatImagePayload[],
  quickAction?: AIChatQuickActionMetadata
): Promise<void> {
  const requestBody: AIChatRequest = {
    message,
    context: {
      currentRoute: context.currentRoute,
      currentPage: context.currentPage,
      entity: context.entity
        ? { type: context.entity.type, id: context.entity.id, name: context.entity.name, data: context.entity.data }
        : undefined,
      recentEntities: context.recentEntities.map((e) => ({ type: e.type, id: e.id, name: e.name })),
    },
    conversationHistory,
    fileContent,
    documentReferences,
    images,
    quickAction,
    stream: true,
  };

  let response: Response;
  try {
    response = await fetchWithAuth('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : 'Network error');
    return;
  }

  if (!response.ok) {
    // UX-045 — a typed paid-action refusal (409) carries a specific reason the
    // UI must render (expired / already used / wrong session / restart loss).
    // Deliver it through onDone as a failure envelope; every other non-OK
    // status keeps the legacy onError contract.
    const body = (await response.json().catch(() => null)) as Partial<AIChatResponse> | null;
    if (body && typeof body === 'object' && body.pendingActionError) {
      handlers.onDone?.({ success: false, ...body });
      return;
    }
    handlers.onError?.(`HTTP ${response.status}`);
    return;
  }

  // Server returned JSON (streaming gate off) — consume it directly.
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    try {
      handlers.onDone?.((await response.json()) as AIChatResponse);
    } catch {
      handlers.onError?.('Failed to parse response');
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? ''; // keep the trailing (possibly incomplete) block
      for (const block of blocks) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let frame: { type?: string; delta?: string; data?: AIChatResponse; message?: string } & ToolProgressFrame;
        try {
          frame = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }
        if (frame.type === 'token' && typeof frame.delta === 'string') handlers.onToken?.(frame.delta);
        else if (frame.type === 'tool') handlers.onTool?.(frame);
        else if (frame.type === 'done' && frame.data) handlers.onDone?.(frame.data);
        else if (frame.type === 'error') handlers.onError?.(frame.message ?? 'Stream error');
      }
    }
  } catch (err) {
    log.warn('stream read failed', { error: err instanceof Error ? err.message : String(err) });
    handlers.onError?.(err instanceof Error ? err.message : 'Stream read error');
  }
}
