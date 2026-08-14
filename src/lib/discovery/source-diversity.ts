/**
 * @file discovery/source-diversity.ts
 * @description Source-rotation containment (BIAS-FIX-2). Prevents one discovery
 * source (the interest-selector, the 2-hop generator, …) from flooding a sweep.
 * Pure, never throws/blocks.
 *
 * NB (SD-4): at the showcase's tiny dispatch counts this is largely inert (with 2
 * sources a ≤40% share is unsatisfiable); it bites at scale, as more sources land.
 */

export interface SourceDiversityVerdict {
  ok: boolean;
  dominantSource?: string;
  dominantShare: number;
  counts: Record<string, number>;
}

/** Report whether any source exceeds maxShare. Escalation-only — never blocks. */
export function checkSourceDiversity(sources: string[], maxShare: number): SourceDiversityVerdict {
  const counts: Record<string, number> = {};
  for (const s of sources) counts[s] = (counts[s] ?? 0) + 1;
  const total = sources.length;

  let dominantSource: string | undefined;
  let dominantCount = 0;
  for (const [s, c] of Object.entries(counts)) {
    if (c > dominantCount) {
      dominantCount = c;
      dominantSource = s;
    }
  }
  const dominantShare = total > 0 ? dominantCount / total : 0;
  return { ok: total === 0 || dominantShare <= maxShare, dominantSource, dominantShare, counts };
}

/**
 * Trim each source to at most `floor(N * maxShare)` items (a count cap), keeping
 * the top-ranked items per source and preserving overall order. Pure.
 */
export function applySourceRotationCap<T extends { source: string }>(candidates: T[], maxShare: number): T[] {
  if (candidates.length === 0) return [];
  // A single source can't "dominate" — capping it would just starve dispatch
  // (the v0.1.0 state, where the interest-selector is effectively the only source).
  // Mirror the diversity-quotas single-type bypass.
  if (new Set(candidates.map((c) => c.source)).size <= 1) return [...candidates];
  const cap = Math.max(1, Math.floor(candidates.length * maxShare));
  const countBySource = new Map<string, number>();
  const result: T[] = [];
  for (const c of candidates) {
    const n = countBySource.get(c.source) ?? 0;
    if (n < cap) {
      result.push(c);
      countBySource.set(c.source, n + 1);
    }
  }
  return result;
}
