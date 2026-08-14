/**
 * @file lib/signals/enrich-on-like.ts
 * @description "Enrich on like" — when a user likes/approves a signal, optionally queue
 * an enrichment (deep-research expansion) pass on it, reusing the existing expand pipeline
 * (`app/signal.expand.requested` → expandSignalJob).
 *
 * Mode is env-configured (SIGNAL_ENRICH_ON_LIKE):
 *   - online (default) — queue the enrichment immediately on like.
 *   - batch            — likes do nothing now; the enrich-liked-signals cron sweeps them.
 *   - off              — never auto-enrich on like.
 *
 * IDEMPOTENCY (no double token spend — this is the whole point):
 *   - already-expanded signals (have `expandedContent`) → skipped, zero tokens.
 *   - in-flight signals (a recent `metadata.expansionQueuedAt`, no result yet — e.g. you
 *     liked it twice fast) → skipped.
 * The expand pipeline itself has NO idempotency guard today, so this layer is what keeps
 * a "like" from re-running an expensive AI+web pass on a signal that's already full.
 *
 * Server-only: emits an Inngest event + uses the admin SDK.
 */
import 'server-only';

import type { Signal } from '@/lib/types';
import { adminGetSignalById, adminGetSignals, adminUpdateSignal } from '@/lib/signals-admin';
import { expandSignal } from '@/lib/signals/expand-signal';
import { linkSignalNow } from '@/lib/signals/link-signal';
import { safeSendEvent } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';

const log = createLogger('signals/enrich-on-like');

export type EnrichOnLikeMode = 'online' | 'batch' | 'off';

/** A re-like within this window of a queued (but not-yet-completed) expansion is a no-op. */
const IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;
/** Cap how many signals one batch sweep enriches, to bound token spend per run. */
const BATCH_LIMIT = Number(process.env.SIGNAL_ENRICH_BATCH_LIMIT ?? '20');

export function signalEnrichOnLikeMode(): EnrichOnLikeMode {
  const v = (process.env.SIGNAL_ENRICH_ON_LIKE ?? 'online').toLowerCase();
  return v === 'batch' || v === 'off' ? v : 'online';
}

export type EnrichOnLikeReason =
  | 'queued'
  | 'disabled'
  | 'already-expanded'
  | 'in-flight'
  | 'batch-deferred'
  | 'not-found';

export interface EnrichOnLikeResult {
  queued: boolean;
  reason: EnrichOnLikeReason;
}

/** Idempotency gate — should we enrich this signal at all? (the no-double-token-spend rule) */
function enrichEligibility(signal: Signal): { ok: boolean; reason: EnrichOnLikeReason } {
  // Already full — nothing to do, no tokens. (The "I like an already-complete one" case.)
  if (signal.expandedContent) return { ok: false, reason: 'already-expanded' };
  // In-flight — a recent queue with no result yet (rapid re-likes).
  const queuedAt = signal.metadata?.expansionQueuedAt;
  if (queuedAt && Date.now() - queuedAt < IN_FLIGHT_WINDOW_MS) return { ok: false, reason: 'in-flight' };
  return { ok: true, reason: 'queued' };
}

/** Mark in-flight FIRST so a concurrent/near-immediate re-like sees it and skips. */
async function markInFlight(signal: Signal): Promise<void> {
  await adminUpdateSignal(signal.id, {
    metadata: { ...(signal.metadata ?? {}), expansionQueuedAt: Date.now() },
  });
}

/**
 * Online entry point — called when a signal is liked/approved (chat tool + UI API route).
 * Runs the enrichment DIRECTLY via the expandSignal service (the SAME proven path the chat
 * expandSignal tool uses), NOT an Inngest event — so it works even when the event runner
 * isn't consuming. It's slow (deep research), so callers FIRE-AND-FORGET it; the like never
 * waits. Idempotent + a no-op in batch/off mode.
 */
export async function queueEnrichOnLike(signalId: string): Promise<EnrichOnLikeResult> {
  const mode = signalEnrichOnLikeMode();
  if (mode === 'off') return { queued: false, reason: 'disabled' };

  const signal = await adminGetSignalById(signalId);
  if (!signal) return { queued: false, reason: 'not-found' };

  const elig = enrichEligibility(signal);
  if (!elig.ok) return { queued: false, reason: elig.reason };

  // Batch mode: leave it Approved + unexpanded; the cron will pick it up.
  if (mode === 'batch') return { queued: false, reason: 'batch-deferred' };

  // Online: mark in-flight, then expand in place. expandSignal sets expandedContent, so a
  // later like is then a clean 'already-expanded' no-op.
  await markInFlight(signal);
  await expandSignal(signalId);
  log.info('Enriched signal on like', { signalId });

  // …then LINK it. The signal is now Approved (the like set that), so run a scoped
  // linker pass so its "Related Entities" populate immediately instead of waiting for
  // the 6-hour linker cron. Best-effort — linkSignalNow never throws.
  const linkResult = await linkSignalNow(signalId);
  log.info('Linked signal on like', { signalId, ...linkResult });

  return { queued: true, reason: 'queued' };
}

/**
 * Batch entry point — the enrich-liked-signals cron (batch mode only). Emits an Inngest
 * event per Approved-but-unexpanded signal so each expands as its own job run (fan-out is
 * better for bulk than N sequential in-request expansions).
 */
export async function runBatchEnrichLikedSignals(): Promise<{
  scanned: number;
  queued: number;
  mode: EnrichOnLikeMode;
}> {
  const mode = signalEnrichOnLikeMode();
  if (mode !== 'batch') return { scanned: 0, queued: 0, mode };

  const all = await adminGetSignals();
  const eligible = all.filter((s) => s.status === 'Approved' && !s.expandedContent).slice(0, BATCH_LIMIT);
  let queued = 0;
  for (const s of eligible) {
    if (!enrichEligibility(s).ok) continue;
    await markInFlight(s);
    await safeSendEvent(
      { name: 'app/signal.expand.requested', data: { signalId: s.id } },
      { silent: true, logPrefix: '[enrich-on-like-batch]' }
    );
    queued++;
  }
  log.info('Batch enrich-liked-signals sweep', { scanned: eligible.length, queued });
  return { scanned: eligible.length, queued, mode };
}
