/**
 * @file ai/reasoning/__tests__/patterns.test.ts
 * @description Tests for reasoning patterns
 */

import {
  getPattern,
  getPatternIds,
  getAllPatterns,
  getPatternsByPermission,
} from '../patterns';
import type { ReasoningPatternId } from '../types';

describe('Reasoning Patterns', () => {
  describe('Pattern Registry', () => {
    it('should have all expected patterns', () => {
      const expectedPatterns: ReasoningPatternId[] = [
        'deep-analysis',
        'technology-scout',
        'competitive-landscape',
        'strategic-fit',
        'signal-triage',
        'gap-analysis',
        'trend-synthesis',
      ];

      expect(getPatternIds()).toEqual(expect.arrayContaining(expectedPatterns));
      expect(getPatternIds().length).toBe(expectedPatterns.length);
    });

    it('should return patterns as array', () => {
      const patterns = getAllPatterns();
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBe(7);
    });
  });

  describe('getPattern', () => {
    it('should return pattern by id', () => {
      const pattern = getPattern('deep-analysis');

      expect(pattern).not.toBeNull();
      expect(pattern?.id).toBe('deep-analysis');
      expect(pattern?.name).toBe('Deep Analysis');
    });

    it('should return null for unknown pattern', () => {
      const pattern = getPattern('unknown-pattern' as ReasoningPatternId);
      expect(pattern).toBeNull();
    });
  });

  describe('Pattern Structure', () => {
    it.each(getPatternIds())('pattern %s should have required fields', (patternId) => {
      const pattern = getPattern(patternId);

      expect(pattern).not.toBeNull();
      expect(pattern?.id).toBe(patternId);
      expect(typeof pattern?.name).toBe('string');
      expect(typeof pattern?.description).toBe('string');
      expect(typeof pattern?.systemPrompt).toBe('string');
      expect(Array.isArray(pattern?.applicableWhen)).toBe(true);
      expect(Array.isArray(pattern?.steps)).toBe(true);
      expect(Array.isArray(pattern?.examples)).toBe(true);
      expect(Array.isArray(pattern?.requiredPermissions)).toBe(true);
    });

    it.each(getPatternIds())('pattern %s should have valid steps', (patternId) => {
      const pattern = getPattern(patternId);

      expect(pattern?.steps.length).toBeGreaterThan(0);

      for (const step of pattern?.steps ?? []) {
        expect(typeof step.step).toBe('number');
        expect(typeof step.action).toBe('string');
        expect(typeof step.description).toBe('string');
        expect(Array.isArray(step.suggestedTools)).toBe(true);
        expect(Array.isArray(step.keyQuestions)).toBe(true);
      }
    });

    it.each(getPatternIds())('pattern %s should have at least one example', (patternId) => {
      const pattern = getPattern(patternId);
      expect(pattern?.examples.length).toBeGreaterThanOrEqual(1);

      for (const example of pattern?.examples ?? []) {
        expect(typeof example.query).toBe('string');
        expect(typeof example.approach).toBe('string');
        expect(Array.isArray(example.toolSequence)).toBe(true);
      }
    });
  });

  describe('getPatternsByPermission', () => {
    it('should return all patterns for admin', () => {
      const patterns = getPatternsByPermission(['admin']);
      expect(patterns.length).toBe(7);
    });

    it('should return read-only patterns for read permission', () => {
      const patterns = getPatternsByPermission(['read']);

      // All patterns except signal-triage should be accessible with just read
      const readOnlyPatterns = patterns.filter(
        (p) => !p.requiredPermissions.includes('signals')
      );
      expect(readOnlyPatterns.length).toBeGreaterThan(0);
    });

    it('should return signal patterns when signals permission included', () => {
      const patterns = getPatternsByPermission(['read', 'signals']);

      const signalPatterns = patterns.filter((p) =>
        p.requiredPermissions.includes('signals')
      );
      expect(signalPatterns.length).toBeGreaterThan(0);
    });

    it('should handle empty permissions', () => {
      const patterns = getPatternsByPermission([]);
      // Patterns with no required permissions (none exist currently)
      expect(Array.isArray(patterns)).toBe(true);
    });
  });

  describe('Deep Analysis Pattern', () => {
    it('should have DECOMPOSE-GATHER-REASON-SYNTHESIZE steps', () => {
      const pattern = getPattern('deep-analysis');

      expect(pattern?.steps.length).toBe(4);
      expect(pattern?.steps[0].action).toBe('Decompose');
      expect(pattern?.steps[1].action).toBe('Gather');
      expect(pattern?.steps[2].action).toBe('Reason');
      expect(pattern?.steps[3].action).toBe('Synthesize');
    });

    it('should include search tools in Gather step', () => {
      const pattern = getPattern('deep-analysis');
      const gatherStep = pattern?.steps.find((s) => s.action === 'Gather');

      const toolNames = gatherStep?.suggestedTools.map((t) => t.name);
      expect(toolNames).toContain('searchDecoupledTechnologies');
      expect(toolNames).toContain('queryGraph');
    });
  });

  describe('Signal Triage Pattern', () => {
    it('should require signals permission', () => {
      const pattern = getPattern('signal-triage');
      expect(pattern?.requiredPermissions).toContain('signals');
    });

    it('should include signal management tools', () => {
      const pattern = getPattern('signal-triage');
      const decideStep = pattern?.steps.find((s) => s.action === 'Decide');

      const toolNames = decideStep?.suggestedTools.map((t) => t.name);
      expect(toolNames).toContain('approveSignal');
      expect(toolNames).toContain('rejectSignal');
    });
  });
});
