/**
 * @file radar-adapter.test.ts
 * @description Unit tests for the pure radar → TechRadarData adapter (3.5).
 */

import { buildRadarDiagramPayload, DEFAULT_RINGS } from '../radar-adapter';
import type { RadarData, RadarPlacement, TechnologyWithPlacement } from '@/lib/types';

type RadarInput = Pick<RadarData, 'name' | 'quadrants' | 'ringConfigs'>;

const radar = (ringConfigs?: RadarData['ringConfigs']): RadarInput => ({
  name: 'AI Radar 2026',
  quadrants: [
    { id: 'q-tech', name: 'Techniques', order: 0 },
    { id: 'q-plat', name: 'Platforms', order: 1 },
  ],
  ringConfigs,
});

const tech = (name: string, placement: Partial<RadarPlacement> = {}): TechnologyWithPlacement =>
  ({
    id: `t-${name}`,
    name,
    placement: {
      id: `p-${name}`,
      technologyId: `t-${name}`,
      radarId: 'r1',
      quadrantId: 'q-tech',
      ring: 'Adopt',
      ...placement,
    } as RadarPlacement,
  }) as unknown as TechnologyWithPlacement;

describe('buildRadarDiagramPayload', () => {
  it('maps quadrants, falls back to standard rings, and carries item names', () => {
    const { payload, itemCount, truncated } = buildRadarDiagramPayload(radar(), [
      tech('Claude', { quadrantId: 'q-plat', ring: 'Adopt' }),
      tech('vLLM', { quadrantId: 'q-tech', ring: 'Trial' }),
    ]);

    expect(payload.title).toBe('AI Radar 2026');
    expect(payload.quadrants).toEqual([
      { id: 'q-tech', name: 'Techniques', order: 0 },
      { id: 'q-plat', name: 'Platforms', order: 1 },
    ]);
    expect(payload.rings).toEqual(DEFAULT_RINGS); // no ringConfigs → standard Adopt/Trial/Assess/Hold
    expect(payload.items).toEqual([
      { name: 'Claude', quadrantId: 'q-plat', ring: 'Adopt', movement: 'stable' },
      { name: 'vLLM', quadrantId: 'q-tech', ring: 'Trial', movement: 'stable' },
    ]);
    expect(itemCount).toBe(2);
    expect(truncated).toBe(false);
  });

  it('uses the radar ringConfigs (sorted innermost-first) and resolves ring ids → names', () => {
    const ringConfigs = [
      { id: 'r-hold', name: 'Hold', order: 3 },
      { id: 'r-adopt', name: 'Adopt', order: 0 },
      { id: 'r-trial', name: 'Trial', order: 1 },
    ];
    const { payload } = buildRadarDiagramPayload(radar(ringConfigs), [
      tech('X', { ring: 'r-adopt' }), // ring given as a ringConfig id → resolves to 'Adopt'
    ]);
    expect(payload.rings).toEqual(['Adopt', 'Trial', 'Hold']);
    expect(payload.items[0].ring).toBe('Adopt');
  });

  it('computes movement from movedFrom by ring order (in / out / stable)', () => {
    const { payload } = buildRadarDiagramPayload(radar(), [
      tech('mover-in', { ring: 'Adopt', movedFrom: 'Trial' }), // Trial(1) → Adopt(0): inward
      tech('mover-out', { ring: 'Hold', movedFrom: 'Assess' }), // Assess(2) → Hold(3): outward
      tech('same', { ring: 'Trial', movedFrom: 'Trial' }), // unchanged
    ]);
    const movementByName = Object.fromEntries(payload.items.map((i) => [i.name, i.movement]));
    expect(movementByName['mover-in']).toBe('in');
    expect(movementByName['mover-out']).toBe('out');
    expect(movementByName['same']).toBe('stable');
  });

  it('caps items at 120 and flags truncation', () => {
    const many = Array.from({ length: 130 }, (_, i) => tech(`t${i}`));
    const { payload, itemCount, truncated } = buildRadarDiagramPayload(radar(), many);
    expect(itemCount).toBe(120);
    expect(payload.items).toHaveLength(120);
    expect(truncated).toBe(true);
  });

  it('throws on zero placements (the caller must guard the empty case)', () => {
    expect(() => buildRadarDiagramPayload(radar(), [])).toThrow();
  });
});
