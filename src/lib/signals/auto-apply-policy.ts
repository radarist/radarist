import { createHash } from 'node:crypto';

import type { Signal } from '@/lib/types';
import { parseBoundedInteger } from '@/lib/config';
import { normalizeSignalEvidenceSources } from './evidence-sources';

export const DEFAULT_SIGNAL_AUTO_APPROVE_THRESHOLD = 85;

/** Stable Technology identity shared by the mutation and commit-recovery paths. */
export function technologyIdForSignal(signalId: string): string {
  return `tech-signal-${createHash('sha256').update(signalId).digest('hex').slice(0, 24)}`;
}

type SignalAutopilotEnvironment = Record<string, string | undefined>;

export interface SignalAutoApplyEvaluation {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'unsupported-entity-type'
    | 'ineligible-status'
    | 'score-below-threshold'
    | 'insufficient-confirming-sources';
  confirmingSourceCount: number;
}

/** Strict integer parser. Invalid configuration disables auto-apply. */
export function parseSignalAutoApproveThreshold(
  env: SignalAutopilotEnvironment
): number | null {
  const raw =
    env.SIGNAL_AUTO_APPROVE_THRESHOLD ??
    env.IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD ??
    String(DEFAULT_SIGNAL_AUTO_APPROVE_THRESHOLD);
  return parseBoundedInteger(raw, DEFAULT_SIGNAL_AUTO_APPROVE_THRESHOLD, 0, 100);
}

/** Primary setting wins over the compatibility alias, including explicit false. */
export function isSignalAutopilotEnabled(env: SignalAutopilotEnvironment): boolean {
  return (env.SIGNAL_AUTOPILOT_ENABLED ?? env.IMPULSE_SIGNAL_AUTOPILOT_ENABLED) === 'true';
}

/**
 * Stable authorization token for the exact persisted expansion used to make
 * an auto-apply decision. The transaction recomputes it to reject stale work.
 */
export function signalAutoApplyFingerprint(signal: Signal): string {
  const sources = normalizeSignalEvidenceSources(signal, signal.expandedContent?.sources ?? []).map((source) => ({
    url: source.url,
    verdict: source.verdict,
  }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        signalId: signal.id,
        title: signal.title,
        description: signal.description ?? '',
        createdBy: signal.metadata?.agentId ?? 'signal-autopilot',
        expandedAt: signal.expandedContent?.expandedAt ?? null,
        entityType: signal.expandedContent?.entityProfile?.type ?? null,
        trustOverall: signal.trustScore?.overall ?? null,
        sources,
      })
    )
    .digest('hex');
}

/** Shared preflight and transaction-boundary eligibility rule. */
export function evaluateSignalAutoApply(signal: Signal, threshold: number): SignalAutoApplyEvaluation {
  const confirmingSourceCount = normalizeSignalEvidenceSources(
    signal,
    signal.expandedContent?.sources ?? []
  ).filter((source) => source.verdict === 'confirming').length;

  if (signal.expandedContent?.entityProfile?.type !== 'technology') {
    return { eligible: false, reason: 'unsupported-entity-type', confirmingSourceCount };
  }
  if (!['Detected', 'Validated', 'Approved'].includes(signal.status)) {
    return { eligible: false, reason: 'ineligible-status', confirmingSourceCount };
  }
  if ((signal.trustScore?.overall ?? -1) < threshold) {
    return { eligible: false, reason: 'score-below-threshold', confirmingSourceCount };
  }
  if (confirmingSourceCount < 2) {
    return { eligible: false, reason: 'insufficient-confirming-sources', confirmingSourceCount };
  }
  return { eligible: true, reason: 'eligible', confirmingSourceCount };
}
