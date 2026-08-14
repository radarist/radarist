/**
 * @file technology-research-dispatch.test.ts
 * @description TEST-022 — pins the shared research dispatch contract.
 */

import {
  RESEARCH_JOB_BUDGET_MS,
  RESEARCH_STALE_AFTER_MS,
  decideResearchDispatch,
  type ResearchDispatchState,
} from '../technology-research-dispatch';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

function state(overrides: Partial<ResearchDispatchState> = {}): ResearchDispatchState {
  return { researchStatus: undefined, researchStartedAt: undefined, ...overrides };
}

describe('TEST-022 research dispatch contract', () => {
  // The bug: a 10-minute window against a 15-minute job budget declared a
  // healthy run dead 5 minutes before it was expected to finish.
  it('never expires before the job itself could have given up', () => {
    expect(RESEARCH_STALE_AFTER_MS).toBeGreaterThan(RESEARCH_JOB_BUDGET_MS);
  });

  describe('allows dispatch', () => {
    it('when the technology has never been researched (absent status)', () => {
      // `researchStatus: 'idle'` is declared in the type but never written by
      // any path — idle is the ABSENT field.
      expect(decideResearchDispatch(state(), NOW)).toEqual({ allowed: true, reason: 'idle' });
    });

    it.each(['completed', 'failed'] as const)('when a previous run settled as %s', (researchStatus) => {
      expect(decideResearchDispatch(state({ researchStatus }), NOW)).toEqual({
        allowed: true,
        reason: 'previous-run-settled',
      });
    });

    it('when a pending run is genuinely abandoned', () => {
      const startedAt = NOW - RESEARCH_STALE_AFTER_MS - MINUTE;
      expect(decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt: startedAt }), NOW)).toEqual({
        allowed: true,
        reason: 'previous-run-stale',
      });
    });

    it.each([
      ['no start time', undefined],
      ['a non-finite start time', Number.NaN],
    ])('when a pending row has %s and cannot be aged', (_label, researchStartedAt) => {
      // Otherwise the technology would be wedged in pending forever.
      expect(decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt }), NOW)).toMatchObject({
        allowed: true,
        reason: 'previous-run-stale',
      });
    });
  });

  describe('refuses dispatch', () => {
    it('while a pending run is still inside the job budget', () => {
      const startedAt = NOW - (RESEARCH_JOB_BUDGET_MS - MINUTE);
      expect(decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt: startedAt }), NOW)).toEqual({
        allowed: false,
        reason: 'already-running',
        startedAt,
      });
    });

    it('for a run that just started', () => {
      expect(decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt: NOW }), NOW)).toMatchObject({
        allowed: false,
        reason: 'already-running',
      });
    });

    // Boundary: exactly at the window is still protected; one ms past is not.
    it('exactly at the stale boundary, but not past it', () => {
      const atBoundary = NOW - RESEARCH_STALE_AFTER_MS;
      expect(
        decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt: atBoundary }), NOW).allowed
      ).toBe(false);
      expect(
        decideResearchDispatch(state({ researchStatus: 'pending', researchStartedAt: atBoundary - 1 }), NOW).allowed
      ).toBe(true);
    });
  });
});
