import type { Mission } from '@/lib/schemas/mission';

const PHASE_PROGRESS = {
  '00-inception': 5,
  '01-brainstorm': 12,
  '02-user-flows': 22,
  '03-design-system': 32,
  '04-user-stories': 42,
  '05-architecture': 52,
  '06-build': 68,
  '07-self-test': 82,
  '08-qa': 92,
} as const satisfies Record<Exclude<NonNullable<Mission['buildPhase']>, 'published'>, number>;

export type ObservableBuildPhase = keyof typeof PHASE_PROGRESS | 'done';

/**
 * STATUS is evidence of forward progress, not publication authority. Keep
 * phase/progress monotonic and cap a `done` status below 100 until publish.
 */
export function monotonicBuildProgress(input: {
  previousPhase?: Mission['buildPhase'];
  previousProgress?: number;
  observedPhase: ObservableBuildPhase;
}): { buildPhase: NonNullable<Mission['buildPhase']>; progress: number } {
  const observedPhase = input.observedPhase === 'done' ? '08-qa' : input.observedPhase;
  const previousPhase = input.previousPhase === 'published' ? 'published' : input.previousPhase;
  if (previousPhase === 'published') return { buildPhase: 'published', progress: 100 };

  const previousRank = previousPhase ? PHASE_PROGRESS[previousPhase] : 0;
  const observedRank = PHASE_PROGRESS[observedPhase];
  const buildPhase = previousRank > observedRank ? previousPhase! : observedPhase;
  const boundedPrevious = Number.isFinite(input.previousProgress)
    ? Math.min(99, Math.max(0, input.previousProgress ?? 0))
    : 0;
  return {
    buildPhase,
    progress: Math.max(boundedPrevious, input.observedPhase === 'done' ? 95 : observedRank),
  };
}
