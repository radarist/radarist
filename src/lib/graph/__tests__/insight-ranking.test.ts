/**
 * @file insight-ranking.test.ts
 * @description Pure unit tests for `rankObservationsByPreference` — no
 * Neo4j/Firestore involved, this module has zero I/O.
 */

import { rankObservationsByPreference, type RankableObservation } from '../insight-ranking';
import type { UserPreference } from '../preferences';

function makePref(overrides: Partial<UserPreference> = {}): UserPreference {
  return {
    topic: 't-x',
    weight: 0,
    actedCount: 0,
    dismissedCount: 0,
    ...overrides,
  };
}

function makeObs(overrides: Partial<RankableObservation> = {}): RankableObservation {
  return {
    confidence: 0.7,
    entityId: 'e-1',
    type: 'discovery',
    ...overrides,
  };
}

describe('rankObservationsByPreference', () => {
  it('boosts a positive-weight topic above a neutral one (0.6 * 1.4 = 0.84 > 0.7)', () => {
    const boosted = makeObs({ confidence: 0.6, entityId: 'e-boost' });
    const neutral = makeObs({ confidence: 0.7, entityId: 'e-neutral' });

    const preferences: UserPreference[] = [makePref({ topic: 't-boost', weight: 0.8 })];
    const topicByEntityId = new Map([
      ['e-boost', 't-boost'],
      // e-neutral intentionally unmapped — no topic resolved.
    ]);

    const result = rankObservationsByPreference([neutral, boosted], preferences, topicByEntityId, { cap: 2 });

    // 0.8 weight clamps at min(1, 0.8)=0.8; multiplier = 1 + 0.8*0.5 = 1.4; score = 0.6*1.4 = 0.84
    expect(result[0].entityId).toBe('e-boost');
    expect(result[1].entityId).toBe('e-neutral');
  });

  it('floors (never removes) a heavily-dismissed topic — still present under a cap that fits everyone', () => {
    const suppressed = makeObs({ confidence: 0.9, entityId: 'e-suppressed', type: 'discovery' });
    const untouched = makeObs({ confidence: 0.5, entityId: 'e-untouched' });

    const preferences: UserPreference[] = [
      makePref({ topic: 't-suppressed', actedCount: 0, dismissedCount: 2 }), // 2 >= 0+2
    ];
    const topicByEntityId = new Map([['e-suppressed', 't-suppressed']]);

    const result = rankObservationsByPreference([suppressed, untouched], preferences, topicByEntityId, { cap: 2 });

    // suppressed: 0.9 * 0.5 = 0.45 < untouched's neutral 0.5 -> sorts last, but still present.
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.entityId)).toEqual(['e-untouched', 'e-suppressed']);
  });

  it('treats dismissedCount === actedCount + 1 (one under the margin) as neutral, not suppressed', () => {
    // Both observations share the same confidence; only their topic's dismiss
    // margin differs. If the "+1" row were (incorrectly) suppressed too, the
    // two would score equal and stable-sort would keep input order — instead
    // we assert the boundary row outranks the over-margin one, proving it
    // scored at neutral (x1) rather than floored (x0.5).
    const atMargin = makeObs({ confidence: 0.5, entityId: 'e-at-margin' }); // dismissed = acted + 1
    const overMargin = makeObs({ confidence: 0.5, entityId: 'e-over-margin' }); // dismissed = acted + 2

    const preferences: UserPreference[] = [
      makePref({ topic: 't-at-margin', actedCount: 1, dismissedCount: 2 }), // 2 >= 1+2? no -> neutral
      makePref({ topic: 't-over-margin', actedCount: 1, dismissedCount: 3 }), // 3 >= 1+2 -> suppressed
    ];
    const topicByEntityId = new Map([
      ['e-at-margin', 't-at-margin'],
      ['e-over-margin', 't-over-margin'],
    ]);

    const result = rankObservationsByPreference([overMargin, atMargin], preferences, topicByEntityId, { cap: 2 });

    expect(result.map((o) => o.entityId)).toEqual(['e-at-margin', 'e-over-margin']);
  });

  it("exempts the 'update' observation type from suppression (enum drift — observeWatchedEntityUpdates writes 'update' via raw Cypher, outside the AgentObservation union)", () => {
    const updateObs = makeObs({ confidence: 0.8, entityId: 'e-1', type: 'update' });
    const discoveryObs = makeObs({ confidence: 0.8, entityId: 'e-2', type: 'discovery' });

    // Same heavily-dismissed preference applies to both entities' shared topic.
    const preferences: UserPreference[] = [makePref({ topic: 't-shared', actedCount: 0, dismissedCount: 5 })];
    const topicByEntityId = new Map([
      ['e-1', 't-shared'],
      ['e-2', 't-shared'],
    ]);

    const result = rankObservationsByPreference([discoveryObs, updateObs], preferences, topicByEntityId, { cap: 2 });

    // 'update' is exempt -> stays at neutral 0.8; 'discovery' is suppressed -> 0.8*0.5=0.4. update sorts first.
    expect(result[0].type).toBe('update');
    expect(result[0].entityId).toBe('e-1');
    expect(result[1].type).toBe('discovery');
  });

  it('caps the result at the requested size (7 in, 5 out)', () => {
    const observations = Array.from({ length: 7 }, (_, i) =>
      makeObs({ entityId: `e-${i}`, confidence: 0.9 - i * 0.01 })
    );

    const result = rankObservationsByPreference(observations, [], new Map(), { cap: 5 });

    expect(result).toHaveLength(5);
  });

  it('is a stable sort on equal scores — ties keep original input order', () => {
    const a = makeObs({ entityId: 'e-a', confidence: 0.5 });
    const b = makeObs({ entityId: 'e-b', confidence: 0.5 });
    const c = makeObs({ entityId: 'e-c', confidence: 0.5 });

    const result = rankObservationsByPreference([a, b, c], [], new Map(), { cap: 3 });

    expect(result.map((o) => o.entityId)).toEqual(['e-a', 'e-b', 'e-c']);
  });

  it('is neutral (x1) when the entity has no resolved topic or the topic has no preference row', () => {
    const noTopic = makeObs({ entityId: 'e-no-topic', confidence: 0.6 });
    const unknownTopicPref = makeObs({ entityId: 'e-unknown-pref', confidence: 0.6 });

    const preferences: UserPreference[] = []; // empty prefs
    const topicByEntityId = new Map([['e-unknown-pref', 't-not-in-preferences']]);

    const result = rankObservationsByPreference([noTopic, unknownTopicPref], preferences, topicByEntityId, {
      cap: 2,
    });

    // Both neutral (x1) -> scores equal -> stable order preserved.
    expect(result.map((o) => o.entityId)).toEqual(['e-no-topic', 'e-unknown-pref']);
  });
});
