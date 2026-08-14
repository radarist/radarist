/**
 * @file discovery/diversity-quotas.ts
 * @description Per-dimension quota + MMR containment (BIAS-FIX-2). Reserves a
 * minimum per-entityType, then greedily fills remaining slots balancing relevance
 * (score) against type-diversity, under a per-type share ceiling. Pure module.
 *
 * v0.1.0 has no embeddings, so the MMR diversity term is entityType-diversity
 * (1/(1+typeCount)) rather than cosine. NB (SD-4): the per-dimension quota is
 * largely un-exercised until >1 live generator ships.
 */

export interface QuotaMMROptions {
  perDimensionQuota: number;
  maxEntityTypeShare: number;
  /** 1 = pure relevance (score), 0 = pure type-diversity. */
  mmrLambda: number;
  limit: number;
}

export function applyQuotasAndMMR<T extends { entityType: string; score: number }>(
  candidates: T[],
  opts: QuotaMMROptions
): T[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const result: T[] = [];
  const used = new Set<T>();
  const typeCount = new Map<string, number>();
  const bump = (t: string) => typeCount.set(t, (typeCount.get(t) ?? 0) + 1);

  // Phase 1 — reserve the per-dimension quota (top-by-score per type).
  const byType = new Map<string, T[]>();
  for (const c of sorted) {
    const arr = byType.get(c.entityType);
    if (arr) arr.push(c);
    else byType.set(c.entityType, [c]);
  }
  for (const arr of byType.values()) {
    for (const c of arr.slice(0, opts.perDimensionQuota)) {
      if (result.length >= opts.limit) break;
      result.push(c);
      used.add(c);
      bump(c.entityType);
    }
  }

  // Phase 2 — greedy MMR fill under the per-type share ceiling.
  // The type-share cap only bites when MORE THAN ONE type competes — a single
  // type can't "dominate" the cycle, so it must be free to fill to the limit
  // (otherwise the single-dimension showcase would cap Technology to ~1/cycle).
  const distinctTypes = new Set(candidates.map((c) => c.entityType)).size;
  const cap = distinctTypes > 1 ? Math.max(1, Math.floor(opts.limit * opts.maxEntityTypeShare)) : Infinity;
  const remaining = sorted.filter((c) => !used.has(c));
  while (result.length < opts.limit) {
    let best: T | undefined;
    let bestVal = -Infinity;
    for (const c of remaining) {
      if (used.has(c)) continue;
      if ((typeCount.get(c.entityType) ?? 0) >= cap) continue;
      const diversityBonus = 1 / (1 + (typeCount.get(c.entityType) ?? 0));
      const mmr = opts.mmrLambda * c.score + (1 - opts.mmrLambda) * diversityBonus;
      if (mmr > bestVal) {
        bestVal = mmr;
        best = c;
      }
    }
    if (!best) break;
    result.push(best);
    used.add(best);
    bump(best.entityType);
  }

  return result.slice(0, opts.limit);
}
