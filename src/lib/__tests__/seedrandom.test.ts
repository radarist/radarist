/**
 * Tests for lib/seedrandom.ts
 */

import { seedrandom } from '../seedrandom';

describe('seedrandom', () => {
  it('should return a function', () => {
    const rng = seedrandom('test');
    expect(typeof rng).toBe('function');
  });

  it('should produce deterministic results for same seed', () => {
    const rng1 = seedrandom('hello');
    const rng2 = seedrandom('hello');
    expect(rng1()).toBe(rng2());
    expect(rng1()).toBe(rng2());
    expect(rng1()).toBe(rng2());
  });

  it('should produce different results for different seeds', () => {
    const rng1 = seedrandom('seed-a');
    const rng2 = seedrandom('seed-b');
    // Very unlikely to be equal
    expect(rng1()).not.toBe(rng2());
  });

  it('should produce values between 0 and 1', () => {
    const rng = seedrandom('bounds-test');
    for (let i = 0; i < 100; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('should produce a sequence of different values', () => {
    const rng = seedrandom('sequence');
    const values = new Set<number>();
    for (let i = 0; i < 20; i++) {
      values.add(rng());
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it('should handle empty string seed', () => {
    const rng = seedrandom('');
    const val = rng();
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(1);
  });
});
