/**
 * @file discovery/inbox-ordering.ts
 * @description Triage-inbox ordering. The default is recency (newest first), but a
 * bootstrap/cold-start phase benefits from "uncertainty-first" — surfacing the
 * proposals the model is least sure about (confidence nearest 50), where a human
 * decision is most informative. Pure module.
 *
 * NB: which order to use is the caller's decision (the read accepts an `order`
 * option). Auto-selecting uncertainty during a cold-start bootstrap is deferred to
 * the inbox UI wiring — the seam ships here, the auto-selection does not.
 */

export type InboxOrder = 'recency' | 'uncertainty';

/**
 * Order items by how UNCERTAIN they are: |confidence - 50| ascending (most
 * uncertain first), tie-broken by createdAt descending (newer first). Non-mutating.
 */
export function orderByUncertaintyFirst<T extends { confidence: number; createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ua = Math.abs(a.confidence - 50);
    const ub = Math.abs(b.confidence - 50);
    if (ua !== ub) return ua - ub;
    return b.createdAt - a.createdAt;
  });
}

/** Apply the requested inbox order (default 'recency' for back-compat). Non-mutating. */
export function applyInboxOrder<T extends { confidence: number; createdAt: number }>(
  items: T[],
  order: InboxOrder = 'recency'
): T[] {
  if (order === 'uncertainty') return orderByUncertaintyFirst(items);
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}
