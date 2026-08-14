/**
 * @file discovery/scout-ui.ts
 * @description Client-safe contract for the on-demand discovery scout: the
 * failure-code → operator-message mapping and the BOUNDED current-view context
 * a dispatching surface (the Graph Explorer) sends along so the sweep scouts
 * what the user is actually looking at instead of the configured default.
 *
 * Pure module — no server imports — safe for client components; the scout API
 * route and the Inngest sweep reuse `clampScoutViewContext` as the single
 * bounds/validation seam so an oversized or forged payload can never reach
 * candidate selection unclamped.
 */

export interface DiscoveryScoutResponse {
  error?: string;
  code?: string;
  retryAfterMs?: number;
}

/**
 * Bounded current-view context for a scout dispatch. `focusEntityIds` are
 * Firestore entity ids of Entity-labeled nodes in view; `focusTopics` are their
 * raw tag strings (the selector normalizes them into its topic key-space).
 */
export interface DiscoveryScoutViewContext {
  focusEntityIds?: string[];
  focusTopics?: string[];
}

/** Hard cap on each context list — keeps the event payload and boost set bounded. */
export const SCOUT_CONTEXT_MAX_ITEMS = 20;

/** Hard cap on a single id/topic term. */
export const SCOUT_CONTEXT_MAX_TERM_LENGTH = 120;

export function getDiscoveryScoutFailureMessage(status: number, data: DiscoveryScoutResponse): string {
  if (status === 429 && typeof data.retryAfterMs === 'number') {
    const retryMinutes = Math.max(1, Math.ceil(data.retryAfterMs / 60_000));
    return `Scout is cooling down. Try again in about ${retryMinutes} minutes.`;
  }
  if (data.code === 'invalid_context') {
    return 'Load entities into the graph view first — the scout only runs scoped to what you are looking at.';
  }
  if (data.code === 'automation_paused') {
    return 'Enable Background Automation in Settings before running the scout.';
  }
  if (data.code === 'maintenance_paused') {
    return 'Ambient automation is paused by MAINTENANCE_PAUSED in this environment. No scout was queued.';
  }
  if (data.code === 'discovery_disabled') {
    return 'Discovery is disabled in the local environment configuration.';
  }
  if (data.code === 'automation_policy_unavailable') {
    return 'The automation policy could not be read. No scout was queued.';
  }
  return data.error || 'Discovery scout could not be queued.';
}

/** Trim, drop non-strings/blanks, truncate to the term cap, dedupe, cap the list. */
function clampTermList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= SCOUT_CONTEXT_MAX_ITEMS) break;
    if (typeof item !== 'string') continue;
    const term = item.trim().slice(0, SCOUT_CONTEXT_MAX_TERM_LENGTH);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * Validate + bound an untrusted view context (request body or event payload).
 * Returns `undefined` when nothing usable survives. Shape/bounds only — the
 * scope RULE (topics required, DISC-016) is enforced at every gate that
 * consumes this: the scout route fails closed with 400 and the sweep consumer
 * rejects the event; there is no fallback to an un-scoped scout.
 */
export function clampScoutViewContext(input: unknown): DiscoveryScoutViewContext | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const focusEntityIds = clampTermList(raw.focusEntityIds);
  const focusTopics = clampTermList(raw.focusTopics);
  if (focusEntityIds.length === 0 && focusTopics.length === 0) return undefined;
  return {
    ...(focusEntityIds.length > 0 ? { focusEntityIds } : {}),
    ...(focusTopics.length > 0 ? { focusTopics } : {}),
  };
}

/** The node shape the graph explorer holds after /api/graph/query serialization. */
export interface GraphViewNode {
  id: string;
  labels?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Build the bounded scout context from the nodes currently rendered in the
 * Graph Explorer. Only Entity-labeled nodes count — placements, assertions,
 * documents, etc. carry ids the selector can never match, and they would only
 * burn the bounded budget. Entity NAMES join the tags as focus topics
 * (DISC-016) so an untagged view still scopes the scout to what's on screen
 * instead of silently degrading to the generic profile ranking. Returns
 * `undefined` when no usable topic scope exists — the scout button is then
 * disabled; there is no un-scoped fallback.
 */
export function buildGraphScoutContext(nodes: readonly GraphViewNode[]): DiscoveryScoutViewContext | undefined {
  const ids: string[] = [];
  const topics: string[] = [];
  for (const node of nodes) {
    if (!Array.isArray(node.labels) || !node.labels.includes('Entity')) continue;
    const props = node.properties ?? {};
    if (typeof props.id === 'string') ids.push(props.id);
    if (typeof props.name === 'string') topics.push(props.name);
    if (Array.isArray(props.tags)) {
      for (const tag of props.tags) if (typeof tag === 'string') topics.push(tag);
    }
  }
  const clamped = clampScoutViewContext({ focusEntityIds: ids, focusTopics: topics });
  // Topics ARE the scope: without them the sweep could only stage generic
  // profile-ranked proposals while the UI claims view-scoping. Fail closed.
  return clamped?.focusTopics?.length ? clamped : undefined;
}
