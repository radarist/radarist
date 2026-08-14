import { monotonicBuildProgress } from '@/lib/build-mission-progress';

describe('monotonic build progress', () => {
  it('maps trusted phases to bounded progress', () => {
    expect(monotonicBuildProgress({ observedPhase: '06-build' })).toEqual({
      buildPhase: '06-build',
      progress: 68,
    });
  });

  it('never regresses an already observed phase or percentage', () => {
    expect(
      monotonicBuildProgress({ previousPhase: '07-self-test', previousProgress: 87, observedPhase: '06-build' })
    ).toEqual({ buildPhase: '07-self-test', progress: 87 });
  });

  it('does not advertise completion before authoritative publication', () => {
    expect(monotonicBuildProgress({ previousPhase: '08-qa', previousProgress: 92, observedPhase: 'done' })).toEqual({
      buildPhase: '08-qa',
      progress: 95,
    });
    expect(monotonicBuildProgress({ previousPhase: 'published', previousProgress: 100, observedPhase: '06-build' })).toEqual({
      buildPhase: 'published',
      progress: 100,
    });
  });
});
