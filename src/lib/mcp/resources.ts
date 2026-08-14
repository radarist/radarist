/**
 * @file mcp/resources.ts
 * @description Resource ACL + list/read surface (L3 Memory-as-resources).
 *
 * Exposes per-user temporal memory (episodes / interest-profile / insights /
 * sessions) plus the shared community-reports overlay over the MCP transport.
 *
 * Security contract (Lane D — the sprint's highest-risk surface):
 *   - Per-user resources are OWNER-ONLY. key-A must never read key-B's memory.
 *     The ACL is resolved DIRECTLY via {@link assertOwner}, keyed to the
 *     authenticated principal's userId.
 *   - Admin permission must NOT bypass the owner check. We deliberately do NOT
 *     route through `canExecuteTool` / `hasPermission` — those carry the three
 *     admin short-circuits (`permissions.ts:296`, `api-keys.ts:378`,
 *     `[server]/route.ts:249`) which would leak cross-user memory. The proven
 *     template is the owner check at `report-tools.ts:516`.
 *   - A cross-tenant denial is indistinguishable from "resource not found"
 *     (mirror `report-tools.ts:516` `return {found:false}`): we throw
 *     {@link ResourceNotFoundError}, never confirming whether the victim has
 *     any data.
 *   - `radarist://graph/community-reports?q=` is SHARED/global — no owner check.
 *   - `getActiveUserIds` (`session-memory.ts:309`) is intentionally NOT imported
 *     here; it must never be reachable from this surface.
 *   - Every returned body is framed through `frameAsData` (untrusted boundary)
 *     so injected instructions in stored memory cannot steer the host model.
 *
 * @author Radarist Team
 * @created 2026-06-26
 */

import { createLogger } from '@/lib/logger';
import { queryEpisodes } from '@/lib/graph/episodes';
import { getInterestProfile } from '@/lib/graph/interest-profile';
import { getInsightsForUser } from '@/lib/graph/proactive-insights';
import { getExploredEntities } from '@/lib/graph/session-memory';
import { queryCommunityReports } from '@/lib/graph/community-reports';

import { frameAsData } from './untrusted';
import {
  parseUri,
  buildUri,
  MEMORY_RESOURCE_KINDS,
  type MemoryResourceUri,
  type GraphCommunityReportsUri,
  type MemoryResourceKind,
} from './resource-uris';
import type { McpResource, McpResourceContents } from './types';

const log = createLogger('mcp/resources');

const RESOURCE_MIME = 'text/plain';

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when a `radarist://` resource cannot be served — either because no
 * such resource exists OR because the caller is not its owner. The two cases
 * are deliberately collapsed so a denial never leaks the existence (or
 * non-existence) of another user's data. Echoes only the requested URI, which
 * the caller already constructed.
 */
export class ResourceNotFoundError extends Error {
  public readonly uri: string;

  constructor(uri: string) {
    super(`Resource not found: ${JSON.stringify(uri)}`);
    this.name = 'ResourceNotFoundError';
    this.uri = uri;
  }
}

/**
 * Internal deny signal raised by {@link assertOwner}. Carries NO ids and NO
 * URI — a generic, information-free refusal. Callers serving the resource
 * surface translate this into {@link ResourceNotFoundError} so the wire form
 * cannot distinguish "denied" from "absent".
 */
export class ResourceAccessDeniedError extends Error {
  constructor() {
    super('Access denied');
    this.name = 'ResourceAccessDeniedError';
  }
}

// ============================================================================
// ACL primitive
// ============================================================================

/**
 * Deny-by-default owner check. Throws unless `callerUserId` is a non-empty
 * string that exactly equals `resourceOwnerId`. Fails closed on any
 * empty/undefined id (no `"" === ""` pass-through). Admin does NOT bypass this
 * — it takes userIds only, never permissions.
 *
 * @throws {ResourceAccessDeniedError} on any mismatch or empty id.
 */
export function assertOwner(callerUserId: string, resourceOwnerId: string): void {
  if (
    typeof callerUserId !== 'string' ||
    callerUserId.length === 0 ||
    typeof resourceOwnerId !== 'string' ||
    resourceOwnerId.length === 0 ||
    callerUserId !== resourceOwnerId
  ) {
    throw new ResourceAccessDeniedError();
  }
}

// ============================================================================
// list
// ============================================================================

const MEMORY_DESCRIPTIONS: Record<MemoryResourceKind, string> = {
  episodes: 'Your agent episodes — temporal memory of what missions observed.',
  'interest-profile': 'Your learned interest profile (vertical + topics).',
  insights: 'Your proactive insights — connections and discoveries surfaced for you.',
  sessions: 'Entities you explored recently, derived from your session history.',
};

/**
 * List the resources visible to `callerUserId`: the caller's own per-user
 * memory resources plus the shared community-reports resource.
 *
 * Principal-scoped by construction — the only userId ever embedded in a listed
 * URI is the caller's own. No IO; no reader is consulted; `getActiveUserIds`
 * is unreachable. Fails closed for an empty principal (lists shared-only).
 */
export async function listResources(callerUserId: string): Promise<McpResource[]> {
  const resources: McpResource[] = [];

  // Per-user memory — only when we have a valid principal. An empty id would
  // both be a fail-closed violation and break `buildUri` (rejects empty userId).
  if (typeof callerUserId === 'string' && callerUserId.length > 0) {
    for (const kind of MEMORY_RESOURCE_KINDS) {
      resources.push({
        uri: buildUri({ scheme: 'memory', kind, userId: callerUserId }),
        name: `memory/${kind}`,
        description: MEMORY_DESCRIPTIONS[kind],
        mimeType: RESOURCE_MIME,
      });
    }
  }

  // Shared, global community-reports overlay. Listed with an empty query as a
  // discoverable template; callers supply `?q=<query>` on read.
  resources.push({
    uri: buildUri({ scheme: 'graph', kind: 'community-reports', query: '' }),
    name: 'graph/community-reports',
    description: 'Shared community summaries. Supply ?q=<query> to retrieve the most relevant reports.',
    mimeType: RESOURCE_MIME,
  });

  return resources;
}

// ============================================================================
// read
// ============================================================================

/**
 * Read a single resource by `radarist://` URI on behalf of `callerUserId`,
 * enforcing the owner ACL for per-user resources.
 *
 * @throws {InvalidResourceUriError} if `uri` does not match the grammar.
 * @throws {ResourceNotFoundError} if the caller may not read it OR it is not a
 *   readable resource on this surface (skill manifests are served via
 *   `prompts/*`, not here). Denial and absence are intentionally identical.
 */
export async function readResource(uri: string, callerUserId: string): Promise<McpResourceContents> {
  // May throw InvalidResourceUriError for a malformed URI — that is an honest
  // client error and is allowed to propagate distinctly.
  const parsed = parseUri(uri);

  switch (parsed.scheme) {
    case 'memory':
      return readMemoryResource(uri, parsed, callerUserId);

    case 'graph':
      // community-reports — SHARED read. No owner check by design.
      return readCommunityReports(uri, parsed);

    case 'skill':
      // Skill manifests are exposed through the `prompts/*` surface, not the
      // resource surface. Refuse here (indistinguishable not-found).
      throw new ResourceNotFoundError(uri);

    default: {
      const _exhaustive: never = parsed;
      void _exhaustive;
      throw new ResourceNotFoundError(uri);
    }
  }
}

// ============================================================================
// Internal readers
// ============================================================================

/**
 * Read a per-user memory resource. The ACL runs FIRST, on URI inspection,
 * before any IO — a cross-tenant request never reaches a graph reader. The
 * reader is then scoped to the trusted principal (`callerUserId`), never the
 * URL-supplied value (which `assertOwner` has already proven equal).
 */
async function readMemoryResource(
  uri: string,
  parsed: MemoryResourceUri,
  callerUserId: string
): Promise<McpResourceContents> {
  try {
    assertOwner(callerUserId, parsed.userId);
  } catch {
    // Collapse denial into not-found — do not confirm the victim's existence.
    log.warn('resources/read denied (owner mismatch)', { kind: parsed.kind, requestedBy: callerUserId });
    throw new ResourceNotFoundError(uri);
  }

  try {
    let payload: unknown;
    switch (parsed.kind) {
      case 'episodes':
        // Agent/MCP surface (M14): include system-principal episodes
        // ('system-sweep' / 'system-discovery') so sweep memory is readable.
        // The owner ACL above still guards WHICH caller may read; system
        // episodes are shared automation history, not another user's memory.
        payload = await queryEpisodes({ userId: callerUserId, includeSystem: true });
        break;
      case 'interest-profile':
        payload = await getInterestProfile(callerUserId);
        break;
      case 'insights':
        payload = await getInsightsForUser(callerUserId);
        break;
      case 'sessions':
        payload = await getExploredEntities(callerUserId);
        break;
      default: {
        const _exhaustive: never = parsed.kind;
        void _exhaustive;
        throw new ResourceNotFoundError(uri);
      }
    }
    return frameResource(uri, `memory:${parsed.kind}`, payload);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) throw error;
    log.error('resources/read reader failed', error instanceof Error ? error : new Error(String(error)), {
      kind: parsed.kind,
    });
    throw error;
  }
}

/**
 * Read the shared community-reports overlay. No owner check — these summaries
 * are global. Any read-gated key may retrieve them.
 */
async function readCommunityReports(uri: string, parsed: GraphCommunityReportsUri): Promise<McpResourceContents> {
  try {
    const reports = await queryCommunityReports(parsed.query);
    return frameResource(uri, 'graph:community-reports', reports);
  } catch (error) {
    log.error('resources/read community-reports failed', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Serialize a reader payload and wrap it through the untrusted-content boundary
 * so any instructions embedded in stored memory are treated as inert data.
 */
function frameResource(uri: string, label: string, payload: unknown): McpResourceContents {
  const json = JSON.stringify(payload ?? null, null, 2);
  return {
    uri,
    mimeType: RESOURCE_MIME,
    text: frameAsData(json, `radarist:${label}`),
  };
}
