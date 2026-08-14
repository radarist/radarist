/**
 * @file mcp/prompt-resource-methods.ts
 * @description SKILL-042 — the one implementation of the MCP `prompts/*` and
 * `resources/*` methods, shared by both transports.
 *
 * These four methods were implemented once and mounted once: only the aggregate
 * `/api/mcp` gateway routed to them, via `handleMcpRequest` in `server.ts`. The
 * per-domain dispatcher `/api/mcp/<server>` — the endpoint the mission runtime
 * and every per-domain client config actually use — answered `Method not found`,
 * so the generated skill-prompt manifest and the memory resources were
 * unreachable from there.
 *
 * Rather than copy the bodies into the second route (a second permission gate,
 * a second budget call, a second error-collapsing rule to drift apart), the
 * bodies live here and both routes delegate. Each returns a transport-neutral
 * outcome that the caller renders as JSON-RPC.
 *
 * What is deliberately NOT here: authentication. Each transport resolves its
 * own `ApiKey` first (the domain route additionally accepts the synthetic
 * internal key) and passes the resolved key in. These functions decide
 * authorization only.
 */

import { checkAndConsume } from './budget';
import { handlePromptsGet, handlePromptsList, type PromptsGetParams } from './prompts';
import { InvalidResourceUriError } from './resource-uris';
import { listResources, readResource, ResourceNotFoundError } from './resources';
import { JSON_RPC_ERROR_CODES, type ApiKey } from './types';

/**
 * Transport-neutral method outcome. `httpStatus` is the status the aggregate
 * gateway has always returned for this condition; the domain dispatcher keeps
 * its own convention of answering JSON-RPC errors with HTTP 200 except where it
 * already deviates (403), so it maps this field rather than echoing it.
 */
export type McpMethodOutcome =
  { ok: true; result: unknown } | { ok: false; code: number; message: string; httpStatus: number };

/**
 * Whether `apiKey` may read from the `resources/*` surface.
 *
 * Direct, target-independent check on the caller's own grants — deliberately
 * NOT `canExecuteTool`, whose admin short-circuit must never be the mechanism
 * that grants resource access. This gate only decides "may this key read shared
 * resources at all"; per-user memory is independently protected by the owner
 * check inside `readResource` (`assertOwner`), which uses userIds, not grants —
 * so an admin key still cannot read another user's memory.
 */
export function hasResourceReadAccess(apiKey: ApiKey): boolean {
  return apiKey.permissions.includes('read') || apiKey.permissions.includes('admin');
}

function budgetExhausted(remaining: number): McpMethodOutcome {
  return {
    ok: false,
    code: JSON_RPC_ERROR_CODES.RATE_LIMITED,
    message: `Daily read budget exhausted (remaining: ${remaining}). Resets at the next UTC day.`,
    httpStatus: 429,
  };
}

/**
 * `prompts/list` — the generated skill manifest plus the legacy reasoning
 * patterns the key's permissions allow. Skills are public analytical methods,
 * so there is no per-skill permission and nothing mission-bound to hide; the
 * read budget is charged on `prompts/get`, where a body is actually served.
 */
export function promptsList(apiKey: ApiKey): McpMethodOutcome {
  return { ok: true, result: handlePromptsList(apiKey) };
}

/** `prompts/get` — budget-gated, hash-verified, untrusted-framed prompt body. */
export async function promptsGet(params: unknown, apiKey: ApiKey): Promise<McpMethodOutcome> {
  const budget = await checkAndConsume(apiKey.id, 1);
  if (!budget.allowed) return budgetExhausted(budget.remaining);

  return { ok: true, result: handlePromptsGet((params ?? {}) as PromptsGetParams, apiKey) };
}

/**
 * `resources/list` — principal-scoped: the caller's own per-user memory
 * resources plus the shared community-reports overlay. No userId other than the
 * caller's own is ever embedded in a listed URI.
 */
export async function resourcesList(apiKey: ApiKey): Promise<McpMethodOutcome> {
  if (!hasResourceReadAccess(apiKey)) {
    return {
      ok: false,
      code: JSON_RPC_ERROR_CODES.FORBIDDEN,
      message: 'Permission denied: resources/list requires the "read" permission',
      httpStatus: 403,
    };
  }
  return { ok: true, result: { resources: await listResources(apiKey.userId) } };
}

/** `resources/read` — permission-gated, budget-gated, existence-leak-free. */
export async function resourcesRead(params: unknown, apiKey: ApiKey): Promise<McpMethodOutcome> {
  const uri = (params as { uri?: unknown } | undefined)?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    return {
      ok: false,
      code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      message: 'resources/read requires a non-empty string "uri" parameter',
      httpStatus: 400,
    };
  }

  // Read-permission gate. Caller-scoped and target-independent, so a denial
  // here cannot leak whether any particular resource exists.
  if (!hasResourceReadAccess(apiKey)) {
    return {
      ok: false,
      code: JSON_RPC_ERROR_CODES.FORBIDDEN,
      message: 'Permission denied: resources/read requires the "read" permission',
      httpStatus: 403,
    };
  }

  // Durable per-key daily read budget — deny BEFORE the read happens.
  const budget = await checkAndConsume(apiKey.id, 1);
  if (!budget.allowed) return budgetExhausted(budget.remaining);

  try {
    return { ok: true, result: { contents: [await readResource(uri, apiKey.userId)] } };
  } catch (error) {
    // No-existence-leak guarantee: a cross-tenant denial, a genuine absence,
    // and a malformed `radarist://` URI all collapse to the SAME NOT_FOUND wire
    // response — the host can never distinguish "you may not read this" from
    // "this does not exist". Only the caller's own echoed URI appears in the
    // message. Any other (unexpected) reader failure rethrows to the caller's
    // generic 500 path.
    if (error instanceof ResourceNotFoundError || error instanceof InvalidResourceUriError) {
      return {
        ok: false,
        code: JSON_RPC_ERROR_CODES.NOT_FOUND,
        message: `Resource not found: ${uri}`,
        httpStatus: 404,
      };
    }
    throw error;
  }
}

/** The MCP methods this module serves, for a transport's dispatch check. */
export const PROMPT_RESOURCE_METHODS = ['prompts/list', 'prompts/get', 'resources/list', 'resources/read'] as const;

export type PromptResourceMethod = (typeof PROMPT_RESOURCE_METHODS)[number];

export function isPromptResourceMethod(method: string): method is PromptResourceMethod {
  return (PROMPT_RESOURCE_METHODS as readonly string[]).includes(method);
}

/**
 * Dispatch one `prompts/*` / `resources/*` method for an already-authenticated
 * key. Both transports call this so the method set can never diverge between
 * them.
 */
export async function handlePromptResourceMethod(
  method: PromptResourceMethod,
  params: unknown,
  apiKey: ApiKey
): Promise<McpMethodOutcome> {
  switch (method) {
    case 'prompts/list':
      return promptsList(apiKey);
    case 'prompts/get':
      return promptsGet(params, apiKey);
    case 'resources/list':
      return resourcesList(apiKey);
    case 'resources/read':
      return resourcesRead(params, apiKey);
  }
}

/**
 * Capabilities the `prompts/*` + `resources/*` surface advertises on
 * `initialize`. A transport must merge this in only when it actually serves
 * these methods — advertising a capability that answers `Method not found` is
 * how a spec-compliant client is taught never to ask again.
 */
export const PROMPT_RESOURCE_CAPABILITIES = {
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
} as const;
