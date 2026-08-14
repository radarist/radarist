/**
 * @file run-linker-cycle.ts
 * @description Scheduled Inngest job that revives the auto-linker.
 *
 * Runs every 6 hours, exercising the existing src/lib/linker/
 * pipeline: generateCandidates → verifyCandidatesWithAI →
 * createProposedRelationIfNotExists.
 *
 * Proposed relations land in the linker triage queue for reviewer
 * approval, rebuilding coverage across orphan Technologies, Signals,
 * and other under-connected entities.
 */
import { createHash } from 'crypto';
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { generateCandidates, verifyCandidatesWithAI } from '@/lib/linker';
import { createProposedRelationIfNotExists } from '@/lib/proposed-relations-admin';
import { createLogger } from '@/lib/logger';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import type { EntityType, EvidenceReference, RelationType } from '@/lib/types';

const log = createLogger('inngest/run-linker-cycle');

export const runLinkerCycleJob = inngest.createFunction(
  {
    id: 'run-linker-cycle',
    name: 'Run Linker Cycle',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('linker cycle failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  [{ event: 'app/schedule.linker.cycle' }, { cron: 'TZ=UTC 0 */6 * * *' }],
  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('run-linker-cycle');
    // Inngest replays handler code outside step.run(), so capture start-time
    // inside a memoized step so durationMs survives replay.
    const startedAt = await step.run('record-start', async () => Date.now());
    const { maxCandidatesPerEntity = 5, dryRun = false } = (event?.data ?? {}) as {
      maxCandidatesPerEntity?: number;
      dryRun?: boolean;
    };

    const automationPolicy = await step.run('load-automation-policy', async () => {
      try {
        const { db: adminDb } = await import('@/lib/firebase-admin');
        const snap = await adminDb.collection('system-config').doc('global').get();
        return resolveBackgroundAutomationPolicy(snap.exists ? snap.data() : undefined);
      } catch (error) {
        log.error(
          'linker: failed to read system config; background automation remains paused',
          error instanceof Error ? error : new Error(String(error))
        );
        return resolveBackgroundAutomationPolicy(undefined);
      }
    });

    if (!automationPolicy.linkerEnabled) {
      return {
        action: 'disabled',
        candidatesGenerated: 0,
        candidatesVerified: 0,
        proposedRelationsCreated: 0,
        outcomes: { created: 0, rejected: 0 },
        durationMs: Date.now() - startedAt,
      };
    }

    // Stage 1: generate candidates across all source types in one bulk pass
    const candidates = await step.run('generate-candidates', async () =>
      generateCandidates({ maxCandidatesPerEntity, useEmbeddings: true })
    );

    // Stage 2: filter through AI verification (applies entity-specific thresholds)
    const verified = await step.run('verify-candidates', async () => verifyCandidatesWithAI(candidates));

    // Stage 3: persist as ProposedRelations (skip on dry run)
    let proposedRelationsCreated = 0;
    const outcomes: Record<string, number> = { created: 0, rejected: 0 };
    if (!dryRun) {
      const now = Date.now();
      const results = await Promise.allSettled(
        verified.map(async (cand) => {
          const sourceType = cand.sourceType as EntityType;
          const targetType = cand.targetType as EntityType;
          const reasoning = cand.evidenceSnippets?.join(' | ') ?? `Discovered via ${cand.discoveryMethod}`;
          const evidence: EvidenceReference[] = (cand.evidenceSnippets ?? []).slice(0, 5).map((snippet) => {
            const trimmed = snippet.slice(0, 500);
            return {
              sourceType: 'entity_field',
              sourceId: cand.sourceId,
              location: { entityType: sourceType, field: `linker:${cand.discoveryMethod}` },
              snippet: trimmed,
              snippetHash: createHash('sha256').update(trimmed).digest('hex'),
              extractedAt: now,
            };
          });

          return createProposedRelationIfNotExists({
            sourceId: cand.sourceId,
            sourceType,
            sourceSnapshot: { type: sourceType, id: cand.sourceId, name: cand.sourceName, snapshotAt: now },
            targetId: cand.targetId,
            targetType,
            targetSnapshot: { type: targetType, id: cand.targetId, name: cand.targetName, snapshotAt: now },
            relationType: cand.relationType as RelationType,
            confidence: cand.confidence,
            reasoning,
            evidence,
            discoveredBy: 'linker-agent',
          });
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.created) {
            proposedRelationsCreated++;
            outcomes.created++;
          } else {
            const reason = r.value.reason ?? 'unknown';
            outcomes[reason] = (outcomes[reason] ?? 0) + 1;
          }
        } else {
          outcomes.rejected++;
          log.warn('linker: createProposedRelationIfNotExists threw', {
            error: r.reason instanceof Error ? `${r.reason.name}: ${r.reason.message}` : String(r.reason),
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;

    await step.run('emit-completion-event', async () => {
      await inngest.send({
        name: 'app/schedule.linker.cycle.completed',
        data: {
          candidatesGenerated: candidates.length,
          candidatesVerified: verified.length,
          proposedRelationsCreated,
          durationMs,
        },
      });
    });

    log.info('linker cycle complete', {
      candidatesGenerated: candidates.length,
      candidatesVerified: verified.length,
      proposedRelationsCreated,
      outcomes,
      durationMs,
    });

    return {
      candidatesGenerated: candidates.length,
      candidatesVerified: verified.length,
      proposedRelationsCreated,
      outcomes,
      durationMs,
    };
  }
);
