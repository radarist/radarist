/**
 * Resolves the release-safe background automation policy from system-config.
 *
 * `sweep.enabled` is the v0.1 master switch for scheduled work. Individual
 * producers must also have their own capability flag enabled. Missing,
 * malformed, or unreadable configuration therefore resolves to paused.
 */

export interface BackgroundAutomationPolicy {
  enabled: boolean;
  impulseSweepEnabled: boolean;
  signalFetchEnabled: boolean;
  linkerEnabled: boolean;
  discoveryEnabled: boolean;
  maxActionsPerSweep: number;
}

const DEFAULT_MAX_ACTIONS_PER_SWEEP = 10;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function resolveBackgroundAutomationPolicy(config: unknown): BackgroundAutomationPolicy {
  const root = asRecord(config);
  const sweep = asRecord(root?.sweep);
  const signalDetection = asRecord(root?.signalDetection);
  const linkerAgent = asRecord(root?.linkerAgent);

  const enabled = sweep?.enabled === true;
  const configuredMaxActions = sweep?.maxActionsPerSweep;
  const maxActionsPerSweep =
    typeof configuredMaxActions === 'number' &&
    Number.isInteger(configuredMaxActions) &&
    configuredMaxActions >= 1 &&
    configuredMaxActions <= 20
      ? configuredMaxActions
      : DEFAULT_MAX_ACTIONS_PER_SWEEP;

  return {
    enabled,
    impulseSweepEnabled: enabled,
    signalFetchEnabled: enabled && signalDetection?.enabled === true,
    linkerEnabled: enabled && linkerAgent?.enabled === true,
    discoveryEnabled: enabled,
    maxActionsPerSweep,
  };
}
