/**
 * @file graph-view-model.test.ts
 * @description Pure view-model helpers for GRAPH-067 dense-graph exploration:
 * the Domain vs Raw audit-view partition (presentation-only, never mutates the
 * query response), the viewport snapshot model (survives isolate + ResizeObserver
 * without drift), and neighborhood translation math (move a node + its visible
 * one-hop neighbors together without a global refit).
 */
import {
  isDomainNode,
  partitionGraphView,
  captureViewport,
  translateNeighborhood,
  computeDomainRingGroups,
  ringGroupId,
  type GraphViewNode,
  type GraphViewEdge,
  computeBodyFit,
} from '../graph-view-model';

const node = (id: string, labels: string[]): GraphViewNode => ({ id, labels });
const edge = (id: string, from: string, to: string): GraphViewEdge => ({ id, from, to });

describe('isDomainNode', () => {
  it('treats business entities as domain nodes', () => {
    expect(isDomainNode(['Technology'])).toBe(true);
    expect(isDomainNode(['RadarPlacement'])).toBe(true);
    expect(isDomainNode(['Entity', 'Company'])).toBe(true);
  });

  it('treats audit/provenance/runtime nodes as raw-only', () => {
    expect(isDomainNode(['Assertion'])).toBe(false);
    expect(isDomainNode(['Evidence'])).toBe(false);
    expect(isDomainNode(['CommunityReport'])).toBe(false);
  });
});

describe('partitionGraphView', () => {
  const nodes = [node('t1', ['Technology']), node('a1', ['Assertion']), node('e1', ['Evidence'])];
  const edges = [edge('r1', 't1', 'a1'), edge('r2', 'a1', 'e1')];

  it('raw view preserves the exact returned topology', () => {
    const view = partitionGraphView(nodes, edges, 'raw');
    expect(view.visibleNodeIds).toEqual(new Set(['t1', 'a1', 'e1']));
    expect(view.visibleEdgeIds).toEqual(new Set(['r1', 'r2']));
  });

  it('domain view hides audit nodes and any edge touching a hidden node', () => {
    const view = partitionGraphView(nodes, edges, 'domain');
    expect(view.visibleNodeIds).toEqual(new Set(['t1']));
    // both edges touch a hidden Assertion/Evidence node → hidden.
    expect(view.visibleEdgeIds).toEqual(new Set());
  });

  it('is presentation-only — it never mutates the input arrays', () => {
    const frozenNodes = Object.freeze([...nodes]);
    const frozenEdges = Object.freeze([...edges]);
    expect(() =>
      partitionGraphView(frozenNodes as GraphViewNode[], frozenEdges as GraphViewEdge[], 'domain')
    ).not.toThrow();
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
  });
});

describe('captureViewport', () => {
  it('snapshots pan, zoom, and every node position by id', () => {
    const snapshot = captureViewport({ pan: { x: 12, y: 34 }, zoom: 1.5 }, [
      { id: 'a', position: { x: 1, y: 2 } },
      { id: 'b', position: { x: 3, y: 4 } },
    ]);
    expect(snapshot.pan).toEqual({ x: 12, y: 34 });
    expect(snapshot.zoom).toBe(1.5);
    expect(snapshot.positions.get('a')).toEqual({ x: 1, y: 2 });
    expect(snapshot.positions.get('b')).toEqual({ x: 3, y: 4 });
  });

  it('deep-copies positions so later node movement cannot corrupt the snapshot', () => {
    const live = { id: 'a', position: { x: 1, y: 2 } };
    const snapshot = captureViewport({ pan: { x: 0, y: 0 }, zoom: 1 }, [live]);
    live.position.x = 999;
    expect(snapshot.positions.get('a')).toEqual({ x: 1, y: 2 });
  });
});

describe('translateNeighborhood', () => {
  it('moves only the named members by the delta, leaving others untouched', () => {
    const positions = new Map([
      ['sel', { x: 0, y: 0 }],
      ['nbr', { x: 10, y: 0 }],
      ['far', { x: 100, y: 100 }],
    ]);
    const moved = translateNeighborhood(positions, new Set(['sel', 'nbr']), { x: 5, y: -5 });
    expect(moved.get('sel')).toEqual({ x: 5, y: -5 });
    expect(moved.get('nbr')).toEqual({ x: 15, y: -5 });
    // A node outside the neighborhood must not move (no global refit).
    expect(moved.get('far')).toEqual({ x: 100, y: 100 });
  });

  it('does not mutate the source positions map', () => {
    const positions = new Map([['sel', { x: 0, y: 0 }]]);
    translateNeighborhood(positions, new Set(['sel']), { x: 5, y: 5 });
    expect(positions.get('sel')).toEqual({ x: 0, y: 0 });
  });
});

describe('computeDomainRingGroups (GRAPH-067 #16)', () => {
  it('groups placements by [radar, ring] without collapsing them — 7 Trial techs stay 7 members', () => {
    const placements = Array.from({ length: 7 }, (_, i) => ({
      id: `placement-${i}`,
      radarId: 'radar-1',
      radarName: 'Ops Radar',
      ring: 'Trial',
    }));
    const { groups } = computeDomainRingGroups(placements);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(7); // seven real placements, one group
    expect(groups[0].label).toBe('Ops Radar / Trial');
    expect(groups[0].groupId).toBe(ringGroupId('radar-1', 'Trial'));
  });

  it('never creates one global Trial group across radars — each radar/ring is distinct', () => {
    const { groups } = computeDomainRingGroups([
      { id: 'a', radarId: 'radar-1', ring: 'Trial' },
      { id: 'b', radarId: 'radar-2', ring: 'Trial' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].groupId).not.toBe(groups[1].groupId);
  });

  it('leaves placements missing a radar or ring ungrouped (no bogus shared group)', () => {
    const { groups, ungrouped } = computeDomainRingGroups([
      { id: 'a', radarId: null, ring: 'Trial' },
      { id: 'b', radarId: 'radar-1', ring: null },
    ]);
    expect(groups).toEqual([]);
    expect(ungrouped.sort()).toEqual(['a', 'b']);
  });
});

describe('computeBodyFit (GRAPH-072/UX-070)', () => {
  const VIEWPORT = { width: 1000, height: 800, padding: 50, minZoom: 0.05, maxZoom: 5 };

  it('frames the box inside the padded viewport and centres it', () => {
    const fit = computeBodyFit({ x1: 0, y1: 0, x2: 900, y2: 700 }, VIEWPORT);
    expect(fit).not.toBeNull();
    // Limited by the tighter axis: (800 - 100) / 700 = 1 vs (1000 - 100) / 900 = 1.
    expect(fit!.zoom).toBeCloseTo(1, 10);
    // Centre of the box lands on the centre of the viewport.
    expect(fit!.pan.x + fit!.zoom * 450).toBeCloseTo(500, 10);
    expect(fit!.pan.y + fit!.zoom * 350).toBeCloseTo(400, 10);
  });

  it('does not depend on anything that scales with the zoom it produces', () => {
    // The regression this function exists to prevent: Cytoscape's own `fit()`
    // measures a label-INCLUSIVE box, and screen-space captions have a model
    // footprint of `constant / zoom`. Feeding that back in makes fit chase its own
    // output — the viewport never settles and the content collapses. Framing on a
    // fixed body box is idempotent by construction.
    const bounds = { x1: -200, y1: -100, x2: 200, y2: 100 };
    const first = computeBodyFit(bounds, VIEWPORT)!;
    const second = computeBodyFit(bounds, VIEWPORT)!;
    expect(second).toEqual(first);
  });

  it('clamps to the renderer zoom range instead of exploding on a tiny box', () => {
    // A single node has a near-zero extent; an unclamped fit would demand an
    // enormous zoom (the "giant circle filling the canvas" failure mode).
    const fit = computeBodyFit({ x1: 10, y1: 10, x2: 11, y2: 11 }, VIEWPORT);
    expect(fit!.zoom).toBe(VIEWPORT.maxZoom);

    const huge = computeBodyFit({ x1: 0, y1: 0, x2: 1_000_000, y2: 1_000_000 }, VIEWPORT);
    expect(huge!.zoom).toBe(VIEWPORT.minZoom);
  });

  it('falls back to the other axis when the box is flat, rather than dividing by zero', () => {
    const flat = computeBodyFit({ x1: 0, y1: 100, x2: 900, y2: 100 }, VIEWPORT);
    expect(flat).not.toBeNull();
    expect(Number.isFinite(flat!.zoom)).toBe(true);
    expect(flat!.zoom).toBeCloseTo((1000 - 100) / 900, 10);
  });

  it('refuses a degenerate viewport or non-finite bounds instead of moving the camera', () => {
    expect(computeBodyFit({ x1: 0, y1: 0, x2: 100, y2: 100 }, { ...VIEWPORT, width: 0 })).toBeNull();
    expect(computeBodyFit({ x1: 0, y1: 0, x2: Number.NaN, y2: 100 }, VIEWPORT)).toBeNull();
  });
});
