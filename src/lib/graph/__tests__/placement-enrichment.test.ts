/**
 * @file placement-enrichment.test.ts
 * @description Pure-derivation tests for GRAPH-065 authoritative placement
 * captions/context. Given ONE bounded enrichment query's row (resolved from the
 * graph, not stale placement text), produce a technology-aware caption + resolved
 * context, degrading honestly when an endpoint is missing.
 */
import { resolvePlacementEnrichment } from '../placement-enrichment';

const baseRow = {
  placementId: 'placement-1771600000000-ab3f2',
  technologyName: 'Quantum Annealing',
  ring: 'Trial',
  quadrantId: 'techniques',
  radarId: 'radar-1',
  radarName: 'Emerging Compute',
  quadrantIds: ['techniques', 'tools'],
  quadrantNames: ['Techniques', 'Tools'],
};

describe('resolvePlacementEnrichment', () => {
  it('builds a technology-aware caption "Technology · Ring"', () => {
    const resolved = resolvePlacementEnrichment(baseRow);
    expect(resolved.caption).toBe('Quantum Annealing · Trial');
    expect(resolved.unresolved).toEqual([]);
  });

  it('gives two technologies in the same ring distinct captions', () => {
    const a = resolvePlacementEnrichment({ ...baseRow, technologyName: 'Quantum Annealing' });
    const b = resolvePlacementEnrichment({ ...baseRow, technologyName: 'Neuromorphic Chips' });
    expect(a.caption).not.toBe(b.caption);
  });

  it('resolves the quadrant name from the authoritative radar config (not stale text)', () => {
    const resolved = resolvePlacementEnrichment({ ...baseRow, quadrantId: 'tools' });
    expect(resolved.quadrantName).toBe('Tools');
  });

  it('exposes every stable id and resolved display name in the context', () => {
    const resolved = resolvePlacementEnrichment(baseRow);
    expect(resolved.technologyName).toBe('Quantum Annealing');
    expect(resolved.radarId).toBe('radar-1');
    expect(resolved.radarName).toBe('Emerging Compute');
    expect(resolved.quadrantId).toBe('techniques');
    expect(resolved.ring).toBe('Trial');
  });

  it('degrades to an explicit unresolved caption + null context when the technology is missing', () => {
    const resolved = resolvePlacementEnrichment({ ...baseRow, technologyName: null });
    expect(resolved.technologyName).toBeNull();
    expect(resolved.caption).toMatch(/^RadarPlacement #/);
    expect(resolved.unresolved).toContain('technology');
    // Never invents a name.
    expect(resolved.caption).not.toContain('Quantum');
  });

  it('marks the radar and quadrant unresolved when the radar endpoint is missing', () => {
    const resolved = resolvePlacementEnrichment({
      placementId: 'placement-xyz',
      technologyName: 'Quantum Annealing',
      ring: 'Trial',
      quadrantId: 'techniques',
      radarId: null,
      radarName: null,
      quadrantIds: null,
      quadrantNames: null,
    });
    expect(resolved.radarName).toBeNull();
    expect(resolved.quadrantName).toBeNull();
    expect(resolved.unresolved).toEqual(expect.arrayContaining(['radar', 'quadrant']));
    // A technology-aware caption still resolves from the PLACES endpoint.
    expect(resolved.caption).toBe('Quantum Annealing · Trial');
  });
});
