/**
 * @file graph-node-caption.test.ts
 * @description Unit tests for the graph caption derivation helpers.
 */

import { deriveNodeCaption, getPrimaryNodeLabel } from '../graph-node-caption';

describe('getPrimaryNodeLabel', () => {
  it('returns the first non-Entity label', () => {
    expect(getPrimaryNodeLabel(['Entity', 'Technology'])).toBe('Technology');
    expect(getPrimaryNodeLabel(['RadarPlacement'])).toBe('RadarPlacement');
  });

  it('falls back to the first label, then "Node"', () => {
    expect(getPrimaryNodeLabel(['Entity'])).toBe('Entity');
    expect(getPrimaryNodeLabel([])).toBe('Node');
  });
});

describe('deriveNodeCaption', () => {
  it('prefers direct descriptive properties in order', () => {
    expect(deriveNodeCaption(['Entity', 'Company'], { name: 'Acme Corp', title: 'x' }, 'c1')).toBe('Acme Corp');
    expect(deriveNodeCaption(['Signal'], { title: 'New chip announced' }, 's1')).toBe('New chip announced');
    expect(deriveNodeCaption(['Concept'], { canonicalName: 'Edge AI' }, 'k1')).toBe('Edge AI');
  });

  it('ignores empty/whitespace strings in the property chain', () => {
    expect(deriveNodeCaption(['Signal'], { name: '  ', title: 'Real title' }, 's1')).toBe('Real title');
  });

  describe('RadarPlacement nodes (no name — sync writes quadrantName + ring)', () => {
    const props = {
      id: 'placement-1771689515182-kj1w383',
      quadrantName: 'AI & Autonomous Systems',
      ring: 'Assess',
      technologyId: 'tech-1',
    };

    it('uses "quadrantName · Ring"', () => {
      expect(deriveNodeCaption(['RadarPlacement'], props, 'p1')).toBe('AI & Autonomous Systems · Assess');
    });

    it('capitalizes lowercase ring values', () => {
      expect(deriveNodeCaption(['RadarPlacement'], { ...props, ring: 'adopt' }, 'p1')).toBe(
        'AI & Autonomous Systems · Adopt'
      );
    });

    it('handles ring-only and quadrant-only placements', () => {
      expect(deriveNodeCaption(['RadarPlacement'], { id: props.id, ring: 'trial' }, 'p1')).toBe('Trial');
      expect(deriveNodeCaption(['RadarPlacement'], { id: props.id, quadrantName: 'Sensing' }, 'p1')).toBe('Sensing');
    });

    it('never returns the raw machine id', () => {
      const caption = deriveNodeCaption(['RadarPlacement'], { id: 'placement-1771689515182-kj1w383' }, 'p1');
      expect(caption).not.toContain('placement-17716');
      expect(caption).toBe('RadarPlacement #w383');
    });

    it('prefers a resolved technologyName over the quadrant (GRAPH-065)', () => {
      // When the read path has enriched the node with the placed technology's
      // name, the caption names the technology — distinct per placement.
      expect(deriveNodeCaption(['RadarPlacement'], { ...props, technologyName: 'Quantum Annealing' }, 'p1')).toBe(
        'Quantum Annealing · Assess'
      );
    });
  });

  it('previews long-text properties (prompt/summary/statement) with ellipsis', () => {
    const prompt = 'Investigate the competitive landscape of quantum networking startups in Europe';
    const caption = deriveNodeCaption(['Mission'], { prompt }, 'm1');
    expect(caption.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(caption.endsWith('…')).toBe(true);
    expect(caption.startsWith('Investigate the competitive')).toBe(true);

    expect(deriveNodeCaption(['Episode'], { summary: 'Short summary' }, 'e1')).toBe('Short summary');
    expect(deriveNodeCaption(['Assertion'], { statement: 'A uses B' }, 'a1')).toBe('A uses B');
  });

  describe('slug-id humanization', () => {
    it('recovers readable words from slug ids, dropping machine segments', () => {
      expect(deriveNodeCaption(['Radar'], { id: 'mwc-2026-emerging-tech-radar-1771689504682' }, 'r1')).toBe(
        'mwc 2026 emerging tech radar'
      );
    });

    it('keeps short readable ids as-is', () => {
      expect(deriveNodeCaption(['Radar'], { id: 'beverage' }, 'r1')).toBe('beverage');
    });

    it('falls back to "Label #suffix" when the id is all machine segments', () => {
      expect(deriveNodeCaption(['Session'], { id: '550e8400-e29b-41d4-a716-446655440000' }, 's1')).toBe(
        'Session #0000'
      );
    });

    it('treats a lone type-prefix word as non-descriptive', () => {
      // 'placement' is contained in 'RadarPlacement' — adds nothing.
      expect(deriveNodeCaption(['RadarPlacement'], { id: 'placement-1771443228833-w8hhpx9' }, 'p1')).toBe(
        'RadarPlacement #hpx9'
      );
    });
  });

  it('uses the element id when properties.id is missing', () => {
    expect(deriveNodeCaption(['Entity', 'Technology'], {}, '4:abc123:42')).toBe('Technology #2342');
  });

  it('returns just the label when no id characters exist', () => {
    expect(deriveNodeCaption(['Chunk'], {}, '---')).toBe('Chunk');
  });
});
