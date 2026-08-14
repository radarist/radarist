/**
 * Tests for the C6 pure community membership-delta matcher.
 */

import { detectCommunityChanges } from '../community-changes';
import type { CommunitySnapshot } from '../community-changes';

function snap(communityId: number, memberIds: string[], title?: string): CommunitySnapshot {
  return { communityId, memberIds, title };
}

describe('detectCommunityChanges', () => {
  it('reports no changes when membership is identical but Louvain renumbered the community', () => {
    const prev = [snap(3, ['a', 'b', 'c', 'd'], 'Old title')];
    const next = [snap(17, ['a', 'b', 'c', 'd'], 'New title')];

    expect(detectCommunityChanges(prev, next)).toEqual([]);
  });

  it('flags a 4-of-10 swap as shifted with jaccard ~0.43 and correct added/removed', () => {
    const kept = ['a', 'b', 'c', 'd', 'e', 'f'];
    const removedIds = ['g', 'h', 'i', 'j'];
    const addedIds = ['k', 'l', 'm', 'n'];
    const prev = [snap(1, [...kept, ...removedIds])];
    const next = [snap(2, [...kept, ...addedIds])];

    const changes = detectCommunityChanges(prev, next);

    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('shifted');
    if (changes[0].kind !== 'shifted') throw new Error('expected shifted');
    // intersection=6, union=10+10-6=14 -> 6/14 ~= 0.4286
    expect(changes[0].jaccard).toBeCloseTo(6 / 14, 6);
    expect(new Set(changes[0].added)).toEqual(new Set(addedIds));
    expect(new Set(changes[0].removed)).toEqual(new Set(removedIds));
  });

  it('reports a wholly new community and a wholly dissolved one when there is no overlap', () => {
    const prev = [snap(1, ['a', 'b', 'c'])];
    const next = [snap(2, ['x', 'y', 'z'])];

    const changes = detectCommunityChanges(prev, next);

    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.kind === 'new')).toMatchObject({ kind: 'new', after: next[0] });
    expect(changes.find((c) => c.kind === 'dissolved')).toMatchObject({ kind: 'dissolved', before: prev[0] });
  });

  it('pairs a split community with its dominant fragment and reports the minor fragment as new', () => {
    const original = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const dominant = original.slice(0, 7); // 7/10 overlap -> jaccard 0.7 (< 0.8, so 'shifted')
    const minor = ['n1', 'n2', 'n3']; // wholly new members -> no overlap with prev

    const prev = [snap(1, original)];
    const next = [snap(10, dominant), snap(11, minor)];

    const changes = detectCommunityChanges(prev, next);

    expect(changes).toHaveLength(2);
    const shifted = changes.find((c) => c.kind === 'shifted');
    const created = changes.find((c) => c.kind === 'new');
    expect(shifted).toBeDefined();
    if (shifted?.kind === 'shifted') {
      expect(shifted.after.communityId).toBe(10);
      expect(shifted.jaccard).toBeCloseTo(0.7, 6);
    }
    expect(created).toMatchObject({ kind: 'new', after: next[1] });
  });

  it('merges two prior communities into one: the dominant pairs, the minor dissolves', () => {
    const bigOriginal = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const smallOriginal = ['s1', 's2'];
    const merged = [...bigOriginal, 's1']; // mostly overlaps `big`, only one member from `small`

    const prev = [snap(1, bigOriginal), snap(2, smallOriginal)];
    const next = [snap(9, merged)];

    const changes = detectCommunityChanges(prev, next);

    // big <-> merged: intersection=8, union=8+9-8=9 -> jaccard 8/9 (~0.89, steady state, no entry)
    // small <-> merged: intersection=1, union=2+9-1=10 -> jaccard 0.1 (< matchThreshold, unpaired)
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'dissolved', before: prev[1] });
  });

  it('treats every next community as new when there is no prior snapshot', () => {
    const next = [snap(1, ['a', 'b']), snap(2, ['c', 'd'])];

    const changes = detectCommunityChanges([], next);

    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.kind === 'new')).toBe(true);
  });

  it('treats every prior community as dissolved when there is no next snapshot', () => {
    const prev = [snap(1, ['a', 'b'])];

    const changes = detectCommunityChanges(prev, []);

    expect(changes).toEqual([{ kind: 'dissolved', before: prev[0] }]);
  });

  it('honours custom matchThreshold/shiftedBelow overrides', () => {
    const prev = [snap(1, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'])];
    // intersection={a,b}=2, union=10+8-2=16 -> jaccard 2/16=0.125, below the
    // default 0.3 threshold (unmatched) but above a lowered custom threshold of 0.1.
    const next = [snap(2, ['a', 'b', 'k', 'l', 'm', 'n', 'o', 'p'])];

    expect(detectCommunityChanges(prev, next)).toHaveLength(2); // default: unmatched -> new + dissolved

    const lenient = detectCommunityChanges(prev, next, { matchThreshold: 0.1 });
    expect(lenient).toHaveLength(1);
    expect(lenient[0].kind).toBe('shifted');
  });
});
