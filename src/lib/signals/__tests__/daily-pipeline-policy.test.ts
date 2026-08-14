/**
 * @file daily-pipeline-policy.test.ts
 * @description DISC-017 — pins the per-step signal-status policy.
 *
 * These tests are the executable form of the audit. A change to any declared
 * state set is a deliberate policy change and must break a test here first.
 */

import type { Signal, SignalStatus } from '@/lib/types';
import {
  DAILY_PIPELINE_SIGNAL_STEPS,
  DAILY_PIPELINE_STATUS_POLICY,
  SIGNAL_ENRICHMENT_OWNER,
  isStatusEligibleForStep,
  selectSignalsForStep,
  signalEligibilityAt,
  summarizeEnrichmentCoverage,
  type DailyPipelineSignalStep,
  type SelectableSignal,
} from '../daily-pipeline-policy';

const ALL_STATUSES: SignalStatus[] = ['Detected', 'Validated', 'Approved', 'Rejected', 'Imported', 'Archived'];

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function signal(overrides: Partial<SelectableSignal> & { status: SignalStatus }): SelectableSignal {
  return { detectedAt: NOW, ...overrides };
}

describe('DISC-017 daily-pipeline status policy', () => {
  describe('the declared contract', () => {
    it('declares exactly the three signal-selecting steps', () => {
      expect([...DAILY_PIPELINE_SIGNAL_STEPS]).toEqual(['get-signals', 'compute-trends', 'recalculate-alignment']);
    });

    it('gives every step a non-empty state set and a rationale', () => {
      for (const step of DAILY_PIPELINE_SIGNAL_STEPS) {
        const policy = DAILY_PIPELINE_STATUS_POLICY[step];
        expect(policy.step).toBe(step);
        expect(policy.statuses.length).toBeGreaterThan(0);
        expect(policy.rationale.trim().length).toBeGreaterThan(0);
      }
    });

    it('never declares a state outside the SignalStatus union', () => {
      for (const step of DAILY_PIPELINE_SIGNAL_STEPS) {
        for (const status of DAILY_PIPELINE_STATUS_POLICY[step].statuses) {
          expect(ALL_STATUSES).toContain(status);
        }
      }
    });

    // The regression DISC-017 was raised for: a human approves a signal and
    // the pipeline selects it in zero steps.
    it('admits Approved into selection and alignment', () => {
      expect(DAILY_PIPELINE_STATUS_POLICY['get-signals'].statuses).toContain('Approved');
      expect(DAILY_PIPELINE_STATUS_POLICY['recalculate-alignment'].statuses).toContain('Approved');
    });

    it('excludes terminal and pre-validation states from selection', () => {
      for (const status of ['Detected', 'Rejected', 'Archived', 'Imported'] as const) {
        expect(isStatusEligibleForStep('get-signals', status)).toBe(false);
      }
    });

    // Trends is outside this lane's owned surface. Pinning the narrower set
    // keeps the divergence a visible decision rather than an accident.
    it('records trends as deliberately narrower and delegated', () => {
      const policy = DAILY_PIPELINE_STATUS_POLICY['compute-trends'];
      expect([...policy.statuses]).toEqual(['Validated']);
      expect(policy.selectionSite).toBe('delegated');
      expect(policy.rationale).toMatch(/trends owner/i);
    });

    it('does not recency-window the steps that run their own query', () => {
      expect(DAILY_PIPELINE_STATUS_POLICY['get-signals'].recencyWindowed).toBe(true);
      expect(DAILY_PIPELINE_STATUS_POLICY['compute-trends'].recencyWindowed).toBe(false);
      expect(DAILY_PIPELINE_STATUS_POLICY['recalculate-alignment'].recencyWindowed).toBe(false);
    });
  });

  describe('signalEligibilityAt', () => {
    it('uses detectedAt when the signal was never reviewed', () => {
      expect(signalEligibilityAt(signal({ status: 'Validated', detectedAt: 42 }))).toBe(42);
    });

    // The second, independent cause of "processed zero".
    it('uses the human review timestamp when it is later than detection', () => {
      expect(signalEligibilityAt(signal({ status: 'Approved', detectedAt: 100, reviewedAt: 900 }))).toBe(900);
    });

    it('never regresses below detectedAt for an out-of-order reviewedAt', () => {
      expect(signalEligibilityAt(signal({ status: 'Approved', detectedAt: 900, reviewedAt: 100 }))).toBe(900);
    });

    it('degrades safely on a legacy row with no timestamps', () => {
      expect(signalEligibilityAt({ status: 'Approved' } as SelectableSignal)).toBe(0);
    });
  });

  describe('selectSignalsForStep', () => {
    it('selects eligible statuses inside the window and counts the rest by status', () => {
      const result = selectSignalsForStep(
        'get-signals',
        [
          signal({ status: 'Validated' }),
          signal({ status: 'Approved' }),
          signal({ status: 'Detected' }),
          signal({ status: 'Rejected' }),
          signal({ status: 'Rejected' }),
        ],
        { now: NOW, windowMs: DAY }
      );

      expect(result.selected).toBe(2);
      expect(result.scanned).toBe(5);
      expect(result.skippedByStatus).toBe(3);
      expect(result.skippedByRecency).toBe(0);
      expect(result.skippedStatusCounts).toEqual({ Detected: 1, Rejected: 2 });
    });

    // The exact reported regression, end to end through the selector.
    it('selects a stale-detected but freshly-approved signal', () => {
      const result = selectSignalsForStep(
        'get-signals',
        [signal({ status: 'Approved', detectedAt: NOW - 4 * DAY, reviewedAt: NOW - 60_000 })],
        { now: NOW, windowMs: DAY }
      );

      expect(result.selected).toBe(1);
      expect(result.skippedByRecency).toBe(0);
    });

    it('still drops a signal that is stale on both timestamps', () => {
      const result = selectSignalsForStep(
        'get-signals',
        [signal({ status: 'Approved', detectedAt: NOW - 9 * DAY, reviewedAt: NOW - 8 * DAY })],
        { now: NOW, windowMs: DAY }
      );

      expect(result.selected).toBe(0);
      expect(result.skippedByRecency).toBe(1);
      // Recency is not a status skip — the two counters must not double-count.
      expect(result.skippedByStatus).toBe(0);
      expect(result.skippedStatusCounts).toEqual({});
    });

    it('reports an empty skip map rather than zero-filling unseen statuses', () => {
      const result = selectSignalsForStep('get-signals', [signal({ status: 'Validated' })], {
        now: NOW,
        windowMs: DAY,
      });
      expect(result.skippedStatusCounts).toEqual({});
    });

    it('ignores the window for a step declared non-windowed', () => {
      const ancient = [signal({ status: 'Approved', detectedAt: NOW - 400 * DAY })];
      expect(selectSignalsForStep('recalculate-alignment', ancient, { now: NOW, windowMs: DAY }).selected).toBe(1);
    });

    it('treats a non-positive window as no narrowing', () => {
      const ancient = [signal({ status: 'Validated', detectedAt: NOW - 400 * DAY })];
      expect(selectSignalsForStep('get-signals', ancient, { now: NOW, windowMs: 0 }).selected).toBe(1);
    });

    it('handles an empty cohort without inventing counts', () => {
      const result = selectSignalsForStep('get-signals', [], { now: NOW, windowMs: DAY });
      expect(result).toMatchObject({ scanned: 0, selected: 0, skippedByStatus: 0, skippedByRecency: 0 });
      expect(result.signals).toEqual([]);
    });

    it('keeps every scanned row accounted for across all steps and statuses', () => {
      const cohort = ALL_STATUSES.map((status) => signal({ status, detectedAt: NOW - 400 * DAY }));
      for (const step of DAILY_PIPELINE_SIGNAL_STEPS as readonly DailyPipelineSignalStep[]) {
        const result = selectSignalsForStep(step, cohort, { now: NOW, windowMs: DAY });
        expect(result.selected + result.skippedByStatus + result.skippedByRecency).toBe(result.scanned);
      }
    });
  });

  describe('summarizeEnrichmentCoverage', () => {
    const withContent = { status: 'Approved' as const, expandedContent: { any: true } as unknown } as Pick<
      Signal,
      'status' | 'expandedContent'
    >;
    const withoutContent = { status: 'Approved' as const } as Pick<Signal, 'status' | 'expandedContent'>;

    it('counts only Approved rows as enrichment candidates', () => {
      const coverage = summarizeEnrichmentCoverage([
        withContent,
        withoutContent,
        { status: 'Validated' } as Pick<Signal, 'status' | 'expandedContent'>,
      ]);
      expect(coverage).toEqual({
        candidates: 2,
        alreadyEnriched: 1,
        awaitingOwner: 1,
        owner: SIGNAL_ENRICHMENT_OWNER,
      });
    });

    it('always attributes the work to the single owning lane', () => {
      expect(summarizeEnrichmentCoverage([]).owner).toBe('enrich-liked-signals');
    });
  });
});
