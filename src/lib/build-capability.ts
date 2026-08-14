/**
 * @file build-capability.ts
 * @description Single source of truth for whether build missions are enabled.
 *
 * Build missions are gated by the non-public `IMPULSE_BUILD_ENABLED` env flag
 * through `IMPULSE_BUILD_ENABLED`. Both the enforcing dispatch route
 * (`POST /api/missions`) and the capability endpoint the UI reads
 * (`GET /api/missions/capabilities`) resolve the flag through this one helper,
 * so the button the user sees and the gate the server enforces can never drift.
 *
 * SERVER-SIDE ONLY: `IMPULSE_BUILD_ENABLED` is not `NEXT_PUBLIC_*`, so it is not
 * inlined into the client bundle — a browser import would always read
 * `undefined` and wrongly report builds as disabled. The client learns the
 * state via the capability endpoint (see `useBuildCapability`), never by
 * importing this module.
 */

const TRUTHY_FLAG_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** True when `IMPULSE_BUILD_ENABLED` is set to a truthy value. */
export function isBuildEnabled(): boolean {
  return TRUTHY_FLAG_VALUES.has((process.env.IMPULSE_BUILD_ENABLED ?? '').trim().toLowerCase());
}

/** User-facing reason shown wherever a build dispatch is blocked. */
export const BUILD_DISABLED_MESSAGE = 'Build missions are disabled on this instance (IMPULSE_BUILD_ENABLED is off).';
