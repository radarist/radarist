/**
 * @file chat-service.ts
 * @description Client-side service for AI Chat functionality
 *
 * Provides methods to interact with the AI chat API endpoint.
 * Includes URL auto-research capability - when URLs are detected in user messages,
 * they are automatically flagged for web research.
 *
 * @author Radarist Team
 * @created 2025-11-29
 * @updated 2025-01-07 - Added URL auto-research detection
 */

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type {
  AIChatRequest,
  AIChatResponse,
  AIChatQuickActionMetadata,
  AIContext,
  AIMessage,
  ChatImagePayload,
  FileContentPayload,
} from '@/types/ai-assistant';

const log = createLogger('chat-service');

// ============================================================================
// URL Detection
// ============================================================================

/**
 * Regular expression to detect URLs in text.
 * Matches http:// and https:// URLs.
 */
const URL_REGEX = /https?:\/\/[^\s<>"\)]+/gi;

/**
 * Detects URLs in a message and returns them.
 *
 * @param message - Message to scan for URLs
 * @returns Array of detected URLs
 */
export function detectUrls(message: string): string[] {
  const matches = message.match(URL_REGEX);
  return matches ? [...new Set(matches)] : []; // Remove duplicates
}

/**
 * Enhances a message with URL research hint if URLs are detected.
 * This helps the AI understand it should use web research tools.
 *
 * @param message - Original user message
 * @param urls - Detected URLs
 * @returns Enhanced message with research hint
 */
function enhanceMessageWithUrls(message: string, urls: string[]): string {
  if (urls.length === 0) return message;

  // The AI will naturally use webScrape or researchWebPage tools when it sees this hint
  const urlList = urls.join(', ');
  return `${message}

[System note: URLs detected in user's message: ${urlList}. Please research these URLs using web scraping tools to gather relevant information.]`;
}

// ============================================================================
// API Client
// ============================================================================

/**
 * Sends a chat message to the AI assistant.
 *
 * @param message - User message
 * @param context - Current AI context
 * @param conversationHistory - Previous messages for context
 * @param fileContent - Optional file content for inline context (Quick Mode)
 * @param documentReferences - Optional document references for library documents (Full Mode) - supports multiple
 * @param images - Optional inline images for multimodal understanding (Gemini vision)
 * @returns AI response
 *
 * @example
 * ```typescript
 * // Without file
 * const response = await sendChatMessage(
 *   "What technologies are related to AI?",
 *   currentContext,
 *   previousMessages
 * );
 *
 * // With file content (Quick Mode)
 * const responseWithFile = await sendChatMessage(
 *   "Summarize this document",
 *   currentContext,
 *   previousMessages,
 *   { name: "report.pdf", type: "application/pdf", text: "..." }
 * );
 *
 * // With document references (Full Mode - supports multiple documents)
 * const responseWithDocs = await sendChatMessage(
 *   "Compare these two documents",
 *   currentContext,
 *   previousMessages,
 *   undefined,
 *   [
 *     { documentId: "doc-123", name: "Annual Report 2025.pdf" },
 *     { documentId: "doc-456", name: "Q4 Financials.pdf" }
 *   ]
 * );
 * ```
 */
export async function sendChatMessage(
  message: string,
  context: AIContext,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  fileContent?: FileContentPayload,
  documentReferences?: Array<{ documentId: string; name: string }>,
  images?: ChatImagePayload[],
  quickAction?: AIChatQuickActionMetadata
): Promise<AIChatResponse> {
  // URL Auto-Research: Detect URLs and enhance message if found
  const detectedUrls = detectUrls(message);
  const enhancedMessage = enhanceMessageWithUrls(message, detectedUrls);

  if (detectedUrls.length > 0) {
    log.info('URL auto-research: detected URLs', { urls: detectedUrls });
  }

  if (fileContent) {
    log.info('File content included', { name: fileContent.name, chars: fileContent.text.length });
  }

  if (documentReferences && documentReferences.length > 0) {
    log.info('Document references included', {
      documents: documentReferences.map((d) => `${d.name} (ID: ${d.documentId})`).join(', '),
    });
  }

  const requestBody: AIChatRequest = {
    message: enhancedMessage,
    context: {
      currentRoute: context.currentRoute,
      currentPage: context.currentPage,
      entity: context.entity
        ? {
            type: context.entity.type,
            id: context.entity.id,
            name: context.entity.name,
            data: context.entity.data,
          }
        : undefined,
      recentEntities: context.recentEntities.map((e) => ({
        type: e.type,
        id: e.id,
        name: e.name,
      })),
    },
    conversationHistory,
    fileContent,
    documentReferences,
    images,
    quickAction,
  };

  const response = await fetchWithAuth('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as Partial<AIChatResponse>;
    // UX-045 — a typed paid-action refusal (409: expired/replayed/wrong session/
    // restart loss) is a first-class envelope the UI renders with a specific
    // explanation and a restage affordance, not a thrown generic error.
    if (errorData && typeof errorData === 'object' && errorData.pendingActionError) {
      return { success: false, ...errorData };
    }
    throw new Error(errorData.error || `Chat request failed (${response.status})`);
  }

  const data = await response.json().catch(() => null);
  if (!data) {
    throw new Error('Invalid response from chat API');
  }
  return data;
}

// ============================================================================
// Daily Greeting
// ============================================================================

/**
 * Response shape from GET /api/ai/greeting.
 * `greeting` is null when AI generation failed (stats still returned).
 */
export interface AIGreetingResponse {
  greeting: string | null;
  stats?: { newSignals: number; completedRuns: number };
  generatedAt?: string;
}

/** localStorage key recording when the daily greeting was last shown. */
export const GREETING_LAST_SHOWN_KEY = 'radarist-ai-greeting-last-shown';

/** Minimum interval between greetings (6 hours). */
export const GREETING_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Abort the greeting fetch after this long — it must never hold up the chat. */
const GREETING_FETCH_TIMEOUT_MS = 8000;

/**
 * Returns true when the daily greeting should be fetched: no record of a
 * previous greeting, an unparsable record, or the last one is 6+ hours old.
 * Returns false when localStorage is unavailable (SSR, privacy mode).
 */
export function shouldShowGreeting(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(GREETING_LAST_SHOWN_KEY);
    if (!raw) return true;
    const lastShown = Number(raw);
    if (!Number.isFinite(lastShown)) return true;
    return now - lastShown >= GREETING_MIN_INTERVAL_MS;
  } catch (error) {
    log.warn('Could not read greeting timestamp', { error: String(error) });
    return false;
  }
}

/**
 * Records that the greeting was shown so it is not repeated within 6 hours.
 */
export function markGreetingShown(now: number = Date.now()): void {
  try {
    localStorage.setItem(GREETING_LAST_SHOWN_KEY, String(now));
  } catch (error) {
    log.warn('Could not persist greeting timestamp', { error: String(error) });
  }
}

/**
 * Fetches the daily "what's new" greeting from /api/ai/greeting.
 *
 * Fail-soft by design: returns null on HTTP errors, timeouts, malformed
 * payloads, or a null/empty greeting — callers keep the static welcome.
 *
 * Marks the 6h window (markGreetingShown) whenever the API RESPONDS — even
 * with `greeting: null` (the keyless-demo path). Otherwise a keyless install
 * would re-fetch on every chat open; this rate-limits retries to the window.
 * Transport failures (HTTP error / abort / network) do NOT mark the window,
 * so a transient outage doesn't suppress the next greeting for 6 hours.
 */
export async function fetchDailyGreeting(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GREETING_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchWithAuth('/api/ai/greeting', { signal: controller.signal });
    if (!response.ok) {
      log.warn('Greeting request failed', { status: response.status });
      return null;
    }
    // The API responded — record it, including the greeting:null case.
    markGreetingShown();
    const data = (await response.json().catch(() => null)) as AIGreetingResponse | null;
    if (!data || typeof data.greeting !== 'string' || data.greeting.trim().length === 0) {
      return null;
    }
    return data.greeting;
  } catch (error) {
    // Abort/timeout/network failures are expected — greeting is best-effort
    log.warn('Greeting fetch failed', { error: String(error) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Conversation History Helpers
// ============================================================================

/**
 * Converts AI messages to conversation history format.
 * Filters out system messages and errors.
 *
 * @param messages - AI messages from store
 * @param maxMessages - Maximum messages to include (default: 10)
 */
export function messagesToHistory(
  messages: AIMessage[],
  maxMessages: number = 10
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.role !== 'system' && !m.error && m.content)
    .slice(-maxMessages)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

// ============================================================================
// Quick Actions & Welcome Messages (re-exported — AI-006)
// ============================================================================

// The quick-action + welcome-message contract moved to
// src/lib/ai/assistant-surface.ts so the capability-catalog generator can
// import it without dragging in fetch-with-auth -> the Firebase client SDK.
// Re-exported here so existing consumers (AIChat, tests) keep importing from
// the chat service unchanged. See QUICK_ACTION_TOOLS there for the backing
// CORE tool(s) per action.
export {
  ALL_AI_PAGE_TYPES,
  getQuickActionsForContext,
  getQuickActionMessage,
  getWelcomeMessage,
  QUICK_ACTION_MESSAGES,
  QUICK_ACTION_TOOLS,
} from '@/lib/ai/assistant-surface';
