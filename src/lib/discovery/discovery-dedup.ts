/**
 * @file discovery/discovery-dedup.ts
 * @description Dedup-before-triage containment (BIAS-FIX-2). v0.1.0 uses a pure,
 * GDS-free exact-normalized-name collapse (the GDS `nodeSimilarity`-backed dupe
 * source is deferred to the hardening track). Pure module.
 */

export interface DedupResult<T> {
  kept: T[];
  collapsed: Array<{ canonicalId: string; droppedId: string }>;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Collapse candidates that share a normalized name to a single canonical. The
 * canonical is the higher-degree node (more graph evidence) when a `degree` is
 * supplied; in v0.1.0 DiscoveryCandidate carries no degree, so this falls through
 * to the lexically-smallest id. `collapsed` is the audit trail. Non-mutating.
 */
export function dedupeBeforeTriage<T extends { entityId: string; entityName?: string; degree?: number }>(
  candidates: T[]
): DedupResult<T> {
  const groups = new Map<string, T[]>();
  for (const c of candidates) {
    const key = normalizeName(c.entityName ?? c.entityId);
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const canonicalIds = new Set<string>();
  const collapsed: Array<{ canonicalId: string; droppedId: string }> = [];
  for (const group of groups.values()) {
    const canonical = [...group].sort(
      (a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.entityId.localeCompare(b.entityId)
    )[0];
    canonicalIds.add(canonical.entityId);
    for (const c of group) {
      if (c.entityId !== canonical.entityId) collapsed.push({ canonicalId: canonical.entityId, droppedId: c.entityId });
    }
  }

  const kept = candidates.filter((c) => canonicalIds.has(c.entityId));
  return { kept, collapsed };
}
