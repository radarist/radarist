/**
 * @file lib/mission-mcp-preflight.ts
 * @description Bounded, provider-free reachability + auth check for the in-tree
 * platform MCP servers a mission depends on (OPS-004).
 *
 * Every internal MCP is served by the same Next.js app at `IMPULSE_MCP_BASE_URL`.
 * When that base points at a port nothing is listening on (a stale profile / env
 * mismatch), or the mission's API key is invalid, every platform tool call is
 * refused and a mission burns its whole budget searching for tools that never
 * answer. This helper verifies the required platform endpoints at the ACTIVE
 * base URL BEFORE any provider call so callers can fail fast with a
 * machine-readable reason instead of paying to discover the misroute.
 *
 * Contract:
 * - **No provider calls** (no Gemini, no Anthropic) — only a JSON-RPC
 *   `tools/list` per endpoint. `ping` is auth-free and would prove only route
 *   reachability, so we probe an auth-REQUIRED method and PARSE the JSON-RPC
 *   body: the route returns a JSON-RPC error at HTTP 200 for an invalid/missing
 *   key, so `response.ok` alone would call a revoked key healthy. An endpoint is
 *   healthy only when it returns `200` with a JSON-RPC `result` and no `error`.
 * - **One canonical authority for the base URL** (OPS-004): `IMPULSE_MCP_BASE_URL`
 *   is mandatory for the app/worker/dispatch surface — the local-demo launcher
 *   and Compose generate it from the active profile. When it is absent the
 *   preflight fails LOUDLY ({@link MCP_BASE_URL_MISSING_REASON}) rather than
 *   silently defaulting to a port that may differ from the Orchestrator's.
 * - Every probe is bounded by `timeoutMs` (cold-start tolerant default) and
 *   never throws.
 */

import 'server-only';
import { createLogger } from '@/lib/logger';
import { INTERNAL_MCP_SERVERS } from '@/lib/mcp/internal-servers';

const log = createLogger('mission-mcp-preflight');

/**
 * The in-tree platform MCP servers the preflight probes — the one canonical
 * catalog shared with `/api/mcp/[server]`. Third-party stdio servers (exa,
 * arxiv, firecrawl, …) are deliberately NOT here: they are never served by this
 * app, so probing `/api/mcp/exa` would 404 and false-fail every mission.
 */
export const REQUIRED_INTERNAL_MCP_SERVERS = INTERNAL_MCP_SERVERS;

/** Machine-readable reason: one or more platform servers unreachable/unauthorized. */
export const MCP_PREFLIGHT_FAILED_REASON = 'mcp-preflight-failed' as const;
/** Machine-readable reason: the canonical base URL is not configured. */
export const MCP_BASE_URL_MISSING_REASON = 'mcp-base-url-missing' as const;
/** Machine-readable reason: the internal service key is not configured. */
export const MCP_INTERNAL_KEY_MISSING_REASON = 'mcp-internal-key-missing' as const;

export type MissionMcpPreflightReason =
  typeof MCP_PREFLIGHT_FAILED_REASON | typeof MCP_BASE_URL_MISSING_REASON | typeof MCP_INTERNAL_KEY_MISSING_REASON;

// Cold-start tolerant: the first request to a Next dynamic route triggers
// on-demand compilation that can take several seconds. A 2.5s bound false-fails
// the very first mission after a cold start; 10s comfortably covers compile +
// warm response while still bounding a truly dead endpoint.
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;

export interface MissionMcpPreflightResult {
  ok: boolean;
  /** Present only on failure. */
  reason?: MissionMcpPreflightReason;
  /** The active base URL that was probed (empty when unconfigured). */
  baseUrl: string;
  /** Server names that were probed. */
  checked: string[];
  /** Server names that did not answer `tools/list` with an authorized result. */
  unreachable: string[];
}

/** A read-only view of environment variables (accepts partial maps in tests). */
type EnvLike = Record<string, string | undefined>;

export interface PreflightMissionMcpOptions {
  env?: EnvLike;
  /** Override the server set (defaults to {@link REQUIRED_INTERNAL_MCP_SERVERS}). */
  servers?: readonly string[];
  /** Per-endpoint timeout in ms (default 10000, cold-start tolerant). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the canonical internal MCP base URL. Returns `undefined` when
 * `IMPULSE_MCP_BASE_URL` is absent/blank — the caller treats that as a loud
 * configuration failure rather than silently defaulting to a port that may not
 * match the Orchestrator's YAML-resolved base (OPS-004 authority contract).
 */
export function resolvePreflightBaseUrl(env: EnvLike = process.env): string | undefined {
  const raw = env['IMPULSE_MCP_BASE_URL']?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * The app/worker mission preflight probes with the EXACT internal service key
 * (`IMPULSE_INTERNAL_KEY`, admin-scoped) — the same key the worker hands the
 * Orchestrator. It deliberately does NOT fall back to `IMPULSE_API_KEY`: a valid
 * external or read-only key could make `tools/list` look healthy at dispatch and
 * then fail mission-bound writes in the worker, exactly the false-green the
 * preflight exists to prevent. Absent → loud config failure, never a silent
 * downgrade. (The standalone agent CLI keeps its own explicit `--api-key`
 * contract; it does not use this helper.)
 */
function resolveInternalServiceKey(env: EnvLike): string | undefined {
  return env['IMPULSE_INTERNAL_KEY']?.trim() || undefined;
}

/**
 * Probe one server with an auth-required `tools/list` and parse the JSON-RPC
 * body. Healthy iff HTTP 200 AND a JSON-RPC `result` is present AND no `error`
 * (a missing/invalid key yields a JSON-RPC error at HTTP 200).
 */
async function probeMcpServer(
  baseUrl: string,
  server: string,
  apiKey: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/${server}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      // SEC-013: never replay the admin-scoped internal key against a redirect
      // target. A redirected internal MCP route is treated as unreachable, which
      // fails the preflight closed, rather than authenticating to a new origin.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json().catch(() => null);
    if (body === null || typeof body !== 'object') return false;
    const record = body as { result?: unknown; error?: unknown };
    // A JSON-RPC error (e.g. invalid/revoked key, permission denied) arrives at
    // HTTP 200 — the body is the source of truth, not the status code.
    return record.error === undefined && record.result !== undefined;
  } catch {
    // Connection refused, DNS failure, or timeout — not reachable.
    return false;
  }
}

/**
 * Probe every required platform MCP endpoint at the canonical base URL with an
 * authenticated `tools/list`. Never throws. Returns a structured result:
 * - `mcp-base-url-missing` when `IMPULSE_MCP_BASE_URL` is unset (loud config
 *   failure, no silent default);
 * - `mcp-preflight-failed` when one or more endpoints are unreachable or the key
 *   is rejected.
 */
export async function preflightMissionMcp(
  options: PreflightMissionMcpOptions = {}
): Promise<MissionMcpPreflightResult> {
  const env = options.env ?? process.env;
  const servers = options.servers ?? REQUIRED_INTERNAL_MCP_SERVERS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const checked = servers.map(String);

  const baseUrl = resolvePreflightBaseUrl(env);
  if (baseUrl === undefined) {
    log.error('mission MCP preflight failed — IMPULSE_MCP_BASE_URL is not configured', undefined, { checked });
    return { ok: false, reason: MCP_BASE_URL_MISSING_REASON, baseUrl: '', checked, unreachable: checked };
  }

  const apiKey = resolveInternalServiceKey(env);
  if (apiKey === undefined) {
    log.error('mission MCP preflight failed — IMPULSE_INTERNAL_KEY is not configured', undefined, { baseUrl, checked });
    return { ok: false, reason: MCP_INTERNAL_KEY_MISSING_REASON, baseUrl, checked, unreachable: checked };
  }

  const probes = await Promise.all(
    servers.map(async (server) => ({
      server,
      ok: await probeMcpServer(baseUrl, server, apiKey, timeoutMs, fetchImpl),
    }))
  );
  const unreachable = probes.filter((probe) => !probe.ok).map((probe) => probe.server);

  if (unreachable.length === 0) {
    return { ok: true, baseUrl, checked, unreachable: [] };
  }

  log.error('mission MCP preflight failed — required internal servers unreachable or unauthorized', undefined, {
    baseUrl,
    unreachable,
    checked,
  });
  return { ok: false, reason: MCP_PREFLIGHT_FAILED_REASON, baseUrl, checked, unreachable };
}

/**
 * Stable, operator-facing remediation for each failure reason. Deliberately
 * URL-FREE: internal base URLs must never appear in an API/chat/worker/Agent
 * user-visible error (they leak deployment topology). The precise base URL and
 * unreachable server list are logged server-side on the structured result; the
 * caller surfaces only `reason` (a stable code) + this remediation.
 */
export function mcpPreflightRemediation(reason: MissionMcpPreflightReason | undefined): string {
  switch (reason) {
    case MCP_BASE_URL_MISSING_REASON:
      return 'The internal MCP base URL is not configured on the server. Set IMPULSE_MCP_BASE_URL and retry.';
    case MCP_INTERNAL_KEY_MISSING_REASON:
      return 'The internal MCP service key is not configured on the server. Set IMPULSE_INTERNAL_KEY and retry.';
    default:
      return 'Internal platform tools are temporarily unavailable. Confirm the app and its internal MCP service are running, then retry.';
  }
}

/**
 * One-line failure message: a stable reason code plus URL-free remediation.
 * Shared by the dispatch gate, route, chat tool, worker, and Agent so the
 * surfaced text is identical everywhere and never leaks an internal base URL.
 */
export function formatMcpPreflightFailure(result: MissionMcpPreflightResult): string {
  const reason = result.reason ?? MCP_PREFLIGHT_FAILED_REASON;
  return `${reason}: ${mcpPreflightRemediation(result.reason)}`;
}
