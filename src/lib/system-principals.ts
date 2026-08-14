/**
 * @file system-principals.ts
 * @description The canonical set of machine principals that autonomous
 * writers stamp as `userId` on missions, agent runs, and agent events —
 * plus the server-authorized union used by local observability surfaces
 * (ARUN-005).
 *
 * In local single-user mode, system-initiated work (sweep cycles, cron
 * discovery, internal MCP calls) must be visible on the activity log, the
 * SSE stream, run detail, and mission lists alongside the signed-in user's
 * own work. Readers achieve that by querying
 * `userId in observabilityPrincipals(auth.uid)`.
 *
 * SECURITY CONTRACT: the union is compiled in. Routes derive the principal
 * list ONLY from the verified `auth.uid` — a client-supplied principal
 * (query param, header, body field) must never reach these helpers.
 *
 * Pure module — no imports — safe for client and server code alike.
 */

/** Generic machine principal (internal MCP calls, discovery tool events). */
export const SYSTEM_PRINCIPAL = 'system';

/** The autonomous sweep cycle and the missions it spawns. */
export const SYSTEM_SWEEP_PRINCIPAL = 'system-sweep';

/** Cron-triggered discovery (interest-profile refresh, benchmark builds). */
export const SYSTEM_DISCOVERY_PRINCIPAL = 'system-discovery';

/** Every machine principal a writer may stamp as `userId`. */
export const SYSTEM_PRINCIPALS: readonly string[] = [
  SYSTEM_PRINCIPAL,
  SYSTEM_SWEEP_PRINCIPAL,
  SYSTEM_DISCOVERY_PRINCIPAL,
];

/** True when a `userId` denotes machine-initiated work, not a human. */
export function isSystemPrincipal(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && SYSTEM_PRINCIPALS.includes(userId);
}

/**
 * The principal union an observability reader queries for the signed-in
 * user: their own uid plus every system principal, deduplicated. Fits a
 * single Firestore `in` filter.
 */
export function observabilityPrincipals(uid: string): string[] {
  return isSystemPrincipal(uid) ? [...SYSTEM_PRINCIPALS] : [uid, ...SYSTEM_PRINCIPALS];
}
