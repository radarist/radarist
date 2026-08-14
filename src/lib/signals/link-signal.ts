/**
 * @file lib/signals/link-signal.ts
 * @description Link ONE just-approved signal to entities on demand (e.g. on like).
 *
 * The auto-linker normally runs as a 6-hour Inngest cron (`run-linker-cycle`), so a
 * freshly-approved signal would sit unlinked until the next sweep — and in the local
 * stack the cron may not run at all. This helper runs the SAME linker pipeline
 * (generateCandidates → verifyCandidatesWithAI → createProposedRelation) scoped to a
 * single signal, so liking a signal links it immediately. Cheap: it processes only
 * the one signal (not the whole Approved collection), bounding both Firestore reads
 * and AI-verification cost.
 *
 * Server-only: admin SDK + linker internals.
 */
import 'server-only';

import { createHash } from 'crypto';
import { generateCandidatesForSignal, verifyCandidatesWithAI } from '@/lib/linker';
import { createProposedRelationIfNotExists } from '@/lib/proposed-relations-admin';
import { createLogger } from '@/lib/logger';
import type { EntityType, EvidenceReference, RelationType } from '@/lib/types';

const log = createLogger('signals/link-signal');

export interface LinkSignalResult {
  candidates: number;
  verified: number;
  created: number;
}

/**
 * Generate + verify + persist proposed relations for a single Approved signal.
 * No-op (returns zeros) for missing / non-Approved signals. Never throws — linking
 * is best-effort and must not fail the like/enrich flow that calls it.
 */
export async function linkSignalNow(signalId: string): Promise<LinkSignalResult> {
  const empty: LinkSignalResult = { candidates: 0, verified: 0, created: 0 };
  try {
    // Heuristic-only candidate generation (no embeddings) keeps this fast + token-free;
    // the AI verifier below is the quality gate, exactly as the cron uses it.
    const candidates = await generateCandidatesForSignal(signalId, { useEmbeddings: false });
    if (candidates.length === 0) return empty;

    const verified = await verifyCandidatesWithAI(candidates);
    if (verified.length === 0) return { candidates: candidates.length, verified: 0, created: 0 };

    const now = Date.now();
    let created = 0;
    for (const cand of verified) {
      try {
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

        const res = await createProposedRelationIfNotExists({
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
        if (res.created) created++;
      } catch (err) {
        log.warn('linkSignalNow: createProposedRelation threw', {
          signalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('linkSignalNow complete', { signalId, candidates: candidates.length, verified: verified.length, created });
    return { candidates: candidates.length, verified: verified.length, created };
  } catch (err) {
    log.warn('linkSignalNow failed (non-fatal)', {
      signalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}
