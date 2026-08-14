/**
 * @file openrouter-transport.ts
 * @description AI-033 — opt-in OpenRouter transport resolution for the Claude
 * chat loop ONLY.
 *
 * Fail-closed by construction: every gate below must hold or the transport is
 * reported disabled (with a reason) and the caller keeps its first-party
 * Anthropic / Gemini behavior. Nothing here changes mission agents, build
 * sandboxes, or any non-Claude path.
 *
 * Gates (ALL required):
 *  1. `OPENROUTER_API_KEY` present and non-placeholder. Read from `process.env`
 *     only — a server secret, never a `NEXT_PUBLIC_*` value, never bundled to
 *     the client. Sent as a Bearer token; the caller must pass it as the SDK's
 *     `authToken` with `apiKey: null` so no second `x-api-key` header is sent.
 *  2. The base URL is an APPROVED HTTPS origin (host allow-list + https). A
 *     server key is never sent over plaintext or to an unapproved host.
 *  3. `CLAUDE_CHAT_MODEL` is explicitly set to an `anthropic/*` OpenRouter slug.
 *     No default is minted, and non-Claude slugs are refused — this transport
 *     can only ever carry a Claude model (AI-033 scope).
 *
 * Env changes require a server restart (values are read from `process.env`).
 */
import { isPlaceholderKey } from './key-resolution';

/**
 * OpenRouter's Anthropic-compatible skin base. The Anthropic SDK appends
 * `/v1/messages` to this. (The `/api/v1` form is OpenRouter's OpenAI-compatible
 * endpoint and is intentionally NOT used here.)
 */
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** Approved OpenRouter origin hosts. HTTPS is additionally required. */
const APPROVED_OPENROUTER_HOSTS: ReadonlySet<string> = new Set(['openrouter.ai']);

export type OpenRouterDisabledReason = 'no-key' | 'unapproved-origin' | 'model-not-explicit-anthropic';

export type OpenRouterChatTransport =
  | { enabled: true; baseURL: string; apiKey: string; model: string }
  | { enabled: false; reason: OpenRouterDisabledReason };

/**
 * True only for an `https:` URL whose host is exactly on the approved list.
 * A lookalike such as `openrouter.ai.evil.com` fails because its parsed host is
 * not the approved host.
 */
export function isApprovedOpenRouterOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && APPROVED_OPENROUTER_HOSTS.has(url.hostname);
}

/**
 * Resolves the opt-in OpenRouter chat transport from the environment,
 * fail-closed. The returned descriptor is `enabled: false` (with a `reason`
 * for logging) whenever any gate is unmet, so callers can safely branch to
 * first-party Anthropic / Gemini.
 */
export function resolveOpenRouterChatTransport(): OpenRouterChatTransport {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || isPlaceholderKey(apiKey)) {
    return { enabled: false, reason: 'no-key' };
  }

  const baseURL = process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL;
  if (!isApprovedOpenRouterOrigin(baseURL)) {
    return { enabled: false, reason: 'unapproved-origin' };
  }

  const model = process.env.CLAUDE_CHAT_MODEL?.trim();
  if (!model || !model.startsWith('anthropic/')) {
    return { enabled: false, reason: 'model-not-explicit-anthropic' };
  }

  return { enabled: true, baseURL, apiKey, model };
}
