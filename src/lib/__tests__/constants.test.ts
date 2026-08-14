/**
 * Tests for src/lib/constants.ts
 * Verifies the constant values used across the application.
 */

import { STATUSES, RING_SYSTEMS, DEFAULT_QUADRANTS, RING_COLORS } from '../constants';
import { STATUSES as TYPE_STATUSES } from '../types';

describe('constants', () => {
  describe('STATUSES', () => {
    it('should include all required status values', () => {
      expect(STATUSES).toContain('Trending');
      expect(STATUSES).toContain('Stable');
      expect(STATUSES).toContain('Fading'); // Task 0.1.1: Critical - Fading must exist
      expect(STATUSES).toContain('New');
      expect(STATUSES).toContain('Warning');
    });

    it('should have exactly 5 status values', () => {
      expect(STATUSES).toHaveLength(5);
    });

    it('should match the Status type definition in types.ts', () => {
      // Verify constants.ts STATUSES matches types.ts STATUSES
      expect(STATUSES).toEqual(TYPE_STATUSES);
    });
  });

  describe('RING_SYSTEMS', () => {
    it('should have Standard ring system with 4 rings', () => {
      expect(RING_SYSTEMS.Standard).toEqual(['Adopt', 'Trial', 'Assess', 'Hold']);
    });

    it('should have TRL ring system with 9 rings', () => {
      expect(RING_SYSTEMS.TRL).toHaveLength(9);
      expect(RING_SYSTEMS.TRL[0]).toBe('TRL 9'); // Highest TRL first
      expect(RING_SYSTEMS.TRL[8]).toBe('TRL 1'); // Lowest TRL last
    });

    it('should have Time-to-Impact ring system with 3 rings (Phase 2 Task 2.3.2)', () => {
      expect(RING_SYSTEMS['Time-to-Impact']).toHaveLength(3);
      expect(RING_SYSTEMS['Time-to-Impact'][0]).toBe('H1 (0-6mo)');  // Near-term first
      expect(RING_SYSTEMS['Time-to-Impact'][1]).toBe('H2 (6-18mo)'); // Mid-term
      expect(RING_SYSTEMS['Time-to-Impact'][2]).toBe('H3 (18+mo)');  // Long-term last
    });
  });

  describe('DEFAULT_QUADRANTS', () => {
    it('should have 4 default quadrants', () => {
      expect(DEFAULT_QUADRANTS).toHaveLength(4);
    });

    it('should include all required quadrants', () => {
      expect(DEFAULT_QUADRANTS).toContain('Techniques');
      expect(DEFAULT_QUADRANTS).toContain('Tools');
      expect(DEFAULT_QUADRANTS).toContain('Platforms');
      expect(DEFAULT_QUADRANTS).toContain('Languages & Frameworks');
    });
  });

  describe('RING_COLORS', () => {
    it('should have colors for all Standard rings', () => {
      expect(RING_COLORS['Adopt']).toBeDefined();
      expect(RING_COLORS['Trial']).toBeDefined();
      expect(RING_COLORS['Assess']).toBeDefined();
      expect(RING_COLORS['Hold']).toBeDefined();
    });

    it('should have colors for all TRL rings', () => {
      for (let i = 1; i <= 9; i++) {
        expect(RING_COLORS[`TRL ${i}`]).toBeDefined();
      }
    });

    it('should have colors for all Time-to-Impact rings (Phase 2 Task 2.3.2)', () => {
      expect(RING_COLORS['H1 (0-6mo)']).toBeDefined();
      expect(RING_COLORS['H2 (6-18mo)']).toBeDefined();
      expect(RING_COLORS['H3 (18+mo)']).toBeDefined();
    });
  });
});
