/**
 * @file inngest/functions/refresh-interest-profiles.ts
 * @description Nightly Inngest cron that re-derives each active user's InterestProfile
 * from their exploration (`deriveInterestFromBehavior`), so the autonomous discovery
 * sweep ranks on real interest rather than the cold-start prior — without any user
 * action. Companion to the on-demand scout-route derive and the refreshInterestFromActivity
 * AI tool (same underlying function, three callers).
 *
 * H11 — it ALSO writes the `system-discovery` InterestProfile as a frequency-ranked
 * aggregate of the active users' profiles. The discovery sweep's cron leg defaults
 * `userId = 'system-discovery'`, and the selector fail-closes to [] when that profile
 * is absent — so without this step the cron sweep dispatches nothing (the smoke script
 * seeded it via raw Cypher as a workaround). No new scheduler: this cron already runs
 * ahead of the sweep. When no active user has any topics yet, it falls back to the
 * broad cold-start prior so the cron sweep still has a profile to rank on.
 *
 * Gated by `DISCOVERY_DERIVE_INTEREST`. Per-user derivation failures are isolated,
 * while aggregate profile reads fail closed so Inngest retries instead of
 * publishing a partial synthetic snapshot. Runs at 02:30 UTC, ahead of any sweep.
 *
 * Inngest convention: service modules are dynamic-imported inside step.run.
 */
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { SKIP_REASONS } from '../skip-reasons';
import { createLogger } from '@/lib/logger';
import { SYSTEM_DISCOVERY_PRINCIPAL } from '@/lib/system-principals';
import { getDiscoveryConfig } from '@/lib/discovery/discovery-config';

const log = createLogger('inngest/refresh-interest-profiles');

export const refreshInterestProfiles = inngest.createFunction(
  {
    id: 'refresh-interest-profiles',
    name: 'Refresh Interest Profiles (Nightly)',
    retries: 2,
  },
  // 02:30 UTC daily — low-traffic, ahead of the discovery sweep.
  { cron: 'TZ=UTC 30 2 * * *' },
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('refresh-interest-profiles');
    if (!getDiscoveryConfig().deriveInterestEnabled) {
      log.info('derive-interest disabled — skipping nightly interest refresh');
      return { skipped: true, reason: SKIP_REASONS.DERIVE_INTEREST_DISABLED, userCount: 0, refreshed: 0 };
    }

    const activeUserIds = await step.run('collect-active-users', async () => {
      const { getActiveUserIds } = await import('@/lib/graph/session-memory');
      return await getActiveUserIds();
    });

    log.info('Refreshing interest profiles for active users', { userCount: activeUserIds.length });

    let refreshed = 0;
    for (const userId of activeUserIds) {
      try {
        await step.run(`derive-${userId}`, async () => {
          const { deriveInterestFromBehavior } = await import('@/lib/discovery/derive-interest');
          return await deriveInterestFromBehavior(userId);
        });
        refreshed += 1;
      } catch (err) {
        // One user's failure must never abort the batch.
        log.warn('deriveInterestFromBehavior failed for one user', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // H11 — aggregate the freshly-derived per-user profiles into the
    // 'system-discovery' InterestProfile so the sweep's cron leg has a profile
    // to rank on. This is a frequency-ranked union of every active user's
    // topics. Every read must succeed before replacement; otherwise the step throws and
    // Inngest retries without publishing a partial synthetic snapshot.
    const systemTopics = await step.run('aggregate-system-discovery-profile', async () => {
      const {
        getInterestProfile,
        MAX_INTEREST_PROFILE_TOPICS,
        replaceSyntheticInterestProfileTopics,
      } = await import('@/lib/graph/interest-profile');
      const { DEFAULT_BROAD_TOPICS } = await import('@/lib/discovery/cold-start');
      const { vertical } = getDiscoveryConfig();
      const systemUserId = SYSTEM_DISCOVERY_PRINCIPAL;

      const profiles = await Promise.all(activeUserIds.map((userId) => getInterestProfile(userId)));
      const countByTopic = new Map<string, number>();
      for (const profile of profiles) {
        for (const topic of profile?.topics ?? []) {
          countByTopic.set(topic, (countByTopic.get(topic) ?? 0) + 1);
        }
      }

      if (countByTopic.size === 0) {
        // No active user has any topics yet — fall back to the broad cold-start
        // prior so the cron sweep still resolves a profile. This is a full
        // synthetic snapshot replacement, so stale aggregate topics disappear.
        log.info('no active-user topics — replacing system-discovery with the broad prior');
        await replaceSyntheticInterestProfileTopics(systemUserId, vertical, [...DEFAULT_BROAD_TOPICS]);
        return 0;
      }

      // Stable frequency rank: higher count first, lexical topic tie-break.
      const ranked = [...countByTopic.keys()]
        .sort((a, b) => (countByTopic.get(b) ?? 0) - (countByTopic.get(a) ?? 0) || a.localeCompare(b))
        .slice(0, MAX_INTEREST_PROFILE_TOPICS);
      await replaceSyntheticInterestProfileTopics(systemUserId, vertical, ranked);
      log.info('system-discovery InterestProfile aggregated', { topicCount: ranked.length });
      return ranked.length;
    });

    return { skipped: false, userCount: activeUserIds.length, refreshed, systemTopics };
  }
);
