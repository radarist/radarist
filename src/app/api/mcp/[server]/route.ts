/**
 * @file /api/mcp/[server]
 * @description Domain MCP Server API Route
 *
 * Routes MCP JSON-RPC requests to one of 6 domain servers:
 *   - entities: Entity CRUD, enrichment, company operations
 *   - graph: GraphRAG, knowledge graph, Cypher queries
 *   - signals: Signal management, pipeline operations
 *   - research: Web research, page research
 *   - radar: Radar management, technology assessments
 *   - reports: Documents, claims, linker triage
 *
 * Authentication:
 *   - `initialize`, `ping`, `initialized` and `notifications/initialized`
 *     work WITHOUT auth (MCP protocol requirement)
 *   - All other methods require a valid API key via `x-api-key` header
 *     or `Authorization: Bearer <key>` header
 *   - `tools/list` and `tools/call` enforce per-key permissions
 *     (read/write/delete/signals/admin) — see hasToolPermission below.
 *     The synthetic internal key (IMPULSE_INTERNAL_KEY) carries ['admin'].
 *
 * JSON-RPC 2.0 format:
 *   Request:  { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
 *   Response: { "jsonrpc": "2.0", "id": 1, "result": { ... } }
 *   Error:    { "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "..." } }
 *
 * **Performance Note:**
 * Server modules are loaded via dynamic import() to prevent Turbopack from
 * eagerly compiling the entire AI tools + graph + Firebase module tree (~3764
 * modules) at route discovery time. Without deferred loading, the MCP route
 * doubles the dev server memory footprint.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { SYSTEM_PRINCIPAL } from '@/lib/system-principals';
import { JSON_RPC_ERROR_CODES } from '@/lib/mcp/types';
import type { ApiKeyPermission } from '@/lib/mcp/types';
import { getToolPermissions, isMissionBoundTool, missionBoundToolGuidance } from '@/lib/mcp/permissions';
import { isPromptResourceMethod, PROMPT_RESOURCE_CAPABILITIES } from '@/lib/mcp/prompt-resource-methods';
import { INTERNAL_MCP_SERVERS } from '@/lib/mcp/internal-servers';
import { getMissionById } from '@/lib/missions';
import type { Slot } from '@/lib/schemas/mission';
import { externalToolFailureToMcp } from '@/lib/mcp/external-tool-result';

const log = createLogger('api/mcp/[server]');

// ============================================================================
// Types (import type only — no runtime cost)
// ============================================================================

type DomainMcpServer = import('@/lib/mcp/servers/entities-server').DomainMcpServer;

// ============================================================================
// Constants
// ============================================================================

const MCP_PROTOCOL_VERSION = '2024-11-05';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-mission-id',
  'Access-Control-Max-Age': '86400',
};

/**
 * Valid platform-served MCP server names, from the one canonical catalog in
 * `@/lib/mcp/internal-servers` (OPS-004) so this route and the mission MCP
 * preflight can never disagree on which endpoints exist. Factory functions are
 * still loaded lazily via dynamic import() to avoid pulling in ~3764 transitive
 * modules at Turbopack compile time.
 */
const VALID_SERVERS = new Set<string>(INTERNAL_MCP_SERVERS);

/** Cache of instantiated domain servers (lazy singleton per server) */
const serverInstances = new Map<string, DomainMcpServer>();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Dynamically import and create a domain server by name.
 * Uses dynamic import() so Turbopack only compiles the module when
 * an actual request arrives, not during route discovery.
 */
async function getServerByName(name: string): Promise<DomainMcpServer | null> {
  if (!VALID_SERVERS.has(name)) {
    return null;
  }

  const cached = serverInstances.get(name);
  if (cached) return cached;

  let instance: DomainMcpServer;
  switch (name) {
    case 'entities': {
      const mod = await import('@/lib/mcp/servers/entities-server');
      instance = mod.createEntitiesServer();
      break;
    }
    case 'graph': {
      const mod = await import('@/lib/mcp/servers/graph-server');
      instance = mod.createGraphServer();
      break;
    }
    case 'signals': {
      const mod = await import('@/lib/mcp/servers/signals-server');
      instance = mod.createSignalsServer();
      break;
    }
    case 'research': {
      const mod = await import('@/lib/mcp/servers/research-server');
      instance = mod.createResearchServer();
      break;
    }
    case 'radar': {
      const mod = await import('@/lib/mcp/servers/radar-server');
      instance = mod.createRadarServer();
      break;
    }
    case 'reports': {
      const mod = await import('@/lib/mcp/servers/reports-server');
      instance = mod.createReportsServer();
      break;
    }
    // Phase 1: Gemini MCP servers
    case 'gemini-image': {
      const mod = await import('@/lib/mcp/servers/gemini-servers');
      instance = mod.createGeminiImageServer();
      break;
    }
    case 'gemini-embeddings': {
      const mod = await import('@/lib/mcp/servers/gemini-servers');
      instance = mod.createGeminiEmbeddingsServer();
      break;
    }
    case 'gemini-research': {
      const mod = await import('@/lib/mcp/servers/gemini-servers');
      instance = mod.createGeminiResearchServer();
      break;
    }
    case 'gemini-grounding': {
      const mod = await import('@/lib/mcp/servers/gemini-servers');
      instance = mod.createGeminiGroundingServer();
      break;
    }
    case 'super-graph': {
      const mod = await import('@/lib/mcp/servers/super-graph-server');
      instance = mod.createSuperGraphServer();
      break;
    }
    default:
      return null;
  }

  serverInstances.set(name, instance);
  return instance;
}

/**
 * Create a successful JSON-RPC 2.0 response.
 */
function jsonRpcResponse(id: string | number | null, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200, headers: CORS_HEADERS });
}

/**
 * Create an error JSON-RPC 2.0 response.
 */
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  httpStatus: number = 200
): NextResponse {
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status: httpStatus, headers: CORS_HEADERS }
  );
}

/**
 * Extract API key from request headers.
 * Supports both `x-api-key` header and `Authorization: Bearer <key>` format.
 */
function extractApiKey(request: NextRequest): string | null {
  const xApiKey = request.headers.get('x-api-key');
  if (xApiKey) return xApiKey;

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Resolve the permissions required to execute a tool.
 *
 * Delegates to the one map (AUDIT-002). This used to carry its OWN verb-prefix
 * inference as a second net over the map — but it was a second source of truth,
 * and it had the same fatal ending as the map's old default: `return ['read']`.
 * Anything the verb list missed became readable-by-anyone. `recordKnowledgeGap`
 * writes to Neo4j and matched no verb, so it slipped through both nets at once.
 *
 * `getToolPermissions` now fails closed, and `permissions-coverage.test.ts`
 * asserts every MCP-exposed tool is explicitly mapped — a review step that a
 * regex over tool names can only ever approximate.
 */
function requiredToolPermissions(toolName: string): ApiKeyPermission[] {
  return getToolPermissions(toolName);
}

/**
 * Permission gate ported from the legacy single-server implementation
 * (src/lib/mcp/server.ts → canExecuteTool): a key must hold every
 * permission a tool requires. The synthetic internal key carries
 * ['admin'] and therefore passes unconditionally — missions keep full
 * tool access.
 */
function hasToolPermission(permissions: ApiKeyPermission[], toolName: string): boolean {
  if (permissions.includes('admin')) {
    return true;
  }
  return requiredToolPermissions(toolName).every((perm) => permissions.includes(perm));
}

// ============================================================================
// OPTIONS Handler (CORS preflight)
// ============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ============================================================================
// POST Handler (JSON-RPC requests)
// ============================================================================

/**
 * ARUN-022 C — dispatch one MCP tool call inside an operation-usage receipt
 * scope, so nested provider spend (Gemini text/grounded/image/research
 * chokepoints) captured during the call is persisted as durable receipts under a
 * SERVER-RESOLVED correlation:
 *   - a mission-bound call flushes under the mission, classified
 *     `additional-to-parent` (the mission headline counts the orchestrator's own
 *     spend, not this nested MCP tool spend — so it adds once, never twice);
 *   - a standalone external call flushes under an `mcp` correlation, classified
 *     `standalone` (it has no parent headline to fold into).
 *
 * Best-effort and non-fatal: the tool result is returned unchanged whether or not
 * the ledger loads or the flush succeeds — accounting never breaks a tool call.
 * The receipt owner is the server-resolved principal, NEVER a caller-supplied
 * value. AsyncLocalStorage does not cross the HTTP boundary, which is exactly why
 * a distributed MCP call needs its own scope opened here.
 */
async function dispatchToolWithReceipts(
  domainServer: DomainMcpServer,
  toolName: string,
  toolArgs: Record<string, unknown>,
  callContext: import('@/lib/mcp/servers/entities-server').McpCallContext,
  correlation: { owner: string; missionId?: string }
): Promise<Awaited<ReturnType<DomainMcpServer['callTool']>>> {
  let instrument: typeof import('@/lib/operation-receipt-instrument') | undefined;
  try {
    instrument = await import('@/lib/operation-receipt-instrument');
  } catch (err) {
    log.warn('operation-usage instrumentation unavailable; dispatching MCP tool without receipts', {
      error: err instanceof Error ? err.message : String(err),
      tool: toolName,
    });
  }
  if (!instrument) {
    return domainServer.callTool(toolName, toolArgs, callContext);
  }

  const { result, captured } = await instrument.withCapturedUsage(() =>
    domainServer.callTool(toolName, toolArgs, callContext)
  );

  if (captured.length > 0) {
    try {
      const { randomUUID } = await import('node:crypto');
      const requestReceiptId = `mcp-${randomUUID()}`;
      if (correlation.missionId) {
        await instrument.flushCapturedUsage(
          {
            parentType: 'mission',
            owner: correlation.owner,
            correlationId: `mission-${correlation.missionId}`,
            missionId: correlation.missionId,
          },
          captured,
          requestReceiptId,
          'additional-to-parent'
        );
      } else {
        await instrument.flushCapturedUsage(
          { parentType: 'mcp', owner: correlation.owner, correlationId: requestReceiptId },
          captured,
          requestReceiptId,
          'standalone'
        );
      }
    } catch (receiptError) {
      log.warn('operation-usage receipt flush failed (non-fatal)', {
        error: receiptError instanceof Error ? receiptError.message : String(receiptError),
        tool: toolName,
      });
    }
  }
  return result;
}

/**
 * POST /api/mcp/[server]
 *
 * Handles MCP JSON-RPC 2.0 requests and routes them to the appropriate
 * domain server.
 *
 * MCP methods:
 *   - `initialize` (no auth): Returns server capabilities
 *   - `ping` (no auth): Returns empty result
 *   - `initialized` / `notifications/initialized` (no auth): Client
 *     acknowledgment notification (202 when sent without an id)
 *   - `tools/list` (auth required): Lists tools the key may execute
 *   - `tools/call` (auth required): Executes a tool the key has permission for
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ server: string }> }) {
  const { server: serverName } = await params;

  // Validate server name
  const domainServer = await getServerByName(serverName);
  if (!domainServer) {
    return NextResponse.json(
      {
        error: 'Not Found',
        message: `Unknown MCP server: '${serverName}'. Valid servers: ${Array.from(VALID_SERVERS).join(', ')}`,
      },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  // Parse JSON-RPC request
  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
          message: 'Parse error: Invalid JSON',
        },
      },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { method, id = null, params: rpcParams } = body;

  if (!method) {
    return jsonRpcError(id, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Missing required field: method');
  }

  log.debug('MCP request', { server: serverName, method, id });

  try {
    // -----------------------------------------------------------------------
    // No-auth methods (MCP protocol requirement)
    // -----------------------------------------------------------------------

    if (method === 'initialize') {
      return jsonRpcResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          // SKILL-042 — this dispatcher now serves `prompts/*` and
          // `resources/*` too, so it advertises them. A spec-compliant client
          // only asks for a capability the server declared, which is why the
          // declaration and the handlers ship from one module.
          ...PROMPT_RESOURCE_CAPABILITIES,
        },
        serverInfo: {
          name: domainServer.name,
          version: domainServer.version,
        },
      });
    }

    if (method === 'ping') {
      return jsonRpcResponse(id, {});
    }

    // `initialized` / `notifications/initialized` are client notifications
    // (no response expected per MCP spec — spec-compliant clients send the
    // `notifications/initialized` form without an id). Notifications get an
    // HTTP 202 with no body; clients that supply an id get the legacy empty
    // result acknowledgment for backward compatibility.
    if (method === 'initialized' || method === 'notifications/initialized') {
      if (id === null) {
        return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
      }
      return jsonRpcResponse(id, {});
    }

    // -----------------------------------------------------------------------
    // Auth-required methods
    // -----------------------------------------------------------------------

    const apiKeyString = extractApiKey(request);
    if (!apiKeyString) {
      return jsonRpcError(
        id,
        JSON_RPC_ERROR_CODES.UNAUTHORIZED,
        'Authentication required. Provide API key via x-api-key header or Authorization: Bearer <key>'
      );
    }

    // Internal service auth: accept IMPULSE_INTERNAL_KEY for server-side callers
    // (e.g., Orchestrator running inside Inngest functions).
    const internalKey = process.env.IMPULSE_INTERNAL_KEY;
    const isInternalCall = internalKey && apiKeyString === internalKey;

    const { validateApiKey } = await import('@/lib/mcp/api-keys');
    let apiKey: Awaited<ReturnType<typeof validateApiKey>> | null = null;

    if (isInternalCall) {
      // Synthetic key for internal calls — full permissions, system user
      apiKey = {
        id: 'internal',
        hashedKey: '',
        userId: SYSTEM_PRINCIPAL,
        name: 'Internal Service Key',
        permissions: ['admin'],
        createdAt: 0,
        expiresAt: null,
        revokedAt: null,
      };
    } else {
      apiKey = await validateApiKey(apiKeyString);
    }

    if (!apiKey) {
      return jsonRpcError(id, JSON_RPC_ERROR_CODES.UNAUTHORIZED, 'Invalid or expired API key');
    }

    // -- prompts/* and resources/* ------------------------------------------

    // SKILL-042 — the skill-prompt manifest and the memory resources were
    // implemented and mounted only on the aggregate `/api/mcp` gateway, which
    // does not accept the internal key; this per-domain dispatcher — the one
    // the mission runtime and per-domain client configs use — answered
    // `Method not found`. Both transports now delegate to the SAME module, so
    // the permission gate, the daily read budget, and the no-existence-leak
    // rule cannot diverge between them.
    //
    // The prompt/resource surface is server-independent by construction: it is
    // the skill library and the caller's own memory, not this domain's tools.
    // Every domain therefore answers identically, which is what lets a client
    // connected to one domain server still reach the skills.
    //
    // Nothing mission-bound is exposed here: mission-binding is a property of
    // specific TOOLS (draftReport / publishReport), and `tools/list` below
    // still hides those without `x-mission-id`. No prompt or resource is
    // mission-scoped, so this path adds no mission-bound surface to hide.
    if (isPromptResourceMethod(method)) {
      const { handlePromptResourceMethod } = await import('@/lib/mcp/prompt-resource-methods');
      const outcome = await handlePromptResourceMethod(method, rpcParams, apiKey);
      if (outcome.ok) {
        log.info(method, { server: serverName, userId: apiKey.userId });
        return jsonRpcResponse(id, outcome.result);
      }
      // This dispatcher answers JSON-RPC errors with HTTP 200 except where it
      // already deviates for a hard authorization denial (403), matching how
      // tools/call reports a permission failure on this route.
      return jsonRpcError(id, outcome.code, outcome.message, outcome.httpStatus === 403 ? 403 : 200);
    }

    // -- tools/list --------------------------------------------------------

    if (method === 'tools/list') {
      const allTools = domainServer.getTools();

      // Permission gate: only advertise tools the key may actually execute
      // (parity with legacy src/lib/mcp/server.ts handleToolsList filtering).
      // Mission-bound tools (draftReport, publishReport) are additionally
      // hidden unless a mission context is bound via x-mission-id — the
      // orchestrator sets that header on every internal HTTP call, so
      // missions still see them; direct external clients don't.
      const missionBoundVisible = Boolean(request.headers.get('x-mission-id'));
      const permittedTools = allTools.filter(
        (t) => hasToolPermission(apiKey.permissions, t.name) && (missionBoundVisible || !isMissionBoundTool(t.name))
      );

      // Task 1.8: Tool-level curation — filter by allowedTools if provided
      const allowedTools = rpcParams?.allowedTools as string[] | undefined;
      const tools = allowedTools ? permittedTools.filter((t) => allowedTools.includes(t.name)) : permittedTools;

      log.info('tools/list', {
        server: serverName,
        toolCount: tools.length,
        permittedTools: permittedTools.length,
        totalTools: allTools.length,
        filtered: !!allowedTools,
        userId: apiKey.userId,
      });
      return jsonRpcResponse(id, { tools });
    }

    // -- tools/call --------------------------------------------------------

    if (method === 'tools/call') {
      const toolName = rpcParams?.name as string | undefined;
      const toolArgs = (rpcParams?.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        return jsonRpcError(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Missing required parameter: name');
      }

      // Permission gate (parity with legacy src/lib/mcp/server.ts
      // handleToolsCall): reject before any tool code runs. The internal
      // synthetic key holds ['admin'] and is never rejected here.
      if (!hasToolPermission(apiKey.permissions, toolName)) {
        const required = requiredToolPermissions(toolName);
        log.warn('Permission denied for tool', {
          server: serverName,
          tool: toolName,
          required,
          permissions: apiKey.permissions,
          userId: apiKey.userId,
        });
        return jsonRpcError(
          id,
          JSON_RPC_ERROR_CODES.FORBIDDEN,
          `Permission denied for tool: ${toolName}. Required permissions: ${required.join(', ')}`,
          403
        );
      }

      const missionIdHeader = request.headers.get('x-mission-id') ?? undefined;

      // Mission-bound tools require a bound mission context — without
      // x-mission-id the executor would reject with the opaque "missionId
      // not bound". Return a self-remediating error instead so external
      // clients learn the supported path (startMission).
      if (!missionIdHeader && isMissionBoundTool(toolName)) {
        log.info('Mission-bound tool called without mission context', {
          server: serverName,
          tool: toolName,
          userId: apiKey.userId,
        });
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: missionBoundToolGuidance(toolName) }],
          isError: true,
        });
      }

      log.info('tools/call', {
        server: serverName,
        tool: toolName,
        userId: apiKey.userId,
        ...(missionIdHeader ? { missionId: missionIdHeader } : {}),
      });

      // Resolve mission.slots AND mission.userId from Firestore (single point
      // of truth) so downstream tools can server-enforce slot cap and per-user
      // authorization. Best-effort: if lookup fails, log and proceed with
      // both undefined — the slot-cap check in publishReport will reject
      // loudly rather than silently, and the userId falls back to the
      // calling apiKey's userId.
      let slots: Slot[] | undefined;
      let missionOwnerId: string | undefined;
      let designBrief: import('@/lib/schemas/design-brief').DesignBrief | undefined;
      let evidenceBundle: import('@/lib/schemas/scout-bundle').ScoutBundle | undefined;
      let evidenceProvenance: import('@/lib/schemas/scout-bundle').EvidenceProvenanceReceipt | undefined;
      if (missionIdHeader) {
        try {
          const mission = await getMissionById(missionIdHeader);
          slots = mission?.slots;
          missionOwnerId = mission?.userId;
          designBrief = mission?.designBrief;
          evidenceBundle = mission?.evidenceBundle;
          evidenceProvenance = mission?.evidenceProvenance;
          if (!evidenceBundle && mission?.prompt) {
            const { parseScoutBundle } = await import('@/lib/scout-bundle-parser');
            const parsedBundle = parseScoutBundle(mission.prompt);
            if (parsedBundle.ok) evidenceBundle = parsedBundle.bundle;
          }
        } catch (err) {
          log.warn('failed to fetch mission for slot/owner context', {
            missionId: missionIdHeader,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Mission ownership gate. When a mission is bound, the mission owner
      // becomes the effective userId (below), so the created report/document is
      // attributed to — and lands in the Storage/Firestore namespace of — the
      // human who launched the mission. Only the internal orchestrator (the
      // synthetic ['admin'] key) is trusted to act as another user; a regular
      // external key MUST own the mission it binds. Otherwise a holder of any
      // default write key could set x-mission-id to a victim's mission and forge
      // an attacker-controlled write (e.g. draftDocument) into the victim's
      // namespace. When the mission lookup failed (missionOwnerId undefined) we
      // skip the check and fall back to the caller's own userId — no forgery is
      // possible without a resolved owner.
      if (missionOwnerId && missionOwnerId !== apiKey.userId && !apiKey.permissions.includes('admin')) {
        log.warn('Rejected mission-bound call: caller does not own the bound mission', {
          server: serverName,
          tool: toolName,
          missionId: missionIdHeader,
          callerUserId: apiKey.userId,
        });
        return jsonRpcError(id, JSON_RPC_ERROR_CODES.FORBIDDEN, 'Mission does not belong to this API key', 403);
      }

      // When a mission is bound, prefer the mission's dispatcher as the
      // effective userId — the orchestrator's IMPULSE_INTERNAL_KEY resolves
      // to the synthetic 'system' user, but reports / authorization decisions
      // must scope to the human who launched the mission.
      const effectiveUserId = missionOwnerId ?? apiKey.userId;

      const callContext: import('@/lib/mcp/servers/entities-server').McpCallContext = {
        userId: effectiveUserId,
        ...(missionIdHeader ? { missionId: missionIdHeader } : {}),
        ...(slots ? { slots } : {}),
        ...(designBrief ? { designBrief } : {}),
        ...(evidenceBundle ? { evidenceBundle } : {}),
        ...(evidenceProvenance ? { evidenceProvenance } : {}),
      };

      // ARUN-022 C — open an operation-usage receipt scope STRICTLY around the
      // real tool invocation, and only here (every auth/permission/ownership gate
      // above returns before this point, so tools/list and denied calls stay
      // zero-spend with no receipt). Nested provider spend inside the tool
      // (Gemini/image/research chokepoints) is captured and flushed under a
      // SERVER-RESOLVED correlation — the owner is derived from the authenticated
      // key / mission owner, never from the caller's body. AsyncLocalStorage does
      // not cross the Agent/build HTTP boundary, so this is where a distributed
      // MCP call gets its own scope. Best-effort and non-fatal: a ledger failure
      // never perturbs the tool result.
      const result = await dispatchToolWithReceipts(domainServer, toolName, toolArgs, callContext, {
        owner: `user:${effectiveUserId}`,
        // Classify spend under the mission ONLY when the mission was actually
        // resolved and its ownership verified (missionOwnerId is set). A missing
        // or failed x-mission-id lookup must NOT attribute spend to a nonexistent
        // parent — such a call records as standalone under the resolved owner.
        missionId: missionIdHeader && missionOwnerId !== undefined ? missionIdHeader : undefined,
      });
      return jsonRpcResponse(id, result);
    }

    // -- Unknown method ----------------------------------------------------

    return jsonRpcError(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('MCP request failed', error instanceof Error ? error : new Error(message), {
      server: serverName,
      method,
    });

    // A domain server should normally contain tool failures itself, but keep
    // the HTTP boundary fail-closed too. Otherwise a thrown provider response
    // can be copied into JSON-RPC's trusted `error.message` by this final catch.
    const failedToolName = method === 'tools/call' ? rpcParams?.name : undefined;
    if (typeof failedToolName === 'string') {
      const framedFailure = externalToolFailureToMcp(failedToolName, error);
      if (framedFailure) return jsonRpcResponse(id, framedFailure);
    }

    return jsonRpcError(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, `Internal error: ${message}`, 500);
  }
}
