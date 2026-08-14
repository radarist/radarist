import type { Mission } from '@/lib/schemas/mission';
import {
  buildRecoveryEligibility,
  resolveRecoveryTurnLimit,
  terminalRecoveryFromMission,
} from '@/lib/build-mission-recovery';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    userId: 'u-1',
    prompt: 'Build it',
    agent: 'builder',
    kind: 'build',
    buildMode: 'limitless',
    status: 'failed',
    progress: 68,
    entities: [],
    sources: [],
    slots: [],
    createdAt: '2026-07-19T08:00:00.000Z',
    completedAt: '2026-07-19T09:00:00.000Z',
    buildPhase: '06-build',
    sandbox: {
      driver: 'docker',
      image: 'sandbox:v1',
      containerName: 'build-m-1',
      volumeName: 'radarist_build_m-1',
      workspacePath: '/workspace',
      state: 'stopped',
      createdAt: '2026-07-19T08:00:00.000Z',
    },
    sessions: [
      {
        index: 0,
        role: 'builder',
        objective: 'build',
        model: 'claude-opus-4-8',
        startedAt: '2026-07-19T08:00:00.000Z',
        endedAt: '2026-07-19T09:00:00.000Z',
        turns: 160,
        costUsd: 22,
        exitReason: 'max-turns',
      },
    ],
    ...overrides,
  } as Mission;
}

describe('build recovery policy', () => {
  it('classifies legacy max-turn failures without flattening them to runtime error', () => {
    expect(terminalRecoveryFromMission(mission())).toEqual(
      expect.objectContaining({ reason: 'turns-exhausted', phase: '06-build', turnsUsed: 160, maxTurns: 160 })
    );
  });

  it.each([
    ['not-limitless', { buildMode: 'standard' }],
    ['running', { status: 'running' }],
    ['not-failed', { status: 'completed' }],
    ['published', { buildPhase: 'published' }],
    ['published', { artifact: { prototypeId: 'p1', publishedAt: '2026-07-19T09:00:00.000Z' } }],
    ['no-sandbox', { sandbox: undefined }],
    ['sandbox-reclaimed', { sandbox: { ...mission().sandbox!, state: 'destroyed' } }],
  ] as Array<[string, Partial<Mission>]>)('rejects %s recovery', (code, overrides) => {
    expect(buildRecoveryEligibility(mission(overrides))).toMatchObject({ eligible: false, code });
  });

  it('reports the previous session bound without reusing it as new authority', () => {
    const base = mission();
    const eligible = buildRecoveryEligibility(
      mission({
        recovery: {
          terminal: terminalRecoveryFromMission(base),
          authorizedMaxTurns: 240,
          attempts: [],
        },
      })
    );
    expect(eligible).toMatchObject({ eligible: true, previousMaxTurns: 160 });
  });

  it('bounds the next builder session instead of expanding a cumulative ceiling', () => {
    expect(resolveRecoveryTurnLimit(40)).toBe(40);
    expect(resolveRecoveryTurnLimit(160)).toBe(160);
    expect(resolveRecoveryTurnLimit(161)).toBeNull();
    expect(resolveRecoveryTurnLimit(0)).toBeNull();
    expect(resolveRecoveryTurnLimit(-1)).toBeNull();
  });
});
