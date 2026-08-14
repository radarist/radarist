/**
 * @jest-environment node
 */
import { checkSourceDiversity, applySourceRotationCap } from '../source-diversity';

describe('checkSourceDiversity', () => {
  it('flags a pool where one source exceeds maxShare', () => {
    const v = checkSourceDiversity(['a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'], 0.4);
    expect(v.ok).toBe(false);
    expect(v.dominantSource).toBe('a');
    expect(v.dominantShare).toBeCloseTo(0.6);
  });

  it('passes a balanced pool', () => {
    expect(checkSourceDiversity(['a', 'a', 'b', 'b', 'c'], 0.5).ok).toBe(true);
  });

  it('treats an empty pool as ok (no-op)', () => {
    expect(checkSourceDiversity([], 0.4).ok).toBe(true);
  });
});

describe('applySourceRotationCap', () => {
  const mk = (source: string, id: string) => ({ source, id });

  it('trims so no source exceeds the cap = floor(N*maxShare), preserving intra-source rank', () => {
    const pool = [
      mk('a', 'a1'),
      mk('a', 'a2'),
      mk('a', 'a3'),
      mk('a', 'a4'),
      mk('a', 'a5'),
      mk('a', 'a6'),
      mk('b', 'b1'),
      mk('b', 'b2'),
      mk('b', 'b3'),
      mk('b', 'b4'),
    ];
    const out = applySourceRotationCap(pool, 0.4); // cap = floor(10*0.4) = 4
    const aKept = out.filter((c) => c.source === 'a');
    expect(aKept).toHaveLength(4);
    expect(aKept.map((c) => c.id)).toEqual(['a1', 'a2', 'a3', 'a4']); // top-ranked kept
  });

  it('leaves an under-cap pool unchanged', () => {
    const pool = [mk('a', 'a1'), mk('a', 'a2'), mk('b', 'b1'), mk('b', 'b2'), mk('c', 'c1')];
    expect(applySourceRotationCap(pool, 0.4)).toEqual(pool); // cap=2, each source ≤2
  });

  it('is a no-op on an empty pool', () => {
    expect(applySourceRotationCap([], 0.4)).toEqual([]);
  });

  it('does NOT trim a single-source pool (one source cannot dominate — fills to the limit)', () => {
    const pool = [mk('a', 'a1'), mk('a', 'a2'), mk('a', 'a3'), mk('a', 'a4'), mk('a', 'a5'), mk('a', 'a6')];
    expect(applySourceRotationCap(pool, 0.4)).toEqual(pool);
  });
});
