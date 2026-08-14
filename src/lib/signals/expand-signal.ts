/**
 * @file lib/signals/expand-signal.ts
 * @description Main signal expansion function (Phase 4.2)
 *
 * Expands signals with:
 * - Deep entity analysis using Gemini + Google Search
 * - Strategic alignment assessment
 * - Trust score calculation
 * - Actionable recommendations
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

// NOTE: Removed 'use server' 2026-04-19 — this file is a server-only lib imported
// only by Inngest functions (src/lib/inngest/functions/expand-signal.ts), not a
// Next.js Server Actions module. Next 16 hard-errors on sync exports from
// 'use server' files; scoreSignalExpansion is intentionally sync (pure CPU).
// Grep confirms no UI/client imports of this file — removing the directive is safe.
//
// 2026-05-13: Migrated to admin SDK in place (T1.3 of firebase-admin migration
// plan v2.4). Was reaching client SDK at module load via static imports of
// `@/lib/signals` and `@/lib/strategies`; both now read inline via admin SDK.
// Audit before T1.3 confirmed no non-Inngest callers of this file.
import 'server-only';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { generateContent, generateGroundedContent } from '@/lib/ai/client';
import { getExpansionPrompt, type StrategyContext } from './expansion-prompts';
import { calculateTrustScore, type TrustScoreInput } from './trust-score';
import type { Signal } from '@/lib/types';
import type { Strategy } from '@/lib/types';
import type { ExpandedContent } from '@/lib/schemas/signal';
import { createLogger } from '@/lib/logger';
import { normalizeSignalEvidenceSources } from './evidence-sources';
import { resolveGroundingCitationIdentities } from './grounding-citations';
import {
  isDirectlyProjectableSignalStatus,
  resolveExpansionEndpoints,
  toPersistedRejections,
  type CandidateLoader,
  type ExpansionEndpointResolution,
  type RejectedExpansionEndpoint,
} from './expansion-endpoint-resolution';

const log = createLogger('signals/expand');

/**
 * Result of signal expansion
 */
export interface ExpandSignalResult {
  success: boolean;
  signalId: string;
  expansionDuration: number;
  error?: string;
  expandedContent?: ExpandedContent;
  trustScore?: import('@/lib/schemas/signal').TrustScore;
  /**
   * GRAPH-063 — what happened to the endpoint IDs the model produced. A caller
   * that reports success without this cannot tell a fully-grounded expansion
   * from one whose invented links were silently dropped.
   */
  endpointResolution?: {
    kept: number;
    resolved: number;
    rejected: number;
    rejectedEndpoints: RejectedExpansionEndpoint[];
  };
}

/**
 * Options for signal expansion
 */
export interface ExpandSignalOptions {
  /** Use quick expansion (less detailed) */
  quick?: boolean;
  /** AI model to use */
  model?: 'gemini-3-flash-preview' | 'gemini-2.5-pro' | 'gemini-3.1-pro-preview';
  /** Enable Google Search */
  useGoogleSearch?: boolean;
  /** Thinking level */
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
}

// ============================================================================
// Atomic phases — callable as individual Inngest step.run() boundaries.
// Keep each phase cheap enough to complete inside a single Inngest HTTP
// round-trip (no hidden long-running work in the non-AI phases).
// ============================================================================

export interface SignalExpansionContext {
  signal: Signal;
  strategies: StrategyContext[];
  startTime: number;
}

/** Phase 1 — load signal + strategies (read-only Firestore). Typical latency: 100-300 ms. */
export async function loadSignalContext(signalId: string): Promise<SignalExpansionContext> {
  const startTime = Date.now();
  const signalSnap = await db.collection('signals').doc(signalId).get();
  if (!signalSnap.exists) {
    throw new Error(`Signal not found: ${signalId}`);
  }
  const signal = signalSnap.data() as Signal;
  const strategiesSnap = await db.collection('strategies').get();
  const strategies = strategiesSnap.docs.map((d) => d.data() as Strategy);
  const strategyContext: StrategyContext[] = strategies.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mainDirectives: s.mainDirectives as any,
  }));
  return { signal, strategies: strategyContext, startTime };
}

/** Phase 2 — Gemini call. This is the slow one (10-30+ s). Isolated by design. */
export async function generateSignalExpansion(
  context: SignalExpansionContext,
  options: ExpandSignalOptions
): Promise<ExpandedContent> {
  const prompt = getExpansionPrompt(context.signal, context.strategies);
  const generationConfig = {
    model: options.model || 'gemini-3-flash-preview',
    thinkingLevel: options.thinkingLevel || 'medium',
    temperature: 0.7,
    maxOutputTokens: 8192,
  } as const;
  const searchEnabled = options.useGoogleSearch !== false;
  const generated = searchEnabled
    ? await generateGroundedContent(prompt, generationConfig)
    : {
        text: await generateContent(prompt, { ...generationConfig, useGoogleSearch: false }),
        citations: [],
      };
  const response = generated.text;
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;
  const parsed = JSON.parse(jsonStr.trim());
  const declaredSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const groundedCitations = await resolveGroundingCitationIdentities(generated.citations);
  const sources = normalizeSignalEvidenceSources(context.signal, declaredSources, {
    groundedCitations,
  });
  return {
    ...parsed,
    sources,
    expandedAt: Date.now(),
    expansionModel: options.model || 'gemini-3-flash-preview',
    expansionDuration: Date.now() - context.startTime,
  };
}

/** Phase 3 — compute trust score (pure CPU, ms). */
export function scoreSignalExpansion(
  context: SignalExpansionContext,
  expandedContent: ExpandedContent,
  _options: ExpandSignalOptions
): import('@/lib/schemas/signal').TrustScore {
  const evidenceSources = normalizeSignalEvidenceSources(context.signal, expandedContent.sources ?? []);
  const corroboratingSourceCount = evidenceSources.filter((source) => source.verdict === 'confirming').length;
  const trustScoreInput: TrustScoreInput = {
    signal: { ...context.signal, expandedContent },
    aiConfidence: 0.8,
    hasCorroboration: corroboratingSourceCount >= 2,
    corroboratingSourceCount,
  };
  return calculateTrustScore(trustScoreInput);
}

/**
 * Phase 3b (GRAPH-063) — resolve or reject the endpoint IDs the model invented,
 * BEFORE the expansion is persisted or scheduled for graph convergence.
 *
 * The expansion prompt hands the model an ungrounded `"id"` slot, so it emits
 * plausible identifiers for entities that do not exist. Each one becomes a
 * `MATCH (…{id: $id}) … MERGE` that silently matches nothing, which is counted
 * as an incomplete projection and PERMANENTLY blocks the signal's source
 * fingerprint — the reconciler then replays that signal every cycle forever.
 *
 * One Firestore read per non-empty kind. Typical latency: 100-300 ms.
 */
export async function resolveSignalExpansionEndpoints(
  signalId: string,
  expandedContent: ExpandedContent
): Promise<ExpansionEndpointResolution> {
  const loadCandidates: CandidateLoader = async (kind) => {
    if (kind === 'signals') {
      const snapshot = await db.collection('signals').get();
      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          label: typeof data.title === 'string' ? data.title : '',
          // An inbox-only signal is never projected on its own, so a
          // RELATED_SIGNAL edge to it could never match.
          projectable: isDirectlyProjectableSignalStatus(data.status),
        };
      });
    }
    const collection = kind === 'technologies' ? 'technologies' : 'companies';
    const snapshot = await db.collection(collection).get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        label: typeof data.name === 'string' ? data.name : '',
        projectable: true,
      };
    });
  };

  const resolution = await resolveExpansionEndpoints(expandedContent, signalId, loadCandidates);
  if (resolution.rejectedCount > 0 || resolution.resolvedCount > 0) {
    log.info('Signal expansion endpoints reconciled against the workspace', {
      signalId,
      kept: resolution.keptCount,
      resolved: resolution.resolvedCount,
      rejected: resolution.rejectedCount,
    });
  }
  return resolution;
}

/**
 * Phase 4 — persist results to Firestore. Typical latency: 100-300 ms.
 *
 * When a resolution is supplied, the CANONICALIZED related items are stored and
 * the dropped endpoints are recorded on the signal, so every downstream reader
 * (graph sync, entity extraction, daily pipeline, UI) sees only endpoints that
 * exist, and an operator can still see what the model invented.
 */
export async function persistSignalExpansion(
  signalId: string,
  expandedContent: ExpandedContent,
  trustScore: import('@/lib/schemas/signal').TrustScore,
  resolution?: ExpansionEndpointResolution
): Promise<void> {
  const canonicalContent = resolution ? { ...expandedContent, relatedItems: resolution.relatedItems } : expandedContent;
  const rejections = resolution ? toPersistedRejections(resolution.decisions) : [];
  await db
    .collection('signals')
    .doc(signalId)
    .update({
      expandedContent: canonicalContent,
      trustScore,
      expansionFailed: false,
      expansionError: FieldValue.delete(),
      expansionFailedAt: FieldValue.delete(),
      // Always written when a resolution ran, so a re-expansion that invents
      // nothing clears the previous run's audit instead of leaving it stale.
      ...(resolution
        ? {
            expansionRejectedEndpoints: rejections,
            expansionRejectedEndpointCount: resolution.rejectedCount,
          }
        : {}),
      updatedAt: Date.now(),
    });
}

/**
 * Expand a signal with deep analysis
 *
 * This function:
 * 1. Fetches the signal and relevant strategies
 * 2. Generates expansion prompt
 * 3. Calls Gemini with Google Search enabled
 * 4. Parses and validates the response
 * 5. Calculates trust score
 * 6. Updates the signal in Firestore
 *
 * @param signalId - ID of signal to expand
 * @param options - Expansion options
 * @returns Expansion result
 */
export async function expandSignal(signalId: string, options: ExpandSignalOptions = {}): Promise<ExpandSignalResult> {
  const startTime = Date.now();
  try {
    log.info('Starting expansion', { signalId });
    const context = await loadSignalContext(signalId);
    const generatedContent = await generateSignalExpansion(context, options);
    // GRAPH-063 — canonicalize before anything downstream can act on it.
    const resolution = await resolveSignalExpansionEndpoints(signalId, generatedContent);
    const expandedContent = { ...generatedContent, relatedItems: resolution.relatedItems };
    const trustScore = scoreSignalExpansion(context, expandedContent, options);
    await persistSignalExpansion(signalId, expandedContent, trustScore, resolution);

    // Re-sync to Neo4j so the expansion-discovered implicit relations
    // (expandedContent.relatedItems / linkedEntities / alignedStrategies) and the
    // updated trustScore reach the graph. persistSignalExpansion writes Firestore
    // directly, bypassing adminUpdateSignal (the only write path that fires the
    // entity-sync event), so without this an expanded signal stays orphaned in the
    // graph. Mirrors the expandSignalJob 'resync-signal-to-graph' step (backlog 0.2)
    // for every NON-Inngest caller of this wrapper — enrich-on-like and the chat
    // expandSignal tool. Best-effort: graph sync must never fail the expansion.
    try {
      const { inngest } = await import('@/lib/inngest/client');
      await inngest.send({
        name: 'app/unified-entity.sync.requested',
        data: { entityId: signalId, entityType: 'signal', operation: 'update' },
      });
    } catch (syncErr) {
      log.warn('Failed to re-sync expanded signal to graph (non-fatal)', {
        signalId,
        error: syncErr instanceof Error ? syncErr.message : String(syncErr),
      });
    }

    const duration = Date.now() - startTime;
    log.info('Expansion completed', { signalId, duration });
    return {
      success: true,
      signalId,
      expansionDuration: duration,
      expandedContent,
      trustScore,
      endpointResolution: {
        kept: resolution.keptCount,
        resolved: resolution.resolvedCount,
        rejected: resolution.rejectedCount,
        rejectedEndpoints: toPersistedRejections(resolution.decisions),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Unknown error during expansion';
    log.error('Expansion failed', error instanceof Error ? error : undefined, { signalId });
    return { success: false, signalId, expansionDuration: duration, error: message };
  }
}

/**
 * Expand multiple signals in batch
 *
 * @param signalIds - Array of signal IDs to expand
 * @param options - Expansion options
 * @returns Array of expansion results
 */
export async function expandSignalsBatch(
  signalIds: string[],
  options: ExpandSignalOptions = {}
): Promise<ExpandSignalResult[]> {
  log.info('Expanding signals batch', { count: signalIds.length });

  // Process signals sequentially to avoid rate limits
  const results: ExpandSignalResult[] = [];
  for (const signalId of signalIds) {
    const result = await expandSignal(signalId, options);
    results.push(result);

    // Add delay between expansions to avoid rate limiting
    if (signalIds.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  log.info('Batch expansion completed', { successCount, total: signalIds.length });

  return results;
}
