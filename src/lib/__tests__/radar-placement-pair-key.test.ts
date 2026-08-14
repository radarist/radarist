/**
 * @file radar-placement-pair-key.test.ts
 * @description Contract tests for the deterministic RadarPlacement pair-identity
 * key (GRAPH-066). One radar's opinion about one technology is the exact ordered
 * tuple [radarId, technologyId]; the key is the deterministic Firestore doc id of
 * the server-owned lock that enforces one placement per pair.
 */
import {
  RADAR_PLACEMENT_PAIR_LOCK_COLLECTION,
  RADAR_PLACEMENT_PAIR_KEY_VERSION,
  buildRadarPlacementPairKey,
  auditRadarPlacementPairLocks,
  planRadarPlacementPairMigration,
} from '../radar-placement-pair-key';

describe('buildRadarPlacementPairKey', () => {
  it('is deterministic for the same ordered pair', () => {
    expect(buildRadarPlacementPairKey('radar-1', 'tech-1')).toBe(buildRadarPlacementPairKey('radar-1', 'tech-1'));
  });

  it('is versioned and prefixed', () => {
    expect(buildRadarPlacementPairKey('radar-1', 'tech-1')).toMatch(
      new RegExp(`^rpk${RADAR_PLACEMENT_PAIR_KEY_VERSION}_`)
    );
  });

  it('treats [radarId, technologyId] as an ordered tuple (radar/tech roles are not interchangeable)', () => {
    // Swapping the arguments is a different pair — a radar named "x" placing tech
    // "y" is not the same identity as radar "y" placing tech "x".
    expect(buildRadarPlacementPairKey('x', 'y')).not.toBe(buildRadarPlacementPairKey('y', 'x'));
  });

  it('distinguishes the same technology on two radars', () => {
    expect(buildRadarPlacementPairKey('radar-a', 'tech-1')).not.toBe(buildRadarPlacementPairKey('radar-b', 'tech-1'));
  });

  it('distinguishes two technologies on the same radar', () => {
    expect(buildRadarPlacementPairKey('radar-1', 'tech-a')).not.toBe(buildRadarPlacementPairKey('radar-1', 'tech-b'));
  });

  it('does not collide across slash/underscore-bearing ids', () => {
    expect(buildRadarPlacementPairKey('a/b', 'c')).not.toBe(buildRadarPlacementPairKey('a', 'b/c'));
    expect(buildRadarPlacementPairKey('a_b', 'c')).not.toBe(buildRadarPlacementPairKey('a', 'b_c'));
  });

  it('exposes the canonical lock collection name', () => {
    expect(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).toBe('radarPlacementPairs');
  });
});

describe('auditRadarPlacementPairLocks', () => {
  const placement = (id: string, radarId: string, technologyId: string) => ({ id, radarId, technologyId });

  it('is healthy when every pair has exactly one placement and one matching lock', () => {
    const key = buildRadarPlacementPairKey('radar-1', 'tech-1');
    const result = auditRadarPlacementPairLocks(
      [placement('placement-1', 'radar-1', 'tech-1')],
      [{ id: key, placementId: 'placement-1' }]
    );
    expect(result.healthy).toBe(true);
    expect(result.missingLockKeys).toEqual([]);
    expect(result.duplicatePairKeys).toEqual([]);
    expect(result.orphanLockKeys).toEqual([]);
  });

  it('flags a pair with two placements as a duplicate (never silently chosen)', () => {
    const result = auditRadarPlacementPairLocks(
      [placement('placement-1', 'radar-1', 'tech-1'), placement('placement-2', 'radar-1', 'tech-1')],
      []
    );
    expect(result.healthy).toBe(false);
    expect(result.duplicatePairKeys).toHaveLength(1);
    expect(result.duplicatePairKeys[0].placementIds.sort()).toEqual(['placement-1', 'placement-2']);
  });

  it('flags a placement with no lock as a missing pair key', () => {
    const key = buildRadarPlacementPairKey('radar-1', 'tech-1');
    const result = auditRadarPlacementPairLocks([placement('placement-1', 'radar-1', 'tech-1')], []);
    expect(result.missingLockKeys).toEqual([key]);
    expect(result.healthy).toBe(false);
  });

  it('flags a lock pointing at no placement as orphaned, and a lock pointing at the wrong placement as mismatched', () => {
    const key = buildRadarPlacementPairKey('radar-1', 'tech-1');
    const orphanKey = buildRadarPlacementPairKey('radar-9', 'tech-9');
    const result = auditRadarPlacementPairLocks(
      [placement('placement-1', 'radar-1', 'tech-1')],
      [
        { id: key, placementId: 'placement-WRONG' },
        { id: orphanKey, placementId: 'placement-gone' },
      ]
    );
    expect(result.orphanLockKeys).toEqual([orphanKey]);
    expect(result.mismatchedLocks.map((m) => m.key)).toContain(key);
    expect(result.healthy).toBe(false);
  });
});

describe('planRadarPlacementPairMigration (GRAPH-066 #10)', () => {
  it('computes a clean backfill plan with no violations', () => {
    const plan = planRadarPlacementPairMigration(
      [
        { id: 'p1', radarId: 'r1', technologyId: 't1', pairKey: null },
        { id: 'p2', radarId: 'r1', technologyId: 't2' },
      ],
      ['r1']
    );
    expect(plan.violations).toEqual([]);
    expect(plan.backfill).toHaveLength(2);
    expect(plan.backfill[0].pairKey).toMatch(/^rpk1_/);
  });

  it('skips placements that already carry the CORRECT pairKey', () => {
    const plan = planRadarPlacementPairMigration(
      [{ id: 'p1', radarId: 'r1', technologyId: 't1', pairKey: buildRadarPlacementPairKey('r1', 't1') }],
      ['r1']
    );
    expect(plan.backfill).toEqual([]);
    expect(plan.violations).toEqual([]);
  });

  it('flags duplicate prospective pair keys and yields NO clean pass (zero mutation intent)', () => {
    const plan = planRadarPlacementPairMigration(
      [
        { id: 'p1', radarId: 'r1', technologyId: 't1' },
        { id: 'p2', radarId: 'r1', technologyId: 't1' }, // same pair → collision
      ],
      ['r1']
    );
    expect(plan.violations.some((v) => v.includes('duplicate prospective pair key'))).toBe(true);
  });

  it('flags malformed endpoints and duplicate ids', () => {
    const plan = planRadarPlacementPairMigration(
      [
        { id: 'p1', radarId: null, technologyId: 't1' },
        { id: 'p1', radarId: 'r1', technologyId: 't2' }, // duplicate placement id
      ],
      ['r1', 'r1'] // duplicate radar id
    );
    expect(plan.violations.some((v) => v.includes('malformed endpoints'))).toBe(true);
    expect(plan.violations.some((v) => v.includes('duplicate Radar.id'))).toBe(true);
    expect(plan.violations.some((v) => v.includes('duplicate RadarPlacement.id'))).toBe(true);
  });
});

describe('planRadarPlacementPairMigration — wrong stored key (regression)', () => {
  it('rejects a placement whose stored pairKey does not match [radarId, technologyId] (zero mutation)', () => {
    const plan = planRadarPlacementPairMigration(
      [{ id: 'p1', radarId: 'r1', technologyId: 't1', pairKey: buildRadarPlacementPairKey('r1', 't2') }],
      ['r1']
    );
    expect(plan.violations.some((v) => v.includes('does not match [radarId, technologyId]'))).toBe(true);
    expect(plan.backfill).toEqual([]); // wrong key must NOT be silently skipped-and-passed
  });

  it('leaves a CORRECT stored key untouched with no violation', () => {
    const correct = ringGroupIdOrPairKeyCorrect();
    const plan = planRadarPlacementPairMigration(
      [{ id: 'p1', radarId: 'r1', technologyId: 't1', pairKey: correct }],
      ['r1']
    );
    expect(plan.violations).toEqual([]);
    expect(plan.backfill).toEqual([]);
  });
});

function ringGroupIdOrPairKeyCorrect(): string {
  return buildRadarPlacementPairKey('r1', 't1');
}

describe('parseRadarPlacementPairLock (GRAPH-066 #3 complete parser)', () => {
  const { parseRadarPlacementPairLock, buildRadarPlacementPairLockEntry } = jest.requireActual(
    '../radar-placement-pair-key'
  );
  const key = buildRadarPlacementPairKey('r1', 't1');
  const good = buildRadarPlacementPairLockEntry('p1', 'r1', 't1', 1000).data;

  it('accepts a well-formed lock matching the expected pair', () => {
    expect(parseRadarPlacementPairLock(key, good, { radarId: 'r1', technologyId: 't1' })).not.toBeNull();
  });

  it('fails closed on wrong key / endpoints / keyVersion / bad createdAt / missing placementId', () => {
    const exp = { radarId: 'r1', technologyId: 't1' };
    expect(parseRadarPlacementPairLock('rpk1_WRONG', good, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, radarId: 'r2' }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, technologyId: 't2' }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, keyVersion: 99 }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, createdAt: -1 }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, createdAt: Number.POSITIVE_INFINITY }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, { ...good, placementId: '' }, exp)).toBeNull();
    expect(parseRadarPlacementPairLock(key, null, exp)).toBeNull();
  });
});
