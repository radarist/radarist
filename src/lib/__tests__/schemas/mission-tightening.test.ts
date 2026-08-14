/**
 * @file mission-tightening.test.ts
 * @description H12 + Agent-2 schema-gap finding.
 *
 * Regression coverage for strict mission input validation.
 * Audit (2026-05-04) found gaps in missionSchema that would let invalid
 * data slip past the writer:
 *   - createdAt / completedAt accepted any string (not strict ISO 8601)
 *   - prompt was unbounded (createMissionSchema caps at 8000; the full
 *     schema didn't mirror, so a direct Firestore write or migration
 *     could land a 100KB prompt and fail downstream UI rendering)
 *   - costUsd accepted negatives
 *   - tokenUsage.input/output accepted negatives and non-integers
 *   - progress accepted fractional values
 *
 * These are the schema gaps Agent 2 flagged as letting invalid drafts
 * publish. Tightening here so the GC, lifecycle, and UI all read clean
 * data.
 */

import { missionSchema, MISSION_PROMPT_MAX_CHARS } from '@/lib/schemas/mission';

const baseMission = {
  id: 'mission-1',
  userId: 'user-1',
  prompt: 'p',
  agent: 'creator',
  status: 'completed' as const,
  progress: 100,
  entities: [],
  sources: [],
  createdAt: '2026-04-29T00:00:00.000Z',
};

describe('missionSchema tightening', () => {
  describe('createdAt / completedAt require ISO 8601 datetime', () => {
    it('rejects createdAt that is not a valid datetime string', () => {
      expect(() => missionSchema.parse({ ...baseMission, createdAt: 'not-a-date' })).toThrow();
    });

    it('rejects createdAt that is just a date without time component', () => {
      expect(() => missionSchema.parse({ ...baseMission, createdAt: '2026-04-29' })).toThrow();
    });

    it('accepts a valid ISO 8601 createdAt with milliseconds', () => {
      const m = missionSchema.parse({ ...baseMission, createdAt: '2026-04-29T00:00:00.000Z' });
      expect(m.createdAt).toBe('2026-04-29T00:00:00.000Z');
    });

    it('rejects completedAt that is not a valid datetime string', () => {
      expect(() => missionSchema.parse({ ...baseMission, completedAt: 'tomorrow' })).toThrow();
    });

    it('accepts a valid ISO 8601 completedAt', () => {
      const m = missionSchema.parse({ ...baseMission, completedAt: '2026-04-29T01:00:00.000Z' });
      expect(m.completedAt).toBe('2026-04-29T01:00:00.000Z');
    });
  });

  describe('prompt is bounded at MISSION_PROMPT_MAX_CHARS', () => {
    // Bound was raised 8000 → 50000 (env-configurable via MISSION_PROMPT_MAX_CHARS)
    // when chat-launched missions began sending full structured briefs. Assert
    // against the exported constant so the test tracks the real cap.
    it('rejects prompts longer than the cap (mirrors createMissionSchema)', () => {
      expect(() => missionSchema.parse({ ...baseMission, prompt: 'x'.repeat(MISSION_PROMPT_MAX_CHARS + 1) })).toThrow();
    });

    it('accepts prompts at the cap boundary', () => {
      const m = missionSchema.parse({ ...baseMission, prompt: 'x'.repeat(MISSION_PROMPT_MAX_CHARS) });
      expect(m.prompt.length).toBe(MISSION_PROMPT_MAX_CHARS);
    });
  });

  describe('costUsd is non-negative', () => {
    it('rejects negative costUsd', () => {
      expect(() => missionSchema.parse({ ...baseMission, costUsd: -0.01 })).toThrow();
    });

    it('accepts zero costUsd (valid for free runs)', () => {
      const m = missionSchema.parse({ ...baseMission, costUsd: 0 });
      expect(m.costUsd).toBe(0);
    });
  });

  describe('tokenUsage uses non-negative integers', () => {
    it('rejects negative input tokens', () => {
      expect(() => missionSchema.parse({ ...baseMission, tokenUsage: { input: -1, output: 0 } })).toThrow();
    });

    it('rejects fractional output tokens', () => {
      expect(() => missionSchema.parse({ ...baseMission, tokenUsage: { input: 0, output: 1.5 } })).toThrow();
    });

    it('accepts non-negative integer token counts', () => {
      const m = missionSchema.parse({ ...baseMission, tokenUsage: { input: 1500, output: 800 } });
      expect(m.tokenUsage).toEqual({ input: 1500, output: 800 });
    });
  });

  describe('progress is an integer', () => {
    it('rejects fractional progress', () => {
      expect(() => missionSchema.parse({ ...baseMission, progress: 50.5 })).toThrow();
    });

    it('accepts integer progress in range', () => {
      const m = missionSchema.parse({ ...baseMission, progress: 75 });
      expect(m.progress).toBe(75);
    });
  });
});
