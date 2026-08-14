/**
 * @file cleanup-zombie-episodes.ts
 * @description Scheduled Inngest job that closes Episode nodes whose mission
 * crashed without calling completeEpisode/failEpisode. Runs every 2 hours
 * (faster than the mission timeout so things get tidied up promptly) and
 * can be triggered on-demand via 'app/schedule.episodes.cleanup'.
 *
 * Graph audit (2026-04-17) found 7 zombie Episodes; without this job they
 * would continue to accumulate and skew session-memory queries.
 */
import { inngest } from '../client';
import { abandonStaleEpisodes } from '@/lib/graph/episodes';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/cleanup-zombie-episodes');

const DEFAULT_MIN_AGE_HOURS = 6;

export const cleanupZombieEpisodesJob = inngest.createFunction(
  {
    id: 'cleanup-zombie-episodes',
    name: 'Cleanup Zombie Episodes',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error(
        'cleanup-zombie-episodes failed permanently',
        error instanceof Error ? error : new Error(String(error))
      );
    },
  },
  [{ event: 'app/schedule.episodes.cleanup' }, { cron: 'TZ=UTC 0 */2 * * *' }],
  async ({ event, step }) => {
    const startedAt = await step.run('record-start', async () => Date.now());
    const { minAgeHours = DEFAULT_MIN_AGE_HOURS } = (event?.data ?? {}) as {
      minAgeHours?: number;
    };

    const abandoned = await step.run('abandon-stale-episodes', async () => abandonStaleEpisodes(minAgeHours));

    const durationMs = Date.now() - startedAt;

    await step.run('emit-completion-event', async () => {
      await inngest.send({
        name: 'app/schedule.episodes.cleanup.completed',
        data: { abandoned, minAgeHours, durationMs },
      });
    });

    log.info('cleanup-zombie-episodes complete', { abandoned, minAgeHours, durationMs });
    return { abandoned, minAgeHours, durationMs };
  }
);
