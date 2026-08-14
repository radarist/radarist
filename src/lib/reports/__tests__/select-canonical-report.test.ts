/**
 * @file lib/reports/__tests__/select-canonical-report.test.ts
 * @description REPORT-002 — the ONE client-safe canonical Report selector that
 * Activity (AgentLog) and the run-detail Output card share.
 *
 * Proves the three properties the lane requires of run→Report resolution:
 *  - a foreign Report is never selected (when the owner is supplied);
 *  - an ownerless legacy Report is never selected;
 *  - a mission with several Reports resolves to ONE deterministic canonical
 *    Report (newest-first by createdAt, id tiebreaker) — never an arbitrary one
 *    — and the map builder and single-selector agree on that winner.
 */

import {
  selectCanonicalMissionReport,
  buildCanonicalReportsByMission,
  type CanonicalReportCandidate,
} from '../select-canonical-report';

const OWNER = 'user-alice';
const OTHER = 'user-mallory';
const MISSION = 'mission-42';

function report(overrides: Partial<CanonicalReportCandidate> = {}): CanonicalReportCandidate {
  return {
    id: 'report-1',
    missionId: MISSION,
    ownerId: OWNER,
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('selectCanonicalMissionReport', () => {
  it('returns undefined for a blank/absent missionId without scanning', () => {
    const reports = [report()];
    expect(selectCanonicalMissionReport(reports, undefined)).toBeUndefined();
    expect(selectCanonicalMissionReport(reports, null)).toBeUndefined();
    expect(selectCanonicalMissionReport(reports, '')).toBeUndefined();
  });

  it('selects the mission-matching owned report', () => {
    const reports = [report({ id: 'report-other', missionId: 'mission-other' }), report({ id: 'report-match' })];
    expect(selectCanonicalMissionReport(reports, MISSION)?.id).toBe('report-match');
  });

  it('never selects an ownerless legacy report (defense-in-depth)', () => {
    const reports = [report({ id: 'report-legacy', ownerId: undefined })];
    expect(selectCanonicalMissionReport(reports, MISSION)).toBeUndefined();
  });

  it('never selects a foreign report when the authenticated owner is supplied', () => {
    const reports = [report({ id: 'report-foreign', ownerId: OTHER })];
    expect(selectCanonicalMissionReport(reports, MISSION, OWNER)).toBeUndefined();
  });

  it('picks the deterministic owned report out of a mixed list', () => {
    // A foreign report, an ownerless legacy report, and two owned reports for
    // the same mission — only the deterministic owned winner may be selected.
    const reports = [
      report({ id: 'report-foreign', ownerId: OTHER, createdAt: '2026-07-09T00:00:00.000Z' }),
      report({ id: 'report-legacy', ownerId: undefined, createdAt: '2026-07-08T00:00:00.000Z' }),
      report({ id: 'report-old', createdAt: '2026-07-01T00:00:00.000Z' }),
      report({ id: 'report-new', createdAt: '2026-07-05T00:00:00.000Z' }),
    ];
    expect(selectCanonicalMissionReport(reports, MISSION, OWNER)?.id).toBe('report-new');
  });

  it('breaks equal-timestamp ties deterministically by id (never arbitrary)', () => {
    const tied = '2026-07-02T09:00:00.000Z';
    const forward = [report({ id: 'report-a', createdAt: tied }), report({ id: 'report-b', createdAt: tied })];
    const reversed = [...forward].reverse();
    // Same set in either input order → the same canonical winner (lowest id).
    expect(selectCanonicalMissionReport(forward, MISSION)?.id).toBe('report-a');
    expect(selectCanonicalMissionReport(reversed, MISSION)?.id).toBe('report-a');
  });

  it('prefers a newer createdAt over the id tiebreaker', () => {
    const reports = [
      report({ id: 'report-a', createdAt: '2026-07-01T00:00:00.000Z' }),
      report({ id: 'report-z', createdAt: '2026-07-09T00:00:00.000Z' }),
    ];
    expect(selectCanonicalMissionReport(reports, MISSION)?.id).toBe('report-z');
  });
});

describe('buildCanonicalReportsByMission', () => {
  it('maps each mission to its single deterministic canonical report', () => {
    const reports = [
      report({ id: 'm1-old', missionId: 'm1', createdAt: '2026-07-01T00:00:00.000Z' }),
      report({ id: 'm1-new', missionId: 'm1', createdAt: '2026-07-05T00:00:00.000Z' }),
      report({ id: 'm2-only', missionId: 'm2', createdAt: '2026-07-03T00:00:00.000Z' }),
    ];
    const map = buildCanonicalReportsByMission(reports);
    expect(map.get('m1')?.id).toBe('m1-new');
    expect(map.get('m2')?.id).toBe('m2-only');
  });

  it('excludes foreign and ownerless reports from the map', () => {
    const reports = [
      report({ id: 'foreign', missionId: 'm3', ownerId: OTHER }),
      report({ id: 'legacy', missionId: 'm4', ownerId: undefined }),
      report({ id: 'owned', missionId: 'm5' }),
    ];
    const map = buildCanonicalReportsByMission(reports, OWNER);
    expect(map.has('m3')).toBe(false);
    expect(map.has('m4')).toBe(false);
    expect(map.get('m5')?.id).toBe('owned');
  });

  it('agrees with selectCanonicalMissionReport on the same list (surfaces cannot diverge)', () => {
    const tied = '2026-07-02T09:00:00.000Z';
    const reports = [
      report({ id: 'report-c', createdAt: tied }),
      report({ id: 'report-a', createdAt: tied }),
      report({ id: 'report-b', createdAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const fromSelect = selectCanonicalMissionReport(reports, MISSION, OWNER);
    const fromMap = buildCanonicalReportsByMission(reports, OWNER).get(MISSION);
    expect(fromMap?.id).toBe(fromSelect?.id);
    expect(fromSelect?.id).toBe('report-a');
  });

  it('skips reports with no missionId', () => {
    const reports = [report({ id: 'no-mission', missionId: undefined })];
    expect(buildCanonicalReportsByMission(reports).size).toBe(0);
  });
});
