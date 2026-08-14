/**
 * @file fetch-signals.ts
 * @description Scheduled Inngest job that pulls signals from external sources
 * (patents, papers, news, github, funding, trends) and writes them to Firestore
 * via createSignal.
 *
 * Runs every 6 hours or on-demand via the 'app/schedule.signals.fetch' event.
 *
 * Signature adaptation notes (vs. original spec):
 * - fetchFromAllSources(params, config) requires FetchSignalsParams + SystemConfiguration.
 *   Config is loaded live from Firestore via getSystemConfig() so user's disabled-source
 *   settings are always respected.
 * - Return type is Record<string, FetchSignalsResult> (not Record<string, RawSignalItem[]>).
 *   We iterate result.signals (already shaped Signal objects) and call createSignal().
 * - createSignal() takes Omit<Signal, 'id' | 'slug' | 'reviewedAt' | 'processedAt'>.
 *   The FetchSignalsResult.signals are already in Signal shape so we pass them through.
 */
import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { fetchFromAllSources } from '@/lib/signal-fetchers';
import type { FetchSignalsResult } from '@/lib/signal-fetchers';
// Pure module (zero imports) — safe to import statically in Inngest workers.
import { DEFAULT_SIGNAL_SOURCES } from '@/lib/signal-source-defaults';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/fetch-signals');

// ---------------------------------------------------------------------------
// Admin-SDK direct write path
// ---------------------------------------------------------------------------
//
// The previous implementation called signals-core.ts:createSignal → entity-
// factory.ts:createEntity, both of which import the firebase Web (client)
// SDK. Server-side the client SDK has no auth context; its gRPC Listen/Write
// streams hang ~5-50s and fail with "Failed to get document because the
// client is offline". The 6-hourly cron had been failing silently since
// 2026-05-11 06:03 UTC — ingestion stopped, the dashboard's "Recent Updates"
// stayed frozen on stale rows.
//
// Same bug class as the 2026-05-12 sync-function fixes (commit c449b7ce):
// we keep going through shared service modules that were never migrated to
// firebase-admin. Surgical fix: skip the service layer and write through the
// admin SDK directly. The wider entity-factory migration is post-rc.1 work
// (it needs error-class extraction so client hooks can still import
// DuplicateEntityError).
//
// `findSignalByUrlAdmin` deduplicates by (source, url) — same pre-check the
// old code had, just via admin SDK. `createSignalAdmin` generates the
// slug/id inline (no dependency on entity-factory), writes the doc, and
// fires the Neo4j sync event so the entity still lands in the graph.

function generateSignalSlug(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

function generateSignalId(): string {
  return `signal-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function findSignalByUrlAdmin(
  adminDb: import('firebase-admin/firestore').Firestore,
  source: string,
  url: string | undefined
): Promise<boolean> {
  if (!url) return false;
  const snap = await adminDb.collection('signals').where('source', '==', source).where('url', '==', url).limit(1).get();
  return !snap.empty;
}

async function createSignalAdmin(
  adminDb: import('firebase-admin/firestore').Firestore,
  input: Record<string, unknown> & { title: string }
): Promise<string> {
  const id = generateSignalId();
  const slug = generateSignalSlug(input.title);
  const now = Date.now();
  const doc = {
    ...input,
    id,
    slug,
    createdAt: now,
    updatedAt: now,
  };
  // Drop undefined fields — Firestore admin SDK rejects them.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (v !== undefined) clean[k] = v;
  await adminDb.collection('signals').doc(id).set(clean);

  // Fire Neo4j sync event so the graph picks up the new signal.
  // Best-effort: ingestion shouldn't fail if Inngest is unavailable.
  try {
    await inngest.send({
      name: 'app/unified-entity.sync.requested',
      data: { entityId: id, entityType: 'signal', operation: 'create' },
    });
  } catch (err) {
    log.warn('createSignalAdmin: graph sync event send failed', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return id;
}

/**
 * Scheduled job: fetch signals from all external sources every 6 hours.
 *
 * Event payload:
 * - source: which source to limit to ('patents' | 'papers' | 'news' | 'github' | 'all')
 * - maxPerSource: maximum signals to fetch per source (default 20)
 * - dryRun: if true, fetches but does not call createSignal (useful for testing)
 *
 * Returns: { sources: Record<string, number>, totalCreated: number, durationMs: number }
 */
export const fetchSignalsJob = inngest.createFunction(
  {
    id: 'fetch-signals',
    name: 'Fetch Signals from External Sources',
    retries: 2,
    onFailure: async ({ error }) => {
      log.error('fetch-signals failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  [{ event: 'app/schedule.signals.fetch' }, { cron: 'TZ=UTC 0 */6 * * *' }],
  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('fetch-signals');
    // Capture start inside a memoized step so durationMs survives Inngest replay.
    const startedAt = await step.run('record-start', async () => Date.now());
    const {
      source = 'all',
      maxPerSource = 20,
      dryRun = false,
    } = (event?.data ?? {}) as {
      source?: string;
      maxPerSource?: number;
      dryRun?: boolean;
    };

    // I1: Load live config from Firestore so user's enabled-source settings
    // are respected. Read via admin SDK directly — `@/lib/system-config`
    // imports the client SDK transitively (`@/lib/firebase`) which hangs the
    // gRPC stream server-side. Same bug class as the createSignal fix below.
    let config = await step.run('load-config', async () => {
      try {
        const { db: adminDb } = await import('@/lib/firebase-admin');
        const snap = await adminDb.collection('system-config').doc('global').get();
        if (snap.exists) {
          return snap.data() as import('@/lib/types').SystemConfiguration;
        }
      } catch (error) {
        log.error(
          'fetch-signals: failed to read system config; background automation remains paused',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      // Missing or unreadable config falls back to a paused minimal default using the
      // shared canonical sources (signal-source-defaults.ts): patents off
      // (legacy PatentsView endpoint retired — see docs/LIMITATIONS.md),
      // funding off (requires paid API). The full default-init path lives in
      // system-config.ts:initializeSystemConfig and runs at first app boot.
      log.info('fetch-signals: system-config/global unavailable, using paused fallback');
      return {
        id: 'global',
        agentMode: { mode: 'copilot', autoActionThreshold: 80 },
        signalDetection: {
          enabled: false,
          frequency: 'daily',
          minRelevanceScore: 50,
          sources: { ...DEFAULT_SIGNAL_SOURCES },
        },
        sweep: { enabled: false, maxActionsPerSweep: 10 },
      } as unknown as import('@/lib/types').SystemConfiguration;
    });

    const automationPolicy = resolveBackgroundAutomationPolicy(config);
    if (!automationPolicy.signalFetchEnabled) {
      log.info('fetch-signals: background automation or signal detection is disabled');
      return {
        action: 'disabled',
        sources: {},
        totalCreated: 0,
        skippedDuplicates: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // Narrow config.signalDetection.sources to the requested source when caller specifies one.
    if (source !== 'all' && source) {
      const sources = {
        patents: source === 'patents',
        papers: source === 'papers',
        news: source === 'news',
        github: source === 'github',
        funding: source === 'funding',
        trends: source === 'trends',
        hackernews: source === 'hackernews',
        sec: source === 'sec',
      };
      config = {
        ...config,
        signalDetection: { ...config.signalDetection, sources },
      };
    }

    // I3: keywords are interest-weighted (fetch → like/dislike → posterior →
    // next-fetch loop), not hardcoded. Dynamic import inside step.run — the
    // codebase's admin-safe Inngest pattern (see the client/server-boundary
    // note above load-config). getAggregateInterestKeywords never throws and
    // never returns an empty array (cold-start falls back to its own internal
    // defaults), so no additional guard is needed here.
    const { keywords, discoveryTopics } = await step.run('interest-keywords', async () => {
      const { getAggregateInterestKeywords } = await import('@/lib/discovery/interest-keywords');
      return getAggregateInterestKeywords({ maxSignals: maxPerSource, now: Date.now() });
    });

    const fetchParams = {
      keywords,
      timeRangeDays: 7,
      maxSignals: maxPerSource,
      // C1: relevance pre-selection. `??` (not `||`) preserves an explicit 0
      // meaning "no filter" (see BaseFetcher.fetch's `if (params.minRelevance)`
      // check) while still falling back to 50 when the field is genuinely absent.
      minRelevance: config.signalDetection?.minRelevanceScore ?? 50,
    };

    const raw = await step.run('fetch-from-sources', async () => fetchFromAllSources(fetchParams, config));

    const results = raw as Record<string, FetchSignalsResult>;

    const sources: Record<string, number> = {};
    // Actionable source health (OPS-002): a source whose failure is permanent
    // (retired endpoint, permanent 4xx, HTML-where-JSON-expected) is reported
    // distinctly so an operator can disable/repair it rather than have it
    // silently fail — and fail fast — every cycle.
    const unhealthySources: Array<{ source: string; error: string; permanent: boolean }> = [];
    for (const [key, result] of Object.entries(results)) {
      if (result.success === false) {
        unhealthySources.push({
          source: key,
          error: result.error ?? 'Unknown error',
          permanent: result.permanent === true,
        });
      }
    }
    if (unhealthySources.length > 0) {
      log.warn('fetch-signals: source health degraded', { unhealthySources });
    }
    let totalCreated = 0;
    let skippedDuplicates = 0;

    // Load admin SDK once outside the loop. See the comment above
    // findSignalByUrlAdmin for the bug context.
    const { db: adminDb } = await import('@/lib/firebase-admin');

    for (const [key, result] of Object.entries(results)) {
      const items = result.signals ?? [];
      sources[key] = items.length;

      if (dryRun) continue;

      for (const signal of items) {
        const source = signal.source ?? key;
        // Pre-check: skip if a signal with this (source, url) already exists.
        // Without this the periodic job re-creates the same external items.
        if (await findSignalByUrlAdmin(adminDb, source, signal.url)) {
          skippedDuplicates++;
          continue;
        }
        try {
          const matchedKeyword = signal.metadata?.matchedKeyword as string | undefined;
          const discoveryTopic = matchedKeyword ? discoveryTopics[matchedKeyword] : undefined;
          await createSignalAdmin(adminDb, {
            type: signal.type,
            title: signal.title,
            description: signal.description ?? '',
            source,
            url: signal.url,
            date: signal.date ?? Date.now(),
            detectedAt: signal.detectedAt ?? Date.now(),
            relevanceScore: signal.relevanceScore ?? 0,
            alignmentScore: signal.alignmentScore ?? 0,
            alignedStrategies: signal.alignedStrategies ?? [],
            linkedEntities: signal.linkedEntities ?? {},
            status: 'Detected',
            sentiment: signal.sentiment ?? 'neutral',
            aiSummary: signal.aiSummary ?? signal.description ?? '',
            metadata: {
              ...signal.metadata,
              fetchedBy: 'inngest:fetch-signals',
              ...(discoveryTopic ? { discoveryTopic } : {}),
            },
          });
          totalCreated++;
        } catch (err) {
          log.warn('fetch-signals: createSignalAdmin failed', {
            source: key,
            title: signal.title,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;

    log.info('fetch-signals complete', { sources, totalCreated, skippedDuplicates, unhealthySources, durationMs });
    return { sources, totalCreated, skippedDuplicates, unhealthySources, durationMs };
  }
);
