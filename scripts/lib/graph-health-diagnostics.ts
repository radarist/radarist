/** Pure evaluation helpers for the live Neo4j graph-health script. */

export interface DisconnectedEntityRate {
  label: string;
  total: number;
  disconnected: number;
  rate: number;
}

/** A large disconnected share is useful curation telemetry, not data loss. */
export const DISCONNECTED_ENTITY_WARN_RATE = 0.5;
export const DISCONNECTED_ENTITY_WARN_MIN_TOTAL = 10;

export function measuredRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Summarize only material backlogs. These remain warnings because Radarist's
 * approve-then-link workflow intentionally leaves untriaged entities without
 * graph edges.
 */
export function evaluateDisconnectedEntityRates(
  entries: DisconnectedEntityRate[],
  rateThreshold: number = DISCONNECTED_ENTITY_WARN_RATE,
  minimumTotal: number = DISCONNECTED_ENTITY_WARN_MIN_TOTAL
): string[] {
  const elevated = entries
    .filter(({ total, rate }) => total >= minimumTotal && rate > rateThreshold)
    .sort((a, b) => b.rate - a.rate);

  if (elevated.length === 0) return [];

  const details = elevated
    .map(
      ({ label, disconnected, total, rate }) =>
        `${label} ${(rate * 100).toFixed(1)}% (${disconnected}/${total})`
    )
    .join(', ');

  return [
    `High disconnected-entity curation backlog: ${details}. ` +
      'Informational only; review the linker/approval queue rather than deleting these nodes.',
  ];
}
