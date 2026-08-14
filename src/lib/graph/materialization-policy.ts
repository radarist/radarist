/** Minimum 0-100 confidence for a machine claim to materialize as a typed edge. */
export const MACHINE_RELATION_MATERIALIZATION_THRESHOLD = 75;

/** Largest absolute reliability adjustment applied by the graph policy. */
export const MAX_MACHINE_RELIABILITY_ADJUSTMENT = 10;

/**
 * Autopilot only closes triage when materialization is guaranteed even for an
 * asserter currently carrying the maximum negative reliability adjustment.
 */
export function machineRelationAutoApprovalThreshold(reliabilityEnabled: boolean): number {
  return (
    MACHINE_RELATION_MATERIALIZATION_THRESHOLD +
    (reliabilityEnabled ? MAX_MACHINE_RELIABILITY_ADJUSTMENT : 0)
  );
}
