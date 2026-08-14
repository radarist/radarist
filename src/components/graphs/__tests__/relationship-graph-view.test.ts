/**
 * @file relationship-graph-view.test.ts
 * @description Unit tests for the pure view-math helpers behind
 * EntityRelationshipPanel's force graph (zoom chooser, force tuning,
 * label layout/truncation).
 */

import {
  DISPLAY_NODE_LIMIT,
  GRAPH_MIN_ZOOM,
  GRAPH_MAX_ZOOM,
  SECOND_DEGREE_PARENT_LIMIT,
  SMALL_GRAPH_NODE_LIMIT,
  SMALL_GRAPH_ZOOM,
  FIT_PADDING_PX,
  getInitialView,
  computeForceTuning,
  computeLabelLayout,
  describeGraphScope,
  truncateLabel,
} from '../relationship-graph-view';

describe('relationship-graph-view', () => {
  describe('getInitialView', () => {
    it('returns a fixed zoom for a single node (never zoomToFit)', () => {
      // Arrange + Act
      const view = getInitialView(1);
      // Assert — zoomToFit on a 1-node bbox degenerates into extreme zoom-in
      expect(view).toEqual({ kind: 'zoom', zoom: SMALL_GRAPH_ZOOM });
    });

    it.each([1, 2, 3])('uses fixed zoom for small graphs (%i nodes)', (nodeCount) => {
      expect(getInitialView(nodeCount).kind).toBe('zoom');
    });

    it.each([4, 17, 50])('uses zoomToFit with padding for larger graphs (%i nodes)', (nodeCount) => {
      expect(getInitialView(nodeCount)).toEqual({ kind: 'fit', padding: FIT_PADDING_PX });
    });

    it('keeps the fixed zoom inside the interactive zoom bounds', () => {
      const view = getInitialView(SMALL_GRAPH_NODE_LIMIT);
      if (view.kind !== 'zoom') throw new Error('expected fixed-zoom view');
      expect(view.zoom).toBeGreaterThanOrEqual(GRAPH_MIN_ZOOM);
      expect(view.zoom).toBeLessThanOrEqual(GRAPH_MAX_ZOOM);
    });

    it('keeps the fixed zoom in a sane focus range (~2-4)', () => {
      const view = getInitialView(1);
      if (view.kind !== 'zoom') throw new Error('expected fixed-zoom view');
      expect(view.zoom).toBeGreaterThanOrEqual(2);
      expect(view.zoom).toBeLessThanOrEqual(4);
    });
  });

  describe('computeForceTuning', () => {
    it('repels far more strongly than the d3 default (~-30) so nodes do not clump', () => {
      const { chargeStrength, linkDistance } = computeForceTuning(17);
      expect(chargeStrength).toBeLessThanOrEqual(-120);
      expect(linkDistance).toBeGreaterThan(30); // d3 default link distance
    });

    it('scales repulsion and link distance with node count', () => {
      const small = computeForceTuning(5);
      const large = computeForceTuning(40);
      expect(Math.abs(large.chargeStrength)).toBeGreaterThan(Math.abs(small.chargeStrength));
      expect(large.linkDistance).toBeGreaterThan(small.linkDistance);
    });

    it('caps both values so huge graphs still settle in a finite area', () => {
      const { chargeStrength, linkDistance } = computeForceTuning(1000);
      expect(chargeStrength).toBe(-600);
      expect(linkDistance).toBe(140);
    });

    it('matches the ContextualGraph reference formulas', () => {
      // chargeStrength: -(120 + n*4), linkDistance: 50 + n*0.6 (pre-cap)
      expect(computeForceTuning(10)).toEqual({ chargeStrength: -160, linkDistance: 56 });
    });
  });

  describe('computeLabelLayout', () => {
    it('keeps the legacy font size and at least the legacy budget at normal zoom (scale 1)', () => {
      const { fontSize, maxWidth } = computeLabelLayout(1);
      expect(fontSize).toBe(12);
      expect(maxWidth).toBeGreaterThanOrEqual(100);
    });

    it('floors the font size at 3 graph units when zoomed in', () => {
      expect(computeLabelLayout(8).fontSize).toBe(3);
    });

    it('keeps a multi-character width budget at extreme zoom (the "Ll..." regression)', () => {
      // Pre-fix: maxWidth = 100/22 ≈ 4.5 graph units at the ~22x zoom a
      // single-node zoomToFit produced — under 2 characters at fontSize 3.
      const { fontSize, maxWidth } = computeLabelLayout(22);
      expect(maxWidth).toBe(fontSize * 9);
      expect(maxWidth / fontSize).toBeGreaterThanOrEqual(9);
    });

    it('grows the budget when zoomed out so labels are not over-truncated', () => {
      const zoomedOut = computeLabelLayout(0.5);
      expect(zoomedOut.fontSize).toBe(24);
      expect(zoomedOut.maxWidth).toBeGreaterThanOrEqual(200);
    });

    it('is safe against non-positive scales', () => {
      const layout = computeLabelLayout(0);
      expect(Number.isFinite(layout.fontSize)).toBe(true);
      expect(Number.isFinite(layout.maxWidth)).toBe(true);
    });

    it('gives the focus node a generous ~24-character budget (P-C7)', () => {
      const { fontSize, maxWidth } = computeLabelLayout(22, { isCenter: true });
      expect(maxWidth).toBe(fontSize * 24);
      expect(maxWidth / fontSize).toBeGreaterThanOrEqual(24);
    });

    it('renders a 19-character focus label ("Agentic Maintenance") in full at every zoom level', () => {
      // Regression for the "Ma" 2-character truncation bug. Sans-Serif
      // glyphs measure ~0.5x the font size on average (empirically verified
      // against a real canvas 2D context), so approximate width that way —
      // the center budget must comfortably clear it at every zoom level.
      const label = 'Agentic Maintenance';
      for (const scale of [0.3, 1, 2.5, 4, 8]) {
        const { fontSize, maxWidth } = computeLabelLayout(scale, { isCenter: true });
        const approxWidth = label.length * fontSize * 0.5;
        expect(approxWidth).toBeLessThanOrEqual(maxWidth);
      }
    });

    it('leaves the peripheral (non-center) budget unchanged when isCenter is omitted', () => {
      expect(computeLabelLayout(22)).toEqual(computeLabelLayout(22, { isCenter: false }));
    });
  });

  describe('truncateLabel', () => {
    // Fake measure: 6px per character, mirroring ctx.measureText linearly.
    const measure = (text: string) => text.length * 6;

    it('returns short labels unchanged', () => {
      expect(truncateLabel('Kafka', 100, measure)).toBe('Kafka');
    });

    it('truncates long labels with an ellipsis that fits the budget', () => {
      const result = truncateLabel('A very long technology name', 60, measure);
      expect(result.endsWith('...')).toBe(true);
      expect(measure(result)).toBeLessThanOrEqual(60);
    });

    it('keeps the maximum number of characters that fit', () => {
      // Budget 60 / 6 px-per-char = 10 chars total, 3 reserved for '...'
      expect(truncateLabel('abcdefghijkl', 60, measure)).toBe('abcdefg...');
    });

    it('degrades to a bare ellipsis when nothing fits', () => {
      expect(truncateLabel('abc', 1, measure)).toBe('...');
    });
  });

  describe('describeGraphScope (UX-069)', () => {
    it('keeps the plain count when nothing was withheld', () => {
      // An uncapped result must make NO limit claim — inventing one would be the
      // same dishonesty in the other direction.
      expect(
        describeGraphScope({
          displayedNodes: 12,
          discoveredNodes: 12,
          displayedLinks: 11,
          unexploredNeighbors: 0,
        })
      ).toEqual({
        capped: false,
        nodesLabel: '12',
        detail: 'Showing all 12 connected entities.',
      });
    });

    it('reproduces the measured failure: the cap presented as the real size', () => {
      // Verified live on `A Technologies`: the footer read "50 entities, 49
      // connections" — exactly the cap — with no indication anything was withheld.
      const description = describeGraphScope({
        displayedNodes: DISPLAY_NODE_LIMIT,
        discoveredNodes: 63,
        displayedLinks: 49,
        unexploredNeighbors: 0,
      });

      expect(description.capped).toBe(true);
      expect(description.nodesLabel).toBe('50 of 63');
      expect(description.detail).toContain('hid 13 discovered entities');
      expect(description.detail).not.toContain('at least');
    });

    it('says "at least" when neighbors were never expanded, because the total is a floor', () => {
      const description = describeGraphScope({
        displayedNodes: DISPLAY_NODE_LIMIT,
        discoveredNodes: 63,
        displayedLinks: 49,
        unexploredNeighbors: 4,
      });

      expect(description.nodesLabel).toBe('50 of 63+');
      expect(description.detail).toContain('at least 63');
      expect(description.detail).toContain('4 neighbors were not expanded');
    });

    it('reports a cap even when the node limit was not the binding constraint', () => {
      // Unexpanded neighbors alone make the count untrustworthy: the display limit
      // was never reached, but connections we never fetched are still missing.
      const description = describeGraphScope({
        displayedNodes: 18,
        discoveredNodes: 18,
        displayedLinks: 17,
        unexploredNeighbors: 3,
      });

      expect(description.capped).toBe(true);
      expect(description.nodesLabel).toBe('18 of 18+');
      expect(description.detail).not.toContain('display limit');
    });

    it('does not describe the node limit as a bound on the visible count it exceeded', () => {
      // Synthetic hub scenario: direct connections are drawn without the
      // second-degree ceiling, so the configured limit never bounded
      // what was displayed — it only stopped expansion past direct neighbors.
      // Reporting it as a display limit is a false claim about the active limit.
      const description = describeGraphScope({
        displayedNodes: 89,
        discoveredNodes: 144,
        displayedLinks: 103,
        unexploredNeighbors: 78,
      });

      expect(description.capped).toBe(true);
      expect(description.nodesLabel).toBe('89 of 144+');
      expect(description.detail).toContain('hid 55 discovered entities');
      // The limit is still named — it is what stopped expansion — but it must
      // not be presented as the ceiling on the 89 entities actually on screen.
      expect(description.detail).toContain(`${DISPLAY_NODE_LIMIT}-node`);
      expect(description.detail).not.toContain(`display limit of ${DISPLAY_NODE_LIMIT} nodes`);
    });

    it('names the node limit as the expansion bound when it did cap the visible count', () => {
      // Synthetic capped scenario: the wording must stay true where the limit binds.
      const description = describeGraphScope({
        displayedNodes: DISPLAY_NODE_LIMIT,
        discoveredNodes: 117,
        displayedLinks: 49,
        unexploredNeighbors: 0,
      });

      expect(description.nodesLabel).toBe('50 of 117');
      expect(description.detail).toContain(`${DISPLAY_NODE_LIMIT}-node`);
      expect(description.detail).toContain('hid 67 discovered entities');
    });

    it('never claims to show more than it found', () => {
      const description = describeGraphScope({
        displayedNodes: 9,
        discoveredNodes: 4, // inconsistent input
        displayedLinks: 8,
        unexploredNeighbors: 0,
      });
      expect(description.capped).toBe(false);
      expect(description.nodesLabel).toBe('9');
    });

    it('uses singular wording for a lone withheld entity or neighbor', () => {
      expect(
        describeGraphScope({
          displayedNodes: DISPLAY_NODE_LIMIT,
          discoveredNodes: DISPLAY_NODE_LIMIT + 1,
          displayedLinks: 49,
          unexploredNeighbors: 1,
        }).detail
      ).toContain('hid 1 discovered entity');
      expect(
        describeGraphScope({
          displayedNodes: 5,
          discoveredNodes: 5,
          displayedLinks: 4,
          unexploredNeighbors: 1,
        }).detail
      ).toContain('1 neighbor was not expanded');
      expect(
        describeGraphScope({
          displayedNodes: 1,
          discoveredNodes: 1,
          displayedLinks: 0,
          unexploredNeighbors: 0,
        }).detail
      ).toBe('Showing all 1 connected entity.');
    });

    it('pins the caps the component enforces to the ones this copy describes', () => {
      expect(SECOND_DEGREE_PARENT_LIMIT).toBe(10);
      expect(DISPLAY_NODE_LIMIT).toBe(50);
    });
  });
});
