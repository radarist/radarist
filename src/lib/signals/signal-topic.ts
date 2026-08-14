/**
 * @file signals/signal-topic.ts
 * @description Resolve a signal's interest TOPIC for the feedback steering wire (P1) and for
 * the "For you" interest-boost sort (US-2, `deriveSignalTopicsBatch`).
 * Signals carry no tags of their own, so the topic comes from the signal's FIRST linked
 * technology — a `"radarId:entryId"` ref into `radars/{radarId}/entries` (the same format
 * + resolver the relation-snapshot refresh uses). The RadarEntry's tags are the source of
 * truth; we derive from the MEANINGFUL (stopword-filtered) tags so a stopword-first entry
 * can't yield a junk topic.
 *
 * Linked-tech path is PREFERRED. When there is no linked tech, an unresolvable entry, or an
 * entry with no usable tag, it falls back to `metadata.discoveryTopic` — the topic a discovery-lane
 * signal was fetched under (S12) — then to `metadata.matchedKeyword` (the raw keyword a signal was
 * fetched under, when no `discoveryTopic` was stamped) — so a dislike still lands on the posterior.
 * Only when none of a linked tag, a discovery topic, NOR a matched keyword exists does it return
 * `undefined` (the caller then SKIPS the wire rather than stranding the posterior on a verbatim
 * type). Tolerant of a null signal (the doc may be deleted on the async hot path). Server-only
 * (admin Firestore read).
 *
 * Caveat: these are the linked RadarEntry's tags, not guaranteed identical to the joined
 * `Technology.tags` the selector reads — the best available coupling without an extra
 * placement→technologies join (a deliberate follow-up, not P1).
 *
 * `deriveSignalTopicsBatch` is a separate, LIST-SCALE primitive (not a loop over
 * `deriveSignalTopic`) for the triage list's "For you" sort. Precedence MIRRORS
 * `deriveSignalTopic` above (linked-tech first, `discoveryTopic ?? matchedKeyword` fallback) —
 * this is a write/read key-space parity requirement: the feedback writer
 * (`deriveSignalTopic`, used by `submitSignalFeedback`) posts a like/dislike to whichever topic
 * it resolves, so the read side MUST resolve the identical topic for the same signal or a vote
 * never boosts (or boosts the wrong topic). Read cost is still minimized: pass 1 is read-free
 * and only handles signals with NO `linkedTechRef` (`discoveryTopic ?? matchedKeyword` straight
 * off the input); pass 2 handles every signal that HAS a `linkedTechRef` (regardless of whether
 * discoveryTopic/matchedKeyword is also present), grouping by radarId and reading each radar's
 * `entries` subcollection AT MOST ONCE per call, however many signals reference it — avoiding
 * the N+1 scan `deriveSignalTopic` does per-signal. When a linked-tech signal's entry can't be
 * resolved (missing entry / no usable tags), it falls back to that signal's own
 * `discoveryTopic ?? matchedKeyword` — the same fallback chain `deriveSignalTopic` uses.
 */
import 'server-only';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { deriveTopicFromTags, meaningfulTags, normalizeTopicKey } from '@/lib/discovery/candidate-topic';
import type { Signal, RadarEntry } from '@/lib/types';

const log = createLogger('signals/signal-topic');

export async function deriveSignalTopic(signal: Signal | null | undefined): Promise<string | undefined> {
  if (!signal) return undefined;

  // Discovery-lane signals have no linked radar tech (that's the whole point — they're
  // adjacent, not yet tracked). Falling back to the discovery keyword's topic means a
  // dislike still lands on the posterior instead of being silently dropped. When no
  // discoveryTopic was stamped either, fall back further to the raw matchedKeyword —
  // mirrors deriveSignalTopicsBatch's `discoveryTopic ?? matchedKeyword` precedence
  // (write/read key-space parity — see the file header + the parity-lock test).
  const discoveryFallback = (): string | undefined => {
    const dt = signal.metadata?.discoveryTopic;
    if (typeof dt === 'string' && dt.trim()) return normalizeTopicKey(dt);
    const mk = signal.metadata?.matchedKeyword;
    return typeof mk === 'string' && mk.trim() ? normalizeTopicKey(mk) : undefined;
  };

  const linked = signal.linkedEntities?.technologies?.[0];
  if (!linked) return discoveryFallback();

  const [radarId, entryIdStr] = linked.split(':');
  const entryId = parseInt(entryIdStr ?? '', 10);
  if (!radarId || Number.isNaN(entryId)) return discoveryFallback();

  try {
    const snap = await db.collection('radars').doc(radarId).collection('entries').get();
    const entry = snap.docs.map((d) => d.data() as RadarEntry).find((e) => e.id === entryId);
    if (!entry) return discoveryFallback();
    const meaningful = meaningfulTags(entry.tags ?? []);
    if (meaningful.length === 0) return discoveryFallback(); // no usable tag → fall back rather than key on junk
    return deriveTopicFromTags(meaningful, 'technology');
  } catch (error) {
    log.warn('deriveSignalTopic failed (falling back to discoveryTopic)', {
      signalId: signal.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return discoveryFallback();
  }
}

/**
 * Minimal per-signal shape `deriveSignalTopicsBatch` needs — the fields available directly
 * off a full `Signal` doc (`getSignals()`), without requiring the whole object. Keeps callers
 * read-free-friendly (no doc fetch needed to build the input) and easy to construct in tests.
 */
export interface SignalTopicRef {
  id: string;
  /** `Signal.linkedEntities.technologies[0]` verbatim — composite `"radarId:entryId"`. */
  linkedTechRef?: string;
  /** `Signal.metadata?.discoveryTopic`. */
  discoveryTopic?: string;
  /** `Signal.metadata?.matchedKeyword`. */
  matchedKeyword?: string;
}

/** Blank/whitespace-only strings are treated as absent — same hygiene as `deriveSignalTopic`. */
function nonBlank(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? normalizeTopicKey(value) : undefined;
}

/**
 * Batched signal→topic resolution for list-scale callers (the triage list's "For you" sort).
 * See the file header for why precedence MIRRORS `deriveSignalTopic` (linked-tech first) —
 * this is the read side of the write/read key-space parity: `deriveSignalTopic` (the feedback
 * writer) resolves linked-tech before discoveryTopic, so this batch resolver must too, or a
 * signal with both a resolvable `linkedTechRef` and discovery metadata would post a vote under
 * one topic key and read the boost under a different one.
 *
 * Pass 1 (read-free): signals WITHOUT a `linkedTechRef` resolve straight off the input —
 * `discoveryTopic ?? matchedKeyword`.
 * Pass 2: every signal WITH a `linkedTechRef` (regardless of discoveryTopic/matchedKeyword) —
 * split `"radarId:entryId"`, group by radarId, read each radar's `entries` subcollection AT
 * MOST ONCE (cached for this call only), then resolve the entry's meaningful tags the same way
 * `deriveSignalTopic` does. A malformed ref, an unresolvable entry, or an entry with no usable
 * tags falls back to that signal's own `discoveryTopic ?? matchedKeyword` — the identical
 * fallback chain `deriveSignalTopic` uses.
 *
 * Never throws — a radar read failure resolves that radar's signals via the discovery-metadata
 * fallback (or `undefined` if that's also absent), logged and isolated from the rest of the batch.
 */
export async function deriveSignalTopicsBatch(signals: SignalTopicRef[]): Promise<Record<string, string | undefined>> {
  const topics: Record<string, string | undefined> = {};
  const pending: Array<{ id: string; radarId: string; entryId: number; fallback: string | undefined }> = [];

  for (const signal of signals) {
    const fallback = nonBlank(signal.discoveryTopic) ?? nonBlank(signal.matchedKeyword);

    const linked = signal.linkedTechRef;
    if (!linked) {
      topics[signal.id] = fallback;
      continue;
    }

    const [radarId, entryIdStr] = linked.split(':');
    const entryId = parseInt(entryIdStr ?? '', 10);
    if (!radarId || Number.isNaN(entryId)) {
      // Malformed compound id — same "can't resolve the linked entry" fallback as below.
      topics[signal.id] = fallback;
      continue;
    }

    pending.push({ id: signal.id, radarId, entryId, fallback });
  }

  if (pending.length === 0) return topics;

  // One entries read per distinct radarId, however many pending signals reference it.
  const radarIds = [...new Set(pending.map((p) => p.radarId))];
  const entriesByRadar = new Map<string, RadarEntry[]>();

  await Promise.all(
    radarIds.map(async (radarId) => {
      try {
        const snap = await db.collection('radars').doc(radarId).collection('entries').get();
        entriesByRadar.set(
          radarId,
          snap.docs.map((d) => d.data() as RadarEntry)
        );
      } catch (error) {
        log.warn(
          'deriveSignalTopicsBatch: entries read failed for radar (signals in it fall back to discovery metadata)',
          {
            radarId,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        entriesByRadar.set(radarId, []);
      }
    })
  );

  for (const { id, radarId, entryId, fallback } of pending) {
    const entry = (entriesByRadar.get(radarId) ?? []).find((e) => e.id === entryId);
    const meaningful = entry ? meaningfulTags(entry.tags ?? []) : [];
    topics[id] = meaningful.length === 0 ? fallback : deriveTopicFromTags(meaningful, 'technology');
  }

  return topics;
}
