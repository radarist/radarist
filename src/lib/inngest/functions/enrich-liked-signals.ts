/**
 * @file lib/inngest/functions/enrich-liked-signals.ts
 * @description Batch path for "enrich on like". Only does work when
 * SIGNAL_ENRICH_ON_LIKE=batch — it sweeps Approved-but-unexpanded signals and queues
 * an enrichment pass for up to SIGNAL_ENRICH_BATCH_LIMIT of them (idempotent: already-
 * expanded / in-flight signals are skipped, so no double token spend).
 *
 * In `online` (default) or `off` mode this is a cheap no-op (runBatchEnrichLikedSignals
 * returns early), so the cron can stay registered regardless of mode.
 *
 * **Trigger:** Cron (default every 6h; override via SIGNAL_ENRICH_BATCH_CRON).
 */
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { runBatchEnrichLikedSignals } from '@/lib/signals/enrich-on-like';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/enrich-liked-signals');

const CRON = process.env.SIGNAL_ENRICH_BATCH_CRON ?? 'TZ=UTC 0 */6 * * *';

export const enrichLikedSignalsJob = inngest.createFunction(
  { id: 'enrich-liked-signals', name: 'Enrich Liked Signals (batch)', retries: 1 },
  { cron: CRON },
  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('enrich-liked-signals');
    const result = await step.run('sweep-approved-unexpanded', async () => runBatchEnrichLikedSignals());
    log.info('Enrich-liked-signals batch sweep complete', result);
    return result;
  }
);
