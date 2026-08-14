/**
 * @file graph/community-changes.ts
 * @description C6 — pure community membership-delta detection.
 *
 * The nightly F2 refresh (`community-reports.ts`) replaces the top-N
 * `:CommunityReport` nodes every run and DETACH-DELETEs whatever falls out
 * of the new top-N set — but nothing ever NOTICED the structural change
 * itself. Louvain also renumbers community IDs run-to-run (topology +
 * non-determinism), so a prior report's `communityId` carries no continuity
 * guarantee across runs — matching two snapshots must be id-agnostic and go
 * purely by member overlap.
 *
 * This module does the matching: given the reports that existed BEFORE this
 * run (`prev`) and the reports this run computed (`next`), pair them up by
 * all-pairs Jaccard similarity on `memberIds`, greedy-assigning the
 * highest-similarity pairs first (a community that split into two fragments
 * should pair with its DOMINANT fragment, not whichever fragment happens to
 * sort first). Unpaired `next` entries are 'new' communities; unpaired
 * `prev` entries are 'dissolved' communities (this is how the caller
 * distinguishes a real dissolution from a report that's merely due to be
 * pruned as part of a routine top-N reshuffle — a paired-but-shifted report
 * isn't dissolved, it just changed shape).
 *
 * Pure — no I/O — safe to unit test without a database. The caller
 * (`buildCommunityReports`) is responsible for reading the prior snapshot
 * from Neo4j BEFORE the prune runs (once pruned, the prior state is gone).
 */

export interface CommunitySnapshot {
  communityId: number;
  title?: string;
  memberIds: string[];
}

export type CommunityChange =
  | { kind: 'new'; after: CommunitySnapshot }
  | { kind: 'dissolved'; before: CommunitySnapshot }
  | {
      kind: 'shifted';
      before: CommunitySnapshot;
      after: CommunitySnapshot;
      jaccard: number;
      added: string[];
      removed: string[];
    };

const DEFAULT_MATCH_THRESHOLD = 0.3;
const DEFAULT_SHIFTED_BELOW = 0.8;

/** Jaccard similarity of two member-id sets. Two empty sets are treated as identical (1). */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const id of setA) {
    if (setB.has(id)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

interface CandidatePair {
  prevIdx: number;
  nextIdx: number;
  jaccard: number;
}

/**
 * Match two community snapshots by member overlap and classify what changed.
 *
 * Algorithm: compute Jaccard similarity for every (prev, next) pair, keep
 * only pairs at or above `matchThreshold`, then greedily assign pairs in
 * descending-similarity order (highest-overlap pairs claimed first; a
 * community already claimed on either side is skipped for weaker pairs).
 * This is id-agnostic by construction — Louvain's renumbering never enters
 * the comparison.
 *
 * A matched pair below `shiftedBelow` is reported as 'shifted' (membership
 * moved enough to be worth surfacing); at or above it, the pair is steady
 * state and produces no change entry. Anything left unmatched on the `next`
 * side is 'new'; left unmatched on the `prev` side is 'dissolved'.
 *
 * The 0.3 / 0.8 default split (rather than a single 0.5 cutoff) is
 * deliberate: it lets a split or merge pair with its dominant fragment
 * (which may retain well under 80% of the original membership) while still
 * keeping near-identical steady-state communities (≥0.8) quiet.
 */
export function detectCommunityChanges(
  prev: CommunitySnapshot[],
  next: CommunitySnapshot[],
  opts: { matchThreshold?: number; shiftedBelow?: number } = {}
): CommunityChange[] {
  const { matchThreshold = DEFAULT_MATCH_THRESHOLD, shiftedBelow = DEFAULT_SHIFTED_BELOW } = opts;

  const candidates: CandidatePair[] = [];
  for (let prevIdx = 0; prevIdx < prev.length; prevIdx++) {
    for (let nextIdx = 0; nextIdx < next.length; nextIdx++) {
      const score = jaccardSimilarity(prev[prevIdx].memberIds, next[nextIdx].memberIds);
      if (score >= matchThreshold) {
        candidates.push({ prevIdx, nextIdx, jaccard: score });
      }
    }
  }
  candidates.sort((a, b) => b.jaccard - a.jaccard);

  const matchedPrev = new Set<number>();
  const matchedNext = new Set<number>();
  const matches: CandidatePair[] = [];
  for (const candidate of candidates) {
    if (matchedPrev.has(candidate.prevIdx) || matchedNext.has(candidate.nextIdx)) continue;
    matchedPrev.add(candidate.prevIdx);
    matchedNext.add(candidate.nextIdx);
    matches.push(candidate);
  }

  const shifted: CommunityChange[] = [];
  for (const match of matches) {
    if (match.jaccard >= shiftedBelow) continue; // steady state — stays quiet
    const before = prev[match.prevIdx];
    const after = next[match.nextIdx];
    const beforeSet = new Set(before.memberIds);
    const afterSet = new Set(after.memberIds);
    shifted.push({
      kind: 'shifted',
      before,
      after,
      jaccard: match.jaccard,
      added: after.memberIds.filter((id) => !beforeSet.has(id)),
      removed: before.memberIds.filter((id) => !afterSet.has(id)),
    });
  }

  const created: CommunityChange[] = next
    .filter((_, idx) => !matchedNext.has(idx))
    .map((after) => ({ kind: 'new' as const, after }));

  const dissolved: CommunityChange[] = prev
    .filter((_, idx) => !matchedPrev.has(idx))
    .map((before) => ({ kind: 'dissolved' as const, before }));

  return [...shifted, ...created, ...dissolved];
}
