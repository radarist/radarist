/**
 * Development-only Inngest function registry selection.
 *
 * The full registry contains both event-triggered work and cron maintenance.
 * Retained-data testing needs an explicit interactive registry so starting a
 * fresh local dev server cannot also launch ambient schedules. Production is
 * always full; an attempted restricted production profile fails closed.
 */

export type InngestFunctionProfile = 'full' | 'interactive';

export function resolveInngestFunctionProfile(
  rawValue: string | undefined,
  isDevelopment: boolean,
): InngestFunctionProfile {
  const value = rawValue?.trim();

  if (!value || value === 'full') {
    return 'full';
  }

  if (value === 'interactive') {
    if (!isDevelopment) {
      throw new Error(
        'INNGEST_FUNCTION_PROFILE=interactive is development-only; production must use the full registry',
      );
    }
    return 'interactive';
  }

  throw new Error(
    `Unsupported INNGEST_FUNCTION_PROFILE "${value}". Expected "full" or "interactive".`,
  );
}
