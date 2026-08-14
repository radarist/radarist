/**
 * GRAPH-071 — the duplicate-`:Radar` dedupe planner.
 *
 * The fixtures mirror the measured retained defect: one `Radar.id`
 * (`llm-models-…`) carried by two byte-identical nodes, each receiving the same
 * 29 `ON_RADAR` edges from the same 29 placements. Everything else is a
 * fail-closed case, because the danger in a dedupe is not "did it delete" but
 * "did it delete something only one copy had".
 */
import {
  canonicalRadarProperties,
  planRadarIdentityDedupe,
  type RadarIdentityEdge,
  type RadarIdentityNode,
} from '../radar-identity-dedupe';

const RADAR_ID = 'llm-models-1783282124122';

const PROPERTIES = {
  id: RADAR_ID,
  name: 'LLM Models',
  slug: 'llm-models',
  createdAt: 1783282124122,
  updatedAt: 1783365852603,
  quadrantCount: 4,
  quadrantIds: ['q1', 'q2', 'q3', 'q4'],
};

function onRadarEdges(count: number, offset = 0): RadarIdentityEdge[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'ON_RADAR',
    direction: 'incoming' as const,
    otherElementId: `4:db:${1000 + offset + index}`,
    otherId: `placement-${offset + index}`,
  }));
}

function radar(elementId: string, edges: RadarIdentityEdge[], properties = PROPERTIES): RadarIdentityNode {
  return { elementId, id: RADAR_ID, properties, edges };
}

describe('planRadarIdentityDedupe', () => {
  it('plans nothing when no id is duplicated', () => {
    const plan = planRadarIdentityDedupe([radar('4:db:9221', onRadarEdges(29))]);

    expect(plan.groups).toEqual([]);
    expect(plan.violations).toEqual([]);
    expect(plan.nodesToDelete).toBe(0);
  });

  it('collapses synthetic identical copies carrying the same 29 ON_RADAR edges', () => {
    const edges = onRadarEdges(29);
    const plan = planRadarIdentityDedupe([radar('4:db:9221', edges), radar('4:db:9223', edges)]);

    expect(plan.violations).toEqual([]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].radarId).toBe(RADAR_ID);
    expect(plan.groups[0].survivorElementId).toBe('4:db:9221');
    expect(plan.groups[0].redundantElementIds).toEqual(['4:db:9223']);
    expect(plan.nodesToDelete).toBe(1);
    expect(plan.edgesToDelete).toBe(29);
  });

  it('keeps the copy with the most edges, so a dedupe never discards the richer node', () => {
    const plan = planRadarIdentityDedupe([radar('4:db:0001', onRadarEdges(2)), radar('4:db:9999', onRadarEdges(29))]);

    expect(plan.violations).toEqual([]);
    expect(plan.groups[0].survivorElementId).toBe('4:db:9999');
    expect(plan.groups[0].redundantElementIds).toEqual(['4:db:0001']);
    expect(plan.edgesToDelete).toBe(2);
  });

  it('is deterministic across input order, so a replay picks the same survivor', () => {
    const edges = onRadarEdges(29);
    const forward = planRadarIdentityDedupe([radar('4:db:9221', edges), radar('4:db:9223', edges)]);
    const reversed = planRadarIdentityDedupe([radar('4:db:9223', edges), radar('4:db:9221', edges)]);

    expect(reversed.groups).toEqual(forward.groups);
  });

  it('absorbs a duplicate whose edges are a STRICT SUBSET of the survivor', () => {
    // The richer node wins the survivor pick, so the poorer one loses nothing.
    const shared = onRadarEdges(29);
    const plan = planRadarIdentityDedupe([
      radar('4:db:9221', shared),
      radar('4:db:9223', [...shared, ...onRadarEdges(1, 500)]),
    ]);

    expect(plan.violations).toEqual([]);
    expect(plan.groups[0].survivorElementId).toBe('4:db:9223');
    expect(plan.groups[0].redundantElementIds).toEqual(['4:db:9221']);
  });

  it('REFUSES divergent copies, where whichever survives the other holds an exclusive edge', () => {
    const shared = onRadarEdges(28);
    const plan = planRadarIdentityDedupe([
      radar('4:db:9221', [...shared, ...onRadarEdges(1, 400)]),
      radar('4:db:9223', [...shared, ...onRadarEdges(1, 500)]),
    ]);

    expect(plan.groups).toEqual([]);
    expect(plan.nodesToDelete).toBe(0);
    expect(plan.violations).toHaveLength(1);
    expect(plan.violations[0]).toContain('carries 1 edge(s) the survivor');
    expect(plan.violations[0]).toContain('placement-500');
  });

  it('REFUSES when duplicate properties differ, naming the exact keys', () => {
    const edges = onRadarEdges(29);
    const plan = planRadarIdentityDedupe([
      radar('4:db:9221', edges),
      radar('4:db:9223', edges, { ...PROPERTIES, name: 'LLM Models (copy)', quadrantCount: 5 }),
    ]);

    expect(plan.groups).toEqual([]);
    expect(plan.violations).toHaveLength(1);
    expect(plan.violations[0]).toContain('properties name, quadrantCount');
  });

  it('treats a different array ORDER as real drift rather than noise', () => {
    const edges = onRadarEdges(29);
    const plan = planRadarIdentityDedupe([
      radar('4:db:9221', edges),
      radar('4:db:9223', edges, { ...PROPERTIES, quadrantIds: ['q2', 'q1', 'q3', 'q4'] }),
    ]);

    expect(plan.violations[0]).toContain('quadrantIds');
  });

  it('refuses an id-less :Radar node rather than guessing its identity', () => {
    const plan = planRadarIdentityDedupe([{ elementId: '4:db:1', id: '', properties: {}, edges: [] }]);

    expect(plan.violations[0]).toContain('has no id');
  });

  it('plans each duplicated id independently', () => {
    const edges = onRadarEdges(3);
    const other = (elementId: string): RadarIdentityNode => ({
      elementId,
      id: 'other-radar',
      properties: { id: 'other-radar' },
      edges: [],
    });
    const plan = planRadarIdentityDedupe([
      radar('4:db:9221', edges),
      radar('4:db:9223', edges),
      other('4:db:100'),
      other('4:db:101'),
    ]);

    expect(plan.violations).toEqual([]);
    expect(plan.groups.map((group) => group.radarId)).toEqual([RADAR_ID, 'other-radar']);
    expect(plan.nodesToDelete).toBe(2);
  });
});

describe('canonicalRadarProperties', () => {
  it('is insensitive to key order', () => {
    expect(canonicalRadarProperties({ a: 1, b: 2 })).toBe(canonicalRadarProperties({ b: 2, a: 1 }));
  });

  it('distinguishes a number from its string form', () => {
    expect(canonicalRadarProperties({ a: 1 })).not.toBe(canonicalRadarProperties({ a: '1' }));
  });
});
