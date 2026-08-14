/**
 * Unit tests for the pure radar blip-label layout helpers:
 * line splitting, label-box estimation, and the deterministic
 * label-collision resolver.
 */

import {
  splitLabelLines,
  estimateLabelBoxPct,
  resolveLabelCollisions,
  computeLabelBox,
  LABEL_MAX_CHARS_PER_LINE,
  LABEL_MAX_LINES,
  type LabelCollisionItem,
  type LabelCollisionOptions,
  type ResolvedBlipLabel,
} from '../radar-label-layout';
import { cartesianToPolar, getQuadrantAnglesByOrder } from '../radar-utils';

describe('splitLabelLines', () => {
  it('returns a single line when the name fits', () => {
    expect(splitLabelLines('Neuromorphic')).toEqual(['Neuromorphic']);
  });

  it('returns an empty array for a blank name', () => {
    expect(splitLabelLines('   ')).toEqual([]);
  });

  it('splits a two-word name across two full lines without ellipsis', () => {
    expect(splitLabelLines('Neuromorphic Computing')).toEqual(['Neuromorphic', 'Computing']);
  });

  it('splits on word boundaries (no mid-word breaks for fitting words)', () => {
    expect(splitLabelLines('Event-Driven Architecture')).toEqual(['Event-Driven', 'Architecture']);
  });

  it('ellipsizes only when the name exceeds two lines', () => {
    const lines = splitLabelLines('Multimodal Foundation Models');
    expect(lines).toHaveLength(LABEL_MAX_LINES);
    expect(lines[0]).toBe('Multimodal');
    expect(lines[1]).toBe('Foundation…');
  });

  it('keeps each line within the per-line character budget', () => {
    const lines = splitLabelLines('Agentic Maintenance Robots For Industrial Plants');
    expect(lines.length).toBeLessThanOrEqual(LABEL_MAX_LINES);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(LABEL_MAX_CHARS_PER_LINE);
    }
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
  });

  it('hard-truncates a single word longer than a whole line', () => {
    const lines = splitLabelLines('Hyperautomatization', 14, 2);
    expect(lines).toEqual(['Hyperautomati…']);
    expect(lines[0].length).toBeLessThanOrEqual(14);
  });

  it('normalizes repeated whitespace', () => {
    expect(splitLabelLines('  Spiking   Neural   Nets  ')).toEqual(['Spiking Neural', 'Nets']);
  });

  it('is deterministic', () => {
    expect(splitLabelLines('Multimodal Foundation Models')).toEqual(splitLabelLines('Multimodal Foundation Models'));
  });
});

describe('estimateLabelBoxPct', () => {
  it('returns zero size for empty lines or invalid radar size', () => {
    expect(estimateLabelBoxPct([], 800)).toEqual({ widthPct: 0, heightPct: 0 });
    expect(estimateLabelBoxPct(['Foo'], 0)).toEqual({ widthPct: 0, heightPct: 0 });
  });

  it('scales width with the longest line and height with line count', () => {
    const one = estimateLabelBoxPct(['Short'], 800);
    const two = estimateLabelBoxPct(['Short', 'Much Longer Ln'], 800);
    expect(two.widthPct).toBeGreaterThan(one.widthPct);
    expect(two.heightPct).toBeGreaterThan(one.heightPct);
  });

  it('is inversely proportional to the radar pixel size', () => {
    const small = estimateLabelBoxPct(['Spiking Neural'], 400);
    const large = estimateLabelBoxPct(['Spiking Neural'], 800);
    expect(small.widthPct).toBeCloseTo(large.widthPct * 2, 6);
  });
});

describe('resolveLabelCollisions', () => {
  // Quadrant 0 of 4 → slice centered at math 45° (screen top-right).
  // Ring band 75..100 (outermost of 4 rings) → screen radius % in [39.5, 48].
  const baseOptions: LabelCollisionOptions = {
    quadrantCount: 4,
    labelOffsetPct: 1.75, // 14px of an 800px radar
  };

  const makeItem = (overrides: Partial<LabelCollisionItem> & { id: LabelCollisionItem['id'] }): LabelCollisionItem => ({
    xPct: 80,
    yPct: 20,
    labelWidthPct: 10,
    labelHeightPct: 3.5,
    fixed: false,
    quadrantOrder: 0,
    ringMinRadius: 75,
    ringMaxRadius: 100,
    ...overrides,
  });

  const boxFor = (item: LabelCollisionItem, resolved: ResolvedBlipLabel, offsetPct: number) =>
    computeLabelBox(
      resolved.xPct,
      resolved.yPct,
      item.labelWidthPct,
      item.labelHeightPct,
      offsetPct,
      resolved.labelSide
    );

  const overlaps = (a: ReturnType<typeof computeLabelBox>, b: ReturnType<typeof computeLabelBox>): boolean =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;

  it('leaves non-overlapping items untouched', () => {
    const items = [makeItem({ id: 1, xPct: 78, yPct: 12 }), makeItem({ id: 2, xPct: 90, yPct: 30 })];
    const result = resolveLabelCollisions(items, baseOptions);
    expect(result.get('1')).toEqual({ xPct: 78, yPct: 12, labelSide: 'below' });
    expect(result.get('2')).toEqual({ xPct: 90, yPct: 30, labelSide: 'below' });
  });

  it('separates two overlapping labels', () => {
    const items = [makeItem({ id: 1, xPct: 80, yPct: 20 }), makeItem({ id: 2, xPct: 81, yPct: 20.5 })];
    const result = resolveLabelCollisions(items, baseOptions);
    const a = result.get('1')!;
    const b = result.get('2')!;
    expect(
      overlaps(boxFor(items[0], a, baseOptions.labelOffsetPct), boxFor(items[1], b, baseOptions.labelOffsetPct))
    ).toBe(false);
  });

  it('separates coincident blips deterministically (stable hash, no Math.random)', () => {
    const randomSpy = jest.spyOn(Math, 'random');
    const items = [makeItem({ id: 7 }), makeItem({ id: 8 })];
    const first = resolveLabelCollisions(items, baseOptions);
    const second = resolveLabelCollisions(
      items.map((i) => ({ ...i })),
      baseOptions
    );
    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();

    expect(first.get('7')).toEqual(second.get('7'));
    expect(first.get('8')).toEqual(second.get('8'));
    // And they actually moved apart.
    const a = first.get('7')!;
    const b = first.get('8')!;
    expect(Math.hypot(a.xPct - b.xPct, a.yPct - b.yPct)).toBeGreaterThan(0);
  });

  it('is independent of input array order', () => {
    const items = [
      makeItem({ id: 'alpha', xPct: 80, yPct: 20 }),
      makeItem({ id: 'beta', xPct: 80.5, yPct: 20.2 }),
      makeItem({ id: 'gamma', xPct: 81, yPct: 19.8 }),
    ];
    const forward = resolveLabelCollisions(items, baseOptions);
    const reversed = resolveLabelCollisions([...items].reverse(), baseOptions);
    for (const id of ['alpha', 'beta', 'gamma']) {
      expect(forward.get(id)).toEqual(reversed.get(id));
    }
  });

  it('never moves a pinned (manually dragged) blip', () => {
    const items = [makeItem({ id: 1, fixed: true, xPct: 80, yPct: 20 }), makeItem({ id: 2, xPct: 80.2, yPct: 20.1 })];
    const result = resolveLabelCollisions(items, baseOptions);
    expect(result.get('1')!.xPct).toBe(80);
    expect(result.get('1')!.yPct).toBe(20);
  });

  it('keeps nudged blips inside their quadrant/ring band', () => {
    const items = [
      makeItem({ id: 1, xPct: 80, yPct: 20 }),
      makeItem({ id: 2, xPct: 80.3, yPct: 20.2 }),
      makeItem({ id: 3, xPct: 80.6, yPct: 19.9 }),
    ];
    const result = resolveLabelCollisions(items, baseOptions);
    const angles = getQuadrantAnglesByOrder(0, 4);
    for (const item of items) {
      const r = result.get(String(item.id))!;
      const polar = cartesianToPolar((r.xPct - 50) * 2, (50 - r.yPct) * 2);
      // Radius clamp mirrors the force sim (band ± 4 buffer).
      expect(polar.r).toBeGreaterThanOrEqual(item.ringMinRadius + 4 - 1e-6);
      expect(polar.r).toBeLessThanOrEqual(item.ringMaxRadius - 4 + 1e-6);
      // Angle stays inside slice 0 (math 0°..90° for N=4).
      const deg = (polar.theta * 180) / Math.PI;
      let delta = deg - angles.center;
      while (delta <= -180) delta += 360;
      while (delta > 180) delta -= 360;
      expect(Math.abs(delta)).toBeLessThanOrEqual(angles.halfWidth + 1e-6);
    }
  });

  it('flips the screen-higher label above when both blips are pinned', () => {
    const items = [
      makeItem({ id: 'hi', fixed: true, xPct: 80, yPct: 19.5 }),
      makeItem({ id: 'lo', fixed: true, xPct: 80.2, yPct: 20 }),
    ];
    const result = resolveLabelCollisions(items, baseOptions);
    expect(result.get('hi')!.labelSide).toBe('above');
    expect(result.get('lo')!.labelSide).toBe('below');
    // Positions untouched.
    expect(result.get('hi')!.xPct).toBe(80);
    expect(result.get('lo')!.xPct).toBe(80.2);
  });

  it('terminates within the iteration cap on a pathological pile-up', () => {
    const items = Array.from({ length: 8 }, (_, i) => makeItem({ id: i + 1 }));
    const result = resolveLabelCollisions(items, { ...baseOptions, maxIterations: 24 });
    expect(result.size).toBe(8);
    // Gross overprint resolved: fewer overlapping pairs than the initial 28.
    let overlapping = 0;
    const ids = items.map((i) => String(i.id));
    for (let j = 0; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const a = boxFor(items[j], result.get(ids[j])!, baseOptions.labelOffsetPct);
        const b = boxFor(items[k], result.get(ids[k])!, baseOptions.labelOffsetPct);
        if (overlaps(a, b)) overlapping++;
      }
    }
    expect(overlapping).toBeLessThan(28);
  });

  it('handles a single-quadrant radar (no angle clamping)', () => {
    const items = [
      makeItem({ id: 1, quadrantOrder: 0, xPct: 80, yPct: 20 }),
      makeItem({ id: 2, quadrantOrder: 0, xPct: 80.2, yPct: 20.1 }),
    ];
    const result = resolveLabelCollisions(items, { ...baseOptions, quadrantCount: 1 });
    const a = result.get('1')!;
    const b = result.get('2')!;
    expect(
      overlaps(boxFor(items[0], a, baseOptions.labelOffsetPct), boxFor(items[1], b, baseOptions.labelOffsetPct))
    ).toBe(false);
  });
});
